/**
 * @vcp/sandbox — 沙箱执行库
 *
 * 自动检测可用沙箱后端，优先级：bwrap → docker → dry-run
 * bwrap 不可用时自动降级，dry-run 模式仅打印命令不执行。
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa, type ExecaReturnValue } from 'execa';

const here = dirname(fileURLToPath(import.meta.url));
// .sandbox 目录在仓库根，相对 packages/sandbox/src/ 是 ../../../.sandbox
const SANDBOX_DIR = resolve(here, '..', '..', '..', '.sandbox');
const BWRAP_PROFILE = resolve(SANDBOX_DIR, 'bwrap.profile');
const DOCKERFILE_DEV = resolve(SANDBOX_DIR, 'Dockerfile.dev');

export type SandboxMode = 'auto' | 'bwrap' | 'docker' | 'dry';

export interface SandboxOptions {
  mode?: SandboxMode;
  /** 读写挂载的工作目录（默认 process.cwd()） */
  repoPath?: string;
  /** 解禁网络（默认禁止） */
  allowNet?: boolean;
  /** Docker 镜像名（docker 模式用，默认 vcp-sandbox-dev） */
  dockerImage?: string;
  /** 仅构造命令字符串，不执行（供测试用） */
  buildOnly?: boolean;
}

export interface SandboxResult {
  /** 最终使用的后端 */
  backend: 'bwrap' | 'docker' | 'dry';
  /** 完整命令数组（含沙箱包装层） */
  argv: string[];
  /** 进程退出码（dry-run 固定 0，buildOnly 返回 undefined） */
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/** 检测 bwrap 是否可用 */
export function hasBwrap(): boolean {
  try {
    execSync('which bwrap', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 检测 docker 是否可用 */
export function hasDocker(): boolean {
  try {
    execSync('which docker', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 bwrap.profile 文件，返回参数列表（过滤注释和空行）。
 * --share-net-disabled 是占位标记，不是真实 bwrap 参数；
 * allowNet=false 时替换为 --unshare-net（已在 --unshare-all 中包含，保持幂等）。
 */
export function parseBwrapProfile(profilePath: string): string[] {
  if (!existsSync(profilePath)) return [];
  return readFileSync(profilePath, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    // 过滤掉占位标记
    .filter(l => l !== '--share-net-disabled');
}

/**
 * 构建 bwrap 命令行参数数组。
 * repoPath 会追加 `--bind <repoPath> <repoPath>`（读写工作目录）。
 * allowNet=true 时去掉 --unshare-all / --unshare-net（允许网络）。
 */
export function buildBwrapArgv(
  cmd: string,
  args: string[],
  opts: SandboxOptions = {}
): string[] {
  const repoPath = opts.repoPath ?? process.cwd();
  let profileArgs = parseBwrapProfile(BWRAP_PROFILE);

  if (opts.allowNet) {
    // 移除网络隔离参数
    profileArgs = profileArgs.filter(
      a => a !== '--unshare-all' && a !== '--unshare-net'
    );
  }

  // 追加读写工作目录绑定
  profileArgs.push('--bind', repoPath, repoPath);

  return ['bwrap', ...profileArgs, '--', cmd, ...args];
}

/**
 * 构建 docker run 命令行参数数组。
 * 挂载 repoPath 为读写，默认禁网（--network none）。
 */
export function buildDockerArgv(
  cmd: string,
  args: string[],
  opts: SandboxOptions = {}
): string[] {
  const repoPath = opts.repoPath ?? process.cwd();
  const image = opts.dockerImage ?? 'vcp-sandbox-dev';

  const dockerArgs = [
    'docker', 'run', '--rm',
    '-v', `${repoPath}:${repoPath}`,
    '-w', repoPath,
  ];

  if (!opts.allowNet) {
    dockerArgs.push('--network', 'none');
  }

  dockerArgs.push(image, cmd, ...args);
  return dockerArgs;
}

/**
 * 自动选择后端。
 * auto: bwrap > docker > dry
 * 其他模式按传入值强制。
 */
export function resolveBackend(
  mode: SandboxMode = 'auto'
): 'bwrap' | 'docker' | 'dry' {
  if (mode === 'bwrap') return 'bwrap';
  if (mode === 'docker') return 'docker';
  if (mode === 'dry') return 'dry';
  // auto
  if (hasBwrap()) return 'bwrap';
  if (hasDocker()) return 'docker';
  return 'dry';
}

/**
 * 核心入口：在沙箱内执行命令。
 *
 * @param cmd  要执行的命令（第一段）
 * @param args 参数列表
 * @param opts 沙箱选项
 * @returns    SandboxResult（buildOnly=true 时仅返回 argv，不执行）
 */
export async function runInSandbox(
  cmd: string,
  args: string[],
  opts: SandboxOptions = {}
): Promise<SandboxResult> {
  const backend = resolveBackend(opts.mode);

  let argv: string[];
  if (backend === 'bwrap') {
    argv = buildBwrapArgv(cmd, args, opts);
  } else if (backend === 'docker') {
    argv = buildDockerArgv(cmd, args, opts);
  } else {
    // dry-run：仅打印，不执行
    argv = [cmd, ...args];
  }

  if (opts.buildOnly) {
    return { backend, argv };
  }

  if (backend === 'dry') {
    // dry-run 模式：打印将执行的命令并返回 0
    const cmdStr = argv.join(' ');
    process.stdout.write(`将执行 ${cmdStr}（dry-run）\n`);
    return { backend, argv, exitCode: 0 };
  }

  // 实际执行
  try {
    const result: ExecaReturnValue = await execa(argv[0], argv.slice(1), {
      stdio: 'inherit',
    });
    return { backend, argv, exitCode: result.exitCode ?? 0 };
  } catch (err: unknown) {
    const exitCode =
      err && typeof err === 'object' && 'exitCode' in err
        ? (err as { exitCode?: number }).exitCode ?? 1
        : 1;
    return { backend, argv, exitCode };
  }
}
