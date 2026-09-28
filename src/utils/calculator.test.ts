import { describe, it, expect } from 'vitest';
import { calcLatestNavPnl, getPlanDueDates, isDcaPlanDueToday } from './calculator';
import type { DcaPlan, Fund, NavRecord, Transaction } from '../types';

function fund(name: string): Fund {
  return { id: 'f1', name, platformId: 'p1', type: 'qdii', currentNav: 1.2, navDate: '2026-09-08' };
}

function nav(date: string, value: number): NavRecord {
  return { date, nav: value, accNav: value };
}

function buy(date: string, shares: number): Transaction {
  return { id: `t-${date}`, fundId: 'f1', type: 'buy', date, amount: shares, fee: 0, shares, nav: 1 };
}

/** 用本地正午避免 Date 解析的 TZ 偏移；2026 节假日见 chineseHolidays.ts */
function noon(date: string): Date {
  return new Date(`${date}T12:00:00`);
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

describe('getPlanDueDates - 法定节假日', () => {
  it('daily 计划跳过 2026-09-25（中秋·周五）', () => {
    const plan: DcaPlan = {
      id: 'p1', fundId: 'f1', amount: 100, frequency: 'daily',
      active: true, startDate: '2026-09-21',
    };
    const dates = getPlanDueDates(plan, '2026-09-28');
    // 9/21-24 工作日，9/25 中秋跳，9/26-27 周末跳，9/28 工作日
    expect(dates).toEqual([
      '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-28',
    ]);
  });

  it('daily 计划跳过 2026 国庆块（10/1-2 + 10/5-7）', () => {
    const plan: DcaPlan = {
      id: 'p1', fundId: 'f1', amount: 100, frequency: 'daily',
      active: true, startDate: '2026-09-28',
    };
    const dates = getPlanDueDates(plan, '2026-10-12');
    // 9/28-30 工作日；10/1-2 假、10/3-4 周末、10/5-7 假；10/8-9 工作日；10/10-11 周末；10/12 工作日
    expect(dates).toEqual([
      '2026-09-28', '2026-09-29', '2026-09-30',
      '2026-10-08', '2026-10-09', '2026-10-12',
    ]);
  });

  it('monthly dayOfMonth=1 跳过 2026-10-01（国庆）——当月不补录', () => {
    const plan: DcaPlan = {
      id: 'p1', fundId: 'f1', amount: 100, frequency: 'monthly',
      dayOfMonth: 1, active: true, startDate: '2026-08-01',
    };
    const dates = getPlanDueDates(plan, '2026-10-31');
    // 9/1 工作日 → 计入；10/1 假日 → 跳过（不顺延）
    expect(dates).toEqual(['2026-09-01']);
  });

  it('weekly dayOfWeek=5 跳过节假日周五', () => {
    const plan: DcaPlan = {
      id: 'p1', fundId: 'f1', amount: 100, frequency: 'weekly',
      dayOfWeek: 5, active: true, startDate: '2026-09-18',
    };
    const dates = getPlanDueDates(plan, '2026-10-09');
    // 9/18 Fri ✓、9/25 Fri 中秋 ✗、10/2 Fri 国庆 ✗、10/9 Fri ✓
    expect(dates).toEqual(['2026-09-18', '2026-10-09']);
  });
});

describe('isDcaPlanDueToday - 法定节假日', () => {
  const basePlan: DcaPlan = {
    id: 'p1', fundId: 'f1', amount: 100, frequency: 'daily',
    active: true, startDate: '2020-01-01',
  };

  it('daily 在中秋当天返回 false', () => {
    expect(isDcaPlanDueToday(basePlan, noon('2026-09-25'))).toBe(false);
  });

  it('daily 在国庆当天返回 false', () => {
    expect(isDcaPlanDueToday(basePlan, noon('2026-10-01'))).toBe(false);
  });

  it('daily 在普通工作日返回 true', () => {
    expect(isDcaPlanDueToday(basePlan, noon('2026-09-28'))).toBe(true);
  });

  it('monthly dayOfMonth=1 在国庆当天返回 false', () => {
    const plan: DcaPlan = { ...basePlan, frequency: 'monthly', dayOfMonth: 1 };
    expect(isDcaPlanDueToday(plan, noon('2026-10-01'))).toBe(false);
  });

  it('monthly dayOfMonth=1 在普通 1 号工作日返回 true', () => {
    const plan: DcaPlan = { ...basePlan, frequency: 'monthly', dayOfMonth: 1 };
    expect(isDcaPlanDueToday(plan, noon('2026-09-01'))).toBe(true);
  });
});
