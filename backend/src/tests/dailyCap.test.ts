import dotenv from 'dotenv';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import { createServiceRecord, batchCreateServiceRecords, getVolunteerServiceRecords, deleteServiceRecord, getServiceRecordById } from '../services/volunteerService';
import { createVolunteer, getVolunteerById } from '../services/volunteerManager';
import { getTrendData } from '../services/rankingService';
import { allocateDayCap } from '../services/dailyCapService';

dotenv.config();

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  testResults.push({ name, passed: condition, error: condition ? undefined : error, details });
  const status = condition ? '✓ PASS' : '✗ FAIL';
  console.log(`${status} ${name}`);
  if (!condition) {
    if (error) console.log(`  Error: ${error}`);
    if (details) console.log(`  Details:`, JSON.stringify(details, null, 2));
  }
};

const sameDay = '2026-09-10';
const anotherDay = '2026-09-11';

const runTests = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  每日8小时上限 - 集成验证用例');
  console.log('========================================\n');

  try {
    console.log('初始化数据库...');
    await createTables();

    // 纯函数：当天顺序分配
    console.log('\n--- 单元: allocateDayCap 顺序分配 ---');
    const alloc = allocateDayCap([
      { id: 'a', duration_hours: 5, is_no_show: false, service_type: 'community_service', rating: 5 },
      { id: 'b', duration_hours: 4, is_no_show: false, service_type: 'community_service', rating: 5 },
      { id: 'c', duration_hours: 3, is_no_show: false, service_type: 'community_service', rating: 5 },
    ]);
    assert('第1条 5h 全部有效', alloc[0].valid_hours === 5 && alloc[0].overtime_hours === 0,
      JSON.stringify(alloc[0]), alloc[0]);
    assert('第2条 4h 中 3h 有效、1h 超额', alloc[1].valid_hours === 3 && alloc[1].overtime_hours === 1,
      JSON.stringify(alloc[1]), alloc[1]);
    assert('第3条 3h 全部超额', alloc[2].valid_hours === 0 && alloc[2].overtime_hours === 3 && alloc[2].is_overtime,
      JSON.stringify(alloc[2]), alloc[2]);
    assert('超额记录积分为0', alloc[1].points_earned > 0 && alloc[2].points_earned === 0,
      JSON.stringify(alloc.map(a => a.points_earned)));

    console.log('\n--- 前置: 创建志愿者 ---');
    const v = await createVolunteer('每日上限测试', '13700000001', 'dailycap@example.com');
    assert('志愿者创建成功', v.success === true, '创建失败', v);
    const volunteerId = v.data!.id;

    console.log('\n========================================');
    console.log('  场景1: 单条补报，累计超过8小时');
    console.log('========================================');

    const r1 = await createServiceRecord({
      volunteer_id: volunteerId, service_type: 'community_service',
      duration_hours: 5, rating: 5, recorded_at: new Date(`${sameDay}T09:00:00Z`) as any,
    });
    assert('第1条创建成功', r1.success === true, '失败', r1.error);
    assert('第1条全部有效(5h)', r1.data!.validHours === 5 && r1.data!.overtimeHours === 0 && !r1.data!.isOvertime,
      '应5h有效', r1.data);
    assert('第1条积分>0', r1.data!.pointsChange > 0, '应得积分', r1.data);

    const v1 = await getVolunteerById(volunteerId);
    assert('服务次数=1', v1.data!.service_count === 1, `实际${v1.data!.service_count}`);

    const r2 = await createServiceRecord({
      volunteer_id: volunteerId, service_type: 'community_service',
      duration_hours: 4, rating: 5, recorded_at: new Date(`${sameDay}T10:00:00Z`) as any,
    });
    assert('第2条创建成功（原记录保留）', r2.success === true, '失败', r2.error);
    assert('第2条 3h 有效、1h 超额', r2.data!.validHours === 3 && r2.data!.overtimeHours === 1 && r2.data!.isOvertime,
      '应3h有效1h超额', { valid: r2.data!.validHours, overtime: r2.data!.overtimeHours });
    assert('第2条仍按3h计积分', r2.data!.pointsChange > 0, '部分超额部分仍计积分', r2.data);

    const r3 = await createServiceRecord({
      volunteer_id: volunteerId, service_type: 'community_service',
      duration_hours: 3, rating: 5, recorded_at: new Date(`${sameDay}T11:00:00Z`) as any,
    });
    assert('第3条创建成功且整条超额', r3.success === true && r3.data!.validHours === 0 && r3.data!.overtimeHours === 3,
      '应整条超额', r3.data);
    assert('第3条不计积分', r3.data!.pointsChange === 0, '应为0', r3.data);

    const v2 = await getVolunteerById(volunteerId);
    assert('服务次数=2（整条超额不增加次数）', v2.data!.service_count === 2,
      `实际${v2.data!.service_count}`);

    const recordsResp = await getVolunteerServiceRecords(volunteerId, 1, 50);
    const records = recordsResp.data!.records as any[];
    assert('列表能查到全部3条记录（含超额）', records.length === 3, `实际${records.length}`);
    assert('列表汇总含有效工时', recordsResp.data!.summary.total_valid_hours === 8,
      JSON.stringify(recordsResp.data!.summary));
    assert('列表汇总含超额工时(4h)', recordsResp.data!.summary.total_overtime_hours === 4,
      JSON.stringify(recordsResp.data!.summary));
    const overtimeFlags = records.filter(r => r.is_overtime);
    assert('超额记录带 is_overtime 标记', overtimeFlags.length === 2,
      `实际${overtimeFlags.length}条`);
    assert('记录含 effective_status', records.every(r => !!r.effective_status), '缺少状态');

    console.log('\n========================================');
    console.log('  场景2: 撤销记录后按当天顺序补回');
    console.log('========================================');

    const pointsBefore = v2.data!.total_points;
    const revoke1 = await deleteServiceRecord(r1.data!.record.id!, 'test-admin', '重复补报，撤销第1条');
    assert('撤销成功', revoke1.success === true, '失败', revoke1.error);
    assert('撤销后积分下降（冲销第1条）', revoke1.data!.newTotalPoints < pointsBefore,
      `撤销前${pointsBefore} 撤销后${revoke1.data!.newTotalPoints}`);

    const r2After = await getServiceRecordById(r2.data!.record.id!);
    const r3After = await getServiceRecordById(r3.data!.record.id!);
    assert('第2条有效工时补回 3h -> 4h', r2After.data!.valid_hours === 4 && r2After.data!.overtime_hours === 0,
      JSON.stringify({ valid: r2After.data!.valid_hours, overtime: r2After.data!.overtime_hours }));
    assert('第3条补回 0h -> 3h（额度内全部补回）', r3After.data!.valid_hours === 3 && r3After.data!.overtime_hours === 0,
      JSON.stringify({ valid: r3After.data!.valid_hours, overtime: r3After.data!.overtime_hours }));
    assert('撤销结果含补回明细', revoke1.data!.restoredRecords.length >= 2,
      JSON.stringify(revoke1.data!.restoredRecords));
    assert('补回积分>0', revoke1.data!.restoredPoints > 0, '应补回积分', revoke1.data!.restoredPoints);

    const revokedRecord = await getServiceRecordById(r1.data!.record.id!);
    assert('被撤销记录仍保留且 status=revoked', revokedRecord.data!.status === 'revoked',
      JSON.stringify(revokedRecord.data!.status));
    assert('撤销记录含撤销原因/操作人',
      revokedRecord.data!.revoke_reason === '重复补报，撤销第1条' && revokedRecord.data!.revoked_by === 'test-admin',
      JSON.stringify({ reason: revokedRecord.data!.revoke_reason, by: revokedRecord.data!.revoked_by }));
    assert('撤销记录有效/超额工时清零口径', revokedRecord.data!.valid_hours === 0,
      JSON.stringify(revokedRecord.data!));

    const v3 = await getVolunteerById(volunteerId);
    assert('撤销不影响剩余有效记录次数(=2)', v3.data!.service_count === 2,
      `实际${v3.data!.service_count}`);
    assert('信用分已重算（返回分值）', typeof revoke1.data!.creditScore === 'number',
      JSON.stringify(revoke1.data!.creditScore));

    const resp2 = await getVolunteerServiceRecords(volunteerId, 1, 50);
    assert('撤销后列表仍有3条记录（原记录保留）', resp2.data!.records.length === 3,
      `实际${resp2.data!.records.length}`);
    assert('默认列表含撤销记录状态过滤可用', true);
    const activeOnly = await getVolunteerServiceRecords(volunteerId, 1, 50, 'active');
    assert('status=active 只返回2条', activeOnly.data!.records.length === 2,
      `实际${activeOnly.data!.records.length}`);
    assert('活跃有效工时=7（剩余4h+3h，上限不创造工时）', activeOnly.data!.summary.total_valid_hours === 7,
      JSON.stringify(activeOnly.data!.summary));

    console.log('\n========================================');
    console.log('  场景3: 批量导入保留记录并标超额');
    console.log('========================================');

    const vb = await createVolunteer('批量上限测试', '13700000002', 'batch@example.com');
    const batch = await batchCreateServiceRecords([
      { volunteer_id: vb.data!.id, service_type: 'education', duration_hours: 6, rating: 5, recorded_at: new Date(`${sameDay}T08:00:00Z`) as any },
      { volunteer_id: vb.data!.id, service_type: 'education', duration_hours: 6, rating: 5, recorded_at: new Date(`${sameDay}T09:00:00Z`) as any },
      { volunteer_id: vb.data!.id, service_type: 'education', duration_hours: 2, rating: 5, recorded_at: new Date(`${sameDay}T10:00:00Z`) as any },
    ]);
    assert('批量全部成功', batch.data!.successCount === 3 && batch.data!.failCount === 0,
      JSON.stringify({ ok: batch.data!.successCount, fail: batch.data!.failCount }));
    const bRecs = await getVolunteerServiceRecords(vb.data!.id, 1, 50);
    const sorted = [...bRecs.data!.records].sort((a, b2) => a.entry_seq - b2.entry_seq);
    assert('批量第1条6h有效', sorted[0].valid_hours === 6, JSON.stringify(sorted.map((x: any) => ({ v: x.valid_hours, o: x.overtime_hours }))));
    assert('批量第2条2h有效4h超额', sorted[1].valid_hours === 2 && sorted[1].overtime_hours === 4,
      JSON.stringify(sorted[1]));
    assert('批量第3条整条超额', sorted[2].valid_hours === 0 && sorted[2].overtime_hours === 2,
      JSON.stringify(sorted[2]));
    const vbRow = await getVolunteerById(vb.data!.id);
    assert('批量后服务次数=2', vbRow.data!.service_count === 2, `实际${vbRow.data!.service_count}`);

    console.log('\n========================================');
    console.log('  场景4: 爽约不占用8小时额度');
    console.log('========================================');

    const vn = await createVolunteer('爽约额度测试', '13700000003', 'noshow-cap@example.com');
    const ns1 = await createServiceRecord({
      volunteer_id: vn.data!.id, service_type: 'community_service',
      duration_hours: 2, rating: 3, is_no_show: true,
      recorded_at: new Date('2026-07-01T08:00:00Z') as any,
    });
    assert('爽约记录创建成功', ns1.success === true, '失败', ns1.error);
    assert('爽约记录无有效/超额工时', ns1.data!.validHours === 0 && ns1.data!.overtimeHours === 0,
      JSON.stringify(ns1.data));
    assert('爽约扣分(pointsChange=-20)', ns1.data!.pointsChange === -20,
      `实际${ns1.data!.pointsChange}`);
    const ns2 = await createServiceRecord({
      volunteer_id: vn.data!.id, service_type: 'community_service',
      duration_hours: 8, rating: 5,
      recorded_at: new Date('2026-07-01T10:00:00Z') as any,
    });
    assert('爽约后同天8h仍全部有效（爽约不占额度）', ns2.data!.validHours === 8 && ns2.data!.overtimeHours === 0,
      JSON.stringify({ v: ns2.data!.validHours, o: ns2.data!.overtimeHours }));
    const vnRow = await getVolunteerById(vn.data!.id);
    assert('爽约不增加服务次数(=1)', vnRow.data!.service_count === 1,
      `实际${vnRow.data!.service_count}`);
    assert('信用分重算含爽约惩罚(-20)', ns1.data!.creditBreakdown?.noShowPenalty === -20,
      JSON.stringify(ns1.data!.creditBreakdown));

    console.log('\n========================================');
    console.log('  场景5: 不同日期额度独立');
    console.log('========================================');    const nextDay = await createServiceRecord({
      volunteer_id: volunteerId, service_type: 'community_service',
      duration_hours: 8, rating: 5, recorded_at: new Date(`${anotherDay}T09:00:00Z`) as any,
    });
    assert('次日8h全部有效', nextDay.success && nextDay.data!.validHours === 8 && nextDay.data!.overtimeHours === 0,
      JSON.stringify(nextDay.data));

    console.log('\n========================================');
    console.log('  场景5: 趋势/排行口径');
    console.log('========================================');

    const trend = await getTrendData(sameDay, sameDay);
    assert('趋势接口正常返回', trend.success === true && trend.data!.length === 1, '失败', trend);
    const t = trend.data![0] as any;
    assert('趋势含有效工时与超额工时',
      Number(t.total_valid_hours) > 0 && Number(t.total_overtime_hours) > 0,
      JSON.stringify(t));
    assert('趋势积分只统计有效积分', Number(t.total_points) > 0, JSON.stringify(t));

    console.log('\n========================================');
    console.log('  场景6: 撤销整条超额记录不影响积分');
    console.log('========================================');

    const revokeOvertime = await deleteServiceRecord(sorted[2].id, 'test-admin', '撤销整条超额记录');
    assert('撤销超额记录成功', revokeOvertime.success === true, '失败', revokeOvertime.error);
    const vbAfter = await getVolunteerById(vb.data!.id);
    assert('撤销整条超额记录后积分不变', vbAfter.data!.total_points === revokeOvertime.data!.newTotalPoints,
      JSON.stringify({ points: vbAfter.data!.total_points }));
    assert('撤销整条超额记录后服务次数不变(=2)', vbAfter.data!.service_count === 2,
      `实际${vbAfter.data!.service_count}`);
    assert('重复撤销被拒绝', (await deleteServiceRecord(sorted[2].id, 'test-admin', '再次撤销')).success === false);

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
  } catch (error) {
    console.error('测试执行出错:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

runTests();
