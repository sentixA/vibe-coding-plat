/**
 * @vcp/vectors — 代码向量索引库
 *
 * 架构说明：
 * - 优先尝试加载 sqlite-vss 虚表（真正的 ANN 向量搜索）
 * - sqlite-vss 不可用时降级为 chunks_dense(chunk_id, vec BLOB) + 内存余弦计算
 * - @xenova/transformers 不可用时降级为 hash-based 伪向量（128 维）
 *
 * 降级状态通过 VECTOR_MODE 导出，供上层感知。
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';
import type { SqliteHandle } from '../../../scripts/_shared/db.js';

// ─── 向量维度 ───────────────────────────────────────────────────────────────
/** 真实 embedding 维度（all-MiniLM-L6-v2 = 384） */
const REAL_DIM = 384;
/** 伪向量维度（hash-based fallback） */
const PSEUDO_DIM = 128;

// ─── 向量模式探测 ────────────────────────────────────────────────────────────
export type VectorMode =
  | 'transformers+vss'  // 最优：本地 embedding + sqlite-vss
  | 'transformers+mem'  // 良好：本地 embedding + 内存余弦
  | 'pseudo+mem';       // 降级：hash 伪向量 + 内存余弦

let _mode: VectorMode | null = null;
let _embedFn: ((text: string) => Promise<number[]>) | null = null;

/** 探测可用能力，缓存结果 */
async function detectCapabilities(): Promise<{
  mode: VectorMode;
  dim: number;
  embed: (text: string) => Promise<number[]>;
}> {
  if (_mode && _embedFn) {
    const dim = _mode === 'pseudo+mem' ? PSEUDO_DIM : REAL_DIM;
    return { mode: _mode, dim, embed: _embedFn };
  }

  // 尝试加载 @xenova/transformers
  let embed: (text: string) => Promise<number[]>;
  let usingReal = false;
  try {
    const { pipeline } = await import('@xenova/transformers' as any);
    const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    embed = async (text: string) => {
      const out = await pipe(text, { pooling: 'mean', normalize: true });
      return Array.from(out.data as Float32Array);
    };
    usingReal = true;
  } catch {
    // 降级为 hash-based 伪向量
    console.error(
      '[WARN] @xenova/transformers 不可用，降级为 hash-based 伪向量（128 维）。' +
      '搜索结果为关键词匹配，不具备语义相似性。'
    );
    embed = async (text: string) => hashVec(text, PSEUDO_DIM);
    usingReal = false;
  }

  // 尝试 sqlite-vss（当前环境通常不可用，直接走 mem 路径）
  // sqlite-vss 需要原生扩展，跳过探测直接用内存余弦
  const mode: VectorMode = usingReal ? 'transformers+mem' : 'pseudo+mem';
  _mode = mode;
  _embedFn = embed;
  const dim = usingReal ? REAL_DIM : PSEUDO_DIM;
  return { mode, dim, embed };
}

// ─── Hash 伪向量 ─────────────────────────────────────────────────────────────
/**
 * 把文本 hash 成 N 维 float 向量（[-1, 1] 均匀分布近似）。
 * 不具备语义相似性，仅用于降级模式下的"向量搜索"（实际退化为 hash 距离）。
 */
function hashVec(text: string, dim: number): number[] {
  const buf = createHash('sha256').update(text).digest();
  const vec: number[] = new Array(dim);
  // 用 sha256 (32 bytes) 循环填充 dim 个维度
  for (let i = 0; i < dim; i++) {
    const byte = buf[i % 32];
    vec[i] = (byte - 128) / 128; // 映射到 [-1, 1]
  }
  return vec;
}

// ─── 余弦相似度（内存计算） ───────────────────────────────────────────────────
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─── Schema ──────────────────────────────────────────────────────────────────
/**
 * 初始化 SQLite schema。
 *
 * 表设计：
 * - chunk_meta(chunk_id, path, start, end, commit_sha, content_hash, mtime)
 *   记录每个 chunk 的文件位置、内容 hash 和 mtime（用于增量跳过）
 * - chunks(chunk_id, text)
 *   块原文，供 FTS5 全文检索
 * - chunks_dense(chunk_id, vec BLOB)
 *   向量存储（BLOB 格式，float32 LE），内存余弦搜索
 * - chunks_fts：FTS5 虚表，针对 chunks.text
 * - file_index(path, mtime, content_hash)
 *   文件级索引，用于增量判断
 */
