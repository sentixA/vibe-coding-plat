/**
 * wiki.test.ts — @vcp/wiki 单元测试
 *
 * 测试策略：
 * - 使用 os.tmpdir() 下的临时目录隔离，不污染真实 .wiki/
 * - 构造 fixture feature 目录（含 spec/plan/tasks 三 md）
 * - 验证 compileFeature 的输出：topic 文件内容、log 行追加、幂等性
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { compileFeature, contentHash } from '@vcp/wiki';

// ──────────────────────────────────────────────────
// 辅助：创建隔离的临时目录结构
// ──────────────────────────────────────────────────

function makeTmpDirs() {
  const base       = mkdtempSync(resolve(tmpdir(), 'vcp-wiki-test-'));
  const specifyDir = resolve(base, '.specify');
  const wikiDir    = resolve(base, '.wiki');
  const wikiTopics = resolve(wikiDir, 'topics');
  const wikiLog    = resolve(wikiDir, 'log.md');

  mkdirSync(specifyDir, { recursive: true });
  mkdirSync(wikiTopics, { recursive: true });

  // 初始化空 log.md
  writeFileSync(wikiLog, '# Wiki Change Log\n\n', 'utf8');

  return { base, specifyDir, wikiDir, wikiTopics, wikiLog };
}

function makeFeatureFixture(
  specifyDir: string,
  slug: string,
  spec = '# hello-world\n\nEcho CLI 功能规格',
  plan = '## 实施计划\n\n1. 创建 index.ts\n2. 注册 echo 命令',
  tasks = '- [ ] 创建入口文件\n- [ ] 添加测试',
) {
  const featDir = resolve(specifyDir, 'features', slug);
  mkdirSync(featDir, { recursive: true });
  writeFileSync(resolve(featDir, 'spec.md'),   spec,  'utf8');
  writeFileSync(resolve(featDir, 'plan.md'),   plan,  'utf8');
  writeFileSync(resolve(featDir, 'tasks.md'),  tasks, 'utf8');
  return featDir;
}

// ──────────────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────────────

describe('@vcp/wiki — compileFeature', () => {
  let dirs: ReturnType<typeof makeTmpDirs>;

  beforeEach(() => {
    dirs = makeTmpDirs();
  });

  // ── 测试 1：首次编译生成 topic 文件 ──────────────

  it('首次编译：生成 .wiki/topics/<slug>.md', async () => {
    makeFeatureFixture(dirs.specifyDir, 'hello-world');

    const result = await compileFeature('hello-world', {
      repoRoot: dirs.base,
      _testPaths: {
        specifyDir: dirs.specifyDir,
        wikiDir:    dirs.wikiDir,
        wikiLog:    dirs.wikiLog,
        wikiTopics: dirs.wikiTopics,
      },
    });

    expect(existsSync(result.topicPath)).toBe(true);

    const content = readFileSync(result.topicPath, 'utf8');

    // topic 文件应包含 slug 标题
    expect(content).toContain('Topic: hello-world');
    // 应包含 ## History 段
    expect(content).toContain('## History');
    // 应包含 spec 内容
    expect(content).toContain('Echo CLI 功能规格');
    // 应包含 plan 内容
    expect(content).toContain('实施计划');
    // 应包含 tasks 内容
    expect(content).toContain('创建入口文件');
    // 应包含 content hash
    expect(content).toContain(result.contentHash);
  });

  // ── 测试 2：log.md 追加行 ──────────────────────

  it('首次编译：向 log.md 追加一行', async () => {
    makeFeatureFixture(dirs.specifyDir, 'hello-world');

    const result = await compileFeature('hello-world', {
      repoRoot: dirs.base,
      _testPaths: {
        specifyDir: dirs.specifyDir,
        wikiDir:    dirs.wikiDir,
        wikiLog:    dirs.wikiLog,
        wikiTopics: dirs.wikiTopics,
      },
    });

    expect(result.logLine).not.toBeNull();

    const logContent = readFileSync(dirs.wikiLog, 'utf8');
    expect(logContent).toContain('hello-world');
    expect(logContent).toContain(result.contentHash);
    // 格式：- YYYY-MM-DD hello-world :: ...
    expect(logContent).toMatch(/- \d{4}-\d{2}-\d{2} hello-world ::/);
  });

  // ── 测试 3：幂等性 — 相同内容重跑不重复写入 ─────

  it('幂等：相同内容重跑，topic 只追加一次 history 节，log 只加一行', async () => {
    makeFeatureFixture(dirs.specifyDir, 'hello-world');

    const opts = {
      repoRoot: dirs.base,
      _testPaths: {
        specifyDir: dirs.specifyDir,
        wikiDir:    dirs.wikiDir,
        wikiLog:    dirs.wikiLog,
        wikiTopics: dirs.wikiTopics,
      },
    };

    // 第一次
    const r1 = await compileFeature('hello-world', opts);
    expect(r1.logLine).not.toBeNull();

    // 第二次（完全相同内容）
    const r2 = await compileFeature('hello-world', opts);
    expect(r2.logLine).toBeNull(); // 幂等跳过，不重复追加

    // log.md 里 hello-world 只应有一行
    const logContent = readFileSync(dirs.wikiLog, 'utf8');
    const matchLines = logContent.split('\n').filter(l => l.includes('hello-world'));
    expect(matchLines.length).toBe(1);

    // topic 文件里同一 hash 的节也只出现一次
    const topicContent = readFileSync(r1.topicPath, 'utf8');
    const hashCount = (topicContent.match(new RegExp(r1.contentHash, 'g')) || []).length;
    expect(hashCount).toBeGreaterThanOrEqual(1);
    // 不应该有两个相同的 ## [日期] hello-world (hash: ...) 段
    const sectionHeaders = topicContent.split('\n').filter(l =>
      l.startsWith('## [') && l.includes(`(hash: ${r1.contentHash})`)
    );
    expect(sectionHeaders.length).toBe(1);
  });

  // ── 测试 4：内容变化时追加新节（merge 保留 History）──

  it('内容变化：已有 topic 文件时追加新节，保留旧 ## History', async () => {
    // 第一次编译
    makeFeatureFixture(dirs.specifyDir, 'my-feat', '# my-feat\n\n版本一规格');

    const opts = {
      repoRoot: dirs.base,
      _testPaths: {
        specifyDir: dirs.specifyDir,
        wikiDir:    dirs.wikiDir,
        wikiLog:    dirs.wikiLog,
        wikiTopics: dirs.wikiTopics,
      },
    };

    const r1 = await compileFeature('my-feat', opts);
    const hash1 = r1.contentHash;

    // 修改 spec，触发新内容
    writeFileSync(
      resolve(dirs.specifyDir, 'features', 'my-feat', 'spec.md'),
      '# my-feat\n\n版本二规格（重大更新）',
      'utf8',
    );

    const r2 = await compileFeature('my-feat', opts);
    const hash2 = r2.contentHash;

    // 两次 hash 应不同
    expect(hash1).not.toBe(hash2);

    // topic 文件应同时包含两个版本的 hash（保留历史）
    const topicContent = readFileSync(r1.topicPath, 'utf8');
    expect(topicContent).toContain(hash1);
    expect(topicContent).toContain(hash2);
    expect(topicContent).toContain('版本一规格');
    expect(topicContent).toContain('版本二规格');

    // log.md 应有两行
    const logContent = readFileSync(dirs.wikiLog, 'utf8');
    const matchLines = logContent.split('\n').filter(l => l.includes('my-feat'));
    expect(matchLines.length).toBe(2);
  });

  // ── 测试 5：contentHash 辅助函数确定性 ────────────

  it('contentHash：相同输入返回相同结果（确定性）', () => {
    const h1 = contentHash('hello world');
    const h2 = contentHash('hello world');
    const h3 = contentHash('different');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    // 格式：8 位十六进制
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
  });

  // ── 测试 6：feature 目录不存在时（空内容）也能正常运行 ─

  it('feature 目录不存在：仍能生成 topic，内容为空骨架', async () => {
    // 故意不创建 fixture，slug 对应目录不存在
    const result = await compileFeature('nonexistent-slug', {
      repoRoot: dirs.base,
      _testPaths: {
        specifyDir: dirs.specifyDir,
        wikiDir:    dirs.wikiDir,
        wikiLog:    dirs.wikiLog,
        wikiTopics: dirs.wikiTopics,
      },
    });

    // 不应抛出，应能正常完成
    expect(existsSync(result.topicPath)).toBe(true);
    const content = readFileSync(result.topicPath, 'utf8');
    expect(content).toContain('Topic: nonexistent-slug');
  });
});
