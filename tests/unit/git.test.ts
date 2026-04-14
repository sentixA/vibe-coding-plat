/**
 * tests/unit/git.test.ts
 *
 * 验证 @vcp/git 的 installHooks、uninstall、status 函数。
 * 所有测试在临时 git 仓库内运行，互不干扰。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { installHooks, uninstall, status } from '../../packages/git/src/index.js';

// 主工作区根目录（commitlint 已安装于此）
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 使用 node:child_process 避免在根 vitest 里解析 execa（execa 只在 packages/git/node_modules）
const execFile = promisify(execFileCb);

/** 同 execa 用法的轻量包装：抛出 exit != 0 的错误 */
async function run(
  cmd: string,
  args: string[],
  options?: { cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
  return execFile(cmd, args, { cwd: options?.cwd, encoding: 'utf8' });
}

/** 在临时目录中初始化一个 git 仓库，并准备好 .githooks/ 目录和两个 hook 脚本 */
async function createTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vcp-git-test-'));

  // 初始化 git 仓库
  await run('git', ['init', '--initial-branch=main'], { cwd: dir });
  // 设置最小 git 配置（避免 CI 报"user not configured"）
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Test User'], { cwd: dir });

  // 创建 .githooks/ 目录和必要的 hook 文件
  const hooksDir = join(dir, '.githooks');
  await mkdir(hooksDir, { recursive: true });

  const commitMsg = join(hooksDir, 'commit-msg');
  const preCommit = join(hooksDir, 'pre-commit');

  await writeFile(commitMsg, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await writeFile(preCommit, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(commitMsg, 0o755);
  await chmod(preCommit, 0o755);

  return dir;
}

/** 写一个 commitlint config（最简化，只允许 feat/fix 类型）到临时仓库 */
async function writeCommitlintConfig(dir: string): Promise<void> {
  const config = `
module.exports = {
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'chore', 'docs', 'refactor', 'test']],
    'type-empty': [2, 'never'],
    'subject-empty': [2, 'never'],
  },
};
`;
  await writeFile(join(dir, 'commitlint.config.cjs'), config, 'utf8');
}

/** 读取 git config 的 core.hooksPath 值 */
async function getHooksPath(dir: string): Promise<string | undefined> {
  try {
    const result = await run('git', ['config', '--get', 'core.hooksPath'], { cwd: dir });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** 清理临时目录 */
async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────────────
// 测试：installHooks
// ────────────────────────────────────────────────────────────────────────────

describe('installHooks', () => {
  let tmpRepo: string;

  beforeEach(async () => {
    tmpRepo = await createTempRepo();
  });

  afterEach(async () => {
    await cleanup(tmpRepo);
  });

  it('installHooks 后 git config --get core.hooksPath 应等于 .githooks', async () => {
    await installHooks(tmpRepo);
    const hooksPath = await getHooksPath(tmpRepo);
    expect(hooksPath).toBe('.githooks');
  });

  it('installHooks 返回值的 hooksPath 字段应为 .githooks', async () => {
    const result = await installHooks(tmpRepo);
    expect(result.hooksPath).toBe('.githooks');
    expect(result.configured).toBe(true);
    expect(result.repoRoot).toBe(tmpRepo);
  });

  it('installHooks 幂等：重复调用不应抛错', async () => {
    await installHooks(tmpRepo);
    await installHooks(tmpRepo); // 第二次调用应正常
    const hooksPath = await getHooksPath(tmpRepo);
    expect(hooksPath).toBe('.githooks');
  });

  it('若 .githooks/ 不存在应抛出 Error', async () => {
    // 创建一个没有 .githooks 的临时仓库
    const bare = await mkdtemp(join(tmpdir(), 'vcp-git-bare-'));
    try {
      await run('git', ['init', '--initial-branch=main'], { cwd: bare });
      await expect(installHooks(bare)).rejects.toThrow('.githooks/');
    } finally {
      await cleanup(bare);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 测试：uninstall
// ────────────────────────────────────────────────────────────────────────────

describe('uninstall', () => {
  let tmpRepo: string;

  beforeEach(async () => {
    tmpRepo = await createTempRepo();
  });

  afterEach(async () => {
    await cleanup(tmpRepo);
  });

  it('install 后 uninstall，core.hooksPath 应被清除', async () => {
    await installHooks(tmpRepo);
    await uninstall(tmpRepo);
    const hooksPath = await getHooksPath(tmpRepo);
    expect(hooksPath).toBeUndefined();
  });

  it('未安装时 uninstall 应返回 unset: false 而非抛错', async () => {
    const result = await uninstall(tmpRepo);
    expect(result.unset).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 测试：status
// ────────────────────────────────────────────────────────────────────────────

describe('status', () => {
  let tmpRepo: string;

  beforeEach(async () => {
    tmpRepo = await createTempRepo();
  });

  afterEach(async () => {
    await cleanup(tmpRepo);
  });

  it('安装前 hooksPath 应为 undefined，安装后应为 .githooks', async () => {
    const before = await status(tmpRepo);
    expect(before.hooksPath).toBeUndefined();

    await installHooks(tmpRepo);

    const after = await status(tmpRepo);
    expect(after.hooksPath).toBe('.githooks');
    expect(after.hooksDir).toBe(true);
    expect(after.commitMsgOk).toBe(true);
    expect(after.preCommitOk).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 测试：commit-msg hook 对合规 / 不合规 commit 的行为
// ────────────────────────────────────────────────────────────────────────────

describe('commit-msg hook 行为', () => {
  let tmpRepo: string;

  beforeEach(async () => {
    tmpRepo = await createTempRepo();
    await writeCommitlintConfig(tmpRepo);

    // 覆盖 .githooks/commit-msg，用主工作区的 commitlint 绝对路径
    // 避免临时仓库里没有 node_modules/commitlint 时 npx 尝试安装失败的问题
    const commitlintBin = join(REPO_ROOT, 'node_modules', '.bin', 'commitlint');
    const hookContent = `#!/usr/bin/env bash
set -euo pipefail
"${commitlintBin}" --edit "$1"
`;
    await writeFile(join(tmpRepo, '.githooks', 'commit-msg'), hookContent, 'utf8');
    await chmod(join(tmpRepo, '.githooks', 'commit-msg'), 0o755);

    // 注册 hooks
    await installHooks(tmpRepo);

    // 创建初始提交（绕过 hook），确保仓库有 HEAD
    await writeFile(join(tmpRepo, 'README.md'), '# test\n', 'utf8');
    await run('git', ['add', '.'], { cwd: tmpRepo });
    await run('git', ['commit', '--no-verify', '-m', 'chore: init'], { cwd: tmpRepo });
  });

  afterEach(async () => {
    await cleanup(tmpRepo);
  });

  it('合规的 conventional commit（feat: 开头）应该被接受', async () => {
    await writeFile(join(tmpRepo, 'a.txt'), 'hello\n', 'utf8');
    await run('git', ['add', 'a.txt'], { cwd: tmpRepo });

    // 应不抛错（exit 0）
    await expect(
      run('git', ['commit', '-m', 'feat: add hello file'], { cwd: tmpRepo })
    ).resolves.toBeDefined();
  });

  it('不合规的 commit 消息（无 type: 前缀）应该被拒绝', async () => {
    await writeFile(join(tmpRepo, 'b.txt'), 'world\n', 'utf8');
    await run('git', ['add', 'b.txt'], { cwd: tmpRepo });

    // 应抛错（exit != 0）
    await expect(
      run('git', ['commit', '-m', 'bad message without type'], { cwd: tmpRepo })
    ).rejects.toThrow();
  });
});
