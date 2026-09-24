import { PoolClient } from 'pg';
import { BADGE_DESCRIPTIONS, BADGE_NAMES, ServiceRecord, ServiceRecordStatus } from '../types';
import { calculateNoShowPenalty } from './pointsCalculator';
import { allocateDay, round2, toRecordDate, DailyCapRow, DAILY_VALID_HOURS_LIMIT } from './dailyCapAllocation';

export interface RecordCapChange {
  record: ServiceRecord;
  before: {
    valid_hours: number;
    overtime_hours: number;
    points_earned: number;
    status: ServiceRecordStatus;
  };
  after: {
    valid_hours: number;
    overtime_hours: number;
    points_earned: number;
    status: ServiceRecordStatus;
  };
}

const ACTIVE_RECORDS_SQL = `
  SELECT * FROM service_records
  WHERE volunteer_id = $1 AND status <> 'revoked'
  ORDER BY recorded_at::date ASC, cap_seq ASC
`;

/**
 * 按“记录日期 + 当天录入顺序”重新分配某志愿者的有效/超额工时。
 * 仅传入 affectedDates 时只重算指定日期，但为简单起见默认重算其全部日期。
 * 撤销（status=revoked）的记录不参与分配，原记录保留。
 */
export const reallocateVolunteerDays = async (
  client: PoolClient,
  volunteerId: string,
  affectedDates?: string[]
): Promise<RecordCapChange[]> => {
  const result = await client.query(ACTIVE_RECORDS_SQL, [volunteerId]);
  const records = result.rows as ServiceRecord[];

  const dateFilter = affectedDates ? new Set(affectedDates) : null;
  const days = new Map<string, ServiceRecord[]>();

  for (const record of records) {
    const date = toRecordDate(record.recorded_at);
    if (dateFilter && !dateFilter.has(date)) {
      continue;
    }
    const dayRecords = days.get(date);
    if (dayRecords) {
      dayRecords.push(record);
    } else {
      days.set(date, [record]);
    }
  }

  const changes: RecordCapChange[] = [];

  for (const [, dayRecords] of days) {
    const allocation = allocateDay(dayRecords as DailyCapRow[]);

    for (const record of dayRecords) {
      const alloc = allocation.get(record.id!)!;
      const nextStatus: ServiceRecordStatus = record.is_no_show
        ? 'no_show'
        : alloc.validHours > 0
          ? 'valid'
          : 'overtime';

      const before = {
        valid_hours: round2(Number(record.valid_hours ?? 0)),
        overtime_hours: round2(Number(record.overtime_hours ?? 0)),
        points_earned: Number(record.points_earned ?? 0),
        status: (record.status ?? 'valid') as ServiceRecordStatus,
      };
      const after = {
        valid_hours: alloc.validHours,
        overtime_hours: alloc.overtimeHours,
        points_earned: alloc.pointsEarned,
        status: nextStatus,
      };

      if (
        before.valid_hours !== after.valid_hours
        || before.overtime_hours !== after.overtime_hours
        || before.points_earned !== after.points_earned
        || before.status !== after.status
      ) {
        await client.query(
          `UPDATE service_records
           SET valid_hours = $1,
               overtime_hours = $2,
               points_earned = $3,
               status = $4
           WHERE id = $5`,
          [after.valid_hours, after.overtime_hours, after.points_earned, after.status, record.id]
        );

        changes.push({
          record: { ...record, ...after },
          before,
          after,
        });
      }
    }
  }

  return changes;
};

/**
 * 依据当前有效记录重建某志愿者的服务类积分流水（related_type='service_record'），
 * 管理员调整、投诉处理等其它流水保持不变。撤销记录与超额（0 分）记录不产生流水。
 */
export const rebuildServicePointsLogs = async (
  client: PoolClient,
  volunteerId: string
): Promise<void> => {
  const baseResult = await client.query(
    `SELECT COALESCE(SUM(change_amount), 0) as base
     FROM points_logs
     WHERE volunteer_id = $1 AND related_type <> 'service_record'`,
    [volunteerId]
  );
  let runningPoints = Math.max(0, Number(baseResult.rows[0].base));

  const recordsResult = await client.query(
    `SELECT * FROM service_records
     WHERE volunteer_id = $1 AND status <> 'revoked'
     ORDER BY recorded_at::date ASC, cap_seq ASC`,
    [volunteerId]
  );
  const activeRecords = recordsResult.rows as ServiceRecord[];

  await client.query(
    `DELETE FROM points_logs WHERE volunteer_id = $1 AND related_type = 'service_record'`,
    [volunteerId]
  );

  for (const record of activeRecords) {
    const changeAmount = record.is_no_show
      ? -calculateNoShowPenalty()
      : Number(record.points_earned ?? 0);

    if (changeAmount === 0) {
      continue;
    }

    const beforePoints = runningPoints;
    runningPoints = Math.max(0, runningPoints + changeAmount);

    const reason = record.is_no_show
      ? '爽约扣分'
      : `服务积分: ${record.service_type}${Number(record.overtime_hours ?? 0) > 0 ? '（含超额工时，超额不计分）' : ''}`;

    await client.query(
      `INSERT INTO points_logs
         (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'service_record')`,
      [volunteerId, changeAmount, reason, beforePoints, runningPoints, record.id]
    );
  }
};

