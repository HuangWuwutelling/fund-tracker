import { describe, it, expect, vi, afterEach } from 'vitest';
import { runRefreshCycle, type RefreshDeps } from './refreshCycle';
import { today as localToday } from '../utils/formatter';
import type { NavRecord, Transaction } from '../types';

/**
 * 一轮刷新的**顺序**测试。
 *
 * 这个模块存在的理由：三条顺序约束（指数先拉 / 确认在净值写入之后 / 基线在循环之后）
 * 以前只以注释存在于 `App.tsx` 的一个 ~180 行闭包里——重排任何一个都不会报错，
 * 只会静默产出错误数字。抽出来 + 注入假的 fetch，就能把它们钉死。
 */

afterEach(() => {
  vi.useRealTimers();
});

/** 一份可用的拉取结果 */
function okFetch(nav: number, navDate: string, history: NavRecord[] = []) {
  return {
    ok: true as const,
    estimate: {
      name: '测试基金', code: 'f1', nav, lastNav: nav, changePercent: 0, navDate,
    },
    navHistory: history,
  };
}

function pendingTx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'p1', fundId: 'f1', type: 'buy', date: '2026-08-26',
    amount: 1575, fee: 0, shares: 0, nav: 0, status: 'pending', ...over,
  };
}

/**
 * 造一套会记录调用顺序的 deps。
 * `log` 里每一条形如 'fetch:f1' / 'confirm:p1' / 'baseline' / 'snapshot' / 'indices'
 */
function makeDeps(over: Partial<RefreshDeps> = {}): { deps: RefreshDeps; log: string[] } {
  const log: string[] = [];
  const deps: RefreshDeps = {
    fundIds: ['f1', 'f2'],
    fetchFundNav: async (fundId) => {
      log.push(`fetch:${fundId}`);
      return okFetch(1.2, '2026-11-20');
    },
    fetchIndexQuotes: async () => {
      log.push('indices');
      return [];
    },
    navOf: () => [],
    pendingTransactions: () => [],
    commitFund: (fundId) => {
      log.push(`commitFund:${fundId}`);
      return true;
    },
    commitNavHistory: (fundId) => {
      log.push(`commitNavHistory:${fundId}`);
    },
    commitTransaction: (id) => {
      log.push(`confirm:${id}`);
      return true;
    },
    commitSnapshot: () => {
      log.push('snapshot');
    },
    recordBaseline: () => {
      log.push('baseline');
      return new Set<string>();
    },
    paceMs: 0,
    ...over,
  };
  return { deps, log };
}

describe('runRefreshCycle —— 顺序约束', () => {
  it('指数先拉（在基金净值之前）', async () => {
    const { deps, log } = makeDeps();
    await runRefreshCycle(deps, { runIndices: true, runFundNavs: true });
    expect(log.indexOf('indices')).toBeLessThan(log.indexOf('fetch:f1'));
  });

  it('runIndices: false → 不拉指数', async () => {
    const { deps, log } = makeDeps();
    await runRefreshCycle(deps, { runIndices: false, runFundNavs: true });
    expect(log).not.toContain('indices');
    expect(log).toContain('fetch:f1');
  });

  it('runFundNavs: false → 只刷指数，不确认 / 不记基线 / 不生成快照', async () => {
    // 退避档：这一轮没拿到新净值，确认与基线都没有依据
    const { deps, log } = makeDeps({
      pendingTransactions: () => [pendingTx()],
      navOf: () => [{ date: '2026-08-26', nav: 1.048, accNav: 1.048 }],
    });
    await runRefreshCycle(deps, { runIndices: true, runFundNavs: false });
    expect(log).toEqual(['indices']);
  });

  it('两个开关都关 → 什么都不做', async () => {
    const { deps, log } = makeDeps();
    await runRefreshCycle(deps, { runIndices: false, runFundNavs: false });
    expect(log).toEqual([]);
  });

  it('确认发生在**所有**净值写入之后', async () => {
    // 关键不变式：确认要用当天净值。用旧数据确认 → 份额算错（2026-08-26 实测多算 13.6 份）
    const { deps, log } = makeDeps({
      pendingTransactions: () => [pendingTx()],
      navOf: () => [{ date: '2026-08-26', nav: 1.048, accNav: 1.048 }],
    });
    await runRefreshCycle(deps, { runIndices: true, runFundNavs: true });

    const confirmAt = log.indexOf('confirm:p1');
    expect(confirmAt).toBeGreaterThan(-1);
    // 两只基金的净值都写完之后才允许确认
    expect(confirmAt).toBeGreaterThan(log.indexOf('commitFund:f1'));
    expect(confirmAt).toBeGreaterThan(log.indexOf('commitFund:f2'));
    expect(confirmAt).toBeGreaterThan(log.indexOf('commitNavHistory:f1'));
  });

  it('新鲜度基线在最后（快照之前）', async () => {
    // 基线读的就是净值历史——提前调用会看到旧数据
    const { deps, log } = makeDeps();
    await runRefreshCycle(deps, { runIndices: true, runFundNavs: true });
    expect(log.indexOf('baseline')).toBeGreaterThan(log.indexOf('commitFund:f2'));
    expect(log.indexOf('snapshot')).toBeGreaterThan(log.indexOf('baseline'));
  });

  it('完整顺序：indices → 逐只 fetch/commit → confirm → baseline → snapshot', async () => {
    const { deps, log } = makeDeps({
      pendingTransactions: () => [pendingTx()],
      navOf: () => [{ date: '2026-08-26', nav: 1.048, accNav: 1.048 }],
    });
    await runRefreshCycle(deps, { runIndices: true, runFundNavs: true });
    expect(log).toEqual([
      'indices',
      'fetch:f1', 'commitFund:f1',
      'fetch:f2', 'commitFund:f2',
      'confirm:p1',
      'baseline',
      'snapshot',
    ]);
  });
});

