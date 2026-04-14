/**
 * @vcp/wiki — spec-kit 兼容的 wiki 增量编译库
 *
 * 核心函数：compileFeature(slug, opts)
 * - 读取 .specify/features/<slug>/{spec,plan,tasks}.md
 * - 可选读取 git diff（--from-git）
 * - 生成或更新 .wiki/topics/<slug>.md
 * - 追加一行到 .wiki/log.md（slug + content_hash 判重，保证幂等）
 * - 不调用任何 LLM
 *
 * spec-kit 安装方式（外部 Python CLI）：
 *   pipx install spec-kit
 * 本仓库只产出兼容 spec-kit 的目录格式（.specify/features/<slug>/）。
 */

import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';

// ──────────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────────

export interface CompileOptions {
  /** 仓库根目录（绝对路径）；缺省使用 process.cwd() */
  repoRoot?: string;
  /** 是否附带 git diff（当前 HEAD 的 staged+unstaged diff） */
  fromGit?: boolean;
  /**
   * 注入测试用临时路径（用于单元测试隔离）
   * 若提供此对象，将覆盖 SPECIFY_DIR / WIKI_DIR / WIKI_LOG / WIKI_TOPICS 四条路径
   */
  _testPaths?: {
    specifyDir: string;
    wikiDir: string;
    wikiLog: string;
    wikiTopics: string;
  };
}

export interface CompileResult {
  /** topic 文件绝对路径 */
  topicPath: string;
  /** log.md 中追加的行（若已存在则为 null，表示幂等跳过） */
  logLine: string | null;
  /** 本次编译的 content hash（sha1 前 8 位） */
  contentHash: string;
}

// ──────────────────────────────────────────────────
// 辅助：安全读文件，不存在返回空字符串
// ──────────────────────────────────────────────────

