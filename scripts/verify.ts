/**
 * verify.ts — 测试闸门 CLI
 *
 * 子命令：unit / chaos / mutation / all（默认 all）
 * 串行跑：pnpm run test:unit → pnpm run test:chaos → pnpm run test:mutation
 * 任一失败立即退出非零。
 * --quick 跳过 mutation（避免 CI 超时）。
 *
 * 用法：
 *   pnpm run verify           # 全跑
 *   pnpm run verify --quick   # 跳过 mutation
 *   pnpm run verify unit      # 仅跑 unit
 *   pnpm run verify chaos     # 仅跑 chaos
 *   pnpm run verify mutation  # 仅跑 mutation
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cac } from 'cac';
import { log, jsonOut } from './_shared/log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ─── 步骤定义 ─────────────────────────────────────────────────────────────

interface Step {
  name: string;
  cmd: string;
}

const STEPS: Record<string, Step> = {
  unit: {
    name: 'unit tests',
    cmd: 'pnpm run test:unit',
  },
  chaos: {
    name: 'chaos scenarios',
    cmd: 'pnpm run test:chaos',
  },
  mutation: {
    name: 'mutation testing',
    cmd: 'pnpm run test:mutation',
  },
};

// ─── 运行单个步骤 ─────────────────────────────────────────────────────────

interface StepResult {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  durationMs: number;
  error?: string;
}

function runStep(step: Step): StepResult {
  const start = Date.now();
  log.info(`▶ 运行 ${step.name}…`);
  try {
    execSync(step.cmd, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      timeout: 300_000, // 5 分钟上限
    });
    const durationMs = Date.now() - start;
    log.ok(`✓ ${step.name} 通过 (${durationMs}ms)`);
    return { name: step.name, status: 'pass', durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(`✗ ${step.name} 失败 (${durationMs}ms): ${errorMsg}`);
    return { name: step.name, status: 'fail', durationMs, error: errorMsg };
  }
}

// ─── 主逻辑 ───────────────────────────────────────────────────────────────

async function runVerify(opts: {
  subcommand?: string;
  quick: boolean;
  json: boolean;
}): Promise<void> {
  const { subcommand, quick, json } = opts;

  // 确定要跑哪些步骤
  let stepsToRun: Step[];

  if (subcommand && subcommand !== 'all') {
    const step = STEPS[subcommand];
    if (!step) {
      log.error(`未知子命令：${subcommand}，可选：unit / chaos / mutation / all`);
      process.exit(1);
    }
    stepsToRun = [step];
  } else {
    // all 模式
    stepsToRun = [STEPS.unit, STEPS.chaos];
    if (!quick) {
      stepsToRun.push(STEPS.mutation);
    } else {
      log.warn('--quick 模式：跳过 mutation testing');
    }
  }

  const results: StepResult[] = [];
  let exitCode = 0;

  for (const step of stepsToRun) {
    const result = runStep(step);
    results.push(result);
    if (result.status === 'fail') {
      exitCode = 1;
      // 任一失败立即退出
      break;
    }
  }

  // quick 模式下 mutation 记为跳过
  if (quick && (subcommand === 'all' || !subcommand)) {
    results.push({
      name: 'mutation testing',
      status: 'skipped',
      durationMs: 0,
    });
  }

  const summary = {
    total: stepsToRun.length,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    steps: results,
  };

  if (json) {
    jsonOut(summary);
  } else {
    const icon = exitCode === 0 ? '✓' : '✗';
    console.log(
      `\n${icon} verify: ${summary.passed}/${stepsToRun.length} 步骤通过` +
        (summary.skipped > 0 ? `，${summary.skipped} 跳过` : '')
    );
  }

  process.exit(exitCode);
}

// ─── CLI ──────────────────────────────────────────────────────────────────

const cli = cac('verify');

cli
  .command('[subcommand]', '运行测试闸门（unit / chaos / mutation / all）')
  .option('--quick', '跳过 mutation testing')
  .option('--json', '以 JSON 格式输出摘要')
  .action(async (subcommand: string | undefined, opts: { quick?: boolean; json?: boolean }) => {
    await runVerify({
      subcommand,
      quick: opts.quick ?? false,
      json: opts.json ?? false,
    });
  });

cli.help();
cli.parse();
