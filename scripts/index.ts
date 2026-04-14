/**
 * index.ts — 代码向量索引 CLI 入口（M3）
 *
 * 子命令：
 *   index [--incremental] [--root <path>]
 *
 * 扫描 ts/js/py/md 等代码文件，按行/块切割，写到 VECTORS_DB。
 */

import { cac } from 'cac';
import { openSqlite } from './_shared/db.js';
import { log, jsonOut } from './_shared/log.js';
import { VECTORS_DB, REPO_ROOT } from './_shared/paths.js';
import { initSchema, indexRepo } from '@vcp/vectors';

const cli = cac('index');

cli
  .command('[root]', '对指定目录（默认仓库根）建代码向量索引')
  .option('--incremental', '增量模式：跳过未变化的文件', { default: false })
  .option('--root <path>', '要索引的根目录（默认仓库根）')
  .option('--json', '以 JSON 格式输出结果')
  .action(async (rootArg: string | undefined, opts: {
    incremental: boolean;
    root?: string;
    json: boolean;
  }) => {
    const root = opts.root ?? rootArg ?? REPO_ROOT;
    log.info(`开始索引：${root}（增量=${opts.incremental}）`);

    const db = await openSqlite(VECTORS_DB);
    initSchema(db);

    const result = await indexRepo(db, root, {
      incremental: opts.incremental,
      onProgress: (filePath, res) => {
        if (!res.skipped) {
          log.info(`  已索引 ${filePath}（${res.chunks} 块）`);
        }
      },
    });

    if (opts.json) {
      jsonOut(result);
    } else {
      log.ok(
        `索引完成：${result.indexed} 文件已更新，${result.skipped} 文件跳过，` +
        `共 ${result.totalChunks} 块。向量模式：${result.mode}`
      );
      if (result.mode === 'pseudo+mem') {
        log.warn(
          '当前使用 hash 伪向量模式，不具备语义相似性。' +
          '安装 @xenova/transformers 可获得真实语义搜索。'
        );
      }
    }
  });

cli.help();
cli.parse();