export function initSchema(db: SqliteHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_meta (
      chunk_id     INTEGER PRIMARY KEY AUTOINCREMENT,
      path         TEXT    NOT NULL,
      start_line   INTEGER NOT NULL,
      end_line     INTEGER NOT NULL,
      commit_sha   TEXT,
      content_hash TEXT    NOT NULL,
      mtime        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_meta_path ON chunk_meta(path);

    CREATE TABLE IF NOT EXISTS chunks (
      chunk_id INTEGER PRIMARY KEY REFERENCES chunk_meta(chunk_id) ON DELETE CASCADE,
      text     TEXT NOT NULL
    );

    -- 向量存储：vec 是 float32 LE BLOB
    CREATE TABLE IF NOT EXISTS chunks_dense (
      chunk_id INTEGER PRIMARY KEY REFERENCES chunk_meta(chunk_id) ON DELETE CASCADE,
      vec      BLOB NOT NULL
    );

    -- FTS5 全文检索
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content='chunks',
      content_rowid='chunk_id'
    );

    -- 文件级增量索引
    CREATE TABLE IF NOT EXISTS file_index (
      path         TEXT PRIMARY KEY,
      mtime        INTEGER NOT NULL,
      content_hash TEXT    NOT NULL
    );
  `);
}

// ─── Chunk 切割 ──────────────────────────────────────────────────────────────
const CHUNK_LINES = 40;
const OVERLAP_LINES = 5;

export interface Chunk {
  text: string;
  start: number; // 1-based
  end: number;
}

/** 按行切割文件内容，~40 行 chunk，5 行重叠 */
export function chunkText(content: string): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = i;
    const end = Math.min(i + CHUNK_LINES, lines.length);
    const text = lines.slice(start, end).join('\n').trim();
    if (text.length > 0) {
      chunks.push({ text, start: start + 1, end });
    }
    i += CHUNK_LINES - OVERLAP_LINES;
  }
  return chunks;
}

// ─── 序列化/反序列化 float32 向量 ─────────────────────────────────────────────
function vecToBlob(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i], i * 4);
  }
  return buf;
}

function blobToVec(buf: Buffer): number[] {
  const len = buf.length / 4;
  const vec: number[] = new Array(len);
  for (let i = 0; i < len; i++) {
    vec[i] = buf.readFloatLE(i * 4);
  }
  return vec;
}

// ─── 内容 hash ────────────────────────────────────────────────────────────────
function contentHash(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

// ─── 索引单个文件 ─────────────────────────────────────────────────────────────
/**
 * 对单个文件建索引。
 * 增量模式：比对 mtime + content_hash，未变化则跳过。
 */
export async function indexFile(
  db: SqliteHandle,
  filePath: string,
  opts: { incremental?: boolean; commitSha?: string } = {}
): Promise<{ skipped: boolean; chunks: number }> {
  const absPath = resolve(filePath);

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absPath);
  } catch {
    return { skipped: true, chunks: 0 };
  }

  const mtime = Math.floor(stat.mtimeMs);
  const content = readFileSync(absPath, 'utf-8');
  const hash = contentHash(content);

  // 增量跳过检查
  if (opts.incremental) {
    const existing = db.prepare(
      'SELECT mtime, content_hash FROM file_index WHERE path = ?'
    ).get(absPath) as { mtime: number; content_hash: string } | undefined;

    if (existing && existing.mtime === mtime && existing.content_hash === hash) {
      return { skipped: true, chunks: 0 };
    }
  }

  // 删除旧 chunks（CASCADE 会级联删 chunks + chunks_dense）
  db.prepare('DELETE FROM chunk_meta WHERE path = ?').run(absPath);
  db.prepare('DELETE FROM file_index WHERE path = ?').run(absPath);

  const { embed } = await detectCapabilities();
  const textChunks = chunkText(content);

  for (const chunk of textChunks) {
    // 插入 chunk_meta
    const meta = db.prepare(`
      INSERT INTO chunk_meta (path, start_line, end_line, commit_sha, content_hash, mtime)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(absPath, chunk.start, chunk.end, opts.commitSha ?? null, hash, mtime) as { lastInsertRowid: number };

    const chunkId = meta.lastInsertRowid;

    // 插入 chunks（文本）
    db.prepare('INSERT INTO chunks (chunk_id, text) VALUES (?, ?)').run(chunkId, chunk.text);

    // 更新 FTS5
    db.prepare('INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)').run(chunkId, chunk.text);

    // 计算并存储向量
    const vec = await embed(chunk.text);
    const blob = vecToBlob(vec);
    db.prepare('INSERT INTO chunks_dense (chunk_id, vec) VALUES (?, ?)').run(chunkId, blob);
  }

  // 更新 file_index
  db.prepare(`
    INSERT INTO file_index (path, mtime, content_hash) VALUES (?, ?, ?)
  `).run(absPath, mtime, hash);

  return { skipped: false, chunks: textChunks.length };
}

// ─── 支持的文件扩展名 ─────────────────────────────────────────────────────────
const SUPPORTED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.md', '.json', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.zsh',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.cache',
  'coverage', '.pnpm', '__pycache__',
]);

/** 递归收集目录下所有支持文件 */
function collectFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (entry.isFile() && SUPPORTED_EXTS.has(extname(entry.name))) {
      results.push(full);
    }
  }
  return results;
}

