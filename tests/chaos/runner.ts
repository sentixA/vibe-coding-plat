/**
 * chaos runner — 扫描 tests/chaos/*.scenario.ts 并逐一执行
 *
 * 用法：
 *   pnpm run test:chaos
 *   tsx tests/chaos/runner.ts [--json]
 */

import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cac } from 'cac';
import { log, jsonOut } from '../../scripts/_shared/log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = resolve(__dirname);

// ─── 场景接口 ─────────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  run: () => Promise<void>;
}

// ─── 扫描场景文件 ─────────────────────────────────────────────────────────

async function loadScenarios(): Promise<Scenario[]> {
  const files = readdirSync(SCENARIO_DIR).filter(
    (f) => f.endsWith('.scenario.ts') || f.endsWith('.scenario.js')
  );

  const scenarios: Scenario[] = [];
  for (const file of files) {
    const url = pathToFileURL(resolve(SCENARIO_DIR, file)).href;
    try {
      const mod = await import(url);
      if (typeof mod.run === 'function') {
        scenarios.push({
          name: mod.name ?? file,
          run: mod.run,
        });
      } else {
        log.warn(`场景文件 ${file} 没有导出 run 函数，已跳过`);
      }
    } catch (err) {
      log.error(`加载场景 ${file} 失败：${err}`);
      // 加载失败也记为一个 scenario，以便统计失败数
      const capturedFile = file;
      scenarios.push({
        name: capturedFile,
        run: async () => { throw err; },
      });
    }
  }
  return scenarios;
}

// ─── 运行所有场景 ─────────────────────────────────────────────────────────

interface ScenarioRecord {
  name: string;
  status: 'pass' | 'fail';
  error?: string;
  durationMs: number;
}

async function runAll(useJson: boolean): Promise<void> {
  const scenarios = await loadScenarios();

  if (scenarios.length === 0) {
    log.warn('未找到任何 *.scenario.ts 文件');
    return;
  }

  log.info(`发现 ${scenarios.length} 个 chaos 场景，开始执行…`);

  const records: ScenarioRecord[] = [];
  let failCount = 0;

  for (const scenario of scenarios) {
    const start = Date.now();
    try {
      await scenario.run();
      const durationMs = Date.now() - start;
      records.push({ name: scenario.name, status: 'pass', durationMs });
      log.ok(`[PASS] ${scenario.name} (${durationMs}ms)`);
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      records.push({ name: scenario.name, status: 'fail', error: errorMsg, durationMs });
      log.error(`[FAIL] ${scenario.name} (${durationMs}ms): ${errorMsg}`);
      failCount++;
    }
  }

  const summary = {
    total: scenarios.length,
    passed: scenarios.length - failCount,
    failed: failCount,
    scenarios: records,
  };

  if (useJson) {
    jsonOut(summary);
  } else {
    console.log(`\nchaos 汇总：${summary.passed}/${summary.total} 通过`);
  }

  if (failCount > 0) {
    process.exit(1);
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────

const cli = cac('chaos-runner');

cli
  .command('', '运行所有 chaos scenarios')
  .option('--json', '以 JSON 格式输出结果')
  .action(async (opts: { json?: boolean }) => {
    await runAll(opts.json ?? false);
  });

cli.help();
cli.parse();
