export const serviceTypes = [
  { type: 'elderly_care', name: '老人陪护', weight: 1.5 },
  { type: 'child_care', name: '儿童关爱', weight: 1.4 },
  { type: 'medical_assist', name: '医疗辅助', weight: 1.6 },
  { type: 'education', name: '教育辅导', weight: 1.3 },
  { type: 'community_service', name: '社区服务', weight: 1.2 },
  { type: 'disaster_relief', name: '救灾援助', weight: 2.0 },
  { type: 'environmental', name: '环保行动', weight: 1.1 },
  { type: 'cultural_activity', name: '文化活动', weight: 1.0 },
  { type: 'other', name: '其他服务', weight: 1.0 },
];

export const badgeLevels = [
  { level: 1, name: '一星志愿者', points_required: 0 },
  { level: 2, name: '二星志愿者', points_required: 100 },
  { level: 3, name: '三星志愿者', points_required: 300 },
  { level: 4, name: '四星志愿者', points_required: 600 },
  { level: 5, name: '五星志愿者', points_required: 1000 },
];

export const serviceRules = {
  pointsPerHour: 10,
  creditLimitThreshold: 30,
  dailyValidHoursLimit: 8,
};

export const apiEndpoints = [
  'GET  /health - 健康检查',
  'GET  /api/v1/service-types - 服务类型配置',
  'GET  /api/v1/volunteers - 创建志愿者',
  'GET  /api/v1/volunteers/:id - 获取志愿者信息',
  'GET  /api/v1/volunteers/:id/summary - 志愿者汇总（含有效/超额工时）',
  'GET  /api/v1/volunteers/:id/badges - 徽章列表',
  'GET  /api/v1/volunteers/:id/points-logs - 积分明细',
  'GET  /api/v1/volunteers/:id/credit-logs - 信用明细',
  'POST /api/v1/service-records - 创建服务记录（按当天8小时上限标记超额）',
  'POST /api/v1/service-records/batch - 批量导入（保留原记录并标记超额）',
  'GET  /api/v1/service-records/volunteer/:volunteerId - 记录列表（有效工时/超额工时/重算结果，支持 status 过滤）',
  'GET  /api/v1/service-records/:id - 记录详情',
  'DELETE /api/v1/service-records/:id - 撤销记录（补回后续记录有效工时并重算）',
  'GET  /api/v1/ranking/points - 积分排行榜',
  'GET  /api/v1/ranking/credit - 信用排行榜',
  'GET  /api/v1/ranking/trend - 趋势数据（含有效/超额工时）',
  'POST /api/v1/complaints - 创建投诉',
  'POST /api/v1/complaints/:id/handle - 处理投诉',
  'POST /api/v1/admin/adjust-points - 调整积分',
  'POST /api/v1/admin/adjust-credit - 调整信用分',
];
