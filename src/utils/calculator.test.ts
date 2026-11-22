import { describe, it, expect } from 'vitest';
import {
  calcLatestNavPnl,
  getPlanDueDates,
  isDcaPlanDueToday,
  calcAmountFromShares,
  calcSharesBeforeTx,
  calcCost,
  calcShares,
  calcMarketValue,
  calcReturn,
  calcReturnRate,
  onlyConfirmed,
} from './calculator';
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

/* ============================================================
 *  calcAmountFromShares —— 卖出/红利再投资的成交额
 * ============================================================ */

describe('calcAmountFromShares', () => {
  it('成交额 = 份额 × 净值', () => {
    expect(calcAmountFromShares(12498.5567, 1.1294)).toBeCloseTo(14115.87, 2);
  });

  it('净值 0 → 0（不产生 NaN / Infinity）', () => {
    expect(calcAmountFromShares(1000, 0)).toBe(0);
  });

  it('份额 0 → 0', () => {
    expect(calcAmountFromShares(0, 1.2345)).toBe(0);
  });
});

/* ============================================================
 *  calcSharesBeforeTx —— 某笔交易「之前」的持仓份额
 * ============================================================ */

describe('calcSharesBeforeTx', () => {
  const t = (over: Partial<Transaction> & { id: string; date: string }): Transaction => ({
    fundId: 'f1', type: 'buy', amount: 0, fee: 0, shares: 0, nav: 1, ...over,
  });

  it('累计到该笔交易之前的份额（卖出前的持仓）', () => {
    const txs = [
      t({ id: 'b1', date: '2026-08-26', type: 'buy', shares: 1516.4645 }),
      t({ id: 'b2', date: '2026-09-11', type: 'buy', shares: 9575.7924 }),
      t({ id: 'd1', date: '2026-11-06', type: 'dividend', shares: 57.61 }),
      t({ id: 's1', date: '2026-11-19', type: 'sell', shares: 12488.7817 }),
    ];
    const sell = txs[3]!;
    expect(calcSharesBeforeTx(txs, sell)).toBeCloseTo(1516.4645 + 9575.7924 + 57.61, 6);
  });

  it('排除自身（编辑一笔已记录的交易时不会把自己算进去）', () => {
    const txs = [
      t({ id: 'b1', date: '2026-08-26', type: 'buy', shares: 1000 }),
      t({ id: 's1', date: '2026-09-01', type: 'sell', shares: 400 }),
    ];
    expect(calcSharesBeforeTx(txs, txs[1]!)).toBeCloseTo(1000, 6);
  });

  it('不计入该笔交易之后的交易', () => {
    const txs = [
      t({ id: 's1', date: '2026-09-01', type: 'sell', shares: 400 }),
      t({ id: 'b2', date: '2026-09-10', type: 'buy', shares: 500 }),
    ];
    expect(calcSharesBeforeTx(txs, txs[0]!)).toBe(0);
  });

  it('同日交易计入（同一天先买后卖也算在持仓里）', () => {
    const txs = [
      t({ id: 'b1', date: '2026-09-01', type: 'buy', shares: 800 }),
      t({ id: 's1', date: '2026-09-01', type: 'sell', shares: 300 }),
    ];
    expect(calcSharesBeforeTx(txs, txs[1]!)).toBeCloseTo(800, 6);
  });

  it('待确认交易不计入持仓', () => {
    const txs = [
      t({ id: 'b1', date: '2026-08-26', type: 'buy', shares: 1000 }),
      t({ id: 's1', date: '2026-09-01', type: 'sell', shares: 400, status: 'pending' }),
    ];
    expect(calcSharesBeforeTx(txs, txs[1]!)).toBeCloseTo(1000, 6);
  });
});

/* ============================================================
 *  以下为重构前的「现状锁定」测试（characterization tests）
 *  覆盖 calcCost / calcShares / calcMarketValue / calcReturn(Rate)。
 *  重构 utils/calculator.ts 时，这些数字不能变。
 * ============================================================ */

/** 构造交易记录（与文件里已有的 buy() 辅助函数刻意区分，避免重名） */
function mkTx(over: Partial<Transaction> & { id: string }): Transaction {
  return {
    fundId: 'f1',
    type: 'buy',
    date: '2026-01-01',
    amount: 0,
    fee: 0,
    shares: 0,
    nav: 1,
    ...over,
  };
}

