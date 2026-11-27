import { describe, it, expect } from 'vitest';
import { portfolioView, fundPosition } from './portfolio';
import type { Fund, NavRecord, Transaction } from '../types';

/**
 * 「我持有什么」的唯一计算入口的测试。
 *
 * 这个模块存在的理由：这份计算过去散在四个地方各算各的，而且**每个调用点都得
 * 记得传 usQdiiFilterMode**——漏传不报错，只是安静地改变数字。这里把 mode 收进
 * 接口，漏传就变成编译错误。
 */

function fund(over: Partial<Fund> = {}): Fund {
  return {
    id: 'f1', name: '测试基金', platformId: 'p1', type: 'mixed',
    currentNav: 1.2, navDate: '2026-11-20', ...over,
  };
}

function nav(date: string, value: number, acc = value): NavRecord {
  return { date, nav: value, accNav: acc };
}

function buy(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1', fundId: 'f1', type: 'buy', date: '2026-11-01',
    amount: 1200, fee: 0, shares: 1000, nav: 1.2, ...over,
  };
}

const A_SHARE_NAV: NavRecord[] = [
  nav('2026-11-18', 1.10),
  nav('2026-11-19', 1.15),
];

/**
 * QDII 的净值历史：最后一条是"占位条目"（nav 与 accNav 都和前一条完全相同）——
 * 天天基金在美股休市日会补一条"复制上一交易日"的记录。
 * `auto` 模式会把它剔掉，`off` 模式不会。
 */
const QDII_NAV: NavRecord[] = [
  nav('2026-11-10', 1.00),
  nav('2026-11-11', 1.10),
  nav('2026-11-12', 1.10), // 占位：与前一条完全相同
];

describe('portfolioView —— 组合合计', () => {
  it('组合总数 = 各基金之和', () => {
    const f1 = fund({ id: 'f1', currentNav: 1.2 });
    const f2 = fund({ id: 'f2', currentNav: 2.0 });
    const input = {
      funds: [f1, f2],
      transactions: [buy({ id: 't1', fundId: 'f1' }), buy({ id: 't2', fundId: 'f2', shares: 500, amount: 1000 })],
      navHistoryOf: () => A_SHARE_NAV,
      mode: 'auto' as const,
    };

    const { positions, totals } = portfolioView(input);
    expect(positions).toHaveLength(2);
    expect(totals.totalValue).toBeCloseTo(1000 * 1.2 + 500 * 2.0, 10);
    expect(totals.totalCost).toBeCloseTo(1200 + 1000, 10);
    expect(totals.totalReturn).toBeCloseTo(totals.totalValue - totals.totalCost, 10);
  });

  it('无持仓的基金不计入合计（它的市值与成本都是 0）', () => {
    const f1 = fund({ id: 'f1' });
    const empty = fund({ id: 'f2', currentNav: 5 });
    const withEmpty = portfolioView({
      funds: [f1, empty],
      transactions: [buy()],
      navHistoryOf: () => A_SHARE_NAV,
      mode: 'auto',
    });
    const withoutEmpty = portfolioView({
      funds: [f1],
      transactions: [buy()],
      navHistoryOf: () => A_SHARE_NAV,
      mode: 'auto',
    });

    expect(withEmpty.totals.totalValue).toBe(withoutEmpty.totals.totalValue);
    expect(withEmpty.totals.totalCost).toBe(withoutEmpty.totals.totalCost);
    // 但它仍然出现在头寸列表里（组合页要展示"已清仓"的基金）
    expect(withEmpty.positions).toHaveLength(2);
    expect(withEmpty.positions[1]!.shares).toBe(0);
    expect(withEmpty.positions[1]!.avgCost).toBe(0);
  });

  it('成本均价 = 成本 ÷ 份额', () => {
    const { positions } = portfolioView({
      funds: [fund()],
      transactions: [buy({ shares: 1000, amount: 1200 })],
      navHistoryOf: () => A_SHARE_NAV,
      mode: 'auto',
    });
    expect(positions[0]!.avgCost).toBeCloseTo(1.2, 10);
  });

  it('待确认交易不进持仓、不进成本', () => {
    const { positions } = portfolioView({
      funds: [fund()],
      transactions: [buy({ id: 't1' }), buy({ id: 't2', status: 'pending', shares: 500, amount: 600 })],
      navHistoryOf: () => A_SHARE_NAV,
      mode: 'auto',
    });
    expect(positions[0]!.shares).toBe(1000);
    expect(positions[0]!.cost).toBe(1200);
  });
});

