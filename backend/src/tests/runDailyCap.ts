/**
 * 测试引导：先把 src/db/pool 重定向到 pg-mem 内存库，再加载实际测试文件。
 */
import * as path from 'path';
import { mockPool } from './helpers/mockDb';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');
const originalResolve = (Module as any)._resolveFilename;
const poolPath = path.resolve(__dirname, '../db/pool');
const mockDbPath = path.resolve(__dirname, './helpers/mockDb');

(Module as any)._resolveFilename = function (request: string, ...rest: any[]): string {
  const resolved: string = originalResolve.call(this, request, ...rest);
  return resolved === poolPath || resolved.startsWith(`${poolPath}.`) ? `${mockDbPath}.ts` : resolved;
};

// 确保业务模块通过 default 拿到同一个内存 pool
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, ...rest: any[]): any {
  const loaded = originalLoad.call(this, request, parent, ...rest);
  if (request.endsWith(path.join('db', 'pool')) && loaded) {
    return { default: mockPool, __esModule: true };
  }
  return loaded;
};

require('./dailyCap.test');