describe('runRefreshCycle —— 确认的判定', () => {
  it('当天的待确认不动（等用户手动确认）', async () => {
    // 用应用自己的 today()（**本地时区**），不能用 toISOString（UTC）——
    // UTC+8 的 00:00–08:00 两者差一天，会让"当天的待确认"变成"昨天的待确认"，
    // 于是被当成可确认的旧交易。这个坑 CLAUDE.md 里点名记过。
    const today = localToday();
    const { deps, log } = makeDeps({
      pendingTransactions: () => [pendingTx({ id: 'p2', date: today })],
      navOf: () => [{ date: today, nav: 1.048, accNav: 1.048 }],
    });
    await runRefreshCycle(deps, { runIndices: false, runFundNavs: true });
    expect(log).not.toContain('confirm:p2');
  });

  it('当天净值还没收录 → 不确认', async () => {
    const { deps, log } = makeDeps({
      pendingTransactions: () => [pendingTx({ id: 'p3', date: '2026-08-26' })],
      navOf: () => [{ date: '2026-08-06', nav: 1.0386, accNav: 1.0386 }],
    });
    await runRefreshCycle(deps, { runIndices: false, runFundNavs: true });
    expect(log).not.toContain('confirm:p3');
  });

  it('写盘失败 → 不计入确认笔数', async () => {
    const { deps } = makeDeps({
      pendingTransactions: () => [pendingTx()],
      navOf: () => [{ date: '2026-08-26', nav: 1.048, accNav: 1.048 }],
      commitTransaction: () => false,
    });
    const outcome = await runRefreshCycle(deps, { runIndices: false, runFundNavs: true });
    expect(outcome.confirmedCount).toBe(0);
  });

  it('确认成功 → 计入笔数', async () => {
    const { deps } = makeDeps({
      pendingTransactions: () => [pendingTx()],
      navOf: () => [{ date: '2026-08-26', nav: 1.048, accNav: 1.048 }],
    });
    const outcome = await runRefreshCycle(deps, { runIndices: false, runFundNavs: true });
    expect(outcome.confirmedCount).toBe(1);
  });
});

describe('runRefreshCycle —— 失败上报', () => {
  it('拉取失败 → 记录原因，不写盘', async () => {
    const { deps, log } = makeDeps({
      fetchFundNav: async () => ({ ok: false as const, reason: 'timeout' as const }),
    });
    const outcome = await runRefreshCycle(deps, { runIndices: false, runFundNavs: true });
    expect(outcome.issues.f1?.reason).toBe('timeout');
    expect(log).not.toContain('commitFund:f1');
  });

  it('拉取抛异常 → 记为 network，不中断整轮', async () => {
    const { deps, log } = makeDeps({
      fetchFundNav: async (fundId: string) => {
        if (fundId === 'f1') throw new Error('boom');
        return okFetch(1.2, '2026-11-20');
      },
    });
    const outcome = await runRefreshCycle(deps, { runIndices: false, runFundNavs: true });
    expect(outcome.issues.f1?.reason).toBe('network');
    // 第二只基金照常处理
    expect(log).toContain('commitFund:f2');
    expect(outcome.issues.f2).toBeUndefined();
  });

  it('趋势为空 → 记为 no-data', async () => {
    const { deps, log } = makeDeps({
      fetchFundNav: async () => okFetch(0, ''),
    });
    const outcome = await runRefreshCycle(deps, { runIndices: false, runFundNavs: true });
    expect(outcome.issues.f1?.reason).toBe('no-data');
    expect(log).not.toContain('commitFund:f1');
  });
});

describe('runRefreshCycle —— 中止（被更新的一轮取代）', () => {
  it('isAborted → 立即返回，不做快照', async () => {
    const { deps, log } = makeDeps({ isAborted: () => true });
    const outcome = await runRefreshCycle(deps, { runIndices: true, runFundNavs: true });
    expect(log).not.toContain('snapshot');
    expect(outcome.confirmedCount).toBe(0);
  });

  it('拉到一半被中止 → 剩余基金不再处理', async () => {
    let calls = 0;
    const { deps, log } = makeDeps({
      isAborted: () => calls > 0,
      fetchFundNav: async () => {
        calls++;
        return okFetch(1.2, '2026-11-20');
      },
    });
    await runRefreshCycle(deps, { runIndices: false, runFundNavs: true });
    expect(log).not.toContain('commitFund:f2');
    expect(log).not.toContain('snapshot');
  });
});
