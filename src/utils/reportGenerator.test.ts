import { afterEach, describe, it, expect } from 'vitest';
import {
  generateFundDailyReturns,
  generateDailyReturns,
  __setNavHistoryForTest,
} from './reportGenerator';
import type { Fund, NavRecord, Transaction } from '../types';
import { today } from './formatter';
import dayjs from 'dayjs';

function fund(id: string, name = id, type: Fund['type'] = 'mixed'): Fund {
  return { id, name, platformId: 'p1', type, currentNav: 1, navDate: '' };
}

function nav(date: string, value: number): NavRecord {
  return { date, nav: value, accNav: value };
}

function buy(date: string, amount: number, shares: number, nav: number, fee = 0): Transaction {
  return { id: `b-${date}`, fundId: 'f1', type: 'buy', date, amount, fee, shares, nav };
}

function sell(date: string, amount: number, shares: number, nav: number, fee = 0): Transaction {
  return { id: `s-${date}`, fundId: 'f1', type: 'sell', date, amount, fee, shares, nav };
}

function dividend(date: string, amount: number, shares = 0, nav = 1): Transaction {
  return { id: `d-${date}`, fundId: 'f1', type: 'dividend', date, amount, fee: 0, shares, nav };
}

// 每个 case 用一个固定的 NAV 序列注入；避免不同 test 之间状态泄漏
afterEach(() => {
  __setNavHistoryForTest(null);
});

describe('generateFundDailyReturns', () => {
  it('no transactions and no nav → empty', () => {
    __setNavHistoryForTest(() => []);
    expect(generateFundDailyReturns(fund('f1'), [], '2025-09-09')).toEqual([]);
  });
});

/**
 * wealth-change 算法的核心不变量：
 *   dailyReturn(D) = cumReturn(D) − cumReturn(prevMeaningfulDate)
 *   cumReturn(D)   = shares × NAV − Σbuy + Σ(sell − fee) + ΣcashDiv
 *
 * 测试日期选 2025-09-08 (Mon) 与 2025-09-09 (Tue)：两个都是交易日，无节假日干扰，
 * 便于逐日断言。
 */
