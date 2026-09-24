/**
 * 集成测试用内存数据库（pg-mem）。
 * 仅用于本地无 PostgreSQL 环境时跑通业务 SQL，行为与真实 PG 基本一致。
 */
import { newDb } from 'pg-mem';
import { v4 as uuidv4 } from 'uuid';

const db = newDb();

db.registerLanguage('plpgsql', () => () => undefined);
db.registerExtension('pgcrypto', () => undefined);
db.public.registerFunction({
  name: 'gen_random_uuid',
  returns: 'text' as any,
  implementation: () => uuidv4(),
  impure: true,
});

// pg-mem 未内置 to_char，这里仅实现测试用到的日期格式化
const toCharImpl = (value: any, _format: string): string => {
  const d = value instanceof Date ? value : new Date(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
db.public.registerFunction({
  name: 'to_char',
  args: ['timestamp', 'text'],
  returns: 'text' as any,
  impure: true,
  implementation: toCharImpl,
} as any);
db.public.registerFunction({
  name: 'to_char',
  args: ['date', 'text'],
  returns: 'text' as any,
  impure: true,
  implementation: toCharImpl,
} as any);

const poolAdapter = db.adapters.createPg();

const rawPool = new poolAdapter.Pool();

/**
 * 去掉 pg-mem 暂不支持的 DECIMAL 精度声明；
 * 把“在 plpgsql DO 块里按需 CREATE SEQUENCE”提前成裸语句，
 * 因为测试环境的 plpgsql 是空实现。
 */
const normalizeSql = (text: string): string => {
  let sql = text.replace(/DECIMAL\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, 'DECIMAL');
  if (sql.includes('service_records_cap_seq_global') && /CREATE SEQUENCE/i.test(sql)) {
    sql = `CREATE SEQUENCE IF NOT EXISTS service_records_cap_seq_global;\n${sql}`;
  }
  return sql;
};

/** pg-mem 不支持 plpgsql 触发器函数，updated_at 自动维护在测试里不需要 */
const shouldSkip = (text: string): boolean =>
  /CREATE OR REPLACE FUNCTION update_updated_at_column/i.test(text);

const wrapClient = (client: any): any =>
  new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (text: string, params?: any[]) => {
          if (typeof text === 'string' && shouldSkip(text)) {
            return { rows: [] };
          }
          const sql = typeof text === 'string' ? normalizeSql(text) : text;
          if (params === undefined) {
            return target.query(sql);
          }
          return target.query(sql, params);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

export const mockPool = new Proxy(rawPool, {
  get(target, prop, receiver) {
    if (prop === 'query') {
      return async (text: string, params?: any[]) => {
        if (typeof text === 'string' && shouldSkip(text)) {
          return { rows: [] };
        }
        const sql = typeof text === 'string' ? normalizeSql(text) : text;
        if (params === undefined) {
          return target.query(sql);
        }
        return target.query(sql, params);
      };
    }
    if (prop === 'connect') {
      return async () => wrapClient(await target.connect());
    }
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as any;

export const resetDatabase = async (): Promise<void> => {
  const tables = [
    'admin_audit_logs',
    'points_logs',
    'credit_logs',
    'complaints',
    'badges',
    'service_records',
    'volunteers',
    'app_metadata',
  ];
  for (const table of tables) {
    await mockPool.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`).catch(() => undefined);
  }
};

export default mockPool;
