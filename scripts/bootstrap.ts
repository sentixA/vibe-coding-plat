/**
 * bootstrap — 全新 clone 后的一键初始化（M9）
 *
 * 做的事：
 *   1. 确保所有运行时目录存在（.memory / .vectors / .specify / .wiki / .sandbox / packages）
 *   2. 初始化 memory.db schema（@vcp/memory.initSchema）
 *   3. 初始化 vectors index.sqlite schema（@vcp/vectors.initSchema）
 *   4. 写出 .wiki/{index,log}.md 与 .specify/constitution.md 的最小骨架（已有则不覆盖）
 *
 * 用法：pnpm run bootstrap
 */

import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { openSqlite } from './_shared/db.js';
import { log } from './_shared/log.js';
import {
  REPO_ROOT, MEMORY_DIR, MEMORY_DB, MEMORY_RAW,
  VECTORS_DIR, VECTORS_DB,
  SPECIFY_DIR, FEATURES_DIR,
  WIKI_DIR, WIKI_INDEX, WIKI_LOG, WIKI_TOPICS,
  SANDBOX_DIR,
} from './_shared/paths.js';
import { initSchema as initMemorySchema } from '@vcp/memory';
import { initSchema as initVectorsSchema } from '@vcp/vectors';

const DIRS = [
  MEMORY_DIR, MEMORY_RAW,
  VECTORS_DIR,
  SPECIFY_DIR, FEATURES_DIR,
  WIKI_DIR, WIKI_TOPICS,
  SANDBOX_DIR,
];

function ensureDirs(): void {
  for (const d of DIRS) {
    if (!existsSync(d)) {
      mkdirSync(d, { recursive: true });
      log.ok(`mkdir ${d.replace(REPO_ROOT + '/', '')}`);
    }
  }
}

function ensureFile(path: string, content: string, label: string): void {
  if (existsSync(path)) {
    log.info(`保留已有 ${label}`);
    return;
  }
  writeFileSync(path, content);
  log.ok(`写入 ${label}`);
}

const WIKI_INDEX_TEMPLATE = `# Wiki Index

## Topics
<!-- compileFeature 会在此处追加 topic 链接 -->

## Recent Log
<!-- 见 log.md -->
`;

const WIKI_LOG_TEMPLATE = `# Wiki Change Log

<!-- 每行格式: - YYYY-MM-DD <slug> :: <one-line summary> -->
`;

const CONSTITUTION_TEMPLATE = `# Project Constitution

> spec-kit 启动后会被 \`/speckit.constitution\` 覆盖。此处仅放最小骨架。

## 工程纪律

1. 模块独占目录，跨模块协作走 \`scripts/_shared/*\` 或 \`@vcp/*\` workspace 包。
2. 共享 SQLite 句柄一律走 \`openSqlite()\`。
3. 所有 CLI 用 \`cac\`，统一支持 \`--json\`。
4. conventional commits；提交前 \`pnpm run verify --quick\` 必绿。
5. 沙箱 + 审批 checkpoint 是写入与提交前的硬关卡。
`;

async function main(): Promise<void> {
  log.info(`bootstrap @ ${REPO_ROOT}`);

  ensureDirs();

  log.info('初始化 memory.db schema...');
  const mdb = await openSqlite(MEMORY_DB);
  initMemorySchema(mdb);
  log.ok(`memory schema OK -> ${MEMORY_DB.replace(REPO_ROOT + '/', '')}`);

  log.info('初始化 vectors index.sqlite schema...');
  const vdb = await openSqlite(VECTORS_DB);
  initVectorsSchema(vdb);
  log.ok(`vectors schema OK -> ${VECTORS_DB.replace(REPO_ROOT + '/', '')}`);

  ensureFile(WIKI_INDEX, WIKI_INDEX_TEMPLATE, '.wiki/index.md');
  ensureFile(WIKI_LOG,   WIKI_LOG_TEMPLATE,   '.wiki/log.md');
  ensureFile(`${SPECIFY_DIR}/constitution.md`, CONSTITUTION_TEMPLATE, '.specify/constitution.md');

  log.ok('bootstrap 完成');
}

main().catch(err => {
  log.error(`bootstrap 失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
