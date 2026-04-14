/**
 * mutation runner — 自研最小 mutation testing 工具
 *
 * 不引入 Stryker（过重），自己实现单点替换：
 *   - == ↔ !=
 *   - > ↔ <
 *   - true ↔ false
 *   - + ↔ -
 *
 * 每次替换后跑 `pnpm exec vitest run`，看是否 fail（= mutant 被杀死）。
 * 输出 mutation score = killed / total。
 *
 * 用法：
 *   pnpm run test:mutation --target packages/chaos/src/index.ts
 *   pnpm run test:mutation --target "packages/**\/src\/*.ts"
 *
 * 缺省（不传 --target）：跳过并打 TODO，避免卡 CI。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';
import { cac } from 'cac';
import { log, jsonOut } from '../../scripts/_shared/log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ─── Mutation 算子 ────────────────────────────────────────────────────────

interface MutationOperator {
  name: string;
  // 匹配的 token（字符串精确匹配）
  from: string;
  to: string;
}

const OPERATORS: MutationOperator[] = [
  { name: 'EQ→NEQ',    from: '===', to: '!==' },
  { name: 'NEQ→EQ',    from: '!==', to: '===' },
  { name: 'LOOSE_EQ→NEQ', from: '==', to: '!=' },
  { name: 'LOOSE_NEQ→EQ', from: '!=', to: '==' },
  { name: 'GT→LT',     from: '>',  to: '<'  },
  { name: 'LT→GT',     from: '<',  to: '>'  },
  { name: 'TRUE→FALSE',from: 'true',  to: 'false' },
  { name: 'FALSE→TRUE',from: 'false', to: 'true'  },
  { name: 'ADD→SUB',   from: ' + ',   to: ' - '   },
  { name: 'SUB→ADD',   from: ' - ',   to: ' + '   },
];

// ─── 找出文件中所有可替换位置 ─────────────────────────────────────────────

interface Mutant {
  file: string;
  operator: MutationOperator;
  /** 在原始内容中的字符偏移 */
  offset: number;
}

function findMutants(file: string, content: string): Mutant[] {
  const mutants: Mutant[] = [];

  for (const op of OPERATORS) {
    let offset = 0;
    while (true) {
      const idx = content.indexOf(op.from, offset);
      if (idx === -1) break;

      // 避免 !== 被 != 误命中：先检查是否已被更长 token 覆盖
      // 跳过注释行（简单过滤）
      const lineStart = content.lastIndexOf('\n', idx) + 1;
      const linePrefix = content.slice(lineStart, idx);
      if (linePrefix.trimStart().startsWith('//') || linePrefix.trimStart().startsWith('*')) {
        offset = idx + op.from.length;
        continue;
      }

      // 对于短 token（<, >, ==, !=），避免被长 token 覆盖导致双重替换
      // 简单做法：如果前后紧挨着 = 符号，跳过（避免 <= >= 被误处理）
      if (op.from === '<' || op.from === '>') {
        const next = content[idx + 1];
        const prev = content[idx - 1];
        if (next === '=' || next === '<' || next === '>' || prev === '<' || prev === '>') {
          offset = idx + 1;
          continue;
        }
      }
      if (op.from === '==' || op.from === '!=') {
        // 避免与 === 或 !== 重叠
        const next = content[idx + op.from.length];
        if (next === '=') {
          offset = idx + 1;
          continue;
        }
      }

      mutants.push({ file, operator: op, offset: idx });
      offset = idx + op.from.length;
    }
  }

  return mutants;
}

// ─── 应用单个 mutant ──────────────────────────────────────────────────────

function applyMutant(original: string, mutant: Mutant): string {
  const { offset, operator } = mutant;
  return (
    original.slice(0, offset) +
    operator.to +
    original.slice(offset + operator.from.length)
  );
}

// ─── 跑 vitest，返回是否失败 ──────────────────────────────────────────────

function runTests(): boolean {
  try {
    execSync('pnpm exec vitest run --reporter=verbose 2>&1', {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      timeout: 60_000,
    });
    // 退出码 0 = 测试全通过 = mutant 存活
    return false;
  } catch {
    // 退出码非 0 = 测试失败 = mutant 被杀死
    return true;
  }
}

