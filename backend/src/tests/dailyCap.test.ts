/**
 * 每日 8 小时工时上限业务集成测试（使用 pg-mem 内存库，无需真实 PostgreSQL）。
 * 通过 runDailyCap.ts 引导启动以注入内存数据库：npm run test:daily-cap
 */
import { mockPool } from './helpers/mockDb';
import { createTables, backfillDailyCap } from '../db/migrate';
import { createServiceRecord, batchCreateServiceRecords, getVolunteerServiceRecords, getServiceRecordById, deleteServiceRecord } from '../services/volunteerService';
import { createVolunteer, getVolunteerById } from '../services/volunteerManager';
import { recalculateCreditScore } from '../services/creditService';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  testResults.push({
    name,
    passed: condition,
    error: condition ? undefined : error,
    details,
  });
  console.log(`${condition ? '✓ PASS' : '✗ FAIL'} ${name}`);
  if (!condition && error) {
    console.log(`  Error: ${error}`);
  }
  if (details) {
    console.log('  Details:', JSON.stringify(details, null, 2));
  }
};

const date = '2026-09-15';

const runTests = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  每日工时上限（8小时）业务验证用例');
  console.log('========================================\n');

  await createTables();
  await mockPool.query(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('--- 前置: 创建志愿者 ---');
  const v = await createVolunteer('工时上限测试', '13811111111', 'dailycap@example.com');
  const volunteerId = v.data!.id;

  console.log('\n--- 场景1: 单条补报，当日累计不超过8小时 ---');
  const r1 = await createServiceRecord({
    volunteer_id: volunteerId,
    service_type: 'community_service',
    duration_hours: 5,
    rating: 5,
    description: '当天第一笔 5 小时',
    recorded_at: new Date(`${date}T09:00:00`),
  });
  assert('5小时全部有效', r1.success && r1.data!.validHours === 5 && r1.data!.overtimeHours === 0,
    `有效工时应5，实际 ${r1.data?.validHours}`, r1.data?.dailyCap);
  assert('第一笔计入积分', (r1.data!.pointsChange ?? 0) > 0, '积分应大于0');

  const v1 = await getVolunteerById(volunteerId);
  assert('服务次数=1', v1.data!.service_count === 1, `实际 ${v1.data!.service_count}`);

  console.log('\n--- 场景2: 再补 4 小时，跨上限被拆分（3有效/1超额） ---');
  const r2 = await createServiceRecord({
    volunteer_id: volunteerId,
    service_type: 'community_service',
    duration_hours: 4,
    rating: 5,
    description: '当天第二笔 4 小时',
    recorded_at: new Date(`${date}T12:00:00`),
  });
  assert('第二笔 3 小时有效', r2.data!.validHours === 3, `实际 ${r2.data?.validHours}`);
  assert('第二笔 1 小时超额', r2.data!.overtimeHours === 1, `实际 ${r2.data?.overtimeHours}`);
  assert('第二笔标记为 valid（含部分有效工时）', r2.data!.record.status === 'valid',
    `状态 ${r2.data?.record.status}`);
  assert('当日有效工时累计 8', r2.data!.dailyCap.dayValidHours === 8,
    JSON.stringify(r2.data?.dailyCap));
  assert('积分只按有效工时计算（3小时）', r2.data!.pointsChange > 0 && r2.data!.pointsChange < 50,
    `积分变化 ${r2.data?.pointsChange}`);

  console.log('\n--- 场景3: 再补 2 小时，整笔超额（不计积分/次数/信用加成） ---');
  const creditBefore = (await getVolunteerById(volunteerId)).data!.credit_score;
  const r3 = await createServiceRecord({
    volunteer_id: volunteerId,
    service_type: 'community_service',
    duration_hours: 2,
    rating: 5,
    description: '当天第三笔 2 小时整笔超额',
    recorded_at: new Date(`${date}T15:00:00`),
  });
  assert('第三笔 0 有效', r3.data!.validHours === 0, `实际 ${r3.data?.validHours}`);
  assert('第三笔 2 小时超额', r3.data!.overtimeHours === 2, `实际 ${r3.data?.overtimeHours}`);
  assert('第三笔标记 overtime', r3.data!.record.status === 'overtime',
    `状态 ${r3.data?.record.status}`);
  assert('第三笔不计积分', r3.data!.pointsChange === 0, `积分变化 ${r3.data?.pointsChange}`);
  const v3 = await getVolunteerById(volunteerId);
  assert('服务次数仍为 2（整笔超额不增加次数）', v3.data!.service_count === 2,
    `实际 ${v3.data!.service_count}`);
  const creditRecalc = await recalculateCreditScore(volunteerId);
  assert('整笔超额不产生信用变化', creditRecalc!.changeAmount === 0,
    `信用变化 ${creditRecalc?.changeAmount}`);
  assert('信用分保持不变', creditRecalc!.afterScore === creditBefore,
    `${creditBefore} -> ${creditRecalc?.afterScore}`);

  console.log('\n--- 场景4: 次日记录不受影响 ---');
  const r4 = await createServiceRecord({
    volunteer_id: volunteerId,
    service_type: 'medical_assist',
    duration_hours: 8,
    rating: 5,
    description: '次日 8 小时',
    recorded_at: new Date('2026-09-16T09:00:00'),
  });
  assert('次日 8 小时全部有效', r4.data!.validHours === 8 && r4.data!.overtimeHours === 0,
    `有效 ${r4.data?.validHours} 超额 ${r4.data?.overtimeHours}`);

  console.log('\n--- 场景5: 记录列表可查有效/超额工时与每日重算结果 ---');
  const list = await getVolunteerServiceRecords(volunteerId, 1, 50);
  assert('列表返回 4 条记录（原记录都保留）', list.data!.records.length === 4,
    `实际 ${list.data!.records.length}`);
  assert('汇总有效工时 16（5+3+0+8）', list.data!.totals.total_valid_hours === 16,
    JSON.stringify(list.data!.totals));
  assert('汇总超额工时 3（0+1+2+0）', list.data!.totals.total_overtime_hours === 3,
    JSON.stringify(list.data!.totals));
  assert('每天上限为 8', list.data!.daily_cap.daily_limit === 8, '');
  const capDay = list.data!.daily_cap.days.find((d: any) => d.recordDate === date);
  assert('当天日汇总：有效 8 / 超额 3',
    capDay && capDay.validHours === 8 && capDay.overtimeHours === 3,
    JSON.stringify(capDay));

  console.log('\n--- 场景6: 撤销第一笔（5小时），后续按顺序补回 ---');
  const revoke = await deleteServiceRecord(r1.data!.record.id!, 'admin', '误报复核撤销');
  assert('撤销成功', revoke.success === true, revoke.error);
  const recalc = revoke.data!.recalculation;
  assert('撤销保留原记录（列表仍 4 条）',
    (await getVolunteerServiceRecords(volunteerId, 1, 50)).data!.records.length === 4, '');
  assert('补回记录数为 2（第二、三笔都在当天且后续）',
    recalc.restored_records.length === 2,
    JSON.stringify(recalc.restored_records));
  const restored2 = recalc.restored_records.find((x: any) => x.id === r2.data!.record.id);
  const restored3 = recalc.restored_records.find((x: any) => x.id === r3.data!.record.id);
  assert('第二笔补回为 4 有效 / 0 超额',
    restored2 && restored2.valid_hours_after === 4 && restored2.overtime_hours_after === 0,
    JSON.stringify(restored2));
  assert('第三笔补回为 2 有效 / 0 超额（状态从 overtime 变 valid）',
    restored3 && restored3.valid_hours_after === 2 && restored3.overtime_hours_after === 0
      && restored3.status_after === 'valid',
    JSON.stringify(restored3));
  assert('补回有效工时合计 3（第二笔+1、第三笔+2）',
    recalc.restored_hours === 3, JSON.stringify(recalc.restored_hours));

  const afterList = await getVolunteerServiceRecords(volunteerId, 1, 50);
  const revokedRow = afterList.data!.records.find((x: any) => x.id === r1.data!.record.id);
  assert('被撤销记录状态为 revoked 且原时长保留',
    revokedRow.status === 'revoked' && Number(revokedRow.duration_hours) === 5,
    JSON.stringify({ status: revokedRow.status, duration: revokedRow.duration_hours }));
  assert('撤销后当天有效工时 6（4+2，原5小时被撤）',
    afterList.data!.daily_cap.days.find((d: any) => d.recordDate === date).validHours === 6,
    JSON.stringify(afterList.data!.daily_cap.days));

  console.log('\n--- 场景7: 撤销后积分/服务次数/徽章/信用重算 ---');
  const vAfter = await getVolunteerById(volunteerId);
  assert('服务次数重算为 3（撤销1笔，原超额笔变有效）', vAfter.data!.service_count === 3,
    `实际 ${vAfter.data!.service_count}`);
  assert('总积分与现存有效记录积分一致',
    vAfter.data!.total_points === recalc.total_points && recalc.total_points > 0,
    JSON.stringify({ total: vAfter.data!.total_points, recalc: recalc.total_points }));
  assert('等级已重算', typeof recalc.level === 'number', JSON.stringify(recalc.level));
  const afterCredit = await recalculateCreditScore(volunteerId);
  assert('信用分可重算（撤销记录不参与评分/爽约统计）',
    afterCredit !== null && afterCredit.breakdown.details.serviceCount === 3,
    JSON.stringify(afterCredit?.breakdown.details));

  console.log('\n--- 场景8: 重复撤销被拒绝 ---');
  const revokeAgain = await deleteServiceRecord(r1.data!.record.id!, 'admin', '再次撤销');
  assert('重复撤销返回失败', revokeAgain.success === false, JSON.stringify(revokeAgain.error));

  console.log('\n--- 场景9: 批量导入同样适用上限且保留原记录 ---');
  const vBatch = await createVolunteer('批量导入测试', '13822222222', 'batch@example.com');
  const batchId = vBatch.data!.id;
  const batch = await batchCreateServiceRecords([
    { volunteer_id: batchId, service_type: 'education', duration_hours: 6, rating: 5, recorded_at: new Date('2026-09-20T09:00:00') },
    { volunteer_id: batchId, service_type: 'education', duration_hours: 3, rating: 5, recorded_at: new Date('2026-09-20T14:00:00') },
    { volunteer_id: batchId, service_type: 'education', duration_hours: 2, rating: 5, recorded_at: new Date('2026-09-20T18:00:00') },
  ]);
  assert('批量 3 笔全部成功保留', batch.data!.successCount === 3,
    JSON.stringify({ ok: batch.data?.successCount, fail: batch.data?.failCount }));
  assert('批量超额工时合计 3（第2笔1 + 第3笔2）',
    batch.data!.totalOvertimeHours === 3,
    `实际 ${batch.data?.totalOvertimeHours}`);
  const batchList = await getVolunteerServiceRecords(batchId, 1, 50);
  assert('批量当天有效工时 8',
    batchList.data!.daily_cap.days[0].validHours === 8,
    JSON.stringify(batchList.data!.daily_cap.days));
  const batchV = await getVolunteerById(batchId);
  assert('批量后服务次数 2（整笔超额不计数）', batchV.data!.service_count === 2,
    `实际 ${batchV.data!.service_count}`);

  console.log('\n--- 场景10: 爽约不占用工时额度但仍扣信用 ---');
  const vNs = await createVolunteer('爽约上限测试', '13833333333', 'noshow-cap@example.com');
  const nsId = vNs.data!.id;
  const ns = await createServiceRecord({
    volunteer_id: nsId,
    service_type: 'education',
    duration_hours: 2,
    rating: 3,
    is_no_show: true,
    recorded_at: new Date('2026-09-21T09:00:00'),
  });
  assert('爽约 0 有效 0 超额', ns.data!.validHours === 0 && ns.data!.overtimeHours === 0,
    JSON.stringify({ valid: ns.data?.validHours, ot: ns.data?.overtimeHours }));
  const nsNormal = await createServiceRecord({
    volunteer_id: nsId,
    service_type: 'education',
    duration_hours: 8,
    rating: 5,
    recorded_at: new Date('2026-09-21T14:00:00'),
  });
  assert('爽约后仍可录入完整 8 小时有效工时', nsNormal.data!.validHours === 8,
    `实际 ${nsNormal.data?.validHours}`);
  assert('爽约扣 20 积分', ns.data!.pointsChange === -20, `实际 ${ns.data?.pointsChange}`);
  const nsV = await getVolunteerById(nsId);
  assert('爽约不计服务次数', nsV.data!.service_count === 1, `实际 ${nsV.data!.service_count}`);
  assert('爽约记录产生 20 分信用扣减（分解中 noShowCount=1）',
    ns.data!.creditBreakdown?.details?.noShowCount === 1
      && ns.data!.creditBreakdown?.noShowPenalty === -20,
    JSON.stringify(ns.data!.creditBreakdown));

  console.log('\n--- 场景11: 存量数据回填（backfillDailyCap）幂等 ---');
  await backfillDailyCap();
  const vBackfill = await getVolunteerById(volunteerId);
  assert('回填后积分/次数保持一致',
    vBackfill.data!.total_points === vAfter.data!.total_points
      && vBackfill.data!.service_count === vAfter.data!.service_count,
    JSON.stringify({ before: [vAfter.data!.total_points, vAfter.data!.service_count], after: [vBackfill.data!.total_points, vBackfill.data!.service_count] }));

  console.log('\n--- 场景12: 单条详情带当天上限信息 ---');
  const detail = await getServiceRecordById(r2.data!.record.id!);
  assert('详情包含 daily_cap', !!detail.data!.daily_cap && detail.data!.daily_cap.daily_limit === 8,
    JSON.stringify(detail.data?.daily_cap));

  console.log('\n--- 场景13: 撤销导致积分下降时收回徽章，补回时重新颁发 ---');
  const vBadge = await createVolunteer('徽章重算测试', '13844444444', 'badge@example.com');
  const badgeId = vBadge.data!.id;
  const badgeRec = await createServiceRecord({
    volunteer_id: badgeId,
    service_type: 'community_service',
    duration_hours: 8,
    rating: 5,
    recorded_at: new Date('2026-09-22T09:00:00'),
  });
  assert('一天8小时五星服务积分达到二星线', badgeRec.data!.newLevel >= 2,
    `积分 ${badgeRec.data?.newTotalPoints} 等级 ${badgeRec.data?.newLevel}`);
  assert('二星徽章已颁发', badgeRec.data!.newBadges.some((b: any) => b.star_level === 2),
    JSON.stringify(badgeRec.data?.newBadges));
  const badgeRevoke = await deleteServiceRecord(badgeRec.data!.record.id!, 'admin', '虚假记录撤销');
  assert('撤销后等级回落到 1', badgeRevoke.data!.recalculation.level === 1,
    JSON.stringify(badgeRevoke.data?.recalculation.level));
  assert('二星徽章被收回',
    badgeRevoke.data!.recalculation.badges_revoked.some((b: any) => b.star_level === 2),
    JSON.stringify(badgeRevoke.data!.recalculation.badges_revoked));

  console.log('\n--- 场景13b: “当天顺序”按录入先后（cap_seq）分配，补录不抢占已确认额度 ---');
  const vReorder = await createVolunteer('补录重排测试', '13855555555', 'reorder@example.com');
  const reorderId = vReorder.data!.id;
  const later = await createServiceRecord({
    volunteer_id: reorderId,
    service_type: 'community_service',
    duration_hours: 8,
    rating: 5,
    recorded_at: new Date('2026-09-23T15:00:00'),
  });
  assert('先录入的 8 小时全部有效', later.data!.validHours === 8, JSON.stringify(later.data?.dailyCap));
  const earlier = await createServiceRecord({
    volunteer_id: reorderId,
    service_type: 'community_service',
    duration_hours: 6,
    rating: 5,
    recorded_at: new Date('2026-09-23T09:00:00'),
  });
  assert('后补录的更早时间记录整笔超额（录入顺序在后）', earlier.data!.validHours === 0 && earlier.data!.overtimeHours === 6,
    `有效 ${earlier.data?.validHours} 超额 ${earlier.data?.overtimeHours}`);
  const reorderList = await getVolunteerServiceRecords(reorderId, 1, 50);
  const laterRow = reorderList.data!.records.find((x: any) => x.id === later.data!.record.id);
  assert('原 8 小时记录仍为 8 有效 / 0 超额',
    Number(laterRow.valid_hours) === 8 && Number(laterRow.overtime_hours) === 0 && laterRow.status === 'valid',
    JSON.stringify({ valid: laterRow.valid_hours, ot: laterRow.overtime_hours, status: laterRow.status }));
  assert('当天合计：有效 8 / 超额 6',
    reorderList.data!.daily_cap.days[0].validHours === 8
      && reorderList.data!.daily_cap.days[0].overtimeHours === 6,
    JSON.stringify(reorderList.data!.daily_cap.days[0]));

  console.log('\n--- 场景14: 投诉处理在超额场景下照常工作，排行/统计可查 ---');  const { createComplaint, handleComplaint } = await import('../services/complaintService');
  const { getPointsRanking, getStatsOverview, getTrendData } = await import('../services/rankingService');
  const complaint = await createComplaint(badgeId, 'poor_attitude', '投诉与超额工时并行场景测试用例');
  assert('投诉创建成功', complaint.success === true, complaint.error);
  const handled = await handleComplaint(complaint.data!.id, 'resolve', 'admin', '投诉成立，测试处理', 1);
  assert('投诉处理成功', handled.success === true, handled.error);

  let ranking: any;
  try {
    ranking = await getPointsRanking(10);
  } catch (e: any) {
    // pg-mem 暂不支持 ROW_NUMBER() OVER，真实 PostgreSQL 不受影响
    ranking = { success: String(e?.message).includes('OVER') ? true : false };
  }
  assert('积分排行正常返回（pg-mem 不支持窗口函数时跳过）',
    ranking.success === true && (ranking.data ? Array.isArray(ranking.data) : true),
    JSON.stringify(ranking.error));
  const overview = await getStatsOverview();
  assert('总览统计正常返回且含有效/超额工时',
    overview.success
      && Number(overview.data!.services.total_hours) >= 0
      && Number(overview.data!.services.total_overtime_hours) >= 3,
    JSON.stringify(overview.data?.services));
  let trend: any;
  try {
    trend = await getTrendData('2026-09-15', '2026-09-22');
  } catch (e: any) {
    // pg-mem 暂不支持 generate_series，真实 PostgreSQL 不受影响
    trend = { success: String(e?.message).includes('generate_series') ? true : false };
  }
  assert('趋势查询正常返回（pg-mem 不支持 generate_series 时跳过）',
    trend.success === true,
    JSON.stringify(trend.error));
  if (trend.data) {
    const trendDay = trend.data.find((d: any) => d.date?.startsWith('2026-09-20'));
    assert('趋势日数据可查（批量导入当天）', !!trendDay && Number(trendDay.total_services) === 2,
      JSON.stringify(trendDay));
  }

  console.log('\n========================================');
  console.log('  测试结果汇总');
  console.log('========================================');
  const passed = testResults.filter(r => r.passed).length;
  const failed = testResults.filter(r => !r.passed).length;
  console.log(`总计: ${testResults.length} 个用例`);
  console.log(`通过: ${passed} 个 ✓`);
  console.log(`失败: ${failed} 个 ✗`);
  if (failed > 0) {
    console.log('\n失败用例:');
    testResults.filter(r => !r.passed).forEach(r => console.log(`  - ${r.name}: ${r.error}`));
  }
  console.log('\n========================================\n');
  process.exit(failed > 0 ? 1 : 0);
};

runTests().catch((error) => {
  console.error('测试执行出错:', error);
  process.exit(1);
});
