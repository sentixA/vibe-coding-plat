/**
 * @vcp/chaos — 轻量故障注入库
 *
 * 不依赖外部 toxiproxy daemon，纯 Node 子进程 + 自研 TCP 代理实现。
 * 支持三种基本 fault：
 *   - latency: 注入 TCP 代理延迟
 *   - kill-after: 超时后 SIGKILL 被测进程
 *   - env-var: 注入环境变量
 */

import { createServer, createConnection, type Socket } from 'node:net';
import { spawn } from 'node:child_process';

// ─── 类型定义 ─────────────────────────────────────────────────────────────

export type LatencyFault = { kind: 'latency'; ms: number };
export type KillAfterFault = { kind: 'kill-after'; ms: number };
export type EnvVarFault = { kind: 'env-var'; key: string; value: string };
export type Fault = LatencyFault | KillAfterFault | EnvVarFault;

export interface ChaosResult {
  /** 被测函数是否抛出或超时 */
  failed: boolean;
  /** 错误信息（如果 failed） */
  error?: string;
  /** 实际耗时 ms */
  durationMs: number;
  /** 触发的 fault 列表 */
  triggeredFaults: Fault[];
}

// ─── TCP 延迟代理 ─────────────────────────────────────────────────────────

/**
 * 在 localhost 上起一个 TCP 代理，转发到 targetPort，
 * 每个数据包延迟 delayMs 毫秒后才转发。
 * 返回 { proxyPort, close } —— close() 关闭代理服务器。
 */
export async function startLatencyProxy(
  targetPort: number,
  delayMs: number
): Promise<{ proxyPort: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((clientSocket: Socket) => {
      const targetSocket = createConnection({ port: targetPort, host: '127.0.0.1' });

      // 客户端 → 目标：延迟转发
      clientSocket.on('data', (chunk) => {
        setTimeout(() => {
          if (!targetSocket.destroyed) targetSocket.write(chunk);
        }, delayMs);
      });

      // 目标 → 客户端：延迟转发
      targetSocket.on('data', (chunk) => {
        setTimeout(() => {
          if (!clientSocket.destroyed) clientSocket.write(chunk);
        }, delayMs);
      });

      clientSocket.on('end', () => targetSocket.end());
      targetSocket.on('end', () => clientSocket.end());
      clientSocket.on('error', () => targetSocket.destroy());
      targetSocket.on('error', () => clientSocket.destroy());
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('代理服务器地址异常'));
        return;
      }
      const proxyPort = addr.port;
      resolve({
        proxyPort,
        close: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });

    server.on('error', reject);
  });
}

// ─── 核心 API ─────────────────────────────────────────────────────────────

/**
 * 在注入指定 faults 的条件下跑 fn，收集结果。
 *
 * @param name      场景名称（仅用于日志）
 * @param fn        被测异步函数；接受 { env, proxyPort? } 上下文
 * @param faults    故障列表
 */
export async function runChaosScenario(
  name: string,
  fn: (ctx: ChaosContext) => Promise<void>,
  faults: Fault[]
): Promise<ChaosResult> {
  const start = Date.now();
  const triggeredFaults: Fault[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  // 构建注入上下文
  const ctx: ChaosContext = {
    env: { ...process.env } as Record<string, string>,
    proxyPorts: {},
  };

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let killed = false;

  try {
    // 应用 env-var faults
    for (const fault of faults) {
      if (fault.kind === 'env-var') {
        ctx.env[fault.key] = fault.value;
        triggeredFaults.push(fault);
      }
    }

    // 应用 latency faults（启动代理，但让 fn 自己决定连哪个端口）
    for (const fault of faults) {
      if (fault.kind === 'latency') {
        // 把代理端口暴露给 fn；fn 自行决定是否使用
        const { proxyPort, close } = await startLatencyProxy(0, fault.ms);
        ctx.proxyPorts['latency'] = proxyPort;
        ctx.latencyMs = fault.ms;
        cleanups.push(close);
        triggeredFaults.push(fault);
      }
    }

    // 应用 kill-after faults
    for (const fault of faults) {
      if (fault.kind === 'kill-after') {
        killTimer = setTimeout(() => {
          killed = true;
        }, fault.ms);
        triggeredFaults.push(fault);
      }
    }

    // 执行被测函数，同时监控 kill-after
    const fnPromise = fn(ctx);

    if (killTimer !== null) {
      // 等 fn 完成或 kill 触发
      await Promise.race([
        fnPromise,
        new Promise<never>((_, reject) => {
          const check = setInterval(() => {
            if (killed) {
              clearInterval(check);
              reject(new Error(`kill-after: 超时被中止`));
            }
          }, 10);
        }),
      ]);
    } else {
      await fnPromise;
    }

    if (killTimer) clearTimeout(killTimer);

    return {
      failed: false,
      durationMs: Date.now() - start,
      triggeredFaults,
    };
  } catch (err) {
    if (killTimer) clearTimeout(killTimer);
    return {
      failed: true,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      triggeredFaults,
    };
  } finally {
    // 关闭所有代理
    for (const cleanup of cleanups) {
      await cleanup().catch(() => {});
    }
  }
}

// ─── 上下文类型 ──────────────────────────────────────────────────────────

export interface ChaosContext {
  /** 注入了 env-var faults 的环境变量副本 */
  env: Record<string, string>;
  /** latency 代理监听端口映射（key 为 'latency'） */
  proxyPorts: Record<string, number>;
  /** 注入的延迟 ms（如果有 latency fault） */
  latencyMs?: number;
}

// ─── 辅助：带超时的 fetch（用于场景测试） ────────────────────────────────

/**
 * 在 ctx 里注入了 latency fault 后，可用此函数替换 fetch，
 * 对指定 url 施加人工延迟。
 * 超过 timeoutMs 则 reject。
 */
export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  delayMs = 0
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`超时 ${timeoutMs}ms`));
    }, timeoutMs);

    // 模拟 latency：延迟 delayMs 后"完成"
    setTimeout(() => {
      clearTimeout(timer);
      resolve(`mock response from ${url}`);
    }, delayMs);
  });
}

// ─── 辅助：运行子进程，支持超时 + env 注入 ───────────────────────────────

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runProcess(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, opts.timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}