// ─── 主逻辑 ───────────────────────────────────────────────────────────────

interface MutantRecord {
  file: string;
  operator: string;
  offset: number;
  status: 'killed' | 'survived';
}

async function runMutation(
  targets: string[],
  useJson: boolean,
  verbose: boolean
): Promise<void> {
  if (targets.length === 0) {
    log.todo('mutation-runner: 未指定 --target，跳过 mutation testing（避免卡 CI）');
    log.info('用法：pnpm run test:mutation --target packages/chaos/src/index.ts');
    if (useJson) jsonOut({ skipped: true, reason: 'no --target specified' });
    return;
  }

  // 展开 glob
  const files: string[] = [];
  for (const t of targets) {
    const abs = resolve(REPO_ROOT, t);
    // 先尝试直接文件
    try {
      readFileSync(abs);
      files.push(abs);
      continue;
    } catch {}
    // 再尝试 glob
    const matched = globSync(t, { cwd: REPO_ROOT });
    for (const m of matched) files.push(resolve(REPO_ROOT, m));
  }

  if (files.length === 0) {
    log.warn(`没有匹配 --target 的文件：${targets.join(', ')}`);
    process.exit(1);
  }

  log.info(`mutation 目标文件：${files.join(', ')}`);

  // 收集所有 mutants
  const allMutants: Mutant[] = [];
  const fileContents: Map<string, string> = new Map();

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    fileContents.set(file, content);
    const mutants = findMutants(file, content);
    log.info(`  ${file}：找到 ${mutants.length} 个 mutant`);
    allMutants.push(...mutants);
  }

  if (allMutants.length === 0) {
    log.warn('未找到任何可替换位置，退出');
    if (useJson) jsonOut({ total: 0, killed: 0, survived: 0, score: 1.0 });
    return;
  }

  log.info(`共 ${allMutants.length} 个 mutant，开始逐一测试…`);

  const records: MutantRecord[] = [];
  let killed = 0;

  for (let i = 0; i < allMutants.length; i++) {
    const mutant = allMutants[i];
    const original = fileContents.get(mutant.file)!;
    const mutated = applyMutant(original, mutant);

    // 写入变异版本
    writeFileSync(mutant.file, mutated, 'utf8');

    let isKilled = false;
    try {
      isKilled = runTests();
    } finally {
      // 无论测试结果，恢复原始文件
      writeFileSync(mutant.file, original, 'utf8');
    }

    const status = isKilled ? 'killed' : 'survived';
    if (isKilled) killed++;

    records.push({
      file: mutant.file,
      operator: mutant.operator.name,
      offset: mutant.offset,
      status,
    });

    if (verbose) {
      const icon = isKilled ? '✓' : '✗';
      log.info(`  [${i + 1}/${allMutants.length}] ${icon} ${mutant.operator.name}@offset=${mutant.offset} → ${status}`);
    } else {
      // 只打活下来的（需关注的）
      if (!isKilled) {
        log.warn(`  [${i + 1}/${allMutants.length}] SURVIVED: ${mutant.operator.name} in ${mutant.file}@${mutant.offset}`);
      }
    }
  }

  const total = allMutants.length;
  const score = total > 0 ? killed / total : 1.0;

  const summary = {
    total,
    killed,
    survived: total - killed,
    score: Math.round(score * 1000) / 1000,
    scorePercent: `${(score * 100).toFixed(1)}%`,
    mutants: records,
  };

  if (useJson) {
    jsonOut(summary);
  } else {
    console.log(`\nmutation score: ${summary.scorePercent} (${killed}/${total} killed)`);
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────

const cli = cac('mutation-runner');

cli
  .command('', '运行 mutation testing')
  .option('--target <glob>', '指定要变异的文件（glob，可多次指定）', { type: [] as string[] })
  .option('--json', '以 JSON 格式输出结果')
  .option('--verbose', '输出每个 mutant 的详细状态')
  .action(async (opts: { target?: string | string[]; json?: boolean; verbose?: boolean }) => {
    const targets = Array.isArray(opts.target)
      ? opts.target
      : opts.target
      ? [opts.target]
      : [];
    await runMutation(targets, opts.json ?? false, opts.verbose ?? false);
  });

cli.help();
cli.parse();
