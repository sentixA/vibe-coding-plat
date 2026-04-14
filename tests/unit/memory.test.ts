/**
 * memory 模块单元测试
 *
 * 覆盖：schema 初始化、ingest fixture jsonl、FTS5 检索命中、
 *       listSessions、showSession、replaySession、幂等性。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { openSqlite, closeAll } from '../../scripts/_shared/db.js';
import {
  initSchema,
  ingestSessionFile,
  listSessions,
  showSession,
  searchFts,
  replaySession,
} from '@vcp/memory';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_JSONL = join(__dirname, '../../packages/memory/test/fixture.jsonl');

// 每个测试使用独立的临时数据库，避免状态污染
let tmpDb: string;

beforeEach(() => {
  const dir = join(tmpdir(), `vcp-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpDb = join(dir, 'memory.db');
});

afterEach(async () => {
  // 关闭所有 db 连接（避免文件锁）
  closeAll();
  // 清理临时目录
  try {
    rmSync(dirname(tmpDb), { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结果
  }
});

// ─── schema 初始化 ─────────────────────────────────────────────────────────────

describe('initSchema', () => {
  it('应创建所有必要的表', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);

    // 查询 sqlite_master 验证表是否存在
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table','shadow') AND name NOT LIKE 'sqlite_%'`
    ).all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('messages');
    expect(tableNames).toContain('tool_calls');
    expect(tableNames).toContain('session_chunks');
    // messages_fts 是虚表，在 sqlite_master 中也会出现
    const virtTables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' OR type = 'shadow'`
    ).all() as Array<{ name: string }>;
    // FTS5 内容表（messages_fts）的影子表
    const allNames = virtTables.map(t => t.name);
    // 直接查 messages_fts 虚表
    const ftsCheck = db.prepare(
      `SELECT name FROM sqlite_master WHERE name = 'messages_fts'`
    ).get() as { name: string } | undefined;
    expect(ftsCheck?.name).toBe('messages_fts');
  });

  it('重复调用 initSchema 应幂等（不报错）', async () => {
    const db = await openSqlite(tmpDb);
    expect(() => {
      initSchema(db);
      initSchema(db); // 第二次 CREATE IF NOT EXISTS 应不报错
    }).not.toThrow();
  });
});

// ─── ingest fixture jsonl ──────────────────────────────────────────────────────

describe('ingestSessionFile', () => {
  it('应将 fixture.jsonl 入库', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);
    ingestSessionFile(db, FIXTURE_JSONL);

    const sessions = listSessions(db);
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe('test-session-uuid-001');
    expect(sessions[0].agent).toBe('claude-code');
  });

  it('应正确解析消息（含 user / assistant / system 条目）', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);
    ingestSessionFile(db, FIXTURE_JSONL);

    const { messages } = showSession(db, 'test-session-uuid-001');
    // fixture 有 user + assistant + user(tool_result) 三条 message
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const roles = messages.map(m => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('应正确提取 tool_use 并存入 tool_calls 表', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);
    ingestSessionFile(db, FIXTURE_JSONL);

    const { toolCalls } = showSession(db, 'test-session-uuid-001');
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolCalls[0].tool).toBe('Write');
  });

  it('tool_result 应关联回 tool_calls.output', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);
    ingestSessionFile(db, FIXTURE_JSONL);

    const { toolCalls } = showSession(db, 'test-session-uuid-001');
    const writeTc = toolCalls.find(tc => tc.tool === 'Write');
    expect(writeTc).toBeDefined();
    // output 应该包含 tool_result 的文本
    expect(writeTc!.output).toContain('File created');
  });

  it('重复 ingest 同一文件应幂等（不重复插入）', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);
    ingestSessionFile(db, FIXTURE_JSONL);
    ingestSessionFile(db, FIXTURE_JSONL); // 第二次

    const sessions = listSessions(db);
    expect(sessions.length).toBe(1); // 只有 1 条 session
  });
});

// ─── FTS5 检索 ─────────────────────────────────────────────────────────────────

describe('searchFts', () => {
  it('应命中包含关键词的消息', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);
    ingestSessionFile(db, FIXTURE_JSONL);

    // fixture 中 assistant 消息包含 "hello world"
    const results = searchFts(db, 'hello');
    expect(results.length).toBeGreaterThan(0);
    // 确认命中的消息来自正确的 session
    expect(results.every(r => r.session_id === 'test-session-uuid-001')).toBe(true);
  });

  it('不存在的关键词应返回空数组', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);
    ingestSessionFile(db, FIXTURE_JSONL);

    const results = searchFts(db, 'zzz_nonexistent_keyword_zzz');
    expect(results).toEqual([]);
  });

  it('中文关键词应能命中（trigram 分词，最少 3 字符）', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);
    ingestSessionFile(db, FIXTURE_JSONL);

    // fixture 中用户消息包含 "请帮我写一个 hello world 函数"
    // trigram 分词器要求查询字符串至少 3 个字符
    const results = searchFts(db, '请帮我');
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─── listSessions & showSession ────────────────────────────────────────────────

describe('listSessions', () => {
  it('空库返回空数组', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);
    expect(listSessions(db)).toEqual([]);
  });

  it('since 过滤应生效', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);
    ingestSessionFile(db, FIXTURE_JSONL);

    // 用远未来的时间戳过滤，应返回空
    const results = listSessions(db, { since: Date.now() + 1_000_000_000 });
    expect(results).toEqual([]);
  });
});

describe('showSession', () => {
  it('不存在的 session 应返回 null', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);
    const { session } = showSession(db, 'nonexistent-id');
    expect(session).toBeNull();
  });
});

// ─── replaySession ────────────────────────────────────────────────────────────

describe('replaySession', () => {
  it('应返回包含 session id 的 Markdown', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);
    ingestSessionFile(db, FIXTURE_JSONL);

    const md = replaySession(db, 'test-session-uuid-001');
    expect(md).toContain('test-session-uuid-001');
    expect(md).toContain('claude-code');
  });

  it('不存在的 session 应返回 Not Found 提示', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);
    const md = replaySession(db, 'no-such-session');
    expect(md).toContain('Not Found');
  });
});

// ─── 额外：多 session 场景 ─────────────────────────────────────────────────────

describe('多 session 场景', () => {
  it('应能区分两个不同 session', async () => {
    const db = await openSqlite(tmpDb);
    initSchema(db);

    // 创建第二个 fixture（不同 sessionId）
    const dir2 = dirname(tmpDb);
    const fixture2 = join(dir2, 'fixture2.jsonl');
    writeFileSync(fixture2, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '另一个会话的消息' }] },
      uuid: 'msg-x01',
      timestamp: '2024-06-01T00:00:00.000Z',
      sessionId: 'test-session-uuid-002',
      cwd: '/tmp/another',
    }) + '\n');

    ingestSessionFile(db, FIXTURE_JSONL);
    ingestSessionFile(db, fixture2);

    const sessions = listSessions(db);
    expect(sessions.length).toBe(2);
    const ids = sessions.map(s => s.id);
    expect(ids).toContain('test-session-uuid-001');
    expect(ids).toContain('test-session-uuid-002');
  });
});
