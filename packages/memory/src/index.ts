/**
 * @vcp/memory — Claude Code 会话历史归档库
 *
 * 提供 SQLite Schema 初始化、jsonl 入库、查询、全文检索、向量检索（占位）和 replay 功能。
 * 所有写入通过 ingestSessionFile，读取通过各 query 函数。
 */

import { readFileSync, statSync } from 'node:fs';
import type { SqliteHandle } from '../../../scripts/_shared/db.js';

// ─── 类型定义 ──────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  agent: string;
  cwd: string | null;
  feature_slug: string | null;
  started_at: number;
  ended_at: number | null;
  message_count: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  summary: string | null;
  raw_path: string | null;
}

export interface Message {
  id: number;
  session_id: string;
  seq: number;
  role: string;
  content: string;
  text_preview: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  ts: number;
}

export interface ToolCall {
  id: number;
  message_id: number;
  session_id: string;
  tool: string;
  input: string;
  output: string | null;
  duration_ms: number | null;
  ok: number | null;
  ts: number;
}

export interface ListSessionsOpts {
  feature?: string;
  since?: number;
  limit?: number;
}

// ─── Schema 初始化 ─────────────────────────────────────────────────────────────

/**
 * 按 §4 建表。session_embeddings 如果 sqlite-vss 不可用则跳过并打 warn。
 */
export function initSchema(db: SqliteHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      agent           TEXT NOT NULL,
      cwd             TEXT,
      feature_slug    TEXT,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      message_count   INTEGER DEFAULT 0,
      tokens_in       INTEGER DEFAULT 0,
      tokens_out      INTEGER DEFAULT 0,
      cost_usd        REAL,
      summary         TEXT,
      raw_path        TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY,
      session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq          INTEGER NOT NULL,
      role         TEXT NOT NULL,
      content      TEXT NOT NULL,
      text_preview TEXT,
      tokens_in    INTEGER,
      tokens_out   INTEGER,
      ts           INTEGER NOT NULL,
      UNIQUE(session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id           INTEGER PRIMARY KEY,
      message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      tool         TEXT NOT NULL,
      input        TEXT NOT NULL,
      output       TEXT,
      duration_ms  INTEGER,
      ok           INTEGER,
      ts           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool);

    -- 独立 FTS5 表（trigram 分词器，支持中文子串检索；由 ingest 时主动维护）
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      session_id UNINDEXED,
      seq UNINDEXED,
      role UNINDEXED,
      text_preview,
      tokenize = "trigram"
    );

    CREATE TABLE IF NOT EXISTS session_chunks (
      chunk_id   INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      start_seq  INTEGER,
      end_seq    INTEGER,
      text       TEXT NOT NULL
    );
  `);

  // 尝试建 session_embeddings 虚表（依赖 sqlite-vss），不可用则降级
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_embeddings USING vss0(embedding(384));
    `);
  } catch {
    // sqlite-vss 未安装，向量检索功能降级为占位实现
    console.error('[warn] sqlite-vss 不可用，session_embeddings 虚表跳过创建（向量检索降级）');
  }
}

// ─── Jsonl 解析工具 ────────────────────────────────────────────────────────────

/**
 * 从 content blocks 数组提取纯文本，用于 text_preview。
 * 处理 string 类型和 array<block> 两种 content 形态。
 */
function extractTextPreview(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text as string)
    .join('\n')
    .slice(0, 4096); // 截断，避免过大
}

// ─── Ingest ────────────────────────────────────────────────────────────────────

/**
 * 把一个 Claude Code session jsonl 文件增量入库。
 * 幂等：同 session uuid 重跑不重复插入（INSERT OR IGNORE + 事务）。
 *
 * jsonl 格式：每行是 JSON，含 type / message / uuid / timestamp / sessionId / cwd 字段。
 */
