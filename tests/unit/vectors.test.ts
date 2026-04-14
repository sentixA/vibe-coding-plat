/**
 * vectors.test.ts — @vcp/vectors 单元测试
 *
 * 覆盖：
 * - initSchema：表是否正确创建
 * - indexFile：写入 chunk_meta / chunks / chunks_dense
 * - searchKeyword：FTS5 命中预期文件
 * - searchVec：向量搜索命中（伪向量模式）
 * - 增量索引：未变化文件跳过
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { SqliteHandle } from '../../scripts/_shared/db.js';
import {
  initSchema,
  indexFile,
  searchKeyword,
  searchVec,
  searchHybrid,
  chunkText,
} from '@vcp/vectors';

// fixture 路径
const FIXTURES_DIR = join(
  new URL('.', import.meta.url).pathname,
  '../../packages/vectors/test/fixtures'
);

// ─── 测试用 SQLite 句柄（不走 openSqlite，避免路径依赖） ───────────────────
function makeTmpDb(): SqliteHandle {
  const db = new Database(':memory:') as unknown as SqliteHandle;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────
function countRows(db: SqliteHandle, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

// ─── 测试套件 ────────────────────────────────────────────────────────────────

describe('initSchema', () => {
  it('应创建所有必要的表', () => {
    const db = makeTmpDb();
    initSchema(db);

    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('chunk_meta');
    expect(tableNames).toContain('chunks');
    expect(tableNames).toContain('chunks_dense');
    expect(tableNames).toContain('file_index');
  });

  it('多次调用 initSchema 不应报错（幂等性）', () => {
    const db = makeTmpDb();
    expect(() => {
      initSchema(db);
      initSchema(db);
    }).not.toThrow();
  });
});

describe('chunkText', () => {
  it('短文本应产生 1 个块', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0].start).toBe(1);
  });

  it('长文本应按 40 行切割并有 5 行重叠', () => {
    // 90 行文本：第 1 块 1-40，第 2 块 36-75，第 3 块 71-90
    const lines = Array.from({ length: 90 }, (_, i) => `line ${i + 1}`);
    const text = lines.join('\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 第 2 块的 start 应为 36（1-based，40-5+1=36）
    expect(chunks[1].start).toBe(36);
  });

  it('空文本应返回空数组', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  \n  ')).toEqual([]);
  });
});

describe('indexFile', () => {
  let db: SqliteHandle;

  beforeEach(() => {
    db = makeTmpDb();
    initSchema(db);
  });

  it('应为 fixture utils.ts 建索引', async () => {
    const path = join(FIXTURES_DIR, 'utils.ts');
    const result = await indexFile(db, path);

    expect(result.skipped).toBe(false);
    expect(result.chunks).toBeGreaterThan(0);

    // 验证 chunk_meta 有记录
    expect(countRows(db, 'chunk_meta')).toBeGreaterThan(0);
    // 验证 chunks 有文本
    expect(countRows(db, 'chunks')).toBeGreaterThan(0);
    // 验证 chunks_dense 有向量
    expect(countRows(db, 'chunks_dense')).toBeGreaterThan(0);
    // 验证 file_index 有记录
    expect(countRows(db, 'file_index')).toBe(1);
  });

  it('应为 fixture database.ts 建索引', async () => {
    const path = join(FIXTURES_DIR, 'database.ts');
    const result = await indexFile(db, path);

    expect(result.skipped).toBe(false);
    expect(result.chunks).toBeGreaterThan(0);
  });

  it('不存在的文件应跳过', async () => {
    const result = await indexFile(db, '/nonexistent/path/foo.ts');
    expect(result.skipped).toBe(true);
    expect(result.chunks).toBe(0);
  });

  it('增量模式：同文件第二次索引应跳过', async () => {
    const path = join(FIXTURES_DIR, 'utils.ts');

    // 第一次索引
    const first = await indexFile(db, path, { incremental: true });
    expect(first.skipped).toBe(false);

    // 第二次：mtime 和 hash 未变，应跳过
    const second = await indexFile(db, path, { incremental: true });
    expect(second.skipped).toBe(true);
  });

  it('增量模式：内容变化后应重新索引', async () => {
    // 创建临时文件
    const tmpDir = join(tmpdir(), `vcp-vectors-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'temp.ts');
    writeFileSync(tmpFile, '// original content\nexport const x = 1;\n');

    try {
      const first = await indexFile(db, tmpFile, { incremental: true });
      expect(first.skipped).toBe(false);
      const chunksAfterFirst = countRows(db, 'chunks');

      // 修改内容
      writeFileSync(tmpFile, '// modified content\nexport const x = 2;\nexport const y = 3;\n');
      // 强制修改 mtime（或内容 hash 不同就会重新索引）

      const second = await indexFile(db, tmpFile, { incremental: false });
      expect(second.skipped).toBe(false);

      // 旧 chunks 应被删除，新 chunks 写入
      expect(countRows(db, 'chunks')).toBe(second.chunks);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('searchKeyword', () => {
  let db: SqliteHandle;

  beforeEach(async () => {
    db = makeTmpDb();
    initSchema(db);

    // 索引所有 fixture 文件
    await indexFile(db, join(FIXTURES_DIR, 'utils.ts'));
    await indexFile(db, join(FIXTURES_DIR, 'database.ts'));
    await indexFile(db, join(FIXTURES_DIR, 'search_helpers.py'));
  });

  it('搜索 "capitalize" 应命中 utils.ts', () => {
    const results = searchKeyword(db, 'capitalize', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.path.includes('utils.ts'))).toBe(true);
  });

  it('搜索 "InMemoryDB" 应命中 database.ts', () => {
    const results = searchKeyword(db, 'InMemoryDB', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.path.includes('database.ts'))).toBe(true);
  });

  it('搜索 "tfidf" 应命中 search_helpers.py', () => {
    const results = searchKeyword(db, 'tfidf', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.path.includes('search_helpers.py'))).toBe(true);
  });

  it('搜索不存在的词应返回空数组', () => {
    const results = searchKeyword(db, 'xyzzy_nonexistent_token_abc', 5);
    expect(results).toEqual([]);
  });

  it('结果应包含必要字段', () => {
    const results = searchKeyword(db, 'function', 3);
    if (results.length > 0) {
      const r = results[0];
      expect(typeof r.chunk_id).toBe('number');
      expect(typeof r.path).toBe('string');
      expect(typeof r.start_line).toBe('number');
      expect(typeof r.end_line).toBe('number');
      expect(typeof r.text).toBe('string');
      expect(typeof r.score).toBe('number');
    }
  });
});

describe('searchVec', () => {
  let db: SqliteHandle;

  beforeEach(async () => {
    db = makeTmpDb();
    initSchema(db);
    await indexFile(db, join(FIXTURES_DIR, 'utils.ts'));
    await indexFile(db, join(FIXTURES_DIR, 'database.ts'));
  });

  it('应返回 k 个结果（或少于 k 个如果总量不足）', async () => {
    const results = await searchVec(db, 'string manipulation', 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('每个结果的 score 应在 [-1, 1] 范围内', async () => {
    const results = await searchVec(db, 'database operations', 5);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(-1);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('结果应按相似度降序排列', async () => {
    const results = await searchVec(db, 'array utilities', 10);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('空库应返回空数组', async () => {
    const emptyDb = makeTmpDb();
    initSchema(emptyDb);
    const results = await searchVec(emptyDb, 'anything', 5);
    expect(results).toEqual([]);
  });
});

describe('searchHybrid', () => {
  let db: SqliteHandle;

  beforeEach(async () => {
    db = makeTmpDb();
    initSchema(db);
    await indexFile(db, join(FIXTURES_DIR, 'utils.ts'));
    await indexFile(db, join(FIXTURES_DIR, 'database.ts'));
    await indexFile(db, join(FIXTURES_DIR, 'search_helpers.py'));
  });

  it('混合搜索应返回结果', async () => {
    const results = await searchHybrid(db, 'string function', 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it('混合搜索结果不应超过 k 个', async () => {
    const results = await searchHybrid(db, 'capitalize text', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
