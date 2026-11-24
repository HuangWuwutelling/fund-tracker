import { describe, it, expect } from 'vitest';
import { buildTxDraft, inferDividendType, type TxFormInput } from './txFormModel';
import type { Transaction } from '../types';

/**
 * 交易录入决策的唯一实现的测试。
 *
 * 这个模块存在的理由：本项目历史上所有真实事故都是"同一条规则在两三个地方各写一遍，
 * 其中一份是旧的或漏了条件"。这里把口径钉死：
 * - 买入按金额、卖出按份额（公式方向不能搞反）
 * - amount 恒为扣费前金额，fee 恒从中扣除
 * - 只有交易当日的净值能用来推算份额
 * - 分红方式只能按 shares 判
 */

const TX_DATE = '2026-11-24';

function input(over: Partial<TxFormInput> = {}): TxFormInput {
  return {
    type: 'buy',
    dividendType: 'cash',
    amount: 0,
    fee: 0,
    shares: 0,
    manualNav: 0,
    lookedUp: null,
    txDate: TX_DATE,
    pendingFlag: false,
    editing: false,
    priorShares: 0,
    ...over,
  };
}

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    fundId: '160140',
    type: 'dividend',
    date: TX_DATE,
    amount: 0,
    fee: 0,
    shares: 0,
    nav: 1,
    ...over,
  };
}

describe('buildTxDraft —— 买入口径', () => {
  it('买入：shares = (amount − fee) / nav', () => {
    const draft = buildTxDraft(
      input({ amount: 1000, fee: 10, lookedUp: { nav: 1.5, navDate: TX_DATE } }),
    );
    expect(draft.shares).toBe(660);
  });

  it('买入：amount 恒为扣费前金额', () => {
    const draft = buildTxDraft(
      input({ amount: 1000, fee: 10, lookedUp: { nav: 1.5, navDate: TX_DATE } }),
    );
    expect(draft.amount).toBe(1000);
  });

  it('买入：fee 恒从该金额中扣除（净买入 = amount − fee）', () => {
    const draft = buildTxDraft(
      input({ amount: 1000, fee: 10, lookedUp: { nav: 1.5, navDate: TX_DATE } }),
    );
    expect(draft.fee).toBe(10);
    // 手续费若没从金额里扣，份额会是 1000 / 1.5 = 666.67
    expect(draft.shares).not.toBeCloseTo(1000 / 1.5, 6);
  });
});

describe('buildTxDraft —— 卖出口径', () => {
  it('卖出：amount = shares × nav（份额为准反算成交额）', () => {
    const draft = buildTxDraft(
      input({ type: 'sell', shares: 1000, fee: 2, lookedUp: { nav: 1.2345, navDate: TX_DATE } }),
    );
    expect(draft.amount).toBeCloseTo(1234.5, 10);
  });

  it('卖出：份额不变——手续费从成交额里扣，不减少份额', () => {
    const draft = buildTxDraft(
      input({ type: 'sell', shares: 1000, fee: 2, lookedUp: { nav: 1.2345, navDate: TX_DATE } }),
    );
    expect(draft.shares).toBe(1000);
  });

  it('卖出：成交额是扣费前金额，手续费从中扣除', () => {
    const draft = buildTxDraft(
      input({ type: 'sell', shares: 1000, fee: 2, lookedUp: { nav: 1.2345, navDate: TX_DATE } }),
    );
    expect(draft.fee).toBe(2);
    expect(draft.amount).toBeCloseTo(1234.5, 10);
  });
});

