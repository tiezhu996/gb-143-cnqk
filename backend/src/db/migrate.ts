import pool from './pool';
import { messages } from '../constants/messages';
import { logger } from '../utils/logger';
import { reallocateVolunteerDays, rebuildServicePointsLogs, reconcileVolunteerAggregates } from '../services/dailyCapService';

const createTables = async (): Promise<void> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    await client.query(`
      CREATE TABLE IF NOT EXISTS volunteers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(20),
        email VARCHAR(100),
        total_points INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 1,
        credit_score INTEGER NOT NULL DEFAULT 100,
        service_count INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_volunteers_total_points ON volunteers(total_points DESC);
      CREATE INDEX IF NOT EXISTS idx_volunteers_credit_score ON volunteers(credit_score DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS service_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        volunteer_id UUID NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
        service_type VARCHAR(50) NOT NULL,
        duration_hours DECIMAL(6,2) NOT NULL,
        rating INTEGER NOT NULL DEFAULT 5 CHECK (rating >= 1 AND rating <= 5),
        points_earned INTEGER NOT NULL DEFAULT 0,
        is_no_show BOOLEAN NOT NULL DEFAULT false,
        location VARCHAR(200),
        description TEXT,
        valid_hours DECIMAL(6,2) NOT NULL DEFAULT 0,
        overtime_hours DECIMAL(6,2) NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'valid'
          CHECK (status IN ('valid', 'overtime', 'no_show', 'revoked')),
        cap_seq BIGINT,
        revoked_at TIMESTAMP,
        revoked_by VARCHAR(100),
        revoke_reason TEXT,
        recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_service_records_volunteer_id ON service_records(volunteer_id);
      CREATE INDEX IF NOT EXISTS idx_service_records_recorded_at ON service_records(recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_service_records_service_type ON service_records(service_type);
      CREATE INDEX IF NOT EXISTS idx_service_records_status ON service_records(status);
      CREATE INDEX IF NOT EXISTS idx_service_records_volunteer_day_seq
        ON service_records(volunteer_id, recorded_at, cap_seq);
    `);

    // 兼容旧库：补齐每日工时上限相关列
    await client.query(`
      ALTER TABLE service_records ADD COLUMN IF NOT EXISTS valid_hours DECIMAL(6,2) NOT NULL DEFAULT 0;
      ALTER TABLE service_records ADD COLUMN IF NOT EXISTS overtime_hours DECIMAL(6,2) NOT NULL DEFAULT 0;
      ALTER TABLE service_records ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'valid';
      ALTER TABLE service_records ADD COLUMN IF NOT EXISTS cap_seq BIGINT;
      ALTER TABLE service_records ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP;
      ALTER TABLE service_records ADD COLUMN IF NOT EXISTS revoked_by VARCHAR(100);
      ALTER TABLE service_records ADD COLUMN IF NOT EXISTS revoke_reason TEXT;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'service_records_status_check'
        ) THEN
          ALTER TABLE service_records
            ADD CONSTRAINT service_records_status_check
            CHECK (status IN ('valid', 'overtime', 'no_show', 'revoked'));
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_service_records_status ON service_records(status);
      CREATE INDEX IF NOT EXISTS idx_service_records_volunteer_day_seq
        ON service_records(volunteer_id, recorded_at, cap_seq);

      UPDATE service_records SET status = 'no_show' WHERE is_no_show = true AND status = 'valid';

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'service_records_cap_seq_global') THEN
          CREATE SEQUENCE service_records_cap_seq_global;
        END IF;
      END $$;

      ALTER TABLE service_records
        ALTER COLUMN cap_seq SET DEFAULT nextval('service_records_cap_seq_global');

      SELECT setval(
        'service_records_cap_seq_global',
        GREATEST(COALESCE((SELECT MAX(cap_seq) FROM service_records), 0), 1),
        true
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS badges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        volunteer_id UUID NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
        star_level INTEGER NOT NULL CHECK (star_level >= 1 AND star_level <= 5),
        badge_name VARCHAR(100) NOT NULL,
        description TEXT,
        awarded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(volunteer_id, star_level)
      );

      CREATE INDEX IF NOT EXISTS idx_badges_volunteer_id ON badges(volunteer_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS complaints (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        volunteer_id UUID NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
        complainant_id UUID,
        complaint_type VARCHAR(50) NOT NULL,
        description TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'rejected')),
        resolution TEXT,
        credit_penalty INTEGER DEFAULT 0,
        points_penalty INTEGER DEFAULT 0,
        handled_by VARCHAR(100),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_complaints_volunteer_id ON complaints(volunteer_id);
      CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS credit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        volunteer_id UUID NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
        change_amount INTEGER NOT NULL,
        reason VARCHAR(200) NOT NULL,
        before_score INTEGER NOT NULL,
        after_score INTEGER NOT NULL,
        related_id UUID,
        related_type VARCHAR(50),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_credit_logs_volunteer_id ON credit_logs(volunteer_id);
      CREATE INDEX IF NOT EXISTS idx_credit_logs_created_at ON credit_logs(created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS points_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        volunteer_id UUID NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
        change_amount INTEGER NOT NULL,
        reason VARCHAR(200) NOT NULL,
        before_points INTEGER NOT NULL,
        after_points INTEGER NOT NULL,
        related_id UUID,
        related_type VARCHAR(50),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_points_logs_volunteer_id ON points_logs(volunteer_id);
      CREATE INDEX IF NOT EXISTS idx_points_logs_created_at ON points_logs(created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id VARCHAR(100) NOT NULL,
        action VARCHAR(50) NOT NULL,
        target_type VARCHAR(50) NOT NULL,
        target_id UUID,
        old_value JSONB,
        new_value JSONB,
        reason TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs(created_at DESC);
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';

      DROP TRIGGER IF EXISTS update_volunteers_updated_at ON volunteers;
      CREATE TRIGGER update_volunteers_updated_at
        BEFORE UPDATE ON volunteers
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

      DROP TRIGGER IF EXISTS update_service_records_updated_at ON service_records;
      CREATE TRIGGER update_service_records_updated_at
        BEFORE UPDATE ON service_records
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `);

    await client.query('COMMIT');
    logger.info(messages.errors.tableCreateSuccess);
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.errors.tableCreateFailed, error);
    throw error;
  } finally {
    client.release();
  }
};

