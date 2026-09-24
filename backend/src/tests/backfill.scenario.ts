import dotenv from 'dotenv';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import { backfillDailyCaps } from '../db/backfill';
import { calculatePoints } from '../services/pointsCalculator';

dotenv.config();

const run = async (): Promise<void> => {
  await createTables();

  // 模拟旧系统数据：同一天补报 5h + 5h + 5h，旧逻辑按全部时长计积分
  const v = await pool.query(
    `INSERT INTO volunteers (name, phone, email, total_points, level, service_count, credit_score)
     VALUES ('旧数据补跑测试', '13600000001', 'backfill-old@example.com', $1, 2, 3, 100)
     RETURNING id`,
    [calculatePoints(5, 'community_service', 5) * 3]
  );
  const volunteerId = v.rows[0].id;

  for (let i = 0; i < 3; i++) {
    await pool.query(
      `INSERT INTO service_records
         (volunteer_id, service_type, duration_hours, valid_hours, overtime_hours,
          is_overtime, rating, points_earned, is_no_show, entry_seq, recorded_at)
       VALUES ($1, 'community_service', 5, 0, 0, false, 5, $2, false, $3, '2025-06-01 09:00:00')`,
      [volunteerId, calculatePoints(5, 'community_service', 5), i + 1]
    );
  }
  // 一条管理员加分，必须在补跑后保留
  await pool.query(
    `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_type)
     VALUES ($1, 50, '管理员调整: 旧数据加分', 0, 50, 'admin_adjust')`,
    [volunteerId]
  );

  await backfillDailyCaps();

  const records = await pool.query(
    `SELECT entry_seq, valid_hours, overtime_hours, is_overtime, points_earned
     FROM service_records WHERE volunteer_id = $1 ORDER BY entry_seq`,
    [volunteerId]
  );
  console.log('records:', JSON.stringify(records.rows, null, 2));

  const volunteer = await pool.query('SELECT * FROM volunteers WHERE id = $1', [volunteerId]);
  console.log('volunteer:', JSON.stringify(volunteer.rows[0], null, 2));

  const logs = await pool.query(
    `SELECT change_amount, reason, related_type FROM points_logs
     WHERE volunteer_id = $1 ORDER BY created_at`, [volunteerId]);
  console.log('logs:', JSON.stringify(logs.rows, null, 2));

  const r = records.rows;
  const ok =
    Number(r[0].valid_hours) === 5 && Number(r[0].overtime_hours) === 0 && r[0].is_overtime === false &&
    Number(r[1].valid_hours) === 3 && Number(r[1].overtime_hours) === 2 && r[1].is_overtime === true &&
    Number(r[2].valid_hours) === 0 && Number(r[2].overtime_hours) === 5 && r[2].is_overtime === true &&
    volunteer.rows[0].service_count === 2;

  const expectedPoints = r[0].points_earned + r[1].points_earned + r[2].points_earned + 50;
  const pointsOk = volunteer.rows[0].total_points === expectedPoints;
  console.log(`\n工时分配: ${ok ? 'PASS' : 'FAIL'}`);
  console.log(`积分保留管理员加分: ${pointsOk ? 'PASS' : 'FAIL'} (total=${volunteer.rows[0].total_points}, expected=${expectedPoints})`);

  // 幂等：再跑一次不应重复对账
  const beforeLogs = logs.rows.length;
  await backfillDailyCaps();
  const logs2 = await pool.query(
    'SELECT COUNT(*)::int as c FROM points_logs WHERE volunteer_id = $1', [volunteerId]);
  console.log(`补跑幂等: ${logs2.rows[0].c === beforeLogs ? 'PASS' : 'FAIL'}`);

  await pool.end();
  process.exit(ok && pointsOk && logs2.rows[0].c === beforeLogs ? 0 : 1);
};

run().catch(e => { console.error(e); process.exit(1); });
