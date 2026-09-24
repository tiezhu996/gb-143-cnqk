import { Volunteer, ServiceRecord, ApiResponse, CreateServiceRecordResult } from '../types';
import pool from '../db/pool';
import { calculateNoShowPenalty } from './pointsCalculator';
import {
  isCreditLimited,
  CREDIT_LIMIT_THRESHOLD,
  recalculateCreditScore,
  logCreditChange,
} from './creditService';
import {
  reallocateVolunteerDays,
  rebuildServicePointsLogs,
  reconcileVolunteerAggregates,
  getVolunteerDayCapSummary,
  RecordCapChange,
} from './dailyCapService';
import { DAILY_VALID_HOURS_LIMIT, round2, toRecordDate } from './dailyCapAllocation';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

export const createServiceRecord = async (
  record: ServiceRecord
): Promise<ApiResponse<CreateServiceRecordResult>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
      [record.volunteer_id]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0] as Volunteer;

    if (isCreditLimited(volunteer.credit_score)) {
      await client.query('ROLLBACK');
      return {
        success: false,
        error: messages.volunteers.creditLimited,
        details: {
          credit_score: volunteer.credit_score,
          credit_limit_threshold: CREDIT_LIMIT_THRESHOLD,
          message: messages.volunteers.creditLimitedDetail(volunteer.credit_score, CREDIT_LIMIT_THRESHOLD)
        }
      };
    }

    const isNoShow = record.is_no_show || false;
    const recordDate = toRecordDate(record.recorded_at);

    const insertResult = await client.query(
      `INSERT INTO service_records
       (volunteer_id, service_type, duration_hours, rating, points_earned, is_no_show,
        location, description, recorded_at, valid_hours, overtime_hours, status)
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7, COALESCE($8, CURRENT_TIMESTAMP), 0, 0,
               CASE WHEN $5 THEN 'no_show' ELSE 'valid' END)
       RETURNING *`,
      [
        record.volunteer_id,
        record.service_type,
        record.duration_hours,
        record.rating,
        isNoShow,
        record.location,
        record.description,
        record.recorded_at || null,
      ]
    );

    const insertedRow = insertResult.rows[0] as ServiceRecord;

    // 统一走“按记录日期 + 当天顺序”的重算引擎：
    // 即使是往已有记录的日期补录更早时间的记录，也会正确重排当天有效/超额工时
    const changes = await reallocateVolunteerDays(client, volunteer.id, [recordDate]);
    const thisChange = changes.find(change => change.record.id === insertedRow.id);
    const cap = thisChange
      ? {
          validHours: thisChange.after.valid_hours,
          overtimeHours: thisChange.after.overtime_hours,
          pointsEarned: thisChange.after.points_earned,
          status: thisChange.after.status,
        }
      : {
          validHours: Number(insertedRow.valid_hours ?? 0),
          overtimeHours: Number(insertedRow.overtime_hours ?? 0),
          pointsEarned: Number(insertedRow.points_earned ?? 0),
          status: (insertedRow.status ?? 'valid') as ServiceRecord['status'],
        };

    const newRecordResult = await client.query(
      'SELECT * FROM service_records WHERE id = $1',
      [insertedRow.id]
    );
    const newRecord = newRecordResult.rows[0] as ServiceRecord;

    await rebuildServicePointsLogs(client, volunteer.id);
    const aggregates = await reconcileVolunteerAggregates(client, volunteer.id);

    const pointsChange = isNoShow ? -calculateNoShowPenalty() : cap.pointsEarned;

    await client.query('COMMIT');

    const creditResult = await recalculateCreditScore(volunteer.id);
    if (creditResult && creditResult.changeAmount !== 0) {
      await logCreditChange(
        volunteer.id,
        creditResult.changeAmount,
        isNoShow
          ? '服务爽约-信用分重算'
          : cap.status === 'overtime'
            ? `完成服务（超额不计信用）-信用分重算: ${record.service_type}`
            : `完成服务-信用分重算: ${record.service_type}`,
        creditResult.beforeScore,
        creditResult.afterScore,
        newRecord.id,
        'service_record'
      );
    }

    const dayTotalsResult = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'valid' THEN valid_hours ELSE 0 END), 0) as day_valid_hours,
         COALESCE(SUM(CASE WHEN status IN ('valid', 'overtime') THEN overtime_hours ELSE 0 END), 0) as day_overtime_hours
       FROM service_records
       WHERE volunteer_id = $1
         AND is_no_show = false
         AND status <> 'revoked'
         AND recorded_at::date = $2::date`,
      [volunteer.id, recordDate]
    );

    return {
      success: true,
      data: {
        record: newRecord,
        pointsChange,
        newTotalPoints: aggregates?.totalPoints ?? volunteer.total_points,
        newLevel: aggregates?.level ?? volunteer.level,
        newBadges: aggregates?.badgesAwarded ?? [],
        levelUp: (aggregates?.level ?? volunteer.level) > volunteer.level,
        creditScore: creditResult ? creditResult.afterScore : volunteer.credit_score,
        creditChange: creditResult ? creditResult.changeAmount : 0,
        creditBreakdown: creditResult?.breakdown,
        validHours: cap.validHours,
        overtimeHours: cap.overtimeHours,
        isOvertime: cap.overtimeHours > 0,
        dailyCap: {
          recordDate,
          dailyLimit: DAILY_VALID_HOURS_LIMIT,
          dayValidHours: round2(Number(dayTotalsResult.rows[0].day_valid_hours)),
          dayOvertimeHours: round2(Number(dayTotalsResult.rows[0].day_overtime_hours)),
        },
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.createServiceRecordFailed, error);
    return { success: false, error: messages.volunteers.serviceRecordCreateFailed };
  } finally {
    client.release();
  }
};

export const batchCreateServiceRecords = async (
  records: ServiceRecord[]
): Promise<ApiResponse<any>> => {
  const results: any[] = [];
  let successCount = 0;
  let failCount = 0;
  let totalOvertimeHours = 0;

  for (const record of records) {
    const result = await createServiceRecord(record);
    if (result.success) {
      successCount++;
      totalOvertimeHours += result.data?.overtimeHours ?? 0;
      results.push(result.data);
    } else {
      failCount++;
      results.push({ error: result.error, record });
    }
  }

  return {
    success: true,
    data: {
      total: records.length,
      successCount,
      failCount,
      totalOvertimeHours: round2(totalOvertimeHours),
      dailyValidHoursLimit: DAILY_VALID_HOURS_LIMIT,
      results,
    },
  };
};

export const getVolunteerServiceRecords = async (
  volunteerId: string,
  page: number = 1,
  pageSize: number = 20,
  filters: { status?: string; recordDate?: string } = {}
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const conditions = ['volunteer_id = $1'];
    const params: any[] = [volunteerId];

    if (filters.status) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filters.recordDate) {
      params.push(filters.recordDate);
      conditions.push(`recorded_at::date = $${params.length}::date`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await client.query(
      `SELECT COUNT(*) as total FROM service_records ${whereClause}`,
      params
    );

    const offset = (page - 1) * pageSize;
    const recordsResult = await client.query(
      `SELECT * FROM service_records
       ${whereClause}
       ORDER BY recorded_at DESC, cap_seq DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );

    const totalsResult = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'valid' THEN valid_hours ELSE 0 END), 0) as total_valid_hours,
         COALESCE(SUM(CASE WHEN status IN ('valid', 'overtime') THEN overtime_hours ELSE 0 END), 0) as total_overtime_hours,
         COALESCE(SUM(CASE WHEN status = 'revoked' THEN duration_hours ELSE 0 END), 0) as total_revoked_hours,
         COUNT(CASE WHEN status = 'valid' THEN 1 END) as valid_count,
         COUNT(CASE WHEN status = 'overtime' THEN 1 END) as overtime_count,
         COUNT(CASE WHEN status = 'no_show' THEN 1 END) as no_show_count,
         COUNT(CASE WHEN status = 'revoked' THEN 1 END) as revoked_count
       FROM service_records
       WHERE volunteer_id = $1`,
      [volunteerId]
    );
    const totals = totalsResult.rows[0];

    const dailyCap = await getVolunteerDayCapSummary(client, volunteerId);

    return {
      success: true,
      data: {
        records: recordsResult.rows,
        totals: {
          total_valid_hours: round2(Number(totals.total_valid_hours)),
          total_overtime_hours: round2(Number(totals.total_overtime_hours)),
          total_revoked_hours: round2(Number(totals.total_revoked_hours)),
          valid_count: Number(totals.valid_count),
          overtime_count: Number(totals.overtime_count),
          no_show_count: Number(totals.no_show_count),
          revoked_count: Number(totals.revoked_count),
        },
        daily_cap: {
          daily_limit: dailyCap.dailyLimit,
          days: dailyCap.days,
        },
        pagination: {
          page,
          page_size: pageSize,
          total: parseInt(countResult.rows[0].total),
          total_pages: Math.ceil(parseInt(countResult.rows[0].total) / pageSize),
        },
      },
    };
  } finally {
    client.release();
  }
};

export const getServiceRecordById = async (
  recordId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      'SELECT * FROM service_records WHERE id = $1',
      [recordId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.volunteers.serviceRecordNotFound };
    }

    const record = result.rows[0] as ServiceRecord;

    const dayResult = await client.query(
      `SELECT
         COALESCE(SUM(valid_hours), 0) as day_valid_hours,
         COALESCE(SUM(overtime_hours), 0) as day_overtime_hours
       FROM service_records
       WHERE volunteer_id = $1
         AND is_no_show = false
         AND status <> 'revoked'
         AND recorded_at::date = $2::date`,
      [record.volunteer_id, toRecordDate(record.recorded_at)]
    );

    return {
      success: true,
      data: {
        ...record,
        daily_cap: {
          record_date: toRecordDate(record.recorded_at),
          daily_limit: DAILY_VALID_HOURS_LIMIT,
          day_valid_hours: round2(Number(dayResult.rows[0].day_valid_hours)),
          day_overtime_hours: round2(Number(dayResult.rows[0].day_overtime_hours)),
        },
      },
    };
  } finally {
    client.release();
  }
};

/**
 * 撤销服务记录（保留原记录，标记为 revoked）：
 * 撤销后按当天记录顺序把释放出的工时额度补回后续记录，
 * 并重算积分、等级、徽章、服务次数与信用分。
 */
export const deleteServiceRecord = async (
  recordId: string,
  adminId: string,
  reason: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const recordResult = await client.query(
      'SELECT * FROM service_records WHERE id = $1 FOR UPDATE',
      [recordId]
    );

    if (recordResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.serviceRecordNotFound };
    }

    const record = recordResult.rows[0] as ServiceRecord;

    if (record.status === 'revoked') {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.serviceRecordAlreadyRevoked };
    }

    await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
      [record.volunteer_id]
    );

    const recordDate = toRecordDate(record.recorded_at);

    await client.query(
      `UPDATE service_records
       SET status = 'revoked',
           revoked_at = CURRENT_TIMESTAMP,
           revoked_by = $1,
           revoke_reason = $2
       WHERE id = $3`,
      [adminId, reason, recordId]
    );

    // 按当天顺序重算有效/超额工时，后续记录的有效工时自动补回
    const changes = await reallocateVolunteerDays(client, record.volunteer_id, [recordDate]);
    await rebuildServicePointsLogs(client, record.volunteer_id);
    const aggregates = await reconcileVolunteerAggregates(client, record.volunteer_id);

    const restoredRecords = changes
      .filter((change: RecordCapChange) => change.after.valid_hours > change.before.valid_hours)
      .map((change: RecordCapChange) => ({
        id: change.record.id,
        service_type: change.record.service_type,
        recorded_at: change.record.recorded_at,
        duration_hours: Number(change.record.duration_hours),
        valid_hours_before: change.before.valid_hours,
        valid_hours_after: change.after.valid_hours,
        overtime_hours_before: change.before.overtime_hours,
        overtime_hours_after: change.after.overtime_hours,
        points_before: change.before.points_earned,
        points_after: change.after.points_earned,
        status_before: change.before.status,
        status_after: change.after.status,
      }));

    const restoredHours = round2(
      restoredRecords.reduce(
        (sum, item) => sum + (item.valid_hours_after - item.valid_hours_before),
        0
      )
    );

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, 'revoke', 'service_record', $2, $3, $4, $5)`,
      [
        adminId,
        recordId,
        record,
        {
          status: 'revoked',
          record_date: recordDate,
          restored_records: restoredRecords,
          restored_hours: restoredHours,
          aggregates,
        },
        reason,
      ]
    );

    await client.query('COMMIT');

    const creditResult = await recalculateCreditScore(record.volunteer_id);
    if (creditResult && creditResult.changeAmount !== 0) {
      await logCreditChange(
        record.volunteer_id,
        creditResult.changeAmount,
        '撤销服务记录-信用分重算',
        creditResult.beforeScore,
        creditResult.afterScore,
        recordId,
        'admin_revoke'
      );
    }

    return {
      success: true,
      message: messages.volunteers.serviceRecordRevoked,
      data: {
        record_id: recordId,
        record_date: recordDate,
        recalculation: {
          restored_hours: restoredHours,
          restored_records: restoredRecords,
          total_points: aggregates?.totalPoints,
          level: aggregates?.level,
          service_count: aggregates?.serviceCount,
          badges_awarded: aggregates?.badgesAwarded ?? [],
          badges_revoked: aggregates?.badgesRevoked ?? [],
        },
        creditScore: creditResult?.afterScore,
        creditChange: creditResult?.changeAmount,
        creditBreakdown: creditResult?.breakdown,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.deleteServiceRecordFailed, error);
    return { success: false, error: messages.volunteers.serviceRecordDeleteFailed };
  } finally {
    client.release();
  }
};
