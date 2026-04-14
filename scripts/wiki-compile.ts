/**
 * wiki-compile CLI 入口（M4）
 * 用法：
 *   pnpm run wiki:compile <slug>
 *   pnpm run wiki:compile <slug> --from-git
 *   pnpm run wiki:compile <slug> --json
 *   pnpm run wiki:compile --help
 */

import { cac } from 'cac';
import { compileFeature } from '@vcp/wiki';
import { log, jsonOut } from './_shared/log.js';
import { REPO_ROOT } from './_shared/paths.js';

const cli = cac('wiki:compile');

cli
  .command('<slug>', '把 .specify/features/<slug>/ 增量编译到 .wiki/')
  .option('--from-git', '同时附带当前 git diff 写入 topic', { default: false })
  .option('--json', '以 JSON 格式输出结果', { default: false })
  .action(async (slug: string, opts: { fromGit: boolean; json: boolean }) => {
    try {
      const result = await compileFeature(slug, {
        repoRoot: REPO_ROOT,
        fromGit: opts.fromGit,
      });

      if (opts.json) {
        jsonOut(result);
      } else {
        log.ok(`topic 已写入: ${result.topicPath}`);
        if (result.logLine) {
          log.ok(`log 追加: ${result.logLine}`);
        } else {
          log.info(`slug=${slug} hash=${result.contentHash} 已存在，跳过（幂等）`);
        }
      }
    } catch (err) {
      log.error(`wiki:compile 失败: ${(err as Error).message}`);
      process.exit(1);
    }
  });

cli.help();
cli.version('0.0.0');

cli.parse();
