import { calculatePoints } from './pointsCalculator';
import { serviceRules } from '../constants/serviceConfig';

export const DAILY_VALID_HOURS_LIMIT = serviceRules.dailyValidHoursLimit;

export interface DailyCapRow {
  id: string;
  duration_hours: number | string;
  is_no_show: boolean;
  service_type: string;
  rating: number;
}

export interface DailyCapAllocation {
  validHours: number;
  overtimeHours: number;
  pointsEarned: number;
  isOvertime: boolean;
}

export const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * 按当天记录顺序（cap_seq / 录入先后）分配每人每天的有效工时，
 * 累计超过 DAILY_VALID_HOURS_LIMIT 的部分记为超额工时。
 * 爽约记录不占用当天工时额度。
 */
export const allocateDay = (
  rows: DailyCapRow[],
  cap: number = DAILY_VALID_HOURS_LIMIT
): Map<string, DailyCapAllocation> => {
  const result = new Map<string, DailyCapAllocation>();
  let remaining = cap;

  for (const row of rows) {
    if (row.is_no_show) {
      result.set(row.id, {
        validHours: 0,
        overtimeHours: 0,
        pointsEarned: 0,
        isOvertime: false,
      });
      continue;
    }

    const duration = round2(Number(row.duration_hours) || 0);
    const validHours = round2(Math.min(duration, Math.max(0, remaining)));
    const overtimeHours = round2(duration - validHours);
    remaining = round2(remaining - validHours);

    const pointsEarned = validHours > 0
      ? calculatePoints(validHours, row.service_type, row.rating)
      : 0;

    result.set(row.id, {
      validHours,
      overtimeHours,
      pointsEarned,
      isOvertime: overtimeHours > 0,
    });
  }

  return result;
};

/** 把 recorded_at 归一化成 YYYY-MM-DD（服务器本地时区），用于按日分组 */
export const toRecordDate = (value?: Date | string | null): string => {
  const date = value ? new Date(value) : new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
