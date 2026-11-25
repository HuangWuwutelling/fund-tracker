import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateSnapshot } from './snapshot';
import type { Fund, Transaction } from '../types';

/**
 * 今日快照是组合趋势图的数据源。
 *
 * 它的合计取自 `portfolioView`——与 Dashboard 同一份实现，所以快照与组合总览
 * 不可能对不上。这条测试钉住两件事：
 * - 非交易日不生成快照（否则日历里多出 0 涨跌的空格子）
 * - 只计入已确认交易（pending 不进持仓，也不进成本）
 */
function fund(over: Partial<Fund> = {}): Fund {
  return {
    id: 'f1', name: '测试基金', platformId: 'p1', type: 'mixed',
    currentNav: 1.2, navDate: '2026-11-20', ...over,
  };
}

function buy(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1', fundId: 'f1', type: 'buy', date: '2026-11-01',
    amount: 1200, fee: 0, shares: 1000, nav: 1.2, ...over,
  };
}

/** 固定到交易日（2026-11-20 周五） */
function pinTradingDay() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T10:00:00'));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('generateSnapshot（今日快照）', () => {
  beforeEach(() => {
    pinTradingDay();
  });

  it('总市值 = 份额 × 最新净值，总成本 = 投入金额', () => {
    const snap = generateSnapshot({
      funds: [fund()],
      transactions: [buy()],
      navHistoryOf: () => [],
      mode: 'auto',
    });
    expect(snap).not.toBeNull();
    expect(snap!.date).toBe('2026-11-20');
    expect(snap!.totalValue).toBe(1200);
    expect(snap!.totalCost).toBe(1200);
  });

  it('多只基金 → 市值与成本都是各自相加', () => {
    const snap = generateSnapshot({
      funds: [fund({ id: 'f1', currentNav: 1.2 }), fund({ id: 'f2', currentNav: 2.0 })],
      transactions: [
        buy({ id: 't1', fundId: 'f1', shares: 1000, amount: 1200 }),
        buy({ id: 't2', fundId: 'f2', shares: 500, amount: 1000 }),
      ],
      navHistoryOf: () => [],
      mode: 'auto',
    });
    expect(snap!.totalValue).toBe(1200 + 1000);
    expect(snap!.totalCost).toBe(2200);
  });

  it('待确认交易不进持仓、不进成本', () => {
    const snap = generateSnapshot({
      funds: [fund()],
      transactions: [buy({ id: 't1' }), buy({ id: 't2', status: 'pending', shares: 500, amount: 600 })],
      navHistoryOf: () => [],
      mode: 'auto',
    });
    expect(snap!.totalValue).toBe(1200);
    expect(snap!.totalCost).toBe(1200);
  });

  it('没有基金 → 市值与成本都是 0', () => {
    const snap = generateSnapshot({
      funds: [],
      transactions: [],
      navHistoryOf: () => [],
      mode: 'auto',
    });
    expect(snap!.totalValue).toBe(0);
    expect(snap!.totalCost).toBe(0);
  });

  it('金额保留 2 位小数', () => {
    const snap = generateSnapshot({
      funds: [fund({ currentNav: 1.23456 })],
      transactions: [buy({ shares: 1000, amount: 1234.5678 })],
      navHistoryOf: () => [],
      mode: 'auto',
    });
    // 市值 = 1000 × 1.23456 = 1234.56（本来就是 2 位）
    expect(snap!.totalValue).toBe(1234.56);
    // 成本 = 1234.5678 → 四舍五入到分
    expect(snap!.totalCost).toBe(1234.57);
  });
});

describe('generateSnapshot —— 非交易日不生成', () => {
  it('周六 → null（避免日历里多出 0 涨跌的空格子）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T10:00:00')); // 周六
    const snap = generateSnapshot({
      funds: [fund()],
      transactions: [buy()],
      navHistoryOf: () => [],
      mode: 'auto',
    });
    expect(snap).toBeNull();
  });

  it('法定节假日 → null', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T10:00:00')); // 国庆
    const snap = generateSnapshot({
      funds: [fund()],
      transactions: [buy()],
      navHistoryOf: () => [],
      mode: 'auto',
    });
    expect(snap).toBeNull();
  });
});
