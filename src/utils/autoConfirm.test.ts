import { describe, it, expect } from 'vitest';
import { confirmPendingTx } from './autoConfirm';
import type { NavRecord, Transaction } from '../types';

function nav(date: string, n: number): NavRecord {
  return { date, nav: n, accNav: n };
}

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1', fundId: 'f1', type: 'buy', date: '2026-08-26',
    amount: 1575, fee: 0, shares: 0, nav: 0, status: 'pending', ...over,
  };
}

// 只有两条净值：08-06 的旧值，和 08-26 当天的真值
const HISTORY: NavRecord[] = [nav('2026-08-06', 1.0386), nav('2026-08-26', 1.048)];

describe('confirmPendingTx —— 只有**交易当天**的净值能用来推算份额', () => {
  it('买入：查到当天净值 → 补份额（(金额 − 手续费) ÷ 当天净值）', () => {
    const r = confirmPendingTx(tx(), HISTORY);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.patch.status).toBe('confirmed');
    expect(r.patch.nav).toBe(1.048);
    // 平台确认的份额是 1502.8626 份——不是用 08-06 的旧净值算出的 1516.4645
    expect(r.patch.shares).toBeCloseTo(1575 / 1.048, 4);
    expect(r.patch.shares).not.toBeCloseTo(1575 / 1.0386, 2);
  });

  it('当天净值还没发布（只有更早的）→ 拒绝确认，绝不用旧净值', () => {
    const r = confirmPendingTx(tx(), [nav('2026-08-06', 1.0386)]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('nav-not-published');
    // 告诉调用方本地最新的净值是哪天——用户能看懂为什么还没确认
    expect(r.latestKnownDate).toBe('2026-08-06');
  });

  it('当天净值已发布但本地还没收录（本地只有更早的）→ 同样拒绝', () => {
    // 这是 2026-08-26 事故的精确形状：远程有 08-26，本地历史陈旧只到 08-06
    const r = confirmPendingTx(tx(), [nav('2026-08-06', 1.0386)]);
    expect(r.ok).toBe(false);
  });

  it('卖出：份额是权威 → 补成交额，份额不动', () => {
    const r = confirmPendingTx(
      tx({ type: 'sell', amount: 0, shares: 1000, fee: 0.5 }),
      HISTORY,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.patch.amount).toBeCloseTo(1000 * 1.048, 4);
    expect(r.patch.shares).toBe(1000);
  });

  it('分红：不需要净值，直接确认', () => {
    const r = confirmPendingTx(
      tx({ type: 'dividend', amount: 62.9, shares: 0 }),
      HISTORY,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.patch.status).toBe('confirmed');
  });

  it('本地完全没有净值历史 → 拒绝确认', () => {
    const r = confirmPendingTx(tx(), []);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('nav-not-published');
    expect(r.latestKnownDate).toBeNull();
  });

  it('份额保留 4 位小数（写入账本的精度口径统一）', () => {
    const r = confirmPendingTx(tx({ amount: 1000 }), HISTORY);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const s = r.patch.shares!;
    expect(s).toBe(Math.round(s * 10000) / 10000);
  });
});
