import { describe, it, expect } from 'vitest';
import { calcLatestNavPnl } from './calculator';
import type { Fund, NavRecord, Transaction } from '../types';

function fund(name: string): Fund {
  return { id: 'f1', name, platformId: 'p1', type: 'qdii', currentNav: 1.2, navDate: '2026-09-08' };
}

function nav(date: string, value: number): NavRecord {
  return { date, nav: value, accNav: value };
}

function buy(date: string, shares: number): Transaction {
  return { id: `t-${date}`, fundId: 'f1', type: 'buy', date, amount: shares, fee: 0, shares, nav: 1 };
}

// 广发纳指 100：9/7 是美股劳工节，被 usableNavSeries 过滤掉，
// 可用序列 = [9/4 (1.0), 9/8 (1.2)] → 配对 prev=9/4、curr=9/8，Δnav = +0.2。
// 9/4 与 9/8 之间夹着一个被过滤的 9/7，正好用来区分 sharesBefore 锚在哪一天。
const HISTORY: NavRecord[] = [
  nav('2026-09-04', 1.0),
  nav('2026-09-07', 1.0), // 美股劳工节的复制记录，会被 usableNavSeries 剔除
  nav('2026-09-08', 1.2),
];

describe('calcLatestNavPnl', () => {
  it('sharesBefore 锚在 curr.date：夹在 prev 与 curr 之间的买入吃满权重', () => {
    // 9/7 买入 1000 份，成本即 9/7 净值；9/8 涨到 1.2 → 应计 1000 × 0.2 = 200。
    // 若锚点被改成 `<= pair.prev.date`（9/4），这笔买入会被当作"当日新增份额"折半，
    // 变成 1000 × 0.2 × 0.5 = 100 —— 静默少算一半，且不会打挂任何其他测试。
    const r = calcLatestNavPnl(fund('广发纳斯达克100ETF联接(QDII)A'), HISTORY, [
      buy('2026-09-07', 1000),
    ]);
    expect(r.pnl).toBeCloseTo(200, 6);
    expect(r.currDate).toBe('2026-09-08');
    expect(r.prevDate).toBe('2026-09-04');
  });

  it('买在 curr.date 当天：按半天持仓折半计', () => {
    // 9/8 当天买入 1000 份 → sharesBefore = 0、sharesAfter = 1000，
    // pnl = 0 × 0.2 + (1000 − 0) × 0.2 × 0.5 = 100。
    const r = calcLatestNavPnl(fund('广发纳斯达克100ETF联接(QDII)A'), HISTORY, [
      buy('2026-09-08', 1000),
    ]);
    expect(r.pnl).toBeCloseTo(100, 6);
  });
});
