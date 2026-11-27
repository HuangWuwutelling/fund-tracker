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
  calcXIRR,
  calcClosedXIRR,
  positionHistory,
  onlyConfirmed,
  isPendingTx,
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

  it('isPendingTx：只有 status === "pending" 才算待确认（未设 status = 已确认）', () => {
    expect(isPendingTx(mkTx({ id: 'a', status: 'confirmed' }))).toBe(false);
    expect(isPendingTx(mkTx({ id: 'b', status: 'pending' }))).toBe(true);
    // 未设 status —— 初始持仓与旧数据，向后兼容
    expect(isPendingTx(mkTx({ id: 'c' }))).toBe(false);
  });

  it('isPendingTx 与 onlyConfirmed 语义一致：判 confirmed 就是 !isPendingTx', () => {
    // 这条是**漂移警报**不是独立验证：onlyConfirmed 本身就是用 isPendingTx 实现的，
    // 两边不可能不一致（除非有人只改一边）。isPendingTx 自身的语义由上一条钉住。
    const txs = [
      mkTx({ id: 'a', date: '2026-01-05', status: 'confirmed' }),
      mkTx({ id: 'b', date: '2026-01-06', status: 'pending' }),
      mkTx({ id: 'c', date: '2026-01-07' }),
    ];
    expect(txs.filter((t) => !isPendingTx(t)).map((t) => t.id)).toEqual(
      onlyConfirmed(txs).map((t) => t.id),
    );
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

/**
 * 浮点残差 —— 全部卖出后必须精确归零。
 *
 * 真实事故（2026-11-27，用户账本 008163 南方标普红利低波50ETF联接A）：
 * 买入 12440.9467 份 + 红利再投 57.61 份 = 12498.5567 份，
 * 11-19 分两笔卖出 12488.78 + 9.7767 = 12498.5567 份 —— **十进制上精确相等**。
 *
 * 但二进制浮点累加后剩下 3.4639e-13 份，于是「已清仓」没被识别成 0：
 *   成本残差 3.5882e-13 → 收益率 = 3.34e-14 / 3.5882e-13 = **+9.32%**（纯垃圾）
 *   市值残差 3.9225e-13 → 年化 XIRR 拿它当终值 → **58.88%**
 *
 * 而市值/收益本身被格式化到两位小数，显示成 0.00 —— 于是界面看起来"持仓是个
 * 很小但不是 0 的值"，比例类指标却是彻底错误的。
 *
 * 修法不是加 epsilon，而是**按数据精度归一**：份额在数据模型里就是 4 位小数
 * （建单时最后才把 shares 舍入到 4 位；卖出超额校验的容差也是 0.0001），
 * 所以 4 位小数的量累加完按 4 位归一 = 精确的十进制和，不是近似。
 */
describe('浮点残差 —— 全部卖出后份额与成本精确归零', () => {
  /** 008163 的真实交易序列（金额/份额原样取自用户备份） */
  const SOLD_OUT: Transaction[] = [
    mkTx({ id: 'b1', type: 'buy', date: '2026-08-26', amount: 1575, shares: 1516.4645, nav: 0 }),
    mkTx({ id: 'b2', type: 'buy', date: '2026-09-01', amount: 200, shares: 189.9335, nav: 1.053 }),
    mkTx({ id: 'b3', type: 'buy', date: '2026-09-08', amount: 200, shares: 192.0123, nav: 1.0416 }),
    mkTx({ id: 'b4', type: 'buy', date: '2026-09-11', amount: 10000, shares: 9575.7924, nav: 1.0443 }),
    mkTx({ id: 'b5', type: 'buy', date: '2026-09-18', amount: 1000, shares: 966.744, nav: 1.0344 }),
    mkTx({ id: 'd1', type: 'dividend', date: '2026-11-06', amount: 62.898598, shares: 57.61, nav: 0 }),
    mkTx({ id: 's1', type: 'sell', date: '2026-11-19', amount: 14104.828132, shares: 12488.78, nav: 1.1294 }),
    mkTx({ id: 's2', type: 'sell', date: '2026-11-19', amount: 11.04180498, shares: 9.7767, nav: 1.1294 }),
  ];

  it('份额精确为 0（不是 3.46e-13）', () => {
    expect(calcShares(SOLD_OUT)).toBe(0);
  });

  it('成本精确为 0（不是 3.59e-13）', () => {
    expect(calcCost(SOLD_OUT)).toBe(0);
  });

  it('派生指标不再出现垃圾数字：收益率 0%、年化 0%', () => {
    const shares = calcShares(SOLD_OUT);
    const cost = calcCost(SOLD_OUT);
    const marketValue = calcMarketValue(shares, 1.1324);
    const totalReturn = calcReturn(marketValue, cost);
    // 修复前：收益率 = 3.34e-14 / 3.5882e-13 = +9.3158…%
    expect(calcReturnRate(totalReturn, cost)).toBe(0);
    // 修复前：市值残差 3.92e-13 被当成非零终值 → 58.88%
    expect(calcXIRR(SOLD_OUT, marketValue)).toBe(0);
  });

  it('未清仓的持仓不受影响 —— 归一不是近似', () => {
    // 4 位小数的份额累加后按 4 位归一 = 精确十进制和
    const txs = [
      mkTx({ id: 'x1', type: 'buy', date: '2026-01-05', amount: 1000, shares: 800.0001, nav: 1 }),
      mkTx({ id: 'x2', type: 'buy', date: '2026-01-06', amount: 500, shares: 400.0002, nav: 1 }),
      mkTx({ id: 'x3', type: 'sell', date: '2026-01-10', amount: 300, shares: 200.0001, nav: 1 }),
    ];
    expect(calcShares(txs)).toBe(1000.0002);
    // 比例成本法：剩 1000.0002/1200.0003 份 → 剩 1500 × 0.83333…% ≈ 1250
    expect(calcCost(txs)).toBeCloseTo(1250, 2);
  });
});

/**
 * 历史已实现盈亏 —— 「清仓后又买回」必须扛得住。
 *
 * 用户场景（2026-11-27）：008163 清仓后若过一段时间又开始投资，第一轮赚的钱
 * 不能被第二轮的投入冲掉。
 *
 * 为什么不用「累计收回 − 累计投入」：第二轮的投入还没卖回来，那个公式会算出
 * **负数**（把还没实现的投入当成了亏损）。分摊法只看「已卖出那部分份额的
 * 成本」，所以两轮互不干扰。
 */
describe('positionHistory —— 清仓后又买回，已实现收益不被新一轮投入冲掉', () => {
  /** 008163 的真实交易序列（金额/份额原样取自用户备份） */
  const ROUND_1: Transaction[] = [
    mkTx({ id: 'b1', type: 'buy', date: '2026-08-26', amount: 1575, shares: 1516.4645, nav: 0 }),
    mkTx({ id: 'b2', type: 'buy', date: '2026-09-01', amount: 200, shares: 189.9335, nav: 1.053 }),
    mkTx({ id: 'b3', type: 'buy', date: '2026-09-08', amount: 200, shares: 192.0123, nav: 1.0416 }),
    mkTx({ id: 'b4', type: 'buy', date: '2026-09-11', amount: 10000, shares: 9575.7924, nav: 1.0443 }),
    mkTx({ id: 'b5', type: 'buy', date: '2026-09-18', amount: 1000, shares: 966.744, nav: 1.0344 }),
    mkTx({ id: 'd0', type: 'dividend', date: '2026-08-07', amount: 2.55, shares: 0, nav: 1.0322 }),
    mkTx({ id: 'd1', type: 'dividend', date: '2026-09-07', amount: 6.79, shares: 0, nav: 1.0412 }),
    mkTx({ id: 'd2', type: 'dividend', date: '2026-11-06', amount: 62.898598, shares: 57.61, nav: 0 }),
    mkTx({ id: 's1', type: 'sell', date: '2026-11-19', amount: 14104.828132, shares: 12488.78, nav: 1.1294 }),
    mkTx({ id: 's2', type: 'sell', date: '2026-11-19', amount: 11.04180498, shares: 9.7767, nav: 1.1294 }),
  ];

  it('刚清仓：已实现收益 = 卖出净额 + 现金分红 − 已消耗成本', () => {
    const h = positionHistory(ROUND_1);
    expect(h.invested).toBeCloseTo(12975, 6);
    expect(h.proceeds).toBeCloseTo(14115.869937, 6);
    expect(h.cashDividend).toBeCloseTo(9.34, 6);
    // 红利再投不是现金 —— 价值已在卖出所得里，不能再加一次
    expect(h.reinvested).toBeCloseTo(62.898598, 6);
    expect(h.consumedCost).toBeCloseTo(12975, 6);
    expect(h.realized).toBeCloseTo(1150.209937, 4);
    expect(h.realizedRate).toBeCloseTo(8.8648, 3);
  });

  it('清仓后又开始投资：已实现收益不变（第二轮的投入不算进已实现）', () => {
    const withRound2 = [
      ...ROUND_1,
      mkTx({ id: 'b6', type: 'buy', date: '2026-12-01', amount: 5000, shares: 4424.77876, nav: 1.13 }),
    ];
    const h = positionHistory(withRound2);
    // 第一轮赚的 1150.21 一点没少
    expect(h.realized).toBeCloseTo(1150.209937, 4);
    expect(h.realizedRate).toBeCloseTo(8.8648, 3);
    // 累计投入变了（第二轮的 5000 在里面），但已消耗成本没变
    expect(h.invested).toBeCloseTo(17975, 6);
    expect(h.consumedCost).toBeCloseTo(12975, 6);
    // 当前持仓是第一轮的残余 0 + 第二轮的份额 → 与已实现收益互不干扰
    expect(calcShares(withRound2)).toBeCloseTo(4424.77876, 4);
  });

  it('没卖过时：已实现收益 = 收到的现金分红（分母为 0 → 收益率不显示）', () => {
    const h = positionHistory([
      mkTx({ id: 'x1', type: 'buy', date: '2026-01-05', amount: 5500, shares: 5000, nav: 1.1 }),
      mkTx({ id: 'x2', type: 'dividend', date: '2026-06-05', amount: 234.85, shares: 0, nav: 1.2 }),
    ]);
    expect(h.realized).toBeCloseTo(234.85, 6);
    expect(h.consumedCost).toBeCloseTo(0, 6);
    expect(h.realizedRate).toBe(0); // 没有分母 —— 界面上不显示这个百分比
  });
});

/**
 * 已清仓仓位的年化 —— 修复前被 `currentValue <= 0` 的早退直接干掉（返回 0），
 * 于是「我在清仓的这只基金上年化多少」在界面上完全看不见。
 */
describe('calcClosedXIRR —— 已清仓也能算年化', () => {
  it('投入 → 清仓的现金流算出年化（无终值，终点是最后一笔现金流）', () => {
    const txs = [
      mkTx({ id: 'b1', type: 'buy', date: '2026-01-05', amount: 10000, shares: 10000, nav: 1 }),
      mkTx({ id: 's1', type: 'sell', date: '2026-07-05', amount: 11000, shares: 10000, nav: 1.1 }),
    ];
    const closed = calcClosedXIRR(txs);
    expect(closed).not.toBe(0);
    // 半年赚 10% → 年化约 21%（(1.1)^2 − 1）
    expect(closed).toBeCloseTo(21, 0);
    // 终值口径下（持仓还在）走的是另一个入口
    expect(calcXIRR(txs, 11000)).not.toBe(0);
  });

  it('没有交易 → 0', () => {
    expect(calcClosedXIRR([])).toBe(0);
  });
});