describe('portfolioView —— mode 收在接口里（漏传不再是可能的事）', () => {
  const qdii = fund({ id: 'q1', name: '纳斯达克100(QDII)', currentNav: 1.1 });

  it('auto 与 off 对 QDII 的 usable 序列不同 → 数字不同', () => {
    const base = {
      funds: [qdii],
      transactions: [buy({ fundId: 'q1' })],
      navHistoryOf: () => QDII_NAV,
    };

    const auto = portfolioView({ ...base, mode: 'auto' });
    const off = portfolioView({ ...base, mode: 'off' });

    // auto 剔掉占位条目 → 最新一对是 11-10 / 11-11；off 保留 → 最新一对是 11-11 / 11-12
    expect(auto.positions[0]!.currNavDate).toBe('2026-11-11');
    expect(off.positions[0]!.currNavDate).toBe('2026-11-12');
    // 盈亏也随之不同：auto 认到 1.00→1.10 的真实涨跌（1000 份 × 0.10 = 100），
    // off 只看到 1.10→1.10（占位条目与前一条同值 → 涨跌 0）
    expect(auto.positions[0]!.dailyPnl).toBeCloseTo(100, 10);
    expect(off.positions[0]!.dailyPnl).toBeCloseTo(0, 10);
  });

  it('A 股基金不受 mode 影响（非美股 QDII 不参与过滤）', () => {
    const base = {
      funds: [fund()],
      transactions: [buy()],
      navHistoryOf: () => A_SHARE_NAV,
    };
    const auto = portfolioView({ ...base, mode: 'auto' });
    const off = portfolioView({ ...base, mode: 'off' });
    expect(auto.positions[0]!.dailyPnl).toBe(off.positions[0]!.dailyPnl);
    expect(auto.totals.totalDailyPnl).toBe(off.totals.totalDailyPnl);
  });
});

describe('portfolioView —— 净值日分桶', () => {
  it('按各基金"最新净值日"分桶，按日期倒序', () => {
    const f1 = fund({ id: 'f1' });
    const f2 = fund({ id: 'f2' });
    const { totals } = portfolioView({
      funds: [f1, f2],
      transactions: [buy({ id: 't1', fundId: 'f1' }), buy({ id: 't2', fundId: 'f2' })],
      navHistoryOf: (id) => (id === 'f1' ? [nav('2026-11-18', 1.1), nav('2026-11-19', 1.15)] : [nav('2026-11-18', 2.1), nav('2026-11-20', 2.2)]),
      mode: 'auto',
    });

    expect(totals.navDateBuckets).toEqual([
      { date: '2026-11-20', count: 1 },
      { date: '2026-11-19', count: 1 },
    ]);
    expect(totals.coveredCount).toBe(2);
    expect(totals.noNavCount).toBe(0);
    expect(totals.totalDailyPnl).not.toBeNull();
  });

  it('没有可用净值的基金 → 计入 noNavCount，totalDailyPnl 为 null', () => {
    const { totals } = portfolioView({
      funds: [fund()],
      transactions: [buy()],
      navHistoryOf: () => [],
      mode: 'auto',
    });
    expect(totals.noNavCount).toBe(1);
    expect(totals.coveredCount).toBe(0);
    expect(totals.totalDailyPnl).toBeNull();
  });
});

describe('fundPosition —— 单只基金的头寸', () => {
  it('返回该基金的头寸', () => {
    const p = fundPosition(
      {
        funds: [fund({ id: 'f1' }), fund({ id: 'f2' })],
        transactions: [buy({ id: 't1', fundId: 'f1' })],
        navHistoryOf: () => A_SHARE_NAV,
        mode: 'auto',
      },
      'f1',
    );
    expect(p).not.toBeNull();
    expect(p!.shares).toBe(1000);
    expect(p!.marketValue).toBeCloseTo(1200, 10);
  });

  it('基金不在列表里 → null', () => {
    const p = fundPosition(
      { funds: [fund({ id: 'f1' })], transactions: [], navHistoryOf: () => A_SHARE_NAV, mode: 'auto' },
      'nope',
    );
    expect(p).toBeNull();
  });

  it('与 portfolioView 里那一只的数字一致', () => {
    const input = {
      funds: [fund({ id: 'f1' }), fund({ id: 'f2' })],
      transactions: [buy({ id: 't1', fundId: 'f1' }), buy({ id: 't2', fundId: 'f2', shares: 500, amount: 1000 })],
      navHistoryOf: (id: string) => (id === 'f1' ? A_SHARE_NAV : A_SHARE_NAV),
      mode: 'auto' as const,
    };
    const { positions } = portfolioView(input);
    const single = fundPosition(input, 'f2');
    expect(single).toEqual(positions[1]);
  });
});