describe('calcCost —— 部分卖出按「平均成本比例」扣减', () => {
  it('买入 1000 份 / 1000 元，卖出 400 份 → 剩余成本 600、剩余份额 600', () => {
    // 平均成本 = 1000 / 1000 = 1.0；卖出扣减 1.0 × 400 = 400 → 成本剩 600。
    // 这里锁的是「比例扣减」本身：换算成批次口径（FIFO/LIFO）会得到别的数字。
    const txs = [
      mkTx({ id: 'b1', date: '2026-01-05', type: 'buy', amount: 1000, shares: 1000, nav: 1 }),
      mkTx({ id: 's1', date: '2026-01-10', type: 'sell', amount: 400, shares: 400, nav: 1 }),
    ];
    expect(calcCost(txs)).toBe(600);
    expect(calcShares(txs)).toBe(600);
  });

  it('是「比例口径」而不是 FIFO / LIFO', () => {
    // 两笔不同成本的买入（100 元/100 份 与 300 元/100 份），卖出 100 份：
    //   比例口径：均价 = 400/200 = 2 → 扣 200 → 剩 200
    //   FIFO：先扣第一批 → 剩 300
    //   LIFO：先扣第二批 → 剩 100
    // 三种口径数字不同，重构时一旦换成批次法，这三个断言会立刻区分出来。
    const txs = [
      mkTx({ id: 'b1', date: '2026-01-05', type: 'buy', amount: 100, shares: 100, nav: 1 }),
      mkTx({ id: 'b2', date: '2026-01-10', type: 'buy', amount: 300, shares: 100, nav: 3 }),
      mkTx({ id: 's1', date: '2026-01-15', type: 'sell', amount: 200, shares: 100, nav: 2 }),
    ];
    expect(calcCost(txs)).toBe(200);
    expect(calcCost(txs)).not.toBe(300); // FIFO 口径
    expect(calcCost(txs)).not.toBe(100); // LIFO 口径
    expect(calcShares(txs)).toBe(100);
  });

  it('卖出份额超过持仓 → 成本钳到 0（不会出现负成本）', () => {
    // Math.min(tx.shares, totalShares)：150 份只按实际持有的 100 份扣，成本归 0。
    const txs = [
      mkTx({ id: 'b1', date: '2026-01-05', type: 'buy', amount: 100, shares: 100, nav: 1 }),
      mkTx({ id: 's1', date: '2026-01-10', type: 'sell', amount: 150, shares: 150, nav: 1 }),
    ];
    expect(calcCost(txs)).toBe(0);
    // 注意（当前行为）：calcShares 本身不钳制，同样的输入会得到 -50。
    // calcCost 与 calcShares 在「超卖」时口径不一致 —— 这里如实锁定现状，
    // 若重构要统一口径，这条断言会先炸，提醒一并处理。
    expect(calcShares(txs)).toBe(-50);
  });

  it('持仓为 0 时的卖出被忽略（成本不会被扣成负数）', () => {
    // 按日期排序后卖出在前：当时没有持仓 → 整个 sell 分支跳过。
    const txs = [
      mkTx({ id: 's1', date: '2026-01-05', type: 'sell', amount: 50, shares: 50, nav: 1 }),
      mkTx({ id: 'b1', date: '2026-01-10', type: 'buy', amount: 100, shares: 100, nav: 1 }),
    ];
    expect(calcCost(txs)).toBe(100);
    // calcShares 是纯加减（不钳制、不看时序）→ 100 − 50 = 50，与 calcCost 的 100 不一致。
    // 当前行为如实锁定：两者在「先卖后买」的数据下会分叉。
    expect(calcShares(txs)).toBe(50);
  });

  it('买入成本含手续费（fee 内扣口径：cost = 用户实付 amount）', () => {
    // amount 是用户掏出的总额，fee 已经含在里面，cost 不再减一次 fee。
    // 份额是净额口径：shares = (amount − fee) / nav = 985。
    const txs = [
      mkTx({ id: 'b1', date: '2026-01-05', type: 'buy', amount: 1000, fee: 15, shares: 985, nav: 1 }),
    ];
    expect(calcCost(txs)).toBe(1000);
    expect(calcShares(txs)).toBe(985);
  });

  it('红利再投资：加份额但不加成本 → 摊薄单位成本', () => {
    // 1000 元 / 1000 份买入，再投资红利 100 份（amount = 0）：
    // 成本仍是 1000，份额变 1100 → 单位成本从 1.0 摊薄到 0.909090…
    const base = [
      mkTx({ id: 'b1', date: '2026-01-05', type: 'buy', amount: 1000, shares: 1000, nav: 1 }),
      mkTx({ id: 'd1', date: '2026-01-10', type: 'dividend', amount: 0, shares: 100, nav: 1 }),
    ];
    expect(calcCost(base)).toBe(1000);
    expect(calcShares(base)).toBe(1100);

    // 接着卖出 550 份：均价 1000/1100 → 扣 500 → 剩 500
    const withSell = [
      ...base,
      mkTx({ id: 's1', date: '2026-01-15', type: 'sell', amount: 550, shares: 550, nav: 1 }),
    ];
    expect(calcCost(withSell)).toBeCloseTo(500, 6);
    expect(calcShares(withSell)).toBe(550);
  });

  it('空交易列表 → 成本 0', () => {
    expect(calcCost([])).toBe(0);
  });
});

