import { PoolClient } from 'pg';
import {
  Volunteer,
  ServiceRecord,
  ApiResponse,
  CreateServiceRecordResult,
  RevokeServiceRecordResult,
  DAILY_VALID_HOURS_LIMIT,
} from '../types';
import pool from '../db/pool';
import { logCreditChange, isCreditLimited, CREDIT_LIMIT_THRESHOLD, recalculateCreditScore } from './creditService';
import { rebuildVolunteerAggregates } from './volunteerAggregateService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

const parseServiceDate = (recordedAt?: Date | string): Date => {
  if (recordedAt) {
    return new Date(recordedAt);
  }
  return new Date();
};

const formatServiceDate = (date: Date): string => {
  return date.toISOString().slice(0, 10);
};

export const createServiceRecord = async (record: ServiceRecord): Promise<ApiResponse<CreateServiceRecordResult>> => {
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

    const serviceDate = parseServiceDate(record.recorded_at);
    const serviceDateText = formatServiceDate(serviceDate);

    // 先落库占位（valid_hours / points 由当天上限重算回填），entry_seq 保证当天顺序稳定
    const insertResult = await client.query(
      `INSERT INTO service_records
         (volunteer_id, service_type, duration_hours, rating, is_no_show,
          location, description, recorded_at, entry_seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamp,
         COALESCE(
           (SELECT MAX(entry_seq) + 1
              FROM service_records
             WHERE volunteer_id = $1 AND recorded_at::date = $8::date),
           1
         ))
       RETURNING *`,
      [
        record.volunteer_id,
        record.service_type,
        record.duration_hours,
        record.rating,
        record.is_no_show || false,
        record.location,
        record.description,
        serviceDate.toISOString(),
      ]
    );

    const newRecord = insertResult.rows[0] as ServiceRecord;

    const rebuild = await rebuildVolunteerAggregates(client, record.volunteer_id, {
      recomputeDates: [serviceDateText],
      emitLogs: true,
      relatedType: 'service_record',
      primaryRecordId: newRecord.id,
      primaryReason: (rec) => rec.is_no_show ? '爽约扣分' : `服务积分: ${rec.service_type}`,
    });

    const storedRecordResult = await client.query(
      'SELECT * FROM service_records WHERE id = $1',
      [newRecord.id]
    );
    const storedRecord = storedRecordResult.rows[0] as ServiceRecord;
    const ownChange = rebuild.recordChanges.find(c => c.record_id === newRecord.id);

    await client.query('COMMIT');

    const creditResult = await recalculateCreditScore(volunteer.id);
    if (creditResult && creditResult.changeAmount !== 0) {
      await logCreditChange(
        volunteer.id,
        creditResult.changeAmount,
        record.is_no_show ? '服务爽约-信用分重算' : `完成服务-信用分重算: ${record.service_type}`,
        creditResult.beforeScore,
        creditResult.afterScore,
        newRecord.id,
        'service_record'
      );
    }

    const otherChanges = rebuild.recordChanges.filter(c => c.record_id !== newRecord.id);

    return {
      success: true,
      data: {
        record: storedRecord,
        pointsChange: ownChange ? ownChange.points_change : 0,
        newTotalPoints: rebuild.newTotalPoints,
        newLevel: rebuild.newLevel,
        newBadges: rebuild.newBadges,
        levelUp: rebuild.newLevel > rebuild.oldLevel,
        creditScore: creditResult ? creditResult.afterScore : volunteer.credit_score,
        creditChange: creditResult ? creditResult.changeAmount : 0,
        creditBreakdown: creditResult?.breakdown,
        validHours: parseFloat(String(storedRecord.valid_hours ?? 0)),
        overtimeHours: parseFloat(String(storedRecord.overtime_hours ?? 0)),
        isOvertime: Boolean(storedRecord.is_overtime),
        dailyLimit: DAILY_VALID_HOURS_LIMIT,
        recompute: {
          recordChanges: otherChanges,
          totalPointsChange: otherChanges.reduce((sum, c) => sum + c.points_change, 0),
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

  // 批量导入保持数组顺序逐条入库，每条都会按当天顺序参与 8 小时上限分配
  for (const record of records) {
    const result = await createServiceRecord(record);
    if (result.success) {
      successCount++;
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
      results,
    },
  };
};

const buildRecordsSummary = async (
  client: PoolClient,
  volunteerId: string
): Promise<any> => {
  const result = await client.query(
    `SELECT
       COUNT(*) as total_records,
       COUNT(*) FILTER (WHERE status = 'active') as active_records,
       COUNT(*) FILTER (WHERE status = 'revoked') as revoked_records,
       COUNT(*) FILTER (WHERE status = 'active' AND is_overtime = true) as overtime_records,
       COALESCE(SUM(CASE WHEN status = 'active' THEN valid_hours ELSE 0 END), 0) as total_valid_hours,
       COALESCE(SUM(CASE WHEN status = 'active' THEN overtime_hours ELSE 0 END), 0) as total_overtime_hours,
       COALESCE(SUM(CASE WHEN status = 'active' THEN duration_hours ELSE 0 END), 0) as total_duration_hours,
       COALESCE(SUM(CASE WHEN status = 'active' THEN points_earned ELSE 0 END), 0) as total_valid_points
     FROM service_records
     WHERE volunteer_id = $1`,
    [volunteerId]
  );
  const row = result.rows[0];
  return {
    daily_valid_hours_limit: DAILY_VALID_HOURS_LIMIT,
    total_records: parseInt(row.total_records, 10),
    active_records: parseInt(row.active_records, 10),
    revoked_records: parseInt(row.revoked_records, 10),
    overtime_records: parseInt(row.overtime_records, 10),
    total_valid_hours: parseFloat(row.total_valid_hours),
    total_overtime_hours: parseFloat(row.total_overtime_hours),
    total_duration_hours: parseFloat(row.total_duration_hours),
    total_valid_points: parseInt(row.total_valid_points, 10),
  };
};

export const getVolunteerServiceRecords = async (
  volunteerId: string,
  page: number = 1,
  pageSize: number = 20,
  status?: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;
    const filters = ['volunteer_id = $1'];
    const params: any[] = [volunteerId];

    if (status === 'active' || status === 'revoked') {
      filters.push(`status = $${params.length + 1}`);
      params.push(status);
    }

    const whereClause = filters.join(' AND ');

    const countResult = await client.query(
      `SELECT COUNT(*) as total FROM service_records WHERE ${whereClause}`,
      params
    );

    const recordsResult = await client.query(
      `SELECT sr.*,
              sr.valid_hours::float8 as valid_hours,
              sr.overtime_hours::float8 as overtime_hours,
              sr.duration_hours::float8 as duration_hours,
              sr.recorded_at::date::text as service_date,
              CASE
                WHEN sr.is_no_show = true THEN 'no_show'
                WHEN sr.status = 'revoked' THEN 'revoked'
                WHEN sr.overtime_hours > 0 AND sr.valid_hours > 0 THEN 'partial_overtime'
                WHEN sr.valid_hours = 0 AND sr.overtime_hours > 0 THEN 'overtime'
                ELSE 'valid'
              END as effective_status
       FROM service_records sr
       WHERE ${whereClause}
       ORDER BY sr.recorded_at DESC, sr.entry_seq DESC, sr.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );

    const summary = await buildRecordsSummary(client, volunteerId);

    return {
      success: true,
      data: {
        records: recordsResult.rows,
        summary,
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
      `SELECT *,
              valid_hours::float8 as valid_hours,
              overtime_hours::float8 as overtime_hours,
              duration_hours::float8 as duration_hours,
              recorded_at::date::text as service_date
       FROM service_records WHERE id = $1`,
      [recordId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.volunteers.serviceRecordNotFound };
    }

    return { success: true, data: result.rows[0] };
  } finally {
    client.release();
  }
};

/**
 * 撤销（软删除）一条服务记录：
 * 原记录保留并标记为 revoked；按当天顺序把后续记录的有效工时补回，
 * 并重算积分、等级、徽章、服务次数与信用分。
 */
export const deleteServiceRecord = async (
  recordId: string,
  adminId: string,
  reason: string
): Promise<ApiResponse<RevokeServiceRecordResult>> => {
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

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
      [record.volunteer_id]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const serviceDateText = formatServiceDate(new Date(record.recorded_at!));
    const oldContribution = (record.points_earned || 0) + (record.points_adjustment || 0);

    // 原记录保留，仅标记撤销；不再参与每日上限分配
    await client.query(
      `UPDATE service_records
       SET status = 'revoked',
           revoked_at = CURRENT_TIMESTAMP,
           revoked_by = $1,
           revoke_reason = $2,
           valid_hours = 0,
           overtime_hours = duration_hours,
           points_earned = 0,
           points_adjustment = 0,
           is_overtime = false,
           recalculated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [adminId, reason, recordId]
    );

    // 撤销记录冲销其自身此前的积分贡献；流水排在当天补回记录之前
    const revokeExtraChange = oldContribution !== 0 ? [{
      record_id: recordId,
      service_date: serviceDateText,
      old_points: oldContribution,
      new_points: 0,
      old_valid_hours: parseFloat(String(record.valid_hours ?? 0)),
      new_valid_hours: 0,
      old_overtime_hours: parseFloat(String(record.overtime_hours ?? 0)),
      new_overtime_hours: parseFloat(String(record.duration_hours ?? 0)),
      points_change: -oldContribution,
      entry_seq: (record.entry_seq || 1) - 0.5,
      log_reason: `管理员撤销记录-冲销原积分: ${reason}`,
    }] : [];

    const rebuild = await rebuildVolunteerAggregates(client, record.volunteer_id, {
      recomputeDates: [serviceDateText],
      emitLogs: true,
      relatedType: 'admin_delete',
      extraChanges: revokeExtraChange,
    });

    const revokedRecordResult = await client.query(
      'SELECT * FROM service_records WHERE id = $1',
      [recordId]
    );

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, 'revoke', 'service_record', $2, $3, $4, $5)`,
      [
        adminId,
        recordId,
        {
          status: 'active',
          points_earned: record.points_earned,
          valid_hours: record.valid_hours,
          overtime_hours: record.overtime_hours,
        },
        { status: 'revoked' },
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
        'admin_delete'
      );
    }

    const restoredRecords = rebuild.recordChanges
      .filter(c => c.record_id !== recordId && c.points_change > 0)
      .map(c => ({
        ...c,
        restored_points: c.points_change,
      }));
    const restoredPoints = restoredRecords.reduce((sum, c) => sum + c.restored_points, 0);

    return {
      success: true,
      message: messages.volunteers.serviceRecordDeleted,
      data: {
        record: revokedRecordResult.rows[0],
        oldTotalPoints: rebuild.oldTotalPoints,
        newTotalPoints: rebuild.newTotalPoints,
        pointsChange: rebuild.pointsChange,
        oldLevel: rebuild.oldLevel,
        newLevel: rebuild.newLevel,
        oldServiceCount: rebuild.oldServiceCount,
        newServiceCount: rebuild.newServiceCount,
        newBadges: rebuild.newBadges,
        removedBadgeLevels: rebuild.removedBadgeLevels,
        restoredRecords,
        restoredPoints,
        creditScore: creditResult ? creditResult.afterScore : volunteerResult.rows[0].credit_score,
        creditChange: creditResult ? creditResult.changeAmount : 0,
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