/**
 * 已清仓的基金 —— 界面层契约（真实事故 2026-11-27，账本 008163）。
 *
 * 用户报的现象：基金详情页的「持仓成本 / 当前市值 / 最新净值日盈亏」显示成
 * `3.588240815588506e-13` 这种一长串数字。
 *
 * 机制：AntD 的 `Statistic` 内部格式化器（antd/es/statistic/Number.js:19-24）
 * 对 `String(value)` 跑 `/^(-?)(\d*)(\.(\d+))?$/` —— **科学计数法匹配不上**，
 * 于是原样把字符串吐出来。所以「极小但非零」的值会以原始科学计数法示人。
 *
 * 上游根因是份额/成本的浮点累加残差（见 calculator.test.ts 的同名用例）：
 * 买入 12440.9467 + 红利再投 57.61 与分两笔卖出 12488.78 + 9.7767 十进制上
 * 精确相等，浮点累加后却剩 3.4639e-13 份。
 *
 * 这条用例钉住**界面读的那几个数**必须是精确的 0 —— 否则 AntD 会把它们
 * 以科学计数法原样显示出来。
 */
describe('已清仓的基金 —— 头寸各项必须精确为 0', () => {
  /** 008163 的真实交易序列（金额/份额原样取自用户备份） */
  const SOLD_OUT: Transaction[] = [
    { ...buy({ id: 'b1', date: '2026-08-26', amount: 1575, shares: 1516.4645, nav: 0 }) },
    { ...buy({ id: 'b2', date: '2026-09-01', amount: 200, shares: 189.9335, nav: 1.053 }) },
    { ...buy({ id: 'b3', date: '2026-09-08', amount: 200, shares: 192.0123, nav: 1.0416 }) },
    { ...buy({ id: 'b4', date: '2026-09-11', amount: 10000, shares: 9575.7924, nav: 1.0443 }) },
    { ...buy({ id: 'b5', date: '2026-09-18', amount: 1000, shares: 966.744, nav: 1.0344 }) },
    { id: 'd1', fundId: 'f1', type: 'dividend', date: '2026-11-06', amount: 62.898598, fee: 0, shares: 57.61, nav: 0 },
    { id: 's1', fundId: 'f1', type: 'sell', date: '2026-11-19', amount: 14104.828132, fee: 0, shares: 12488.78, nav: 1.1294 },
    { id: 's2', fundId: 'f1', type: 'sell', date: '2026-11-19', amount: 11.04180498, fee: 0, shares: 9.7767, nav: 1.1294 },
  ];

  const input = {
    funds: [fund({ id: 'f1', currentNav: 1.1324 })],
    transactions: SOLD_OUT,
    navHistoryOf: () => A_SHARE_NAV,
    mode: 'auto' as const,
  };

  it('份额 / 成本 / 市值 / 收益率 / 年化 全部精确为 0', () => {
    const p = fundPosition(input, 'f1');
    if (!p) throw new Error('基金 f1 应该存在');
    expect(p.shares).toBe(0);
    expect(p.cost).toBe(0);
    expect(p.marketValue).toBe(0);
    expect(p.totalReturn).toBe(0);
    expect(p.returnRate).toBe(0);
    expect(p.xirr).toBe(0);
    expect(p.avgCost).toBe(0);
  });

  it('这些值不会以科学计数法示人（AntD Statistic 会原样输出）', () => {
    const p = fundPosition(input, 'f1');
    if (!p) throw new Error('基金 f1 应该存在');
    // AntD 的内部格式化器匹配不上就原样输出 —— 所以值必须是普通十进制串
    const ANT_PATTERN = /^(-?)(\d*)(\.(\d+))?$/;
    for (const [name, v] of Object.entries({
      shares: p.shares, cost: p.cost, marketValue: p.marketValue,
      totalReturn: p.totalReturn, returnRate: p.returnRate, xirr: p.xirr,
    })) {
      expect(String(v), `${name} 不该以科学计数法示人`).toMatch(ANT_PATTERN);
    }
  });

  it('组合合计不受这只基金影响', () => {
    const { totals } = portfolioView(input);
    expect(totals.totalValue).toBe(0);
    expect(totals.totalCost).toBe(0);
    expect(totals.totalReturnRate).toBe(0);
  });
});