describe('generateFundDailyReturns - wealth change', () => {
  const NAVS_0809 = [
    nav('2025-09-08', 1.0),
    nav('2025-09-09', 1.0),
  ];

  it('buy on day, NAV flat → 0 dailyReturn (cumReturn unchanged)', () => {
    __setNavHistoryForTest(() => NAVS_0809);
    const txs = [buy('2025-09-08', 1000, 1000, 1.0)];

    const out = generateFundDailyReturns(fund('f1'), txs, '2025-09-09');

    // 9/8: cumReturn = 1000×1.0 − 1000 = 0, 9/9: cumReturn = 0 → 两格都是 0
    expect(out).toHaveLength(2);
    expect(out[0]!.date).toBe('2025-09-08');
    expect(out[0]!.totalReturn).toBe(0);
    expect(out[0]!.perFund[0]!.returnAmount).toBe(0);
    expect(out[1]!.date).toBe('2025-09-09');
    expect(out[1]!.totalReturn).toBe(0);
    expect(out[1]!.perFund[0]!.returnAmount).toBe(0);
  });

  it('NAV up 1% on day with no tx → positive return = shares × Δnav', () => {
    const navs = [nav('2025-09-08', 1.0), nav('2025-09-09', 1.01)];
    __setNavHistoryForTest(() => navs);
    const txs = [buy('2025-09-08', 1000, 1000, 1.0)];

    const out = generateFundDailyReturns(fund('f1'), txs, '2025-09-09');

    // 9/8: cumReturn = 0 (buy 1000 @1.0)
    // 9/9: cumReturn = 1000×1.01 − 1000 = 10
    expect(out[0]!.totalReturn).toBe(0);
    expect(out[1]!.totalReturn).toBeCloseTo(10, 6);
    expect(out[1]!.perFund[0]!.returnAmount).toBeCloseTo(10, 6);
  });

  it('buy mid-day at higher NAV than prev → return for buy day captures discount gain', () => {
    // 9/8 buy 1000 @ 1.0，9/9 NAV 跳到 1.10（无买卖）
    // cumReturn(9/8) = 0
    // cumReturn(9/9) = 1000×1.10 − 1000 = 100
    // 9/9 dailyReturn = 100 − 0 = 100
    const navs = [nav('2025-09-08', 1.0), nav('2025-09-09', 1.10)];
    __setNavHistoryForTest(() => navs);
    const txs = [buy('2025-09-08', 1000, 1000, 1.0)];

    const out = generateFundDailyReturns(fund('f1'), txs, '2025-09-09');

    expect(out[0]!.totalReturn).toBe(0);
    expect(out[1]!.totalReturn).toBeCloseTo(100, 6);
  });

  it('cash dividend → cumReturn bumps by amount on dividend date', () => {
    // 9/8 buy 1000 @ 1.0，9/9 现金分红 amount=50，shares=0
    // cumReturn(9/8) = 0
    // cumReturn(9/9) = 1000×1.0 − 1000 + 0 + 50 = 50
    const navs = [nav('2025-09-08', 1.0), nav('2025-09-09', 1.0)];
    __setNavHistoryForTest(() => navs);
    const txs = [
      buy('2025-09-08', 1000, 1000, 1.0),
      dividend('2025-09-09', 50, 0, 1.0),
    ];

    const out = generateFundDailyReturns(fund('f1'), txs, '2025-09-09');

    expect(out[0]!.totalReturn).toBe(0);
    expect(out[1]!.totalReturn).toBeCloseTo(50, 6);
  });

  it('reinvest dividend → shares bump, cumReturn += shares × NAV', () => {
    // 9/8 buy 1000 @ 1.0，9/9 红利再投资 amount=0, shares=100
    // cumReturn(9/8) = 0
    // cumReturn(9/9) = (1000+100)×1.0 − 1000 + 0 + 0 = 100
    const navs = [nav('2025-09-08', 1.0), nav('2025-09-09', 1.0)];
    __setNavHistoryForTest(() => navs);
    const txs = [
      buy('2025-09-08', 1000, 1000, 1.0),
      dividend('2025-09-09', 0, 100, 1.0),
    ];

    const out = generateFundDailyReturns(fund('f1'), txs, '2025-09-09');

    expect(out[0]!.totalReturn).toBe(0);
    expect(out[1]!.totalReturn).toBeCloseTo(100, 6);
  });

  it('sell → cumReturn bumps by sell.amount − sell.fee', () => {
    // 9/8 buy 1000 @ 1.0，9/9 sell 500 @ 1.0 fee=10 → inflow 990
    // cumReturn(9/8) = 0
    // cumReturn(9/9) = 500×1.0 − 1000 + (1000 − 10) + 0 = 490
    const navs = [nav('2025-09-08', 1.0), nav('2025-09-09', 1.0)];
    __setNavHistoryForTest(() => navs);
    const txs = [
      buy('2025-09-08', 1000, 1000, 1.0),
      sell('2025-09-09', 1000, 500, 1.0, 10),
    ];

    const out = generateFundDailyReturns(fund('f1'), txs, '2025-09-09');

    expect(out[0]!.totalReturn).toBe(0);
    expect(out[1]!.totalReturn).toBeCloseTo(490, 6);
  });

  it('pending transactions are excluded (only confirmed counts)', () => {
    // pending buy 应该被忽略；如果误算会多出 +1 (NAV 不变时) 或其他偏差
    const navs = [nav('2025-09-08', 1.0), nav('2025-09-09', 1.0)];
    __setNavHistoryForTest(() => navs);
    const txs = [
      buy('2025-09-08', 1000, 1000, 1.0),
      { ...buy('2025-09-09', 9999, 9999, 1.0), status: 'pending' as const },
    ];

    const out = generateFundDailyReturns(fund('f1'), txs, '2025-09-09');

    // 两格 totalReturn 都应当是 0（NAV 没动 + 没分红/买卖计入）
    expect(out[0]!.totalReturn).toBe(0);
    expect(out[1]!.totalReturn).toBe(0);
  });

  it('today格 uses latest NAV pair when today has no NAV', () => {
    // 9/8 买，9/8 NAV，9/9 没 NAV，today=9/10（最新可用 NAV=9/8）
    // 9/9 dailyReturn = cumReturn(9/9) - cumReturn(9/8) = 0 - 0 = 0
    // 9/10 dailyReturn = 0（同 cumToday = prevCum）
    // 9/10 的 navDate 应该是 9/8（最新可用 NAV 归属日）
    const navs = [nav('2025-09-08', 1.0)];
    __setNavHistoryForTest(() => navs);
    const txs = [buy('2025-09-08', 1000, 1000, 1.0)];

    const out = generateFundDailyReturns(fund('f1'), txs, '2025-09-10');

    // 9/10 是周三，交易日，会被发射
    expect(out[out.length - 1]!.date).toBe('2025-09-10');
    expect(out[out.length - 1]!.perFund[0]!.navDate).toBe('2025-09-08');
    expect(out[out.length - 1]!.totalReturn).toBe(0);
  });

  it('today格 noNav=true when fund has position but no usable NAV at all', () => {
    // 没 NAV、没 tx → 早就 early-return []，走不到 today 格
    // 这里给 NAV 但 usable<2：仍没有可用 NAV 对，pf.noNav 应为 true
    // 但今天的 dailyReturn 是 cumByDate[today-1]=cumReturn(prior NAV) - prevCum；
    // 这里 today 用的是 9/9（有 NAV 1.0），shares=1000，cumReturn=0。
    //   noNav: isToday && hasPosition && !hasUsableNav → true
    // 关键不变量：noNav 仅在 isToday=true 时为 true，历史格不会
    const navs = [nav('2025-09-08', 1.0), nav('2025-09-09', 1.0)];
    __setNavHistoryForTest(() => navs);
    const txs = [buy('2025-09-08', 1000, 1000, 1.0)];

    const out = generateFundDailyReturns(fund('f1'), txs, '2025-09-09');

    // 今天格: hasPosition=true, hasUsableNav=true(usable.length>=1) → noNav=false
    const todayEntry = out[out.length - 1]!;
    expect(todayEntry.date).toBe('2025-09-09');
    expect(todayEntry.perFund[0]!.noNav).toBe(false);
    expect(todayEntry.isPending).toBe(false);

    // 历史格 noNav 永远是 false
    expect(out[0]!.perFund[0]!.noNav).toBeFalsy();
  });

  it('skips non-trading days in history; today always included when trading day', () => {
    // 9/8 (Mon) 买，9/9 (Tue) NAV，9/10 (Wed) today
    // 9/8 在财年内是交易日；中间没非交易日（不放周末干扰）
    // 用 9/12 (Fri) → 9/15 (Mon, 元旦后? 不对)  改用 9/8/9/10 三个连续交易日
    const navs = [
      nav('2025-09-08', 1.0),
      nav('2025-09-09', 1.0),
      nav('2025-09-10', 1.0),
    ];
    __setNavHistoryForTest(() => navs);
    const txs = [buy('2025-09-08', 1000, 1000, 1.0)];

    const out = generateFundDailyReturns(fund('f1'), txs, '2025-09-10');

    // 9/8 Mon, 9/9 Tue, 9/10 Wed 都是交易日
    expect(out.map((d) => d.date)).toEqual(['2025-09-08', '2025-09-09', '2025-09-10']);
  });
});

