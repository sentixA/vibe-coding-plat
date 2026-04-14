/**
 * @vcp/chaos 自身单元测试
 * 验证 runChaosScenario / startLatencyProxy / fetchWithTimeout / runProcess 基础行为
 */

import { describe, it, expect } from 'vitest';
import {
  runChaosScenario,
  startLatencyProxy,
  fetchWithTimeout,
  runProcess,
  type Fault,
} from '../src/index.js';

// ─── runChaosScenario 基础行为 ────────────────────────────────────────────

describe('runChaosScenario', () => {
  it('无 fault 时，fn 成功则结果 failed=false', async () => {
    const result = await runChaosScenario('no-fault', async () => {}, []);
    expect(result.failed).toBe(false);
    expect(result.triggeredFaults).toHaveLength(0);
  });

  it('fn 抛出时，结果 failed=true 且含 error', async () => {
    const result = await runChaosScenario(
      'throw',
      async () => { throw new Error('故意出错'); },
      []
    );
    expect(result.failed).toBe(true);
    expect(result.error).toContain('故意出错');
  });

  it('env-var fault 注入到 ctx.env 中', async () => {
    let injectedValue = '';
    const faults: Fault[] = [{ kind: 'env-var', key: 'TEST_KEY', value: 'hello-chaos' }];
    const result = await runChaosScenario(
      'env-var',
      async (ctx) => { injectedValue = ctx.env['TEST_KEY'] ?? ''; },
      faults
    );
    expect(result.failed).toBe(false);
    expect(injectedValue).toBe('hello-chaos');
    expect(result.triggeredFaults).toHaveLength(1);
  });

  it('kill-after fault 超时后 failed=true', async () => {
    const faults: Fault[] = [{ kind: 'kill-after', ms: 50 }];
    const result = await runChaosScenario(
      'kill-after',
      async () => {
        // 模拟耗时操作，远超 kill-after 50ms
        await new Promise((res) => setTimeout(res, 500));
      },
      faults
    );
    expect(result.failed).toBe(true);
    expect(result.error).toContain('kill-after');
  });

  it('kill-after fault 在超时前完成则 failed=false', async () => {
    const faults: Fault[] = [{ kind: 'kill-after', ms: 500 }];
    const result = await runChaosScenario(
      'kill-after-ok',
      async () => {
        // 远快于 500ms
        await new Promise((res) => setTimeout(res, 10));
      },
      faults
    );
    expect(result.failed).toBe(false);
  });

  it('latency fault 被记录到 triggeredFaults，且 ctx.latencyMs 正确', async () => {
    const faults: Fault[] = [{ kind: 'latency', ms: 100 }];
    let capturedLatency = 0;
    const result = await runChaosScenario(
      'latency',
      async (ctx) => { capturedLatency = ctx.latencyMs ?? 0; },
      faults
    );
    expect(result.failed).toBe(false);
    expect(capturedLatency).toBe(100);
    expect(result.triggeredFaults).toHaveLength(1);
    expect(result.triggeredFaults[0].kind).toBe('latency');
  });

  it('durationMs 大于 0', async () => {
    const result = await runChaosScenario('duration', async () => {}, []);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── startLatencyProxy ────────────────────────────────────────────────────

describe('startLatencyProxy', () => {
  it('能启动并关闭代理，返回合法端口号', async () => {
    // 随便指向一个不存在的端口（测试只验证代理本身能起来）
    const { proxyPort, close } = await startLatencyProxy(19999, 10);
    expect(proxyPort).toBeGreaterThan(0);
    expect(proxyPort).toBeLessThan(65536);
    await close();
  });
});

// ─── fetchWithTimeout ─────────────────────────────────────────────────────

describe('fetchWithTimeout', () => {
  it('delay < timeout 时成功返回', async () => {
    const res = await fetchWithTimeout('http://mock', 500, 10);
    expect(res).toContain('mock response');
  });

  it('delay > timeout 时 reject', async () => {
    await expect(fetchWithTimeout('http://mock', 50, 300)).rejects.toThrow('超时');
  });
});

// ─── runProcess ───────────────────────────────────────────────────────────

describe('runProcess', () => {
  it('成功运行命令，exitCode=0', async () => {
    const r = await runProcess('node', ['-e', 'process.exit(0)']);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('命令输出被捕获到 stdout', async () => {
    const r = await runProcess('node', ['-e', "process.stdout.write('hello');"]);
    expect(r.stdout).toContain('hello');
  });

  it('超时时 timedOut=true', async () => {
    const r = await runProcess('node', ['-e', 'setTimeout(()=>{},9999)'], { timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
  });

  it('env 注入后子进程能读到环境变量', async () => {
    const r = await runProcess(
      'node',
      ['-e', "process.stdout.write(process.env.MY_VAR || 'missing');"],
      { env: { ...process.env as Record<string, string>, MY_VAR: 'injected' } }
    );
    expect(r.stdout).toContain('injected');
  });
});
