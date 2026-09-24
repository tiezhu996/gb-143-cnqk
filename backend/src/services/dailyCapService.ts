import { PoolClient } from 'pg';
import {
  DAILY_VALID_HOURS_LIMIT,
  DailyCapRecomputeResult,
  RecordPointsChange,
  ServiceRecord,
} from '../types';
import { calculatePointsForValidHours, calculateNoShowPenalty, roundHours } from './pointsCalculator';

interface CapRecordRow {
  id: string;
  duration_hours: string | number;
  valid_hours: string | number | null;
  overtime_hours: string | number | null;
  points_earned: number;
  points_adjustment: number;
  is_no_show: boolean;
  service_type: string;
  rating: number;
  service_date: string;
}

export interface DayAllocationItem {
  id: string;
  valid_hours: number;
  overtime_hours: number;
  points_earned: number;
  points_adjustment: number;
  is_overtime: boolean;
}

const NO_SHOW_PENALTY = calculateNoShowPenalty();

const toHours = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) {
    return 0;
  }
  return typeof value === 'string' ? parseFloat(value) : value;
};

/**
 * 按当天记录顺序（同记录日期按入库先后 entry_seq）重新分配每人每天的有效工时。
 * 爽约记录不占用 8 小时额度，不产生积分，另计爽约扣分（points_adjustment）。
 * 超额部分保留在原记录上，标记为超额，不计积分。
 * 该函数只做计算，不写库。
 */
export const allocateDayCap = (
  records: Array<Pick<ServiceRecord, 'id' | 'is_no_show' | 'service_type' | 'rating'> & { duration_hours: number | string }>,
  limit: number = DAILY_VALID_HOURS_LIMIT
): DayAllocationItem[] => {
  let remaining = limit;

  return records.map((record) => {
    const duration = toHours(record.duration_hours as string | number);

    if (record.is_no_show) {
      return {
        id: record.id!,
        valid_hours: 0,
        overtime_hours: 0,
        points_earned: 0,
        points_adjustment: -NO_SHOW_PENALTY,
        is_overtime: false,
      };
    }

    const validHours = roundHours(Math.min(duration, Math.max(0, remaining)));
    const overtimeHours = roundHours(duration - validHours);
    remaining = roundHours(remaining - validHours);

    return {
      id: record.id!,
      valid_hours: validHours,
      overtime_hours: overtimeHours,
      points_earned: calculatePointsForValidHours(validHours, record.service_type, record.rating),
      points_adjustment: 0,
      is_overtime: overtimeHours > 0,
    };
  });
};

/**
 * 重算某志愿者某一记录日期的每日上限分配，并把结果写回 service_records。
 * 返回每条记录的积分/工时变化（仅包含发生变化的记录）。
 * points_change = 有效工时积分 + 调整项（爽约扣分）的合计变化。
 */
export const recomputeDailyCap = async (
  client: PoolClient,
  volunteerId: string,
  serviceDate: string
): Promise<DailyCapRecomputeResult> => {
  const recordsResult = await client.query(
    `SELECT
       id,
       duration_hours,
       valid_hours,
       overtime_hours,
       points_earned,
       points_adjustment,
       is_no_show,
       service_type,
       rating,
       recorded_at::date::text as service_date
     FROM service_records
     WHERE volunteer_id = $1
       AND recorded_at::date = $2::date
       AND status = 'active'
     ORDER BY entry_seq ASC, created_at ASC, recorded_at ASC
     FOR UPDATE`,
    [volunteerId, serviceDate]
  );

  const rows = recordsResult.rows as CapRecordRow[];
  const allocation = allocateDayCap(rows);

  const recordChanges: RecordPointsChange[] = [];
  const updatedRecordIds: string[] = [];
  let totalPointsChange = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const next = allocation[i];
    const oldPoints = row.points_earned || 0;
    const oldAdjustment = row.points_adjustment || 0;
    const oldValidHours = roundHours(toHours(row.valid_hours));
    const oldOvertimeHours = roundHours(toHours(row.overtime_hours));
    const newValidHours = next.valid_hours;
    const newOvertimeHours = next.overtime_hours;
    const newPoints = next.points_earned;
    const newAdjustment = next.points_adjustment;
    const pointsChange = (newPoints + newAdjustment) - (oldPoints + oldAdjustment);

    if (
      pointsChange !== 0 ||
      oldValidHours !== newValidHours ||
      oldOvertimeHours !== newOvertimeHours ||
      oldAdjustment !== newAdjustment
    ) {
      await client.query(
        `UPDATE service_records
         SET valid_hours = $1,
             overtime_hours = $2,
             points_earned = $3,
             points_adjustment = $4,
             is_overtime = $5,
             recalculated_at = CURRENT_TIMESTAMP
         WHERE id = $6`,
        [newValidHours, newOvertimeHours, newPoints, newAdjustment, next.is_overtime, row.id]
      );

      recordChanges.push({
        record_id: row.id,
        service_date: row.service_date,
        old_points: oldPoints + oldAdjustment,
        new_points: newPoints + newAdjustment,
        old_valid_hours: oldValidHours,
        new_valid_hours: newValidHours,
        old_overtime_hours: oldOvertimeHours,
        new_overtime_hours: newOvertimeHours,
        points_change: pointsChange,
      });
      updatedRecordIds.push(row.id);
      totalPointsChange += pointsChange;
    }
  }

  const effectivePointsTotal = allocation.reduce(
    (sum, item) => sum + item.points_earned + item.points_adjustment,
    0
  );

  return {
    updatedRecordIds,
    recordChanges,
    totalPointsChange,
    effectivePointsTotal,
    noShowPenaltyTotal: allocation.reduce(
      (sum, item) => sum + (item.points_adjustment < 0 ? -item.points_adjustment : 0),
      0
    ),
  };
};