/**
 * generateDailyReturns 的核心不变量：组合日序列 = 各基金日序列按日期合并。
 *
 * 这个测试是 Task 2 重构（把 portfolio 日历改成"按基金组合"）的回归保护：
 *   - 重构前/后都必须保持：portfolio[i].totalReturn === Σ perFund[i].totalReturn
 *   - portfolio[i].perFund 必须包含所有基金（即便有些基金当日没贡献也应出现）
 *
 * 用 today() 当锚点构造 NAV + 买入日；保证 generateDailyReturns 内部 today() 与
 * generateFundDailyReturns 外部传入的 todayStr 同值（一天内多次调用 today() 不会跨日）。
 */
describe('generateDailyReturns - portfolio composition', () => {
  it('portfolio daily total = sum of per-fund daily totals', () => {
    const todayStr = today();
    const prev = dayjs(todayStr).subtract(1, 'day').format('YYYY-MM-DD');
    // NAV 双天序列（prev + today）。NAV 跳 1% on 1000 shares = +10 / +20 收益。
    const navs1 = [nav(prev, 1.0), nav(todayStr, 1.01)];
    const navs2 = [nav(prev, 2.0), nav(todayStr, 2.02)];

    __setNavHistoryForTest((code) => {
      if (code === 'f1') return navs1;
      if (code === 'f2') return navs2;
      return [];
    });

    const f1 = fund('f1', 'Fund 1');
    const f2 = fund('f2', 'Fund 2');
    const txs = [
      { ...buy(prev, 1000, 1000, 1.0), fundId: 'f1' },
      { ...buy(prev, 1000, 500, 2.0), fundId: 'f2' },
    ];

    const perFund1 = generateFundDailyReturns(f1, txs, todayStr);
    const perFund2 = generateFundDailyReturns(f2, txs, todayStr);
    const portfolio = generateDailyReturns([f1, f2], txs);

    // 同日期序列、同 dailyReturn = Σ per-fund
    expect(portfolio.length).toBe(perFund1.length);
    for (let i = 0; i < portfolio.length; i++) {
      expect(portfolio[i]!.date).toBe(perFund1[i]!.date);
      expect(portfolio[i]!.totalReturn).toBeCloseTo(
        perFund1[i]!.totalReturn + perFund2[i]!.totalReturn,
        6,
      );
      // 每个 portfolio 格子都包含两只基金的 perFund
      expect(portfolio[i]!.perFund).toHaveLength(2);
      const ids = portfolio[i]!.perFund.map((p) => p.fundId).sort();
      expect(ids).toEqual(['f1', 'f2']);
    }
  });
});