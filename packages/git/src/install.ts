/**
 * install.ts — prepare 脚本入口
 *
 * 由根 package.json 的 "prepare" 脚本调用：
 *   tsx packages/git/src/install.ts
 *
 * 自动注册 .githooks/ 为 core.hooksPath，使 commit-msg / pre-commit 生效。
 * 幂等，重复运行安全。
 *
 * 注意：CI 环境（如 GitHub Actions）通常设置 CI=true，
 * 为避免强制安装干扰 CI 流程，CI 环境下跳过安装。
 */

import { installHooks } from './index.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// packages/git/src/ -> packages/git/ -> vibe-coding-plat/（仓库根）
const repoRoot = resolve(here, '..', '..', '..');

// CI 环境跳过，避免干扰 CI hooks 配置
if (process.env.CI) {
  process.stdout.write('[git] CI 环境，跳过 installHooks\n');
  process.exit(0);
}

try {
  const result = await installHooks(repoRoot);
  process.stdout.write(
    `[git] hooks 已注册：git config core.hooksPath = ${result.hooksPath}\n`
  );
} catch (err: unknown) {
  // 非 git 仓库（如纯 npm 包安装场景）时降级为警告，不阻断 install
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[git] 警告: installHooks 失败，跳过（${msg}）\n`);
  process.exit(0);
}
