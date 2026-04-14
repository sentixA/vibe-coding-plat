/**
 * sandbox-run.ts — 沙箱执行 CLI 入口（M6）
 *
 * 用法：
 *   pnpm run sandbox -- <cmd> [args...]
 *   pnpm run sandbox --mode dry -- echo hi
 *   pnpm run sandbox --allow-net -- curl https://example.com
 *
 * 把 `--` 后的整段命令交给 runInSandbox。
 * 支持 --mode auto|dry|bwrap|docker
 */

import cac from 'cac';
import { runInSandbox, type SandboxMode } from '@vcp/sandbox';
import { log } from './_shared/log.js';
import { REPO_ROOT } from './_shared/paths.js';

const cli = cac('sandbox');

cli
  .command('[...passthrough]', '在沙箱内执行命令（-- 后跟命令）')
  .option('--mode <mode>', '沙箱模式: auto | dry | bwrap | docker', { default: 'auto' })
  .option('--allow-net', '解禁网络（默认禁止）', { default: false })
  .option('--read-only-root', '强制只读 /（bwrap 模式默认已启用）', { default: true })
  .option('--json', '以 JSON 格式输出结果', { default: false })
  .action(async (_passthrough: string[], opts: {
    mode: string;
    allowNet: boolean;
    readOnlyRoot: boolean;
    json: boolean;
    '--': string[];
  }) => {
    // cac 把 -- 后的内容放在 options['--'] 里
    const rest: string[] = (opts as unknown as Record<string, string[]>)['--'] ?? [];

    if (rest.length === 0) {
      log.error('请在 -- 后面指定要执行的命令。示例：sandbox -- echo hi');
      process.exit(1);
    }

    const [cmd, ...args] = rest;

    log.info(`沙箱模式: ${opts.mode}，命令: ${[cmd, ...args].join(' ')}`);

    const result = await runInSandbox(cmd, args, {
      mode: opts.mode as SandboxMode,
      repoPath: REPO_ROOT,
      allowNet: opts.allowNet,
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
    }

    process.exit(result.exitCode ?? 0);
  });

cli.help();
cli.version('0.0.0');

// 解析原始 process.argv，cac 支持 -- 分隔符
cli.parse(process.argv, { run: false });

// 如果没有子命令匹配（只传了 --help / --version），正常执行
await cli.runMatchedCommand();