// ─── 索引整个仓库 ─────────────────────────────────────────────────────────────
export interface IndexRepoOpts {
  incremental?: boolean;
  commitSha?: string;
  onProgress?: (path: string, result: { skipped: boolean; chunks: number }) => void;
}

export interface IndexRepoResult {
  total: number;
  indexed: number;
  skipped: number;
  totalChunks: number;
  mode: VectorMode;
}

export async function indexRepo(
  db: SqliteHandle,
  root: string,
  opts: IndexRepoOpts = {}
): Promise<IndexRepoResult> {
  initSchema(db);
  const { mode } = await detectCapabilities();

  const files = collectFiles(resolve(root));
  let indexed = 0, skipped = 0, totalChunks = 0;

  for (const file of files) {
    const result = await indexFile(db, file, {
      incremental: opts.incremental,
      commitSha: opts.commitSha,
    });
    if (result.skipped) {
      skipped++;
    } else {
      indexed++;
      totalChunks += result.chunks;
    }
    opts.onProgress?.(file, result);
  }

  return { total: files.length, indexed, skipped, totalChunks, mode };
}

// ─── 向量搜索 ─────────────────────────────────────────────────────────────────
export interface SearchResult {
  chunk_id: number;
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  score: number;
}

/** 向量相似度搜索（内存余弦计算） */
export async function searchVec(
  db: SqliteHandle,
  query: string,
  k = 10
): Promise<SearchResult[]> {
  const { embed } = await detectCapabilities();
  const qvec = await embed(query);

  // 取所有向量（小数据量 OK；大数据量应分批或用 ANN 索引）
  const rows = db.prepare(`
    SELECT cd.chunk_id, cd.vec, cm.path, cm.start_line, cm.end_line, c.text
    FROM chunks_dense cd
    JOIN chunk_meta cm ON cm.chunk_id = cd.chunk_id
    JOIN chunks c ON c.chunk_id = cd.chunk_id
  `).all() as Array<{
    chunk_id: number;
    vec: Buffer;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
  }>;

  const scored = rows.map(row => ({
    chunk_id: row.chunk_id,
    path: row.path,
    start_line: row.start_line,
    end_line: row.end_line,
    text: row.text,
    score: cosine(qvec, blobToVec(row.vec)),
  }));

  // 按相似度降序，返回 top-k
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ─── 关键词全文搜索（FTS5） ───────────────────────────────────────────────────
/** FTS5 全文检索 */
export function searchKeyword(
  db: SqliteHandle,
  query: string,
  k = 10
): SearchResult[] {
  // FTS5 MATCH 查询，用 BM25 分数排序（越小越相关）
  const rows = db.prepare(`
    SELECT cf.rowid AS chunk_id,
           cm.path, cm.start_line, cm.end_line,
           c.text,
           bm25(chunks_fts) AS score
    FROM chunks_fts cf
    JOIN chunk_meta cm ON cm.chunk_id = cf.rowid
    JOIN chunks c ON c.chunk_id = cf.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `).all(query, k) as Array<{
    chunk_id: number;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    score: number;
  }>;

  // 把 BM25 score（负数，越接近 0 越好）转为正数相似度
  return rows.map(r => ({
    ...r,
    score: -r.score, // 翻转为越大越好
  }));
}

// ─── 混合搜索 ─────────────────────────────────────────────────────────────────
/**
 * 混合搜索：FTS5 关键词 + 向量余弦，加权合并。
 * vec_weight 默认 0.5，即各占 50%。
 */
export async function searchHybrid(
  db: SqliteHandle,
  query: string,
  k = 10,
  vecWeight = 0.5
): Promise<SearchResult[]> {
  const [vecResults, kwResults] = await Promise.all([
    searchVec(db, query, k * 2),
    Promise.resolve(searchKeyword(db, query, k * 2)),
  ]);

  // 合并去重，按加权分数排序
  const map = new Map<number, SearchResult & { combined: number }>();

  const maxVec = vecResults[0]?.score ?? 1;
  const maxKw = kwResults[0]?.score ?? 1;

  for (const r of vecResults) {
    const norm = maxVec > 0 ? r.score / maxVec : 0;
    map.set(r.chunk_id, { ...r, score: r.score, combined: norm * vecWeight });
  }
  for (const r of kwResults) {
    const norm = maxKw > 0 ? r.score / maxKw : 0;
    const existing = map.get(r.chunk_id);
    if (existing) {
      existing.combined += norm * (1 - vecWeight);
    } else {
      map.set(r.chunk_id, { ...r, score: r.score, combined: norm * (1 - vecWeight) });
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b.combined - a.combined)
    .slice(0, k)
    .map(({ combined: _c, ...rest }) => ({ ...rest, score: _c }));
}

// ─── 当前向量模式（供调用方感知） ─────────────────────────────────────────────
export async function getVectorMode(): Promise<VectorMode> {
  const { mode } = await detectCapabilities();
  return mode;
}
