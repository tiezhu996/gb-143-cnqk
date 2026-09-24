export interface ServiceTypeWeight {
  type: string;
  weight: number;
  name: string;
}

export const SERVICE_TYPE_WEIGHTS: ServiceTypeWeight[] = [
  { type: 'elderly_care', weight: 1.5, name: '老人陪护' },
  { type: 'child_care', weight: 1.4, name: '儿童关爱' },
  { type: 'medical_assist', weight: 1.6, name: '医疗辅助' },
  { type: 'education', weight: 1.3, name: '教育辅导' },
  { type: 'community_service', weight: 1.2, name: '社区服务' },
  { type: 'disaster_relief', weight: 2.0, name: '救灾援助' },
  { type: 'environmental', weight: 1.1, name: '环保行动' },
  { type: 'cultural_activity', weight: 1.0, name: '文化活动' },
  { type: 'other', weight: 1.0, name: '其他服务' },
];

export const POINTS_PER_HOUR = 10;

export const DAILY_VALID_HOURS_LIMIT = 8;

export type ServiceRecordStatus = 'active' | 'revoked';

export const LEVEL_THRESHOLDS: Record<number, number> = {
  1: 0,
  2: 100,
  3: 300,
  4: 600,
  5: 1000,
};

export const BADGE_NAMES: Record<number, string> = {
  1: '一星志愿者',
  2: '二星志愿者',
  3: '三星志愿者',
  4: '四星志愿者',
  5: '五星志愿者',
};

export const BADGE_DESCRIPTIONS: Record<number, string> = {
  1: '初入志愿服务，迈出奉献第一步',
  2: '坚持服务，展现热忱之心',
  3: '积极奉献，成为志愿中坚',
  4: '资深志愿者，榜样力量',
  5: '卓越志愿者，公益楷模',
};

export interface ServiceRecord {
  id?: string;
  volunteer_id: string;
  service_type: string;
  duration_hours: number;
  valid_hours?: number;
  overtime_hours?: number;
  is_overtime?: boolean;
  status?: ServiceRecordStatus;
  revoked_at?: Date;
  revoked_by?: string;
  revoke_reason?: string;
  recalculated_at?: Date;
  entry_seq?: number;
  rating: number;
  points_earned?: number;
  points_adjustment?: number;
  is_no_show?: boolean;
  location?: string;
  description?: string;
  recorded_at?: Date;
  created_at?: Date;
  updated_at?: Date;
}

export interface Volunteer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  total_points: number;
  level: number;
  credit_score: number;
  service_count: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Badge {
  id: string;
  volunteer_id: string;
  star_level: number;
  badge_name: string;
  description: string;
  awarded_at: Date;
}

export interface Complaint {
  id: string;
  volunteer_id: string;
  complainant_id?: string;
  complaint_type: string;
  description: string;
  status: 'pending' | 'resolved' | 'rejected';
  resolution?: string;
  credit_penalty?: number;
  points_penalty?: number;
  handled_by?: string;
  created_at: Date;
  resolved_at?: Date;
}

export interface CreditLog {
  id: string;
  volunteer_id: string;
  change_amount: number;
  reason: string;
  before_score: number;
  after_score: number;
  related_id?: string;
  related_type?: string;
  created_at: Date;
}

export interface PointsLog {
  id: string;
  volunteer_id: string;
  change_amount: number;
  reason: string;
  before_points: number;
  after_points: number;
  related_id?: string;
  related_type?: string;
  created_at: Date;
}

export interface CreditCalculationBreakdown {
  baseScore: number;
  serviceCountBonus: number;
  ratingBonus: number;
  noShowPenalty: number;
  complaintPenalty: number;
  total: number;
  details: {
    serviceCount: number;
    serviceCountBonus: number;
    avgRating: number | null;
    ratingBonus: number;
    noShowCount: number;
    noShowPenalty: number;
    activeComplaintCount: number;
    complaintPenalty: number;
  };
}

export interface CreditScoreResult {
  beforeScore: number;
  afterScore: number;
  changeAmount: number;
  breakdown: CreditCalculationBreakdown;
}

export interface ServiceRecordWithCredit extends ServiceRecord {
  creditScore?: number;
  creditChange?: number;
  creditBreakdown?: CreditCalculationBreakdown;
}

export interface DailyCapRecomputeResult {
  updatedRecordIds: string[];
  recordChanges: RecordPointsChange[];
  totalPointsChange: number;
  effectivePointsTotal: number;
  noShowPenaltyTotal: number;
}

export interface RecordPointsChange {
  record_id: string;
  service_date: string;
  old_points: number;
  new_points: number;
  old_valid_hours: number;
  new_valid_hours: number;
  old_overtime_hours: number;
  new_overtime_hours: number;
  points_change: number;
  entry_seq?: number;
  log_reason?: string;
}

export interface VolunteerRebuildResult {
  oldTotalPoints: number;
  newTotalPoints: number;
  pointsChange: number;
  oldLevel: number;
  newLevel: number;
  oldServiceCount: number;
  newServiceCount: number;
  newBadges: Badge[];
  removedBadgeLevels: number[];
  effectivePointsTotal: number;
  noShowPenaltyTotal: number;
  recordChanges: RecordPointsChange[];
  updatedRecordIds: string[];
}

export interface CreateServiceRecordResult {
  record: ServiceRecord;
  pointsChange: number;
  newTotalPoints: number;
  newLevel: number;
  newBadges: any[];
  levelUp: boolean;
  creditScore: number;
  creditChange: number;
  creditBreakdown?: CreditCalculationBreakdown;
  validHours: number;
  overtimeHours: number;
  isOvertime: boolean;
  dailyLimit: number;
  recompute?: {
    recordChanges: RecordPointsChange[];
    totalPointsChange: number;
  };
}

export interface RevokeServiceRecordResult {
  record: ServiceRecord;
  oldTotalPoints: number;
  newTotalPoints: number;
  pointsChange: number;
  oldLevel: number;
  newLevel: number;
  oldServiceCount: number;
  newServiceCount: number;
  newBadges: Badge[];
  removedBadgeLevels: number[];
  restoredRecords: RecordPointsChange[];
  restoredPoints: number;
  creditScore: number;
  creditChange: number;
  creditBreakdown?: CreditCalculationBreakdown;
}

export interface ComplaintWithCredit extends Complaint {
  creditScore?: number;
  creditChange?: number;
  creditBreakdown?: CreditCalculationBreakdown;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  details?: any;
}

export interface PaginatedData<T> {
  data: T[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
}

export interface RankingEntry {
  volunteer_id: string;
  volunteer_name: string;
  score: number;
  rank: number;
  level?: number;
}

export interface TrendData {
  date: string;
  total_points: number;
  total_services: number;
  total_valid_hours: number;
  total_overtime_hours: number;
  average_credit: number;
}
