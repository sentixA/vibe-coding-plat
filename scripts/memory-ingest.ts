/**
 * memory-ingest — 扫描 CLAUDE_PROJECTS_DIR 下所有 jsonl，增量入库。
 *
 * 判重策略：raw_path + mtime（先查 sessions.raw_path，再对比文件 mtime）。
 * 保证幂等：同 session uuid 重跑不重复插入（INSERT OR IGNORE）。
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openSqlite } from './_shared/db.js';
import { log } from './_shared/log.js';
import { MEMORY_DB, CLAUDE_PROJECTS_DIR } from './_shared/paths.js';
import { initSchema, ingestSessionFile } from '@vcp/memory';

/**
 * 递归扫描目录，收集所有 .jsonl 文件路径。
 */
function collectJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results;
}

async function main() {
  const db = await openSqlite(MEMORY_DB);
  initSchema(db);

  log.info(`扫描目录: ${CLAUDE_PROJECTS_DIR}`);

  const files = collectJsonlFiles(CLAUDE_PROJECTS_DIR);
  if (files.length === 0) {
    log.info('未找到任何 jsonl 文件，退出');
    return;
  }

  log.info(`找到 ${files.length} 个 jsonl 文件`);

  let ingested = 0;
  let skipped = 0;

  for (const filePath of files) {
    // 判重：查 sessions 表中是否已有 raw_path = filePath
    const existing = db.prepare(
      `SELECT id, raw_path FROM sessions WHERE raw_path = ?`
    ).get(filePath) as { id: string; raw_path: string } | undefined;

    if (existing) {
      // 进一步比对 mtime（文件变更则重新入库）
      let mtime: number;
      try {
        mtime = statSync(filePath).mtimeMs;
      } catch {
        skipped++;
        continue;
      }

      // 获取 sessions 的 ended_at 作为近似的上次入库时间
      const session = db.prepare(
        `SELECT ended_at FROM sessions WHERE id = ?`
      ).get(existing.id) as { ended_at: number | null } | undefined;

      // 如果文件 mtime 早于或等于 ended_at，视为未变化，跳过
      if (session?.ended_at && mtime <= session.ended_at) {
        log.info(`跳过（未变化）: ${filePath}`);
        skipped++;
        continue;
      }
    }

    try {
      ingestSessionFile(db, filePath);
      log.ok(`入库: ${filePath}`);
      ingested++;
    } catch (err) {
      log.error(`入库失败: ${filePath} — ${(err as Error).message}`);
    }
  }

  log.ok(`完成：入库 ${ingested} 个，跳过 ${skipped} 个`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