function safeRead(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// ──────────────────────────────────────────────────
// 辅助：计算内容哈希（sha1 前 8 位）
// ──────────────────────────────────────────────────

export function contentHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

// ──────────────────────────────────────────────────
// 辅助：从 .specify/features/<slug>/ 读取三文件
// ──────────────────────────────────────────────────

interface FeatureDocs {
  spec: string;
  plan: string;
  tasks: string;
  diff: string;
}

function loadFeatureDocs(featDir: string, fromGit: boolean, repoRoot: string): FeatureDocs {
  const spec  = safeRead(resolve(featDir, 'spec.md'));
  const plan  = safeRead(resolve(featDir, 'plan.md'));
  const tasks = safeRead(resolve(featDir, 'tasks.md'));

  let diff = '';
  if (fromGit) {
    try {
      // 同时获取 staged 和 unstaged 变更
      diff = execSync('git diff HEAD', { cwd: repoRoot, encoding: 'utf8' });
    } catch {
      diff = '';
    }
  }

  return { spec, plan, tasks, diff };
}

// ──────────────────────────────────────────────────
// 辅助：生成 topic 文件正文（plain string template）
// ──────────────────────────────────────────────────

function renderTopicSection(slug: string, docs: FeatureDocs, hash: string, date: string): string {
  const lines: string[] = [];

  lines.push(`## [${date}] ${slug} (hash: ${hash})`);
  lines.push('');

  if (docs.spec) {
    lines.push('### Spec');
    lines.push('');
    lines.push(docs.spec.trim());
    lines.push('');
  }

  if (docs.plan) {
    lines.push('### Plan');
    lines.push('');
    lines.push(docs.plan.trim());
    lines.push('');
  }

  if (docs.tasks) {
    lines.push('### Tasks');
    lines.push('');
    lines.push(docs.tasks.trim());
    lines.push('');
  }

  if (docs.diff) {
    lines.push('### Git Diff');
    lines.push('');
    lines.push('```diff');
    // 截断超大 diff，避免 topic 文件膨胀
    const truncated = docs.diff.length > 8000
      ? docs.diff.slice(0, 8000) + '\n... (truncated)'
      : docs.diff;
    lines.push(truncated.trim());
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────
// 辅助：生成新 topic 文件全文
// ──────────────────────────────────────────────────

function renderNewTopic(slug: string, section: string): string {
  return [
    `# Topic: ${slug}`,
    '',
    '<!-- 由 wiki:compile 自动生成，可人工补充 -->',
    '',
    '## History',
    '',
    section,
  ].join('\n');
}

// ──────────────────────────────────────────────────
// 辅助：合并到已存在的 topic 文件（保留 ## History，追加新节）
// ──────────────────────────────────────────────────

function mergeIntoTopic(existing: string, newSection: string): string {
  const HISTORY_MARKER = '## History';
  const idx = existing.indexOf(HISTORY_MARKER);

  if (idx === -1) {
    // 文件里没有 ## History，直接追加到末尾
    return existing.trimEnd() + '\n\n## History\n\n' + newSection;
  }

  // 在 ## History 之后追加新节
  const before = existing.slice(0, idx + HISTORY_MARKER.length);
  const after  = existing.slice(idx + HISTORY_MARKER.length);

  return before + '\n\n' + newSection + after.replace(/^\n+/, '\n');
}

// ──────────────────────────────────────────────────
// 辅助：判断 log.md 中是否已存在相同 slug+hash 行
// ──────────────────────────────────────────────────

function logAlreadyExists(logContent: string, slug: string, hash: string): boolean {
  const marker = `${slug} :: `;
  // 找到同一 slug 的所有行，看是否有相同 hash
  return logContent.split('\n').some(line => {
    return line.includes(marker) && line.includes(`(hash:${hash})`);
  });
}

// ──────────────────────────────────────────────────
// 核心导出：compileFeature
// ──────────────────────────────────────────────────

export async function compileFeature(
  slug: string,
  opts: CompileOptions = {},
): Promise<CompileResult> {
  const repoRoot  = opts.repoRoot ?? process.cwd();
  const fromGit   = opts.fromGit ?? false;

  // 路径解析（测试注入优先）
  const specifyDir  = opts._testPaths?.specifyDir  ?? resolve(repoRoot, '.specify');
  const wikiTopics  = opts._testPaths?.wikiTopics  ?? resolve(repoRoot, '.wiki', 'topics');
  const wikiLog     = opts._testPaths?.wikiLog     ?? resolve(repoRoot, '.wiki', 'log.md');
  const wikiDir     = opts._testPaths?.wikiDir     ?? resolve(repoRoot, '.wiki');

  const featDir     = resolve(specifyDir, 'features', slug);
  const topicPath   = resolve(wikiTopics, `${slug}.md`);

  // 读取 feature 文档
  const docs = loadFeatureDocs(featDir, fromGit, repoRoot);

  // 计算 content hash（基于 spec+plan+tasks+diff 的联合内容）
  const combined  = [docs.spec, docs.plan, docs.tasks, docs.diff].join('\n---\n');
  const hash      = contentHash(combined);

  // 确保目录存在
  mkdirSync(wikiTopics, { recursive: true });
  mkdirSync(dirname(wikiLog), { recursive: true });

  // 生成当前日期（ISO 日期部分）
  const date = new Date().toISOString().slice(0, 10);

  // 构造本次要插入的 history 节
  const section = renderTopicSection(slug, docs, hash, date);

  // ── 写 topic 文件（merge 模式：保留 ## History 并追加，不覆盖） ──
  let topicContent: string;
  if (existsSync(topicPath)) {
    const existing = readFileSync(topicPath, 'utf8');

    // 检查是否已存在相同 hash 的节（幂等：相同内容不重复写入）
    const hashMarker = `(hash: ${hash})`;
    if (existing.includes(hashMarker)) {
      // 幂等：topic 已是最新，仅检查 log
      topicContent = existing;
    } else {
      topicContent = mergeIntoTopic(existing, section);
      writeFileSync(topicPath, topicContent, 'utf8');
    }
  } else {
    topicContent = renderNewTopic(slug, section);
    writeFileSync(topicPath, topicContent, 'utf8');
  }

  // ── 追加 log.md 行（slug+hash 判重，保证幂等） ──
  let logLine: string | null = null;
  const existingLog = safeRead(wikiLog);

  if (!logAlreadyExists(existingLog, slug, hash)) {
    // 提取 spec 第一行作为摘要（去掉 # 前缀）
    const summary = docs.spec
      .split('\n')
      .map(l => l.replace(/^#+\s*/, '').trim())
      .find(l => l.length > 0) || slug;

    logLine = `- ${date} ${slug} :: ${summary} (hash:${hash})`;

    // 如果 log.md 不存在或没有以换行结尾，先补换行
    const needNewline = existingLog.length > 0 && !existingLog.endsWith('\n');
    appendFileSync(wikiLog, (needNewline ? '\n' : '') + logLine + '\n', 'utf8');
  }

  return { topicPath, logLine, contentHash: hash };
}