const seedData = async (): Promise<void> => {
  const client = await pool.connect();

  try {
    const result = await client.query('SELECT COUNT(*) as count FROM volunteers');
    if (parseInt(result.rows[0].count) === 0) {
      logger.info(messages.errors.seedStarting);

      const volunteerInserts = [
        { name: '张伟', phone: '13800138001', email: 'zhangwei@example.com' },
        { name: '李娜', phone: '13800138002', email: 'lina@example.com' },
        { name: '王强', phone: '13800138003', email: 'wangqiang@example.com' },
        { name: '刘婷', phone: '13800138004', email: 'liuting@example.com' },
        { name: '陈明', phone: '13800138005', email: 'chenming@example.com' },
      ];

      for (const v of volunteerInserts) {
        await client.query(
          'INSERT INTO volunteers(name, phone, email) VALUES($1, $2, $3)',
          [v.name, v.phone, v.email]
        );
      }

      logger.info(messages.errors.seedCreated);
    }
  } catch (error) {
    logger.error(messages.errors.seedFailed, error);
  } finally {
    client.release();
  }
};

/**
 * 一次性回填：为存量服务记录补齐当天顺序号（cap_seq），
 * 再按每人每天 8 小时上限重算有效/超额工时、积分流水、积分/等级/徽章/服务次数。
 */
const backfillDailyCap = async (): Promise<void> => {
  const client = await pool.connect();

  try {
    const flagResult = await client.query(
      `SELECT value FROM app_metadata WHERE key = 'daily_cap_initialized'`
    );
    if (flagResult.rows.length > 0 && flagResult.rows[0].value === 'v1') {
      return;
    }

    await client.query('BEGIN');

    // 同一人同一天按录入先后编号；旧记录没有独立的日序号，用 recorded_at 近似
    await client.query(`
      DO $$
      DECLARE
        rec RECORD;
        day_seq BIGINT;
      BEGIN
        day_seq := 0;
        FOR rec IN
          SELECT id, volunteer_id, recorded_at::date AS record_date
          FROM service_records
          WHERE cap_seq IS NULL
          ORDER BY volunteer_id, recorded_at::date, recorded_at ASC, created_at ASC
        LOOP
          day_seq := nextval('service_records_cap_seq_global');
          UPDATE service_records SET cap_seq = day_seq WHERE id = rec.id;
        END LOOP;
      END $$;
    `);

    // 后续新插入自动生成当天顺序号（序列与默认值已在建表迁移中创建）

    const volunteersResult = await client.query('SELECT id FROM volunteers ORDER BY created_at');
    for (const row of volunteersResult.rows) {
      await reallocateVolunteerDays(client, row.id);
      await rebuildServicePointsLogs(client, row.id);
      await reconcileVolunteerAggregates(client, row.id);
    }

    await client.query(
      `INSERT INTO app_metadata (key, value)
       VALUES ('daily_cap_initialized', 'v1')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`
    );

    await client.query('COMMIT');
    logger.info('Daily working-hours cap backfill completed.');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Daily working-hours cap backfill failed', error);
    throw error;
  } finally {
    client.release();
  }
};

export { createTables, seedData, backfillDailyCap };
