/**
 * search.ts — 代码向量检索 CLI 入口（M3）
 *
 * 子命令：
 *   search "<query>" [--k 10] [--mode vec|keyword|hybrid]
 *
 * 混合模式 = FTS5 关键词 + 向量余弦加权合并。
 */

import { cac } from 'cac';
import { openSqlite } from './_shared/db.js';
import { log, jsonOut } from './_shared/log.js';
import { VECTORS_DB } from './_shared/paths.js';
import { searchVec, searchKeyword, searchHybrid, initSchema } from '@vcp/vectors';

const cli = cac('search');

cli
  .command('<query>', '在代码向量库中搜索')
  .option('--k <number>', '返回结果数', { default: 10 })
  .option('--mode <mode>', '搜索模式：vec | keyword | hybrid', { default: 'hybrid' })
  .option('--json', '以 JSON 格式输出结果')
  .action(async (query: string, opts: {
    k: number | string;
    mode: 'vec' | 'keyword' | 'hybrid';
    json: boolean;
  }) => {
    const k = Number(opts.k) || 10;
    const mode = opts.mode ?? 'hybrid';

    if (!['vec', 'keyword', 'hybrid'].includes(mode)) {
      log.error(`不支持的搜索模式：${mode}，可选：vec | keyword | hybrid`);
      process.exit(1);
    }

    const db = await openSqlite(VECTORS_DB);
    // 确保 schema 存在（DB 可能尚未初始化）
    initSchema(db);

    let results;
    try {
      if (mode === 'vec') {
        results = await searchVec(db, query, k);
      } else if (mode === 'keyword') {
        results = searchKeyword(db, query, k);
      } else {
        results = await searchHybrid(db, query, k);
      }
    } catch (err) {
      log.error(`搜索失败：${(err as Error).message}`);
      process.exit(1);
    }

    if (opts.json) {
      jsonOut(results);
      return;
    }

    if (results.length === 0) {
      log.warn(`未找到匹配结果（模式=${mode}）`);
      return;
    }

    log.ok(`找到 ${results.length} 个匹配块（模式=${mode}）：`);
    for (const r of results) {
      const score = r.score.toFixed(4);
      console.log(`\n  [${score}] ${r.path}:${r.start_line}-${r.end_line}`);
      // 输出文本预览（最多 3 行）
      const preview = r.text.split('\n').slice(0, 3).join('\n');
      console.log(`  ${preview.replace(/\n/g, '\n  ')}`);
    }
  });

cli.help();
cli.parse();
