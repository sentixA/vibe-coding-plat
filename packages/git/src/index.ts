/**
 * @vcp/git — Git 工作流集成库
 *
 * 通过 `git config core.hooksPath .githooks` 注册 hooks 目录，
 * 比 simple-git-hooks 更轻量、可移植，无需额外包。
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** installHooks 的返回值类型 */
export interface InstallResult {
  repoRoot: string;
  hooksPath: string;
  /** true 表示本次调用实际写入了配置（幂等：已设置相同值时也视为成功） */
  configured: boolean;
}

/** uninstall 的返回值类型 */
export interface UninstallResult {
  repoRoot: string;
  unset: boolean;
}

/** status 的返回值类型 */
export interface StatusResult {
  repoRoot: string;
  /** core.hooksPath 当前值，undefined 表示未设置 */
  hooksPath: string | undefined;
  /** .githooks/ 目录是否存在 */
  hooksDir: boolean;
  /** commit-msg hook 是否可执行 */
  commitMsgOk: boolean;
  /** pre-commit hook 是否可执行 */
  preCommitOk: boolean;
}

/**
 * 在指定 git 仓库根目录注册 .githooks/ 为 hooksPath。
 * 幂等操作，可重复调用。
 *
 * @param repoRoot git 仓库根目录绝对路径，默认为 process.cwd()
 */
export async function installHooks(repoRoot: string = process.cwd()): Promise<InstallResult> {
  const hooksPath = '.githooks';
  const absHooksDir = resolve(repoRoot, hooksPath);

  // 校验 .githooks 目录存在（防止在错误目录调用）
  if (!existsSync(absHooksDir)) {
    throw new Error(
      `[git] .githooks/ 目录不存在: ${absHooksDir}。` +
      `请确认 repoRoot 正确，或先创建 .githooks/ 目录。`
    );
  }

  // 使用 git config 设置 core.hooksPath（--local 作用于当前仓库）
  await execa('git', ['config', '--local', 'core.hooksPath', hooksPath], {
    cwd: repoRoot,
    stdio: 'pipe',
  });

  return {
    repoRoot,
    hooksPath,
    configured: true,
  };
}

/**
 * 取消注册 hooks（unset core.hooksPath），恢复 git 默认行为。
 * 若原本未设置，graceful 返回 unset: false。
 *
 * @param repoRoot git 仓库根目录绝对路径，默认为 process.cwd()
 */
export async function uninstall(repoRoot: string = process.cwd()): Promise<UninstallResult> {
  try {
    await execa('git', ['config', '--local', '--unset', 'core.hooksPath'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    return { repoRoot, unset: true };
  } catch (err: unknown) {
    // exit code 5 = key not set，属于正常情况
    const exitCode = (err as { exitCode?: number }).exitCode;
    if (exitCode === 5) {
      return { repoRoot, unset: false };
    }
    throw err;
  }
}

/**
 * 查询当前 hooks 配置状态，不修改任何配置。
 *
 * @param repoRoot git 仓库根目录绝对路径，默认为 process.cwd()
 */
export async function status(repoRoot: string = process.cwd()): Promise<StatusResult> {
  // 读取 core.hooksPath 当前值
  let hooksPath: string | undefined;
  try {
    const result = await execa('git', ['config', '--get', 'core.hooksPath'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    hooksPath = result.stdout.trim() || undefined;
  } catch {
    // 未设置时 git config --get 返回 exit code 1
    hooksPath = undefined;
  }

  const absHooksDir = resolve(repoRoot, '.githooks');
  const hooksDir = existsSync(absHooksDir);
  const commitMsgOk = existsSync(resolve(absHooksDir, 'commit-msg'));
  const preCommitOk = existsSync(resolve(absHooksDir, 'pre-commit'));

  return {
    repoRoot,
    hooksPath,
    hooksDir,
    commitMsgOk,
    preCommitOk,
  };
}