export interface AggregateReconcileResult {
  totalPoints: number;
  serviceCount: number;
  level: number;
  oldLevel: number;
  badgesAwarded: any[];
  badgesRevoked: any[];
}

/**
 * 依据现存服务记录重算志愿者总积分、服务次数、等级并对齐徽章：
 * - 积分 = 有效记录积分（超额为 0）- 爽约扣分 + 管理员/投诉等手工流水
 * - 服务次数只统计有效（非爽约、非撤销、非整笔超额）记录
 * - 超过当前等级的徽章补发，等级下降的徽章收回
 */
export const reconcileVolunteerAggregates = async (
  client: PoolClient,
  volunteerId: string
): Promise<AggregateReconcileResult | null> => {
  const volunteerResult = await client.query(
    'SELECT * FROM volunteers WHERE id = $1',
    [volunteerId]
  );
  if (volunteerResult.rows.length === 0) {
    return null;
  }
  const volunteer = volunteerResult.rows[0];
  const oldLevel = Number(volunteer.level);

  const pointsResult = await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN is_no_show = false AND status <> 'revoked' THEN points_earned ELSE 0 END), 0) as service_points,
       COUNT(CASE WHEN is_no_show = true AND status = 'no_show' THEN 1 END) as no_show_count
     FROM service_records
     WHERE volunteer_id = $1`,
    [volunteerId]
  );
  const servicePoints = Number(pointsResult.rows[0].service_points);
  const noShowCount = Number(pointsResult.rows[0].no_show_count);

  const manualResult = await client.query(
    `SELECT COALESCE(SUM(change_amount), 0) as manual_points
     FROM points_logs
     WHERE volunteer_id = $1 AND related_type <> 'service_record'`,
    [volunteerId]
  );
  const manualPoints = Number(manualResult.rows[0].manual_points);

  const totalPoints = Math.max(
    0,
    Math.round(servicePoints - noShowCount * calculateNoShowPenalty() + manualPoints)
  );

  const countResult = await client.query(
    `SELECT COUNT(*) as count
     FROM service_records
     WHERE volunteer_id = $1
       AND is_no_show = false
       AND status = 'valid'`,
    [volunteerId]
  );
  const serviceCount = Number(countResult.rows[0].count);

  let level = 1;
  if (totalPoints >= 1000) {
    level = 5;
  } else if (totalPoints >= 600) {
    level = 4;
  } else if (totalPoints >= 300) {
    level = 3;
  } else if (totalPoints >= 100) {
    level = 2;
  }

  await client.query(
    `UPDATE volunteers
     SET total_points = $1, level = $2, service_count = $3
     WHERE id = $4`,
    [totalPoints, level, serviceCount, volunteerId]
  );

  const revokedBadgesResult = await client.query(
    `DELETE FROM badges
     WHERE volunteer_id = $1 AND star_level > $2
     RETURNING *`,
    [volunteerId, level]
  );

  const badgesAwarded: any[] = [];
  for (let starLevel = 2; starLevel <= level; starLevel++) {
    const insertResult = await client.query(
      `INSERT INTO badges (volunteer_id, star_level, badge_name, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (volunteer_id, star_level) DO NOTHING
       RETURNING *`,
      [volunteerId, starLevel, BADGE_NAMES[starLevel], BADGE_DESCRIPTIONS[starLevel]]
    );
    if (insertResult.rows[0]) {
      badgesAwarded.push(insertResult.rows[0]);
    }
  }

  return {
    totalPoints,
    serviceCount,
    level,
    oldLevel,
    badgesAwarded,
    badgesRevoked: revokedBadgesResult.rows,
  };
};

/** 某人某天（记录日期）的工时上限与已使用情况，供接口返回重算结果 */
export const getVolunteerDayCapSummary = async (
  client: PoolClient,
  volunteerId: string
): Promise<{
  dailyLimit: number;
  days: Array<{
    recordDate: string;
    validHours: number;
    overtimeHours: number;
    revokedHours: number;
    recordCount: number;
  }>;
}> => {
  const result = await client.query(
    `SELECT
       to_char(recorded_at::date, 'YYYY-MM-DD') as record_date,
       COALESCE(SUM(CASE WHEN status = 'valid' THEN valid_hours ELSE 0 END), 0) as valid_hours,
       COALESCE(SUM(CASE WHEN status IN ('valid', 'overtime') THEN overtime_hours ELSE 0 END), 0) as overtime_hours,
       COALESCE(SUM(CASE WHEN status = 'revoked' THEN duration_hours ELSE 0 END), 0) as revoked_hours,
       COUNT(*) as record_count
     FROM service_records
     WHERE volunteer_id = $1 AND is_no_show = false
     GROUP BY recorded_at::date
     ORDER BY recorded_at::date DESC`,
    [volunteerId]
  );

  return {
    dailyLimit: DAILY_VALID_HOURS_LIMIT,
    days: result.rows.map((row) => ({
      recordDate: row.record_date,
      validHours: round2(Number(row.valid_hours)),
      overtimeHours: round2(Number(row.overtime_hours)),
      revokedHours: round2(Number(row.revoked_hours)),
      recordCount: Number(row.record_count),
    })),
  };
};
