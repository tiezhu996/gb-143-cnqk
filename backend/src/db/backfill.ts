import pool from './pool';
import { logger } from '../utils/logger';
import { recomputeDailyCap } from '../services/dailyCapService';
import { calculateLevel } from '../services/badgeService';

const BACKFILL_KEY = 'daily_cap_backfill_v1';

/**
 * 为旧数据补跑每日 8 小时上限，并按 active 记录重算志愿者的
 * total_points / level / service_count / 徽章。
 * 管理员调整与投诉扣分以一次性对账流水的形式保留。
 * 幂等：通过 app_metadata 标记，只执行一次。
 */
export const backfillDailyCaps = async (): Promise<void> => {
  const client = await pool.connect();

  try {
    const flagResult = await client.query(
      'SELECT value FROM app_metadata WHERE key = $1',
      [BACKFILL_KEY]
    );
    if (flagResult.rows.length > 0 && flagResult.rows[0].value === 'done') {
      return;
    }

    logger.info('开始补跑每日8小时上限并重建志愿者汇总...');
    await client.query('BEGIN');

    const volunteersResult = await client.query('SELECT id FROM volunteers ORDER BY created_at');
    const volunteerIds: string[] = volunteersResult.rows.map(r => r.id);

    for (const volunteerId of volunteerIds) {
      const daysResult = await client.query(
        `SELECT DISTINCT recorded_at::date::text as service_date
         FROM service_records
         WHERE volunteer_id = $1 AND status = 'active'
         ORDER BY service_date`,
        [volunteerId]
      );

      let recordPointsDelta = 0;
      for (const row of daysResult.rows) {
        const result = await recomputeDailyCap(client, volunteerId, row.service_date);
        recordPointsDelta += result.totalPointsChange;
      }

      const contributionResult = await client.query(
        `SELECT
           COALESCE(SUM(points_earned), 0)::int as earned_total,
           COALESCE(SUM(points_adjustment), 0)::int as adjustment_total
         FROM service_records
         WHERE volunteer_id = $1 AND status = 'active'`,
        [volunteerId]
      );
      const earnedTotal = contributionResult.rows[0].earned_total;
      const adjustmentTotal = contributionResult.rows[0].adjustment_total;
      const recordTotal = Math.max(0, earnedTotal + adjustmentTotal);

      const nonRecordResult = await client.query(
        `SELECT COALESCE(SUM(change_amount), 0)::int as total
         FROM points_logs
         WHERE volunteer_id = $1
           AND related_type IS DISTINCT FROM 'service_record'
           AND related_type IS DISTINCT FROM 'admin_delete'`,
        [volunteerId]
      );
      const nonRecordAdjustments = nonRecordResult.rows[0].total;

      const volunteerResult = await client.query(
        'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
        [volunteerId]
      );
      const volunteer = volunteerResult.rows[0];
      const oldTotalPoints = volunteer.total_points;
      const newTotalPoints = Math.max(0, recordTotal + nonRecordAdjustments);
      const newLevel = calculateLevel(newTotalPoints);

      const countResult = await client.query(
        `SELECT COUNT(*)::int as service_count
         FROM service_records
         WHERE volunteer_id = $1
           AND status = 'active'
           AND is_no_show = false
           AND valid_hours > 0`,
        [volunteerId]
      );

      await client.query(
        `UPDATE volunteers
         SET total_points = $1, level = $2, service_count = $3
         WHERE id = $4`,
        [newTotalPoints, newLevel, countResult.rows[0].service_count, volunteerId]
      );

      // 徽章对账：缺级补发，超出回收
      await client.query('DELETE FROM badges WHERE volunteer_id = $1 AND star_level > $2',
        [volunteerId, newLevel]);
      const badgeTypes = [
        { level: 2, name: '二星志愿者', desc: '坚持服务，展现热忱之心' },
        { level: 3, name: '三星志愿者', desc: '积极奉献，成为志愿中坚' },
        { level: 4, name: '四星志愿者', desc: '资深志愿者，榜样力量' },
        { level: 5, name: '五星志愿者', desc: '卓越志愿者，公益楷模' },
      ];
      for (const badge of badgeTypes) {
        if (badge.level <= newLevel) {
          await client.query(
            `INSERT INTO badges (volunteer_id, star_level, badge_name, description)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (volunteer_id, star_level) DO NOTHING`,
            [volunteerId, badge.level, badge.name, badge.desc]
          );
        }
      }

      const correction = newTotalPoints - oldTotalPoints;
      if (correction !== 0) {
        await client.query(
          `INSERT INTO points_logs
             (volunteer_id, change_amount, reason, before_points, after_points, related_type)
           VALUES ($1, $2, $3, $4, $5, 'daily_cap_backfill')`,
          [
            volunteerId,
            correction,
            '历史记录每日8小时上限对账',
            oldTotalPoints,
            newTotalPoints,
          ]
        );
      }

      if (recordPointsDelta !== 0) {
        logger.info(`志愿者 ${volunteerId} 每日上限对账，记录积分增量 ${recordPointsDelta}`);
      }
    }

    await client.query(
      `INSERT INTO app_metadata (key, value)
       VALUES ($1, 'done')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [BACKFILL_KEY]
    );

    await client.query('COMMIT');
    logger.info('每日8小时上限补跑完成。');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('每日上限补跑失败', error);
    throw error;
  } finally {
    client.release();
  }
};
