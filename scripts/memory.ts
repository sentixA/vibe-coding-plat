/**
 * memory CLI — 会话历史查询入口
 *
 * 子命令：list / show / search / replay
 * 支持 --json 切换 JSON 输出
 */

import { cac } from 'cac';
import { openSqlite } from './_shared/db.js';
import { log, jsonOut } from './_shared/log.js';
import { MEMORY_DB } from './_shared/paths.js';
import {
  initSchema,
  listSessions,
  showSession,
  searchFts,
  searchVec,
  replaySession,
} from '@vcp/memory';

const cli = cac('memory');

// ─── list ──────────────────────────────────────────────────────────────────────

cli
  .command('list', '列出所有会话')
  .option('--feature <slug>', '按 feature slug 过滤')
  .option('--since <ts>', '起始时间戳（epoch ms）')
  .option('--limit <n>', '最多返回条数', { default: 20 })
  .option('--json', '以 JSON 格式输出')
  .action(async (opts: { feature?: string; since?: string; limit?: string; json?: boolean }) => {
    const db = await openSqlite(MEMORY_DB);
    initSchema(db);
    const sessions = listSessions(db, {
      feature: opts.feature,
      since: opts.since ? parseInt(opts.since, 10) : undefined,
      limit: opts.limit ? parseInt(opts.limit as string, 10) : 20,
    });
    if (opts.json) {
      jsonOut(sessions);
    } else {
      if (sessions.length === 0) {
        log.info('没有找到任何会话');
        return;
      }
      for (const s of sessions) {
        const date = new Date(s.started_at).toISOString().slice(0, 19).replace('T', ' ');
        console.log(`${s.id}  ${date}  msg=${s.message_count}  ${s.cwd ?? ''}`);
      }
    }
  });

// ─── show ──────────────────────────────────────────────────────────────────────

cli
  .command('show <id>', '显示指定会话详情')
  .option('--json', '以 JSON 格式输出')
  .action(async (id: string, opts: { json?: boolean }) => {
    const db = await openSqlite(MEMORY_DB);
    initSchema(db);
    const result = showSession(db, id);
    if (!result.session) {
      log.error(`找不到会话: ${id}`);
      process.exit(1);
    }
    if (opts.json) {
      jsonOut(result);
    } else {
      console.log(`Session: ${result.session.id}`);
      console.log(`Agent:   ${result.session.agent}`);
      console.log(`CWD:     ${result.session.cwd ?? '(unknown)'}`);
      console.log(`Messages: ${result.messages.length}`);
      console.log('');
      for (const msg of result.messages) {
        console.log(`[${msg.seq}] ${msg.role}: ${(msg.text_preview ?? '').slice(0, 120)}`);
      }
    }
  });

// ─── search ────────────────────────────────────────────────────────────────────

cli
  .command('search <query>', '全文检索消息（FTS5）')
  .option('--vec', '使用向量检索（降级为 FTS5 fallback）')
  .option('--json', '以 JSON 格式输出')
  .action(async (query: string, opts: { vec?: boolean; json?: boolean }) => {
    const db = await openSqlite(MEMORY_DB);
    initSchema(db);
    const results = opts.vec ? searchVec(db, query) : searchFts(db, query);
    if (opts.json) {
      jsonOut(results);
    } else {
      if (results.length === 0) {
        log.info('没有找到匹配结果');
        return;
      }
      for (const r of results) {
        console.log(`[${r.session_id}/${r.seq}] ${r.role}: ${(r.text_preview ?? '').slice(0, 120)}`);
      }
    }
  });

// ─── replay ────────────────────────────────────────────────────────────────────

cli
  .command('replay <id>', '把指定会话还原为 Markdown')
  .option('--json', '以 JSON 格式输出（原始结构）')
  .action(async (id: string, opts: { json?: boolean }) => {
    const db = await openSqlite(MEMORY_DB);
    initSchema(db);
    if (opts.json) {
      const result = showSession(db, id);
      jsonOut(result);
    } else {
      const md = replaySession(db, id);
      console.log(md);
    }
  });

// ─── 帮助 & 解析 ───────────────────────────────────────────────────────────────

cli.help();
cli.version('0.0.0');
cli.parse();
