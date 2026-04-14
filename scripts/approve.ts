/**
 * approve.ts — 人机审批 checkpoint CLI（M6）
 *
 * 子命令：
 *   approve plan <slug>   — 读取 .specify/features/<slug>/{spec,plan,tasks}.md，彩色打印摘要，等 stdin y/n
 *   approve diff          — 跑 git diff（--staged 则为暂存区），彩色打印，等 stdin y/n
 *   approve commit        — 展示暂存区 diff + 拟用 commit message，确认后执行 commit
 *
 * 选项：
 *   --yes               跳过交互（CI 模式，直接通过）
 *   --rollback-on-no    拒绝时执行 git restore + git stash（默认 true）
 *   --message <msg>     commit 子命令用的 commit message（可选）
 *   --staged            diff 子命令：使用 --staged
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import cac from 'cac';
import { execa } from 'execa';
import { log } from './_shared/log.js';
import { FEATURES_DIR } from './_shared/paths.js';

// ─── ANSI 颜色工具（不引入额外依赖） ───────────────────────────────────────────

const isTTY = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = (code: number, s: string) => isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold   = (s: string) => c(1,  s);
const green  = (s: string) => c(32, s);
const red    = (s: string) => c(31, s);
const yellow = (s: string) => c(33, s);
const cyan   = (s: string) => c(36, s);
const dim    = (s: string) => c(2,  s);

/** 给 git diff 输出着色（+ 行绿，- 行红，@@ 青，其余 dim） */
function colorDiff(raw: string): string {
  return raw
    .split('\n')
    .map(line => {
      if (line.startsWith('+++') || line.startsWith('---')) return bold(line);
      if (line.startsWith('+')) return green(line);
      if (line.startsWith('-')) return red(line);
      if (line.startsWith('@@')) return cyan(line);
      return dim(line);
    })
    .join('\n');
}

// ─── 交互：等待 stdin y/n ──────────────────────────────────────────────────────

/**
 * 若 stdin 非 TTY 且未传 --yes，直接拒绝退出 2。
 * yes=true 则跳过交互直接返回 true。
 */