describe('buildTxDraft —— 净值可用性（只有交易当日的净值能推算份额）', () => {
  it('查到的净值日期 ≠ 交易日期且用户没填净值 → pending 且 nav = 0', () => {
    // 2026-08-26 实测事故：本地净值历史陈旧（只到 08-06），兜底取到 1.0386，
    // 份额被算成 1516.4645 份，而当日真实净值 1.048 对应的平台确认份额是 1502.8626 份。
    const draft = buildTxDraft(
      input({
        amount: 1575,
        txDate: '2026-08-26',
        lookedUp: { nav: 1.0386, navDate: '2026-08-06' },
      }),
    );
    expect(draft.status).toBe('pending');
    expect(draft.nav).toBe(0);
    expect(draft.shares).toBe(0);
  });

  it('查到的净值日期 === 交易日期 → confirmed，用查到的净值', () => {
    const draft = buildTxDraft(
      input({ amount: 1575, lookedUp: { nav: 1.048, navDate: '2026-08-26' }, txDate: '2026-08-26' }),
    );
    expect(draft.status).toBe('confirmed');
    expect(draft.nav).toBe(1.048);
  });

  it('用户手动填了净值 → confirmed，用用户填的值', () => {
    const draft = buildTxDraft(
      input({
        amount: 1575,
        manualNav: 1.048,
        txDate: '2026-08-26',
        lookedUp: { nav: 1.0386, navDate: '2026-08-06' },
      }),
    );
    expect(draft.status).toBe('confirmed');
    expect(draft.nav).toBe(1.048);
  });

  it('pendingFlag 为 true → pending、nav = 0，且不产生 warning', () => {
    const draft = buildTxDraft(
      input({ amount: 1000, pendingFlag: true, lookedUp: { nav: 1.5, navDate: TX_DATE } }),
    );
    expect(draft.status).toBe('pending');
    expect(draft.nav).toBe(0);
    expect(draft.warning).toBeUndefined();
  });

  it('lookedUp 为 null（本地没这条净值）→ pending、nav = 0', () => {
    const draft = buildTxDraft(input({ amount: 1000 }));
    expect(draft.status).toBe('pending');
    expect(draft.nav).toBe(0);
  });

  it('净值不可用导致 pending 时，给出非阻断 warning', () => {
    const draft = buildTxDraft(
      input({ amount: 1000, txDate: '2026-08-26', lookedUp: { nav: 1.0386, navDate: '2026-08-06' } }),
    );
    expect(draft.warning).toBeTruthy();
    expect(draft.blocking).toBeUndefined();
  });
});

describe('buildTxDraft —— 编辑期', () => {
  it('编辑期：用户填的净值优先于查到的净值', () => {
    const draft = buildTxDraft(
      input({
        editing: true,
        manualNav: 2,
        lookedUp: { nav: 1.5, navDate: TX_DATE },
      }),
    );
    expect(draft.nav).toBe(2);
  });

  it('编辑期：pendingFlag 决定 status', () => {
    const confirmed = buildTxDraft(input({ editing: true, manualNav: 2 }));
    expect(confirmed.status).toBe('confirmed');

    const pending = buildTxDraft(input({ editing: true, manualNav: 2, pendingFlag: true }));
    expect(pending.status).toBe('pending');
  });

  it('编辑期：不产生 warning', () => {
    const draft = buildTxDraft(
      input({
        editing: true,
        manualNav: 2,
        txDate: '2026-08-26',
        lookedUp: { nav: 1.0386, navDate: '2026-08-06' },
      }),
    );
    expect(draft.warning).toBeUndefined();
  });

  it('编辑期：净值不回退到 lookedUp（用户填 0 就是 0）', () => {
    const draft = buildTxDraft(
      input({ editing: true, manualNav: 0, lookedUp: { nav: 1.5, navDate: TX_DATE } }),
    );
    expect(draft.nav).toBe(0);
  });
});

describe('inferDividendType —— 分红方式只能按 shares 判', () => {
  it('shares > 0 → reinvest（即使 amount > 0）', () => {
    // 红利再投资同时有 amount（= 份额 × 净值）和 shares，
    // 用 amount > 0 判会把它误判成现金分红 → 编辑保存时把 shares 清零，份额凭空消失。
    expect(inferDividendType(tx({ type: 'dividend', shares: 100, amount: 150 }))).toBe('reinvest');
  });

  it('shares === 0 → cash', () => {
    expect(inferDividendType(tx({ type: 'dividend', shares: 0, amount: 50 }))).toBe('cash');
  });
});

