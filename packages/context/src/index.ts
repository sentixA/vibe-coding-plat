/**
 * @vcp/context — 运行时上下文注入库
 * 提供 dumpDbSchema / dumpEnv / dumpApi / dumpRecentLogs 四个只读探测函数
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
// 从共享层取 SQLite 句柄，禁止自己 new Database()
// ESM + tsx 环境下通过 tsconfig paths / vitest alias 解析 #shared/db
import { openSqlite } from '#shared/db';

// ---------- 类型 ----------

/** sessions 表单行 */
export interface SessionRow {
  id: string;
  started_at: number;
  message_count: number;
  summary: string | null;
}

/** API 端点条目 */
export interface ApiEntry {
  kind: 'openapi' | 'trpc';
  file: string;  // 相对于 repoRoot 的路径
  line: number;
  name: string;
}

// ---------- 工具函数 ----------

/** 判断某个 key 名是否属于敏感字段 */
function isSensitiveKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper.includes('KEY') ||
    upper.includes('TOKEN') ||
    upper.includes('SECRET') ||
    upper.includes('PASSWORD')
  );
}

/**
 * 启发式判断值是否像一个密钥（长度 > 16 且字符多样性高）。
 * 字符多样性：同时含有数字、大写/小写字母或特殊字符中的 ≥2 类。
 */
function looksLikeSecret(value: string): boolean {
  if (value.length <= 16) return false;
  const hasDigit = /[0-9]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasSpecial = /[^A-Za-z0-9]/.test(value);
  const diversity =
    (hasDigit ? 1 : 0) +
    (hasUpper ? 1 : 0) +
    (hasLower ? 1 : 0) +
    (hasSpecial ? 1 : 0);
  return diversity >= 2;
}

/** 对敏感值脱敏 */
function redact(key: string, value: string): string {
  if (isSensitiveKey(key) || looksLikeSecret(value)) {
    return '<redacted>';
  }
  return value;
}

// ---------- 核心导出 ----------

/**
 * 探测 SQLite 文件的所有表结构（含列、索引、虚表），输出 markdown。
 * 纯只读，不修改数据库。
 */
