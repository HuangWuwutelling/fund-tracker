import { describe, it, expect } from 'vitest';
import {
  generateDailyReturns,
  generateMonthlyReturns,
  generateWeeklyReport,
  type NavHistorySource,
} from './reportGenerator';
import type { Fund, NavRecord, Transaction } from '../types';

/**
 * 收益率**分母**的口径测试。
 *
 * 之前 returnRate 完全没有断言：reportGenerator 的分子（每日收益）走一个
 * 全局测试钩子，分母（资金加权持仓市值）走真实 storage——在 node 环境下
 * 走不到，所以 generateWeeklyReport / generateMonthlyReport /
 * generateMonthlyReturns / generateYearlyReturns 这四个函数**完全没测**，
 * returnRate 在测试里恒为 0（分母为 0）。
 *
 * 现在净值历史是入参，分母路径第一次可以被真正验证。
 */

function fund(id: string): Fund {
  return { id, name: id, platformId: 'p1', type: 'mixed', currentNav: 1, navDate: '' };
}

function nav(date: string, v: number): NavRecord {
  return { date, nav: v, accNav: v };
}

/** 2026-08-01 → 2026-08-31，8/15 买入 1000 份 @1.0，8/31 净值 1.02 */
const FUNDS = [fund('f1')];
const NAVS: NavRecord[] = [nav('2026-08-01', 1.0), nav('2026-08-31', 1.02)];
const navOf: NavHistorySource = () => NAVS;
const TXS: Transaction[] = [
  {
    id: 'b1', fundId: 'f1', type: 'buy', date: '2026-08-15',
    amount: 1000, fee: 0, shares: 1000, nav: 1.0,
  },
];

describe('月度收益率的分母 = 区间内资金加权持仓市值', () => {
  it('月中买入 → 分母是「日均持仓市值」，不是成本，也不是月末市值', () => {
    const dailies = generateDailyReturns(FUNDS, TXS, navOf);
    const monthly = generateMonthlyReturns(FUNDS, TXS, dailies, 2026, navOf);
    const aug = monthly.find((m) => m.month === '2026-08');
    expect(aug).toBeDefined();

    // 收益：1000 份 × (1.02 − 1.0) = 20 元
    expect(aug!.totalReturn).toBeCloseTo(20, 4);

    // 分母（手算）：8/15-8/30 共 16 天市值 1000，8/31 市值 1020，其余 14 天无持仓 0
    //   → (16 × 1000 + 1020) / 31 = 17020 / 31 ≈ 549.03
    const expectedWeighted = (16 * 1000 + 1020) / 31;
    expect(aug!.returnRate).toBeCloseTo((20 / expectedWeighted) * 100, 4);

    // 分母不是成本（1000）——否则分母偏大、收益率被压低
    expect(aug!.returnRate).not.toBeCloseTo((20 / 1000) * 100, 2);
    // 也不是月末市值（1020）
    expect(aug!.returnRate).not.toBeCloseTo((20 / 1020) * 100, 2);
  });

  it('周报：区间内净值没动 → 收益为 0（分母路径走通，不炸）', () => {
    const week = generateWeeklyReport(
      new Date('2026-08-19'), FUNDS, TXS, [], [], navOf,
    );
    expect(week.weekStart).toBe('2026-08-17');
    expect(week.weekEnd).toBe('2026-08-23');
    expect(week.totalReturn).toBeCloseTo(0, 4);
    // 分母非零（8/15 买入 → 周内有持仓）→ returnRate 有定义
    expect(Number.isFinite(week.returnRate)).toBe(true);
  });

  it('完全没有持仓 → 收益率 0（分母为 0 不产生 NaN/Infinity）', () => {
    const dailies = generateDailyReturns(FUNDS, [], navOf);
    const monthly = generateMonthlyReturns(FUNDS, [], dailies, 2026, navOf);
    const aug = monthly.find((m) => m.month === '2026-08');
    expect(aug!.totalReturn).toBe(0);
    expect(aug!.returnRate).toBe(0);
    expect(Number.isFinite(aug!.returnRate)).toBe(true);
  });
});