describe('buildTxDraft —— 分红', () => {
  it('现金分红：amount 权威、shares = 0', () => {
    const draft = buildTxDraft(
      input({
        type: 'dividend',
        dividendType: 'cash',
        amount: 50,
        lookedUp: { nav: 1.5, navDate: TX_DATE },
      }),
    );
    expect(draft.amount).toBe(50);
    expect(draft.shares).toBe(0);
  });

  it('红利再投资：amount = shares × nav、fee = 0、份额照记', () => {
    const draft = buildTxDraft(
      input({
        type: 'dividend',
        dividendType: 'reinvest',
        shares: 100,
        fee: 5,
        lookedUp: { nav: 1.5, navDate: TX_DATE },
      }),
    );
    expect(draft.shares).toBe(100);
    expect(draft.amount).toBeCloseTo(150, 10);
    expect(draft.fee).toBe(0);
  });
});

describe('buildTxDraft —— 卖出超额校验', () => {
  it('卖出份额 > 该笔交易之前的持仓 → blocking 非空', () => {
    const draft = buildTxDraft(
      input({
        type: 'sell',
        shares: 200,
        priorShares: 100,
        lookedUp: { nav: 1.5, navDate: TX_DATE },
      }),
    );
    expect(draft.blocking).toBeTruthy();
    expect(draft.blocking).toContain('100.0000');
  });

  it('卖出份额恰好等于持仓 → 不 blocking', () => {
    const draft = buildTxDraft(
      input({
        type: 'sell',
        shares: 100,
        priorShares: 100,
        lookedUp: { nav: 1.5, navDate: TX_DATE },
      }),
    );
    expect(draft.blocking).toBeUndefined();
  });

  it('卖出份额在 0.0001 容差内 → 不 blocking', () => {
    const draft = buildTxDraft(
      input({
        type: 'sell',
        shares: 100.00005,
        priorShares: 100,
        lookedUp: { nav: 1.5, navDate: TX_DATE },
      }),
    );
    expect(draft.blocking).toBeUndefined();
  });

  it('非卖出类型 → 不 blocking', () => {
    const draft = buildTxDraft(
      input({ amount: 1000, priorShares: 100, lookedUp: { nav: 1.5, navDate: TX_DATE } }),
    );
    expect(draft.blocking).toBeUndefined();
  });

  it('pendingFlag 为 true 的卖出 → 不做超额校验', () => {
    const draft = buildTxDraft(
      input({
        type: 'sell',
        shares: 200,
        priorShares: 100,
        pendingFlag: true,
        lookedUp: { nav: 1.5, navDate: TX_DATE },
      }),
    );
    expect(draft.blocking).toBeUndefined();
  });

  it('净值不可用导致 status=pending（但用户没勾待确认）的卖出 → 仍然做超额校验', () => {
    // 「你不能卖出比持有更多的份额」跟净值无关，净值没发布也必须拦。
    const draft = buildTxDraft(
      input({
        type: 'sell',
        shares: 200,
        priorShares: 100,
        txDate: '2026-08-26',
        lookedUp: { nav: 1.0386, navDate: '2026-08-06' },
      }),
    );
    expect(draft.blocking).toBeTruthy();
  });
});

describe('buildTxDraft —— 份额舍入', () => {
  it('份额保留 4 位小数', () => {
    const draft = buildTxDraft(
      input({ amount: 1000, lookedUp: { nav: 3, navDate: TX_DATE } }),
    );
    expect(draft.shares).toBe(333.3333);
  });

  it('成交额由未舍入的份额算出（先算 amount，最后才舍入 shares）', () => {
    const draft = buildTxDraft(
      input({
        type: 'sell',
        shares: 1234.56789,
        lookedUp: { nav: 1.5, navDate: TX_DATE },
      }),
    );
    expect(draft.shares).toBe(1234.5679);
    expect(draft.amount).toBeCloseTo(1234.56789 * 1.5, 10);
  });
});