export async function dumpDbSchema(dbPath: string): Promise<string> {
  if (!existsSync(dbPath)) {
    return `_数据库文件不存在：${dbPath}_`;
  }

  const db = await openSqlite(dbPath);

  // 取所有表（含虚表）
  const tables = (
    db.prepare(
      `SELECT name, type FROM sqlite_master
       WHERE type IN ('table', 'view', 'trigger')
       ORDER BY type, name`,
    ).all() as { name: string; type: string }[]
  );

  if (tables.length === 0) {
    return `_数据库无表：${dbPath}_`;
  }

  const lines: string[] = [`## DB Schema: ${dbPath}`, ''];

  for (const { name, type } of tables) {
    lines.push(`### ${name} (${type})`);

    // 列信息（虚表的 PRAGMA 可能报错，捕获并跳过）
    try {
      const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as {
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[];
      if (cols.length > 0) {
        lines.push('');
        lines.push('**列：**');
        for (const col of cols) {
          const flags: string[] = [];
          if (col.pk) flags.push('PK');
          if (col.notnull) flags.push('NOT NULL');
          if (col.dflt_value !== null) flags.push(`DEFAULT ${col.dflt_value}`);
          const flagStr = flags.length ? ` _(${flags.join(', ')})_` : '';
          lines.push(`- \`${col.name}\` ${col.type}${flagStr}`);
        }
      }
    } catch {
      lines.push(`- _(虚表，无法读取列信息)_`);
    }

    // 索引信息
    try {
      const idxs = db.prepare(`PRAGMA index_list("${name}")`).all() as {
        seq: number;
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }[];
      if (idxs.length > 0) {
        lines.push('');
        lines.push('**索引：**');
        for (const idx of idxs) {
          const uniq = idx.unique ? ' UNIQUE' : '';
          lines.push(`- \`${idx.name}\`${uniq}`);
        }
      }
    } catch {
      // 虚表忽略
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 从环境变量取白名单（默认 NODE_ENV / CLAUDE_PROJECTS_DIR / PATH），
 * 敏感字段自动脱敏为 `<redacted>`。
 * 可通过 extraVars 追加更多 key。
 */
export function dumpEnv(
  extraVars: string[] = [],
  allowList: string[] = ['NODE_ENV', 'CLAUDE_PROJECTS_DIR', 'PATH'],
): string {
  const keys = [...new Set([...allowList, ...extraVars])];
  const lines: string[] = ['## Environment Variables', ''];

  for (const key of keys) {
    const raw = process.env[key];
    if (raw === undefined) {
      lines.push(`- \`${key}\`: _unset_`);
    } else {
      const safe = redact(key, raw);
      lines.push(`- \`${key}\`: \`${safe}\``);
    }
  }

  return lines.join('\n');
}

/**
 * 扫描 repoRoot 下的 OpenAPI 文件（openapi.yaml/.yml/.json）和 tRPC 路由文件（*.tRPC.ts），
 * 列出 endpoint/route 名称 + 文件路径 + 行号。
 * 仅输出清单，不做深度解析。
 */
export function dumpApi(repoRoot: string): string {
  const entries: ApiEntry[] = [];

  /** 递归遍历目录，跳过 node_modules 和 .git */
  function walk(dir: string): void {
    let items: string[];
    try {
      items = readdirSync(dir);
    } catch {
      return;
    }
    for (const item of items) {
      if (item === 'node_modules' || item === '.git') continue;
      const full = resolve(dir, item);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        scanFile(full);
      }
    }
  }

  /** 扫描单个文件，按文件类型提取端点 */
  function scanFile(filePath: string): void {
    const name = filePath.split('/').pop() ?? '';
    const relPath = relative(repoRoot, filePath);

    // OpenAPI 文件：openapi.yaml / openapi.yml / openapi.json
    if (/^openapi\.(yaml|yml|json)$/i.test(name)) {
      const lines = safeReadLines(filePath);
      extractOpenApiPaths(lines, relPath, entries);
      return;
    }

    // tRPC 文件：*.tRPC.ts（大小写不敏感）
    if (/\.tRPC\.ts$/i.test(name)) {
      const lines = safeReadLines(filePath);
      extractTrpcRoutes(lines, relPath, entries);
    }
  }

  walk(repoRoot);

  if (entries.length === 0) {
    return '## API Endpoints\n\n_未发现 OpenAPI 或 tRPC 文件_';
  }

  const lines: string[] = ['## API Endpoints', ''];
  for (const e of entries) {
    lines.push(`- **[${e.kind}]** \`${e.name}\` — \`${e.file}:${e.line}\``);
  }
  return lines.join('\n');
}

/** 安全读取文件行（失败时返回空数组） */
function safeReadLines(filePath: string): string[] {
  try {
    return readFileSync(filePath, 'utf8').split('\n');
  } catch {
    return [];
  }
}

/** 从 OpenAPI YAML/JSON 行中提取 path 条目（匹配 "  /xxx:" 格式） */
function extractOpenApiPaths(
  lines: string[],
  relPath: string,
  out: ApiEntry[],
): void {
  for (let i = 0; i < lines.length; i++) {
    // 匹配 YAML 路径键：以 /开头的缩进行，或 JSON "path" 字段
    const yamlMatch = lines[i].match(/^\s{0,4}(\/[\w/{}:._-]+)\s*:/);
    if (yamlMatch) {
      out.push({ kind: 'openapi', file: relPath, line: i + 1, name: yamlMatch[1] });
      continue;
    }
    // JSON 格式："  \"/path\":"
    const jsonMatch = lines[i].match(/^\s+"(\/[\w/{}:._-]+)"\s*:/);
    if (jsonMatch) {
      out.push({ kind: 'openapi', file: relPath, line: i + 1, name: jsonMatch[1] });
    }
  }
}

/** 从 tRPC 文件中提取 router/procedure 名称 */
function extractTrpcRoutes(
  lines: string[],
  relPath: string,
  out: ApiEntry[],
): void {
  for (let i = 0; i < lines.length; i++) {
    // 匹配 .query() / .mutation() / .subscription() 调用前的路由名
    // 例：  getUser: t.procedure.query(...)
    const routeMatch = lines[i].match(/^\s*([\w.]+)\s*:\s*(?:router|t\.router|procedure|t\.procedure)/);
    if (routeMatch) {
      out.push({ kind: 'trpc', file: relPath, line: i + 1, name: routeMatch[1] });
      continue;
    }
    // 匹配 router({ key: ...  }) 风格
    const routerKeyMatch = lines[i].match(/^\s+([\w]+)\s*:/);
    if (routerKeyMatch && lines[i - 1]?.includes('router(')) {
      out.push({ kind: 'trpc', file: relPath, line: i + 1, name: routerKeyMatch[1] });
    }
  }
}

/**
 * 从 MEMORY_DB 的 sessions 表读取最近 N 条，输出 markdown。
 * 若 DB 不存在或 sessions 表不存在，优雅降级输出 `_no sessions yet_`。
 */
export async function dumpRecentLogs(
  n: number,
  dbPath: string,
): Promise<string> {
  if (!existsSync(dbPath)) {
    return '## Recent Sessions\n\n_no sessions yet_';
  }

  let db;
  try {
    db = await openSqlite(dbPath);
  } catch {
    return '## Recent Sessions\n\n_no sessions yet_';
  }

  // 检查 sessions 表是否存在
  const tableCheck = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`,
  ).get() as { name: string } | undefined;

  if (!tableCheck) {
    return '## Recent Sessions\n\n_no sessions yet_';
  }

  const rows = db.prepare(
    `SELECT id, started_at, message_count, summary
     FROM sessions
     ORDER BY started_at DESC
     LIMIT ?`,
  ).all(n) as SessionRow[];

  if (rows.length === 0) {
    return '## Recent Sessions\n\n_no sessions yet_';
  }

  const lines: string[] = ['## Recent Sessions', ''];
  lines.push('| id | started_at | message_count | summary |');
  lines.push('|---|---|---|---|');
  for (const row of rows) {
    const ts = new Date(row.started_at * 1000).toISOString();
    const summary = row.summary ? row.summary.slice(0, 80) : '-';
    lines.push(`| \`${row.id}\` | ${ts} | ${row.message_count} | ${summary} |`);
  }

  return lines.join('\n');
}