export function ingestSessionFile(db: SqliteHandle, jsonlPath: string): void {
  const raw = readFileSync(jsonlPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return;

  // 解析所有行
  const entries: any[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // 跳过无效行
    }
  }
  if (entries.length === 0) return;

  // 从第一个有效条目推断 sessionId 和 cwd
  const firstEntry = entries.find(e => e.sessionId);
  if (!firstEntry) return;
  const sessionId: string = firstEntry.sessionId;
  const cwd: string | null = firstEntry.cwd ?? null;

  // 计算时间范围
  const timestamps = entries
    .filter(e => e.timestamp)
    .map(e => new Date(e.timestamp).getTime())
    .filter(t => !isNaN(t));
  const startedAt = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
  const endedAt = timestamps.length > 0 ? Math.max(...timestamps) : null;

  // 获取文件的 mtime（用于后续判重，已在 memory-ingest 层处理，这里仅记录路径）
  let rawPath: string | null = null;
  try {
    statSync(jsonlPath);
    rawPath = jsonlPath;
  } catch {
    // 文件不存在则不记录
  }

  // 用事务保证原子性
  const txn = (db as any).transaction ? (db as any).transaction : null;
  const doIngest = () => {
    // 插入 session（已存在则忽略）
    const insertSession = db.prepare(`
      INSERT OR IGNORE INTO sessions
        (id, agent, cwd, started_at, ended_at, message_count, tokens_in, tokens_out, raw_path)
      VALUES (?, 'claude-code', ?, ?, ?, 0, 0, 0, ?)
    `);
    insertSession.run(sessionId, cwd, startedAt, endedAt, rawPath);

    // 插入消息并提取 tool_use / tool_result
    let seq = 0;
    // 收集 tool_use_id -> message_id 映射（用于 tool_result 关联）
    const toolUseIdToMsgId = new Map<string, number>();
    // 收集待填 output 的 tool_calls（key=tool_use_id）
    const pendingToolOutput = new Map<string, { toolUseId: string }>();

    const insertMsg = db.prepare(`
      INSERT OR IGNORE INTO messages
        (session_id, seq, role, content, text_preview, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertToolCall = db.prepare(`
      INSERT OR IGNORE INTO tool_calls
        (message_id, session_id, tool, input, ts)
      VALUES (?, ?, ?, ?, ?)
    `);
    const updateToolOutput = db.prepare(`
      UPDATE tool_calls SET output = ? WHERE message_id = ? AND tool = ?
    `);
    // 用 tool_use_id 更新 output
    const updateToolOutputById = db.prepare(`
      UPDATE tool_calls SET output = ?
      WHERE id = (
        SELECT tc.id FROM tool_calls tc
        JOIN messages m ON tc.message_id = m.id
        WHERE m.session_id = ? AND tc.input LIKE ?
        LIMIT 1
      )
    `);

    // 专门的 tool_use_id -> tool_calls.rowid 映射（从 db 查）
    const getToolCallByUseId = db.prepare(`
      SELECT tc.id FROM tool_calls tc
      JOIN messages m ON tc.message_id = m.id
      WHERE m.session_id = ? AND tc.tool = ?
      ORDER BY tc.id DESC LIMIT 1
    `);

    // 更精确：用 JSON 的 id 字段匹配
    // 将 tool_use_id -> tool_calls rowid 存入内存 map
    const toolUseIdToRowId = new Map<string, number>();

    for (const entry of entries) {
      if (!entry.message) continue; // system/summary 等无 message 字段的行跳过

      const msg = entry.message;
      const role: string = msg.role ?? entry.type ?? 'unknown';
      const content = msg.content;
      const ts = entry.timestamp
        ? new Date(entry.timestamp).getTime()
        : startedAt;

      const contentStr = typeof content === 'string'
        ? content
        : JSON.stringify(content);
      const textPreview = extractTextPreview(content);

      // 插入消息行
      const msgResult = insertMsg.run(sessionId, seq, role, contentStr, textPreview, ts) as any;
      // 获取 lastInsertRowid（better-sqlite3 返回 BigInt 或 number）
      let msgId: number = typeof msgResult.lastInsertRowid === 'bigint'
        ? Number(msgResult.lastInsertRowid)
        : (msgResult.lastInsertRowid as number);

      // 如果 IGNORE 生效（已存在），查找已有 id
      if (msgId === 0 || msgResult.changes === 0) {
        const existing = db.prepare(
          `SELECT id FROM messages WHERE session_id = ? AND seq = ?`
        ).get(sessionId, seq) as any;
        msgId = existing?.id ?? 0;
      }

      if (msgId > 0 && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            // tool_use block -> 插入 tool_calls 行
            const inputStr = JSON.stringify(block.input ?? {});
            const tcResult = insertToolCall.run(msgId, sessionId, block.name ?? 'unknown', inputStr, ts) as any;
            let tcId: number = typeof tcResult.lastInsertRowid === 'bigint'
              ? Number(tcResult.lastInsertRowid)
              : (tcResult.lastInsertRowid as number);
            if (tcId > 0 && block.id) {
              toolUseIdToRowId.set(block.id, tcId);
            }
            if (block.id) {
              toolUseIdToMsgId.set(block.id, msgId);
            }
          } else if (block.type === 'tool_result') {
            // tool_result block -> 找对应的 tool_calls 行，填 output
            const toolUseId: string = block.tool_use_id;
            if (toolUseId && toolUseIdToRowId.has(toolUseId)) {
              const tcRowId = toolUseIdToRowId.get(toolUseId)!;
              const outputText = extractTextPreview(block.content);
              db.prepare(`UPDATE tool_calls SET output = ? WHERE id = ?`)
                .run(outputText, tcRowId);
            }
          }
        }
      }

      seq++;
    }

    // 更新 session 统计
    const countResult = db.prepare(
      `SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?`
    ).get(sessionId) as any;
    db.prepare(
      `UPDATE sessions SET message_count = ?, ended_at = ? WHERE id = ?`
    ).run(countResult?.cnt ?? 0, endedAt, sessionId);

    // 重建 FTS 索引：先删除该 session 旧数据（FTS5 独立表支持 DELETE），再批量插入
    db.prepare(`DELETE FROM messages_fts WHERE session_id = ?`).run(sessionId);
    db.prepare(`
      INSERT INTO messages_fts(session_id, seq, role, text_preview)
      SELECT session_id, seq, role, text_preview FROM messages
      WHERE session_id = ? AND text_preview IS NOT NULL AND text_preview != ''
    `).run(sessionId);
  };

  // 使用 better-sqlite3 原生事务（如可用）
  if ((db as any).transaction) {
    (db as any).transaction(doIngest)();
  } else {
    db.exec('BEGIN');
    try {
      doIngest();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// ─── 查询函数 ──────────────────────────────────────────────────────────────────

/**
 * 列出所有 session，可按 feature_slug / 时间过滤。
 */
export function listSessions(db: SqliteHandle, opts: ListSessionsOpts = {}): Session[] {
  let sql = `SELECT * FROM sessions WHERE 1=1`;
  const params: unknown[] = [];
  if (opts.feature) {
    sql += ` AND feature_slug = ?`;
    params.push(opts.feature);
  }
  if (opts.since !== undefined) {
    sql += ` AND started_at >= ?`;
    params.push(opts.since);
  }
  sql += ` ORDER BY started_at DESC`;
  if (opts.limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(opts.limit);
  }
  return db.prepare(sql).all(...params) as Session[];
}

/**
 * 获取指定 session 的详细信息（含全部消息和 tool_calls）。
 */
export function showSession(
  db: SqliteHandle,
  id: string
): { session: Session | null; messages: Message[]; toolCalls: ToolCall[] } {
  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Session | null;
  if (!session) return { session: null, messages: [], toolCalls: [] };
  const messages = db.prepare(
    `SELECT * FROM messages WHERE session_id = ? ORDER BY seq`
  ).all(id) as Message[];
  const toolCalls = db.prepare(
    `SELECT * FROM tool_calls WHERE session_id = ? ORDER BY id`
  ).all(id) as ToolCall[];
  return { session, messages, toolCalls };
}

/**
 * FTS5 全文检索 messages.text_preview。
 * 返回命中的消息行（含 session_id，便于关联）。
 */
export function searchFts(
  db: SqliteHandle,
  q: string
): Array<Message & { highlight?: string }> {
  // FTS5 独立表：通过 session_id + seq 关联回 messages 表
  const rows = db.prepare(`
    SELECT m.*
    FROM messages_fts fts
    JOIN messages m ON m.session_id = fts.session_id AND m.seq = fts.seq
    WHERE fts.text_preview MATCH ?
    ORDER BY rank
    LIMIT 50
  `).all(q) as Message[];
  return rows;
}

/**
 * 向量检索（占位实现）。
 * 需要 sqlite-vss 且已有 session_embeddings 数据；当前降级为 FTS5 fallback。
 *
 * TODO: 接入 @xenova/transformers 生成 embedding，写入 session_chunks + session_embeddings。
 */
export function searchVec(db: SqliteHandle, q: string): Message[] {
  console.error('[warn] searchVec: sqlite-vss 向量检索未实现，降级为 FTS5 fallback');
  return searchFts(db, q);
}

/**
 * 把指定 session 还原成 Markdown，便于喂回 agent prompt。
 * 格式：会话元信息 + 逐条消息（tool_use/tool_result 折叠展示）。
 */
export function replaySession(db: SqliteHandle, id: string): string {
  const { session, messages, toolCalls } = showSession(db, id);
  if (!session) return `# Session Not Found\n\nid: ${id}`;

  const startDate = new Date(session.started_at).toISOString();
  const lines: string[] = [
    `# Session Replay: ${id}`,
    ``,
    `- **Agent**: ${session.agent}`,
    `- **CWD**: ${session.cwd ?? '(unknown)'}`,
    `- **Started**: ${startDate}`,
    `- **Messages**: ${session.message_count}`,
    ``,
    `---`,
    ``,
  ];

  // tool_calls 按 message_id 分组
  const tcByMsg = new Map<number, ToolCall[]>();
  for (const tc of toolCalls) {
    if (!tcByMsg.has(tc.message_id)) tcByMsg.set(tc.message_id, []);
    tcByMsg.get(tc.message_id)!.push(tc);
  }

  for (const msg of messages) {
    lines.push(`## [${msg.seq}] ${msg.role.toUpperCase()}`);
    lines.push(``);

    // 显示文本预览
    if (msg.text_preview) {
      lines.push(msg.text_preview);
      lines.push(``);
    }

    // 显示 tool_calls
    const tcs = tcByMsg.get(msg.id);
    if (tcs && tcs.length > 0) {
      for (const tc of tcs) {
        lines.push(`> **Tool**: \`${tc.tool}\``);
        try {
          const inp = JSON.parse(tc.input);
          const inputPreview = JSON.stringify(inp, null, 2).slice(0, 500);
          lines.push(`> **Input**: \`\`\`json\n${inputPreview}\n\`\`\``);
        } catch {
          lines.push(`> **Input**: ${tc.input.slice(0, 200)}`);
        }
        if (tc.output) {
          lines.push(`> **Output**: ${tc.output.slice(0, 300)}`);
        }
        lines.push(``);
      }
    }

    lines.push(`---`);
    lines.push(``);
  }

  return lines.join('\n');
}
