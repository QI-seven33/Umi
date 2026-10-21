import { resolve } from 'node:path';
import { inspectRequestCache } from '../packages/adapters/src/sqlite/request-cache.js';

// 必须显式指定数据库和会话；没有默认生产库，也不会创建应用/发模型请求。
const [database, conversationId, count, before] = process.argv.slice(2);
if (!database || !conversationId || process.argv.length > 6) {
  throw new Error('用法：node dist/scripts/inspect-request-cache.js <database.sqlite> <conversationId> [1..100] [beforeOrdinal]');
}
console.log(JSON.stringify(inspectRequestCache(resolve(database), conversationId, count === undefined ? 50 : Number(count), before === undefined ? undefined : Number(before)), null, 2));