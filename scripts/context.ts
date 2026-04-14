/**
 * scripts/context.ts — 运行时上下文注入 CLI（M8）
 *
 * 子命令：
 *   db-schema [path]        探测 SQLite 表结构
 *   env [--vars a,b,c]      白名单 env 脱敏输出
 *   api [--root path]       扫描 OpenAPI / tRPC endpoint 清单
 *   recent-logs [--n 10]    最近 N 条 sessions
 *
 * 全局选项：
 *   --json                  输出 JSON 而非 markdown
 */

import cac from 'cac';
import { dumpDbSchema, dumpEnv, dumpApi, dumpRecentLogs } from '@vcp/context';
import { MEMORY_DB, REPO_ROOT } from './_shared/paths.js';
import { log, jsonOut } from './_shared/log.js';

const cli = cac('context');

// ---------- db-schema ----------
cli
  .command('db-schema [path]', '探测 SQLite 文件的表结构（含列、索引、虚表）')
  .option('--json', '输出 JSON 格式')
  .action(async (dbPath: string | undefined, opts: { json?: boolean }) => {
    const target = dbPath ?? MEMORY_DB;
    const md = await dumpDbSchema(target);
    if (opts.json) {
      jsonOut({ markdown: md });
    } else {
      process.stdout.write(md + '\n');
    }
  });

// ---------- env ----------
cli
  .command('env', '输出白名单环境变量（敏感字段自动脱敏）')
  .option('--vars <list>', '追加额外白名单 key（逗号分隔）')
  .option('--json', '输出 JSON 格式')
  .action((opts: { vars?: string; json?: boolean }) => {
    const extra = opts.vars ? opts.vars.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const md = dumpEnv(extra);
    if (opts.json) {
      jsonOut({ markdown: md });
    } else {
      process.stdout.write(md + '\n');
    }
  });

// ---------- api ----------
cli
  .command('api', '扫描 OpenAPI / tRPC endpoint 清单')
  .option('--root <path>', '仓库根目录（默认当前仓库根）')
  .option('--json', '输出 JSON 格式')
  .action((opts: { root?: string; json?: boolean }) => {
    const root = opts.root ?? REPO_ROOT;
    const md = dumpApi(root);
    if (opts.json) {
      jsonOut({ markdown: md });
    } else {
      process.stdout.write(md + '\n');
    }
  });

// ---------- recent-logs ----------
cli
  .command('recent-logs', '读取 sessions 表最近 N 条记录')
  .option('--n <count>', '读取条数（默认 10）', { default: 10 })
  .option('--db <path>', '指定 MEMORY_DB 路径（默认 .memory/memory.db）')
  .option('--json', '输出 JSON 格式')
  .action(async (opts: { n?: number; db?: string; json?: boolean }) => {
    const n = Number(opts.n ?? 10);
    const dbPath = opts.db ?? MEMORY_DB;
    const md = await dumpRecentLogs(n, dbPath);
    if (opts.json) {
      jsonOut({ markdown: md });
    } else {
      process.stdout.write(md + '\n');
    }
  });

// ---------- 全局帮助 ----------
cli.help();
cli.version('0.0.0');

cli.parse();
