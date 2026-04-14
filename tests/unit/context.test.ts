/**
 * tests/unit/context.test.ts — @vcp/context 单元测试
 *
 * 每个子命令一个测试组，使用临时 SQLite 和临时目录隔离。
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { dumpDbSchema, dumpEnv, dumpApi, dumpRecentLogs } from '@vcp/context';
import { openSqlite, closeAll } from '../../scripts/_shared/db.js';

// 临时目录，测试结束后清理
const TMP = resolve(tmpdir(), `vcp-context-test-${Date.now()}`);
mkdirSync(TMP, { recursive: true });

afterAll(() => {
  closeAll();
  rmSync(TMP, { recursive: true, force: true });
});

// ---------- dumpDbSchema ----------

describe('dumpDbSchema', () => {
  it('对不存在的文件优雅降级', async () => {
    const result = await dumpDbSchema(resolve(TMP, 'nonexistent.db'));
    expect(result).toContain('不存在');
  });

  it('正常探测有表的 SQLite', async () => {
    const dbPath = resolve(TMP, 'schema-test.db');
    const db = await openSqlite(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id   INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);
    `);

    const result = await dumpDbSchema(dbPath);
    expect(result).toContain('## DB Schema');
    expect(result).toContain('users');
    expect(result).toContain('id');
    expect(result).toContain('name');
    expect(result).toContain('idx_users_name');
  });
});

// ---------- dumpEnv ----------

describe('dumpEnv', () => {
  it('输出白名单变量，包含 NODE_ENV', () => {
    const result = dumpEnv();
    expect(result).toContain('## Environment Variables');
    expect(result).toContain('NODE_ENV');
  });

  it('敏感 key 名自动脱敏', () => {
    // 临时注入一个测试用的敏感变量
    process.env['FAKE_API_KEY'] = 'super-secret-value-12345abcde';
    const result = dumpEnv(['FAKE_API_KEY']);
    expect(result).toContain('FAKE_API_KEY');
    expect(result).toContain('<redacted>');
    expect(result).not.toContain('super-secret-value');
    delete process.env['FAKE_API_KEY'];
  });

  it('长度 > 16 且多字符多样性的值被脱敏（heuristic）', () => {
    // PASSWORD 子串也命中敏感 key 检查，改用普通 key 测 heuristic
    process.env['MY_CONFIG_VAL'] = 'aB3!xY9@kL2#mN7$';  // 长度 16，多样性高
    const result = dumpEnv(['MY_CONFIG_VAL']);
    // heuristic: 长度 > 16 才触发；这里刚好 16 不触发；测试 > 16 的场景
    process.env['MY_CONFIG_VAL'] = 'aB3!xY9@kL2#mN7$Q';  // 17 个字符，含4类
    const result2 = dumpEnv(['MY_CONFIG_VAL']);
    expect(result2).toContain('<redacted>');
    delete process.env['MY_CONFIG_VAL'];
  });

  it('追加 --vars 扩展白名单', () => {
    process.env['CUSTOM_VAR'] = 'hello-world';
    const result = dumpEnv(['CUSTOM_VAR']);
    expect(result).toContain('CUSTOM_VAR');
    expect(result).toContain('hello-world');
    delete process.env['CUSTOM_VAR'];
  });
});

// ---------- dumpApi ----------

describe('dumpApi', () => {
  it('无 OpenAPI / tRPC 文件时优雅降级', () => {
    const emptyDir = resolve(TMP, 'empty-repo');
    mkdirSync(emptyDir, { recursive: true });
    const result = dumpApi(emptyDir);
    expect(result).toContain('## API Endpoints');
    expect(result).toContain('未发现');
  });

  it('扫描 openapi.yaml 文件提取路径', () => {
    const apiDir = resolve(TMP, 'api-repo');
    mkdirSync(apiDir, { recursive: true });
    writeFileSync(
      join(apiDir, 'openapi.yaml'),
      `openapi: "3.0.0"
info:
  title: Test
paths:
  /users:
    get:
      summary: List users
  /users/{id}:
    get:
      summary: Get user
`,
    );

    const result = dumpApi(apiDir);
    expect(result).toContain('/users');
    expect(result).toContain('openapi');
    expect(result).toContain('openapi.yaml');
  });

  it('跳过 node_modules 目录', () => {
    const projDir = resolve(TMP, 'proj-with-nm');
    const nmDir = join(projDir, 'node_modules', 'some-pkg');
    mkdirSync(nmDir, { recursive: true });
    writeFileSync(
      join(nmDir, 'openapi.yaml'),
      `paths:\n  /should-not-appear:\n    get: {}\n`,
    );

    const result = dumpApi(projDir);
    expect(result).not.toContain('/should-not-appear');
  });
});

// ---------- dumpRecentLogs ----------

describe('dumpRecentLogs', () => {
  it('MEMORY_DB 不存在时优雅降级', async () => {
    const result = await dumpRecentLogs(10, resolve(TMP, 'no-memory.db'));
    expect(result).toContain('## Recent Sessions');
    expect(result).toContain('_no sessions yet_');
  });

  it('sessions 表不存在时优雅降级', async () => {
    const dbPath = resolve(TMP, 'empty-memory.db');
    // 仅创建 DB，不建 sessions 表
    const db = await openSqlite(dbPath);
    db.exec('CREATE TABLE other_table (id INTEGER PRIMARY KEY)');

    const result = await dumpRecentLogs(5, dbPath);
    expect(result).toContain('_no sessions yet_');
  });

  it('有 sessions 数据时正常输出 markdown 表格', async () => {
    const dbPath = resolve(TMP, 'has-sessions.db');
    const db = await openSqlite(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        agent         TEXT NOT NULL,
        cwd           TEXT,
        feature_slug  TEXT,
        started_at    INTEGER NOT NULL,
        ended_at      INTEGER,
        message_count INTEGER DEFAULT 0,
        tokens_in     INTEGER DEFAULT 0,
        tokens_out    INTEGER DEFAULT 0,
        cost_usd      REAL,
        summary       TEXT,
        raw_path      TEXT
      )
    `);
    db.prepare(
      `INSERT INTO sessions (id, agent, started_at, message_count, summary)
       VALUES (?, 'claude-code', ?, ?, ?)`,
    ).run('sess-001', Math.floor(Date.now() / 1000), 42, '测试摘要');
    db.prepare(
      `INSERT INTO sessions (id, agent, started_at, message_count, summary)
       VALUES (?, 'claude-code', ?, ?, ?)`,
    ).run('sess-002', Math.floor(Date.now() / 1000) - 100, 10, null);

    const result = await dumpRecentLogs(10, dbPath);
    expect(result).toContain('## Recent Sessions');
    expect(result).toContain('sess-001');
    expect(result).toContain('sess-002');
    expect(result).toContain('42');
    expect(result).toContain('测试摘要');
  });
});