describe('calcShares —— 份额累计', () => {
  it('买入累加、卖出扣减', () => {
    const txs = [
      mkTx({ id: 'b1', date: '2026-01-05', type: 'buy', amount: 1000, shares: 1000, nav: 1 }),
      mkTx({ id: 'b2', date: '2026-01-10', type: 'buy', amount: 500, shares: 500, nav: 1 }),
      mkTx({ id: 's1', date: '2026-01-15', type: 'sell', amount: 300, shares: 300, nav: 1 }),
    ];
    expect(calcShares(txs)).toBe(1200);
  });

  it('红利再投资加份额；现金分红（shares = 0）不影响份额', () => {
    const txs = [
      mkTx({ id: 'b1', date: '2026-01-05', type: 'buy', amount: 1000, shares: 1000, nav: 1 }),
      mkTx({ id: 'd1', date: '2026-01-10', type: 'dividend', amount: 62.9, shares: 0, nav: 1 }),
      mkTx({ id: 'd2', date: '2026-01-15', type: 'dividend', amount: 0, shares: 57.61, nav: 1.0918 }),
    ];
    expect(calcShares(txs)).toBe(1057.61);
  });

  it('与输入顺序无关（加法交换律）', () => {
    const a = mkTx({ id: 'b1', date: '2026-01-05', type: 'buy', amount: 1000, shares: 1000, nav: 1 });
    const b = mkTx({ id: 's1', date: '2026-01-15', type: 'sell', amount: 300, shares: 300, nav: 1 });
    expect(calcShares([a, b])).toBe(calcShares([b, a]));
    expect(calcShares([a, b])).toBe(700);
  });

  it('calcShares 自身不过滤 pending —— 过滤由调用方 onlyConfirmed 负责', () => {
    // 现状锁定：calcShares 内部没有 status 判断，直接把 pending 也算进去。
    // 生产调用方（calcFundSummary / calcSharesBeforeTx）都先过 onlyConfirmed，
    // 所以这是「契约」而不是 bug；但如果重构把过滤下沉进 calcShares，
    // 这条断言会失败 —— 那时必须同时复核所有调用方。
    const txs = [
      mkTx({ id: 'b1', date: '2026-01-05', type: 'buy', amount: 1000, shares: 1000, nav: 1 }),
      mkTx({ id: 'b2', date: '2026-01-10', type: 'buy', amount: 500, shares: 500, nav: 1, status: 'pending' }),
    ];
    expect(calcShares(txs)).toBe(1500);
    expect(calcShares(onlyConfirmed(txs))).toBe(1000);
  });

  it('onlyConfirmed：剔除 pending，保留 confirmed 与未设 status 的旧数据', () => {
    const txs = [
      mkTx({ id: 'a', date: '2026-01-05', status: 'confirmed' }),
      mkTx({ id: 'b', date: '2026-01-06', status: 'pending' }),
      mkTx({ id: 'c', date: '2026-01-07' }), // 未设 status —— 旧数据，向后兼容
    ];
    expect(onlyConfirmed(txs).map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('空交易列表 → 0', () => {
    expect(calcShares([])).toBe(0);
  });
});

describe('calcMarketValue —— 市值 = 份额 × 净值', () => {
  it('正常计算', () => {
    expect(calcMarketValue(600, 1.2)).toBeCloseTo(720, 10);
    expect(calcMarketValue(0, 1.2)).toBe(0);
  });

  it('净值缺失 / 非有限 → 0（不产生 NaN 传染到整页）', () => {
    // 刚 addFund 还没拉到 NAV 时 currentNav 是 undefined，
    // shares * undefined = NaN 会污染 totalValue / calendar / snapshot。
    expect(calcMarketValue(1000, undefined as unknown as number)).toBe(0);
    expect(calcMarketValue(1000, NaN)).toBe(0);
    expect(calcMarketValue(1000, Infinity)).toBe(0);
    expect(calcMarketValue(1000, -Infinity)).toBe(0);
  });

  it('份额非有限 / 非数字 → 0', () => {
    expect(calcMarketValue(NaN, 1.2)).toBe(0);
    expect(calcMarketValue(undefined as unknown as number, 1.2)).toBe(0);
    expect(calcMarketValue(Infinity, 1.2)).toBe(0);
  });

  it('当前行为：负份额不被钳制（市值会是负数）', () => {
    // 超卖时 calcShares 可能是负数，市值跟着为负 —— 现状锁定，不做静默修正。
    expect(calcMarketValue(-50, 1.2)).toBeCloseTo(-60, 10);
  });
});

describe('calcReturn / calcReturnRate —— 收益与收益率', () => {
  it('calcReturn = 市值 − 成本', () => {
    expect(calcReturn(1200, 1000)).toBe(200);
    expect(calcReturn(800, 1000)).toBe(-200);
    expect(calcReturn(1000, 1000)).toBe(0);
  });

  it('calcReturnRate = calcReturn / 成本 × 100（手算例子）', () => {
    // 买入 1000 元，市值 1200 → 收益 200 → 收益率 200/1000 × 100 = 20%
    const cost = 1000;
    const marketValue = 1200;
    const r = calcReturn(marketValue, cost);
    expect(r).toBe(200);
    expect(calcReturnRate(r, cost)).toBe(20);
  });

  it('收益率 = 收益 / 成本（不是 / 市值）', () => {
    // 成本 950、收益 150 → 150/950 × 100 ≈ 15.789474%
    // 若误用市值（1100）做分母会得到 13.636364% —— 两者必须区分开。
    expect(calcReturnRate(150, 950)).toBeCloseTo(15.789474, 6);
    expect(calcReturnRate(150, 950)).not.toBeCloseTo((150 / 1100) * 100, 6);
  });

  it('成本为 0 → 收益率 0（不产生 NaN / Infinity）', () => {
    expect(calcReturnRate(100, 0)).toBe(0);
    expect(calcReturnRate(0, 0)).toBe(0);
  });

  it('成本为 -0 也按 0 处理（-0 === 0）', () => {
    expect(calcReturnRate(100, -0)).toBe(0);
  });

  it('当前行为：负成本不做特殊处理（直接按公式相除）', () => {
    // 现状锁定：只有 cost === 0 被特判；负成本会算出负收益率。
    expect(calcReturnRate(100, -50)).toBe(-200);
  });
});

describe('组合口径 —— 1000 元买入 / 卖 400 份 / 净值 1.2', () => {
  it('份额 600、成本 600、市值 720、收益 120、收益率 20%', () => {
    // 把上面几个函数串起来，锁住 Dashboard 上那套数字的整体口径。
    const txs = [
      mkTx({ id: 'b1', date: '2026-01-05', type: 'buy', amount: 1000, shares: 1000, nav: 1 }),
      mkTx({ id: 's1', date: '2026-01-10', type: 'sell', amount: 400, shares: 400, nav: 1 }),
    ];
    const shares = calcShares(txs);
    const cost = calcCost(txs);
    const marketValue = calcMarketValue(shares, 1.2);
    const totalReturn = calcReturn(marketValue, cost);
    expect(shares).toBe(600);
    expect(cost).toBe(600);
    expect(marketValue).toBeCloseTo(720, 10);
    expect(totalReturn).toBeCloseTo(120, 10);
    expect(calcReturnRate(totalReturn, cost)).toBeCloseTo(20, 10);
  });
});
