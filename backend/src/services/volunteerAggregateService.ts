import { PoolClient } from 'pg';
import {
  RecordPointsChange,
  ServiceRecord,
  Volunteer,
  VolunteerRebuildResult,
  Badge,
} from '../types';
import { calculateLevel, checkNewBadges } from './badgeService';
import { recomputeDailyCap } from './dailyCapService';

interface RebuildOptions {
  // 需要重新分配每日上限的记录日期（YYYY-MM-DD）
  recomputeDates?: string[];
  // 是否写入积分流水
  emitLogs?: boolean;
  // 流水关联类型
  relatedType?: string;
  // 触发本次重算的记录ID（该记录的流水使用 primaryReason）
  primaryRecordId?: string;
  primaryReason?: (record: ServiceRecord, change: RecordPointsChange) => string;
  // 不参与每日上限重算、但需要计入本次积分增量的变更（如撤销记录冲销自身贡献）
  extraChanges?: RecordPointsChange[];
}

/**
 * 依据全部有效（active）服务记录重建志愿者汇总数据：
 * total_points、service_count、level、徽章。
 *
 * 管理员调整与投诉扣分不体现在 service_records 中，因此按
 * 「当前积分 + 记录积分增量」做增量修正，保留这些调整。
 */
export const rebuildVolunteerAggregates = async (
  client: PoolClient,
  volunteerId: string,
  options: RebuildOptions = {}
): Promise<VolunteerRebuildResult> => {
  const {
    recomputeDates = [],
    emitLogs = false,
    relatedType = 'service_record',
    primaryRecordId,
    primaryReason,
    extraChanges = [],
  } = options;

  const volunteerResult = await client.query(
    'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
    [volunteerId]
  );

  if (volunteerResult.rows.length === 0) {
    throw new Error('volunteer_not_found');
  }

  const volunteer = volunteerResult.rows[0] as Volunteer;
  const oldTotalPoints = volunteer.total_points;
  const oldLevel = volunteer.level;
  const oldServiceCount = volunteer.service_count;

  const allRecordChanges: RecordPointsChange[] = [];
  const allUpdatedRecordIds: string[] = [];

  const uniqueDates = Array.from(new Set(recomputeDates));
  for (const serviceDate of uniqueDates) {
    const result = await recomputeDailyCap(client, volunteerId, serviceDate);
    allRecordChanges.push(...result.recordChanges);
    allUpdatedRecordIds.push(...result.updatedRecordIds);
  }

  const pointsDeltaFromRecords = allRecordChanges.reduce(
    (sum, change) => sum + change.points_change,
    0
  ) + extraChanges.reduce((sum, change) => sum + change.points_change, 0);

  // 超额记录（有效工时为 0）不计入服务次数；部分超额的整条仍算一次
  const countResult = await client.query(
    `SELECT COUNT(*) as service_count
     FROM service_records
     WHERE volunteer_id = $1
       AND status = 'active'
       AND is_no_show = false
       AND valid_hours > 0`,
    [volunteerId]
  );
  const newServiceCount = parseInt(countResult.rows[0].service_count, 10);

  const newTotalPoints = Math.max(0, oldTotalPoints + pointsDeltaFromRecords);
  const newLevel = calculateLevel(newTotalPoints);

  await client.query(
    `UPDATE volunteers
     SET total_points = $1,
         level = $2,
         service_count = $3
     WHERE id = $4`,
    [newTotalPoints, newLevel, newServiceCount, volunteerId]
  );

  // 积分流水：按日期与当天顺序逐条记录，保证流水余额连续可审计
  if (emitLogs) {
    const changesToLog = [...allRecordChanges, ...extraChanges];
    const recordSeqMap = new Map<string, number>();
    if (changesToLog.length > 0) {
      const seqResult = await client.query(
        'SELECT id, entry_seq FROM service_records WHERE id = ANY($1::uuid[])',
        [changesToLog.map(c => c.record_id)]
      );
      seqResult.rows.forEach((r: { id: string; entry_seq: number }) =>
        recordSeqMap.set(r.id, r.entry_seq)
      );
    }

    const orderedChanges = [...changesToLog].sort((a, b) => {
      if (a.service_date !== b.service_date) {
        return a.service_date < b.service_date ? -1 : 1;
      }
      const seqA = a.entry_seq ?? recordSeqMap.get(a.record_id) ?? 0;
      const seqB = b.entry_seq ?? recordSeqMap.get(b.record_id) ?? 0;
      return seqA - seqB;
    });

    let runningTotal = oldTotalPoints;

    for (const change of orderedChanges) {
      if (change.points_change === 0) {
        continue;
      }

      const before = runningTotal;
      const after = Math.max(0, before + change.points_change);
      runningTotal = after;

      let reason: string;
      if (change.log_reason) {
        reason = change.log_reason;
      } else if (change.record_id === primaryRecordId && primaryReason) {
        const recordResult = await client.query(
          'SELECT * FROM service_records WHERE id = $1',
          [change.record_id]
        );
        reason = primaryReason(recordResult.rows[0] as ServiceRecord, change);
      } else {
        reason = `每日8小时上限重算: ${change.service_date}`;
      }

      await client.query(
        `INSERT INTO points_logs
           (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          volunteerId,
          change.points_change,
          reason,
          before,
          after,
          change.record_id,
          relatedType,
        ]
      );
    }
  }

  // 徽章对账：升级补发，降级收回（UNIQUE 约束保证每级一枚）
  const newBadges: Badge[] = [];
  const removedBadgeLevels: number[] = [];

  if (newLevel > oldLevel) {
    const currentBadgesResult = await client.query(
      'SELECT * FROM badges WHERE volunteer_id = $1',
      [volunteerId]
    );
    const awarded = await checkNewBadges(volunteerId, newLevel, currentBadgesResult.rows, client);
    newBadges.push(...awarded);
  } else if (newLevel < oldLevel) {
    const removeResult = await client.query(
      `DELETE FROM badges
       WHERE volunteer_id = $1 AND star_level > $2
       RETURNING star_level`,
      [volunteerId, newLevel]
    );
    removedBadgeLevels.push(
      ...removeResult.rows.map((r: { star_level: number }) => r.star_level)
    );
  }

  const contributionResult = await client.query(
    `SELECT
       COALESCE(SUM(points_earned), 0) as earned_total,
       COALESCE(SUM(points_adjustment), 0) as adjustment_total
     FROM service_records
     WHERE volunteer_id = $1 AND status = 'active'`,
    [volunteerId]
  );

  return {
    oldTotalPoints,
    newTotalPoints,
    pointsChange: newTotalPoints - oldTotalPoints,
    oldLevel,
    newLevel,
    oldServiceCount,
    newServiceCount,
    newBadges,
    removedBadgeLevels,
    effectivePointsTotal: parseInt(contributionResult.rows[0].earned_total, 10),
    noShowPenaltyTotal: Math.abs(parseInt(contributionResult.rows[0].adjustment_total, 10)),
    recordChanges: allRecordChanges,
    updatedRecordIds: allUpdatedRecordIds,
  };
};