async function confirm(prompt: string, yes: boolean): Promise<boolean> {
  if (yes) return true;

  if (!process.stdin.isTTY) {
    log.error('stdin 不是 TTY 且未传 --yes，自动拒绝。');
    process.exit(2);
  }

  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${bold(prompt)} ${dim('[y/N]')} `, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/** 拒绝时的回滚操作 */
async function rollback(): Promise<void> {
  log.warn('执行回滚：git restore --staged . && git stash push --keep-index --include-untracked');
  try {
    await execa('git', ['restore', '--staged', '.'], { stdio: 'inherit' });
    await execa('git', ['stash', 'push', '--keep-index', '--include-untracked'], { stdio: 'inherit' });
    log.ok('回滚完成。');
  } catch (err) {
    log.error(`回滚失败: ${String(err)}`);
  }
}

// ─── 子命令实现 ─────────────────────────────────────────────────────────────────

/** plan <slug>：读取并展示 spec/plan/tasks.md */
async function cmdPlan(slug: string, yes: boolean, rollbackOnNo: boolean): Promise<void> {
  const featureDir = resolve(FEATURES_DIR, slug);

  const files = ['spec.md', 'plan.md', 'tasks.md'] as const;
  const contents: Record<string, string> = {};

  for (const file of files) {
    const filePath = resolve(featureDir, file);
    if (existsSync(filePath)) {
      contents[file] = readFileSync(filePath, 'utf-8');
    } else {
      contents[file] = dim(`（${file} 不存在）`);
    }
  }

  console.log('\n' + bold(cyan(`═══ Feature: ${slug} ═══`)));

  for (const file of files) {
    console.log('\n' + bold(yellow(`─── ${file} ───`)));
    console.log(contents[file]);
  }

  console.log('');
  const ok = await confirm('确认通过此 feature 规划？', yes);

  if (!ok) {
    log.warn('已拒绝。');
    if (rollbackOnNo) await rollback();
    process.exit(1);
  }

  log.ok(`Feature ${slug} 规划已通过。`);
}

/** diff [--staged]：展示 git diff，等待确认 */
async function cmdDiff(staged: boolean, yes: boolean, rollbackOnNo: boolean): Promise<void> {
  const diffArgs = staged ? ['diff', '--staged'] : ['diff'];
  let diffOutput = '';

  try {
    const result = await execa('git', diffArgs);
    diffOutput = result.stdout;
  } catch (err: unknown) {
    // execa 在非零退出码时抛出，但 git diff 正常退出码是 0/1
    const e = err as { stdout?: string; exitCode?: number };
    diffOutput = e.stdout ?? '';
    if (!diffOutput) {
      log.error(`git diff 失败: ${String(err)}`);
      process.exit(1);
    }
  }

  if (!diffOutput.trim()) {
    log.info('无变更（diff 为空）。');
    process.exit(0);
  }

  const label = staged ? '暂存区 diff (--staged)' : '工作区 diff';
  console.log('\n' + bold(cyan(`═══ ${label} ═══`)));
  console.log(colorDiff(diffOutput));
  console.log('');

  const ok = await confirm('确认接受此 diff？', yes);
  if (!ok) {
    log.warn('已拒绝。');
    if (rollbackOnNo) await rollback();
    process.exit(1);
  }

  log.ok('Diff 已通过。');
}

/** commit：展示暂存区 diff + commit message，确认后提交 */
async function cmdCommit(message: string | undefined, yes: boolean, rollbackOnNo: boolean): Promise<void> {
  // 展示暂存区 diff
  let diffOutput = '';
  try {
    const result = await execa('git', ['diff', '--staged']);
    diffOutput = result.stdout;
  } catch (err: unknown) {
    const e = err as { stdout?: string };
    diffOutput = e.stdout ?? '';
  }

  if (!diffOutput.trim()) {
    log.warn('暂存区无变更，无需 commit。');
    process.exit(0);
  }

  console.log('\n' + bold(cyan('═══ 暂存区 diff ═══')));
  console.log(colorDiff(diffOutput));

  // 处理 commit message
  let msg = message;
  if (!msg) {
    // 若 stdin 非 TTY 且无 --yes / --message，退出 2
    if (!process.stdin.isTTY && !yes) {
      log.error('stdin 不是 TTY 且未传 --message / --yes，无法读取 commit message。');
      process.exit(2);
    }
    if (process.stdin.isTTY) {
      // 从 stdin 读取 commit message
      msg = await new Promise<string>(resolve => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(bold('请输入 commit message（conventional commit 格式）: '), answer => {
          rl.close();
          resolve(answer.trim());
        });
      });
    } else {
      // yes 模式但无 message，生成默认
      msg = 'chore: approve commit (--yes mode)';
    }
  }

  if (!msg) {
    log.error('commit message 不能为空。');
    process.exit(1);
  }

  console.log('\n' + bold(yellow('═══ 拟用 commit message ═══')));
  console.log(green(msg));
  console.log('');

  const ok = await confirm('确认执行 commit？', yes);
  if (!ok) {
    log.warn('已拒绝。');
    if (rollbackOnNo) await rollback();
    process.exit(1);
  }

  try {
    await execa('git', ['commit', '-m', msg], { stdio: 'inherit' });
    log.ok('Commit 完成。');
  } catch (err) {
    log.error(`commit 失败: ${String(err)}`);
    process.exit(1);
  }
}

// ─── CLI 注册 ──────────────────────────────────────────────────────────────────

const cli = cac('approve');

// 通用选项
const commonOpts = (cmd: ReturnType<typeof cli.command>) =>
  cmd
    .option('--yes', '跳过交互（CI 模式）', { default: false })
    .option('--rollback-on-no', '拒绝时执行回滚（默认 true）', { default: true });

// approve plan <slug>
commonOpts(
  cli.command('plan <slug>', '读取 feature spec/plan/tasks 并等待审批')
).action(async (slug: string, opts: { yes: boolean; rollbackOnNo: boolean }) => {
  await cmdPlan(slug, opts.yes, opts.rollbackOnNo);
});

// approve diff
commonOpts(
  cli.command('diff', '展示 git diff 并等待审批')
    .option('--staged', '展示暂存区 diff (git diff --staged)', { default: false })
).action(async (opts: { yes: boolean; rollbackOnNo: boolean; staged: boolean }) => {
  await cmdDiff(opts.staged, opts.yes, opts.rollbackOnNo);
});

// approve commit
commonOpts(
  cli.command('commit', '展示暂存区 diff + commit message 并确认提交')
    .option('--message <msg>', 'commit message（可选，不传则从 stdin 读）')
).action(async (opts: { yes: boolean; rollbackOnNo: boolean; message?: string }) => {
  await cmdCommit(opts.message, opts.yes, opts.rollbackOnNo);
});

cli.help();
cli.version('0.0.0');

cli.parse();
