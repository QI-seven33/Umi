import { readFileSync } from 'node:fs';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { hash } from '../../../agent/src/identity.js';
import type { ToolRegistry } from '../../../agent/src/tools/registry.js';
import { UmiError } from '../../../protocol/src/model.js';
import { filePath } from '../../../protocol/src/file-path.js';
import { metadataInventory } from './metadata.js';
import { ResourceFiles } from './resources.js';
import { bytesHash, observe, safeFile, sameEntry } from './paths.js';

const schema = z.object({
  mountId: z.string().min(1).max(160), query: z.string().min(1).max(500),
  path: filePath.optional(), prefix: filePath.optional(),
  limit: z.number().int().min(1).max(100).default(30), cursor: z.string().min(1).max(1024).optional(),
}).strict().refine(a => !(a.path && a.prefix), 'path 与 prefix 互斥');
const cursorSchema = z.object({ v: z.literal(1), binding: z.string(), version: z.string(), offset: z.number().int().nonnegative().max(10000) }).strict();
type Match = { mountId: string; path: string; hash: string; startByte: number; endByte: number; line: number; text: string; readSuggestion: { startLine: number; lineCount: number; expectedHash: string } };

// 搜索只提供定位，不产生编辑读证据；分页绑定范围、查询及已观察文件版本。
export function registerTextSearch(registry: ToolRegistry, files: ResourceFiles) {
  registry.register({ name: 'search_text', schema, effect: 'read',
    description: '字面搜索获准副本。path 限定单文件，prefix 限定子目录；返回所有实际出现位置（含同一行多次）、1-based 行号、hash 与 read_file 行读取建议。totalMatches=出现次数，matchedLines 为命中起始行数，matchedFiles 为命中文件数；覆盖不完整或有跳过目录时仅为下界。用同参数和 nextCursor 翻页，版本变更重新搜索；摘录不代替读取回执。',
    prepare(input, env) { const a = schema.parse(input); return files.mountContext(input, env, a.mountId, a.path); },
    async execute(input, ctx, _c, signal) {
      const a = schema.parse(input), m = files.repo.mount(a.mountId, ctx.environmentId);
      if (a.path) files.assertPath(m.scope, a.path);
      const query = Buffer.from(a.query);
      if (query.toString('utf8') !== a.query || a.query.includes('\0')) throw new UmiError('TOOL_ARGUMENTS_INVALID', '查询必须是完整 UTF-8 文本');
      const inventory = metadataInventory(m.root, { maxEntries: 5000, maxDepth: 16, maxMs: 1500 }, {
        expectedRoot: m.rootIdentity, signal, ...((a.path ?? a.prefix) ? { prefix: a.path ?? a.prefix! } : {}),
        ...(m.scope.kind === 'file' ? { fileOnly: m.scope.path } : a.path ? { fileOnly: a.path } : {}),
      });
      const matches: Match[] = [], lines = new Set<string>(), matchedFiles = new Set<string>();
      const observations: { path: string; hash: string; identity: string }[] = [];
      const skipped: { path: string; reason: string }[] = [];
      let scannedBytes = 0, scannedFiles = 0, complete = inventory.coverage.complete && Object.values(inventory.coverage.skipped).every(count => count === 0);
      const started = Date.now();
      for (const item of inventory.entries.filter(e => e.kind === 'file')) {
        await yieldToHost(undefined, { signal });
        if (Date.now() - started > 2500 || scannedBytes + item.size > 32 * 1024 * 1024 || matches.length >= 10000) { complete = false; skipped.push({ path: item.path, reason: 'search-budget' }); break; }
        if (item.size > 4 * 1024 * 1024) { complete = false; skipped.push({ path: item.path, reason: 'file-over-4MiB' }); continue; }
        const before = observe(m.root, item.path, m.rootIdentity);
        if (!before) { complete = false; skipped.push({ path: item.path, reason: 'missing' }); continue; }
        if (before.size !== item.size) throw new UmiError('RESOURCE_CHANGED', '搜索清单后文件大小变化，请重新搜索');
        const bytes = readFileSync(safeFile(m.root, item.path, m.rootIdentity));
        if (!sameEntry(before, observe(m.root, item.path, m.rootIdentity)) || bytesHash(bytes) !== before.hash)
          throw new UmiError('RESOURCE_CHANGED', '搜索期间文件变化，请重新搜索');
        observations.push({ path: item.path, hash: before.hash, identity: before.identity });
        scannedBytes += bytes.length; scannedFiles++;
        try { if (new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0')) throw Error('binary'); }
        catch { skipped.push({ path: item.path, reason: 'non-utf8-or-binary' }); complete = false; continue; }
        let offset = 0, line = 1, lineOffset = 0;
        for (let found = bytes.indexOf(query, offset); found >= 0; found = bytes.indexOf(query, offset)) {
          signal.throwIfAborted();
          while (lineOffset < found) { const lf = bytes.indexOf(10, lineOffset); if (lf < 0 || lf >= found) break; line++; lineOffset = lf + 1; }
          let end = Math.min(bytes.length, found + query.length + 160);
          while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
          matches.push({ mountId: m.id, path: item.path, hash: before.hash, startByte: found, endByte: found + query.length, line, text: bytes.subarray(found, end).toString('utf8'), readSuggestion: { startLine: Math.max(1, line - 2), lineCount: 5, expectedHash: before.hash } });
          lines.add(`${item.path}:${line}`); matchedFiles.add(item.path);
          offset = found + 1;
          if (matches.length >= 10000) { complete = false; skipped.push({ path: item.path, reason: 'match-limit' }); break; }
        }
      }
      // 多文件搜索让出宿主后，早先文件也可能改变；续页只接受同一观察版本。
      for (const observation of observations) {
        const current = observe(m.root, observation.path, m.rootIdentity);
        if (!current || current.hash !== observation.hash || current.identity !== observation.identity)
          throw new UmiError('RESOURCE_CHANGED', '搜索期间文件变化，请重新搜索');
      }
      const binding = hash({ mountId: m.id, rootIdentity: m.rootIdentity, bindingVersion: m.bindingVersion, query: a.query, path: a.path ?? null, prefix: a.prefix ?? null });
      const version = hash({ inventory: inventory.version, observations });
      let offset = 0;
      if (a.cursor) {
        let cursor;
        try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(a.cursor, 'base64url').toString('utf8'))); }
        catch { throw new UmiError('TOOL_ARGUMENTS_INVALID', '无效搜索游标'); }
        if (cursor.binding !== binding || cursor.version !== version) throw new UmiError('RESOURCE_CHANGED', '搜索范围、查询或文件版本变化，请去掉 cursor 重新搜索');
        offset = cursor.offset;
        if (offset > matches.length) throw new UmiError('RESOURCE_CHANGED', '搜索覆盖变化，请重新搜索');
      }
      const page = matches.slice(offset, offset + a.limit), next = offset + page.length;
      return { outcome: 'succeeded' as const, content: '', data: {
        matches: page, totalMatches: matches.length, matchedLines: lines.size, matchedFiles: matchedFiles.size, totalExact: complete,
        truncated: next < matches.length || !complete,
        nextCursor: next < matches.length ? Buffer.from(JSON.stringify({ v: 1, binding, version, offset: next })).toString('base64url') : null,
        coverage: { complete, counts: complete ? 'exact' : 'lower-bound', scannedFiles, scannedBytes, inventory: inventory.coverage, skipped },
      } };
    },
    async reconcile(a, ctx, c, s) { return this.execute(a, ctx, c, s); },
  });
}
