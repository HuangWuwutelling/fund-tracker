import { describe, it, expect } from 'vitest';
import { auditTransactions } from './txAudit';
import { INITIAL_POSITION_NOTE } from './txNormalize';
import type { NavRecord, Transaction } from '../types';

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1', fundId: 'f1', type: 'buy', date: '2026-08-26',
    amount: 1575, fee: 0, shares: 1516.4645, nav: 1.0386, ...over,
  };
}

function nav(date: string, nav: number): NavRecord {
  return { date, nav, accNav: nav };
}

describe('auditTransactions（交易自检：记录净值 vs 净值历史）', () => {
  it('买入的记录净值与该日期净值历史不一致 → 报一条，并给出正确份额', () => {
    const issues = auditTransactions(
      [tx({ nav: 1.0386, shares: 1516.4645 })],
      { f1: [nav('2026-08-26', 1.048)] },
    );
    expect(issues).toHaveLength(1);
    const i = issues[0]!;
    expect(i.type).toBe('buy');
    expect(i.recordedNav).toBe(1.0386);
    expect(i.correctNav).toBe(1.048);
    expect(i.correctShares).toBeCloseTo(1575 / 1.048, 6);
    expect(i.correctShares).toBeCloseTo(1502.8626, 4);
  });

  it('净值一致 → 不报', () => {
    const issues = auditTransactions(
      [tx({ nav: 1.048, shares: 1502.8626 })],
      { f1: [nav('2026-08-26', 1.048)] },
    );
    expect(issues).toHaveLength(0);
  });

  it('卖出的记录净值不一致 → 份额是权威（不动），只给正确成交额', () => {
    const issues = auditTransactions(
      [tx({ type: 'sell', date: '2026-11-19', nav: 1.1294, shares: 1000, amount: 1129.4 })],
      { f1: [nav('2026-11-19', 1.13)] },
    );
    expect(issues).toHaveLength(1);
    const i = issues[0]!;
    expect(i.correctShares).toBe(1000);          // 份额不动
    expect(i.correctAmount).toBeCloseTo(1130, 6); // 成交额 = 份额 × 正确净值
  });

  it('初始持仓记录跳过（它的 nav 是成本单价，不是市场净值）', () => {
    const issues = auditTransactions(
      [tx({ note: INITIAL_POSITION_NOTE, nav: 1.0386 })],
      { f1: [nav('2026-08-26', 1.048)] },
    );
    expect(issues).toHaveLength(0);
  });

  it('待确认记录跳过（净值还没确认，nav=0 是正常的）', () => {
    const issues = auditTransactions(
      [tx({ status: 'pending', nav: 0, shares: 0 })],
      { f1: [nav('2026-08-26', 1.048)] },
    );
    expect(issues).toHaveLength(0);
  });

  it('净值历史里没有该日期 → 跳过（不是错，是缺数据）', () => {
    const issues = auditTransactions(
      [tx({ nav: 1.0386 })],
      { f1: [nav('2026-08-25', 1.0437)] },
    );
    expect(issues).toHaveLength(0);
  });

  it('分红记录不参与检查', () => {
    const issues = auditTransactions(
      [tx({ type: 'dividend', nav: 0, shares: 57.61, amount: 62.89 })],
      { f1: [nav('2026-11-06', 1.0918)] },
    );
    expect(issues).toHaveLength(0);
  });

  it('多只基金分别核对', () => {
    const issues = auditTransactions(
      [
        tx({ id: 'a', fundId: 'f1', nav: 1.0386 }),
        tx({ id: 'b', fundId: 'f2', nav: 2.0 }),
      ],
      {
        f1: [nav('2026-08-26', 1.048)],
        f2: [nav('2026-08-26', 2.0)],
      },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.txId).toBe('a');
  });

  it('净值差在浮点误差内（≤1e-9）不报', () => {
    const issues = auditTransactions(
      [tx({ nav: 1.048, shares: 1502.8626 })],
      { f1: [nav('2026-08-26', 1.048 + 1e-12)] },
    );
    expect(issues).toHaveLength(0);
  });
});

/**
 * provenance 改成类型之后，**备注不再决定来源**。
 *
 * 旧实现用 `note.includes('初始持仓')` 跳过自检——用户在备注里写这两个字，
 * 手动交易就被静默排除在自检之外（错账就查不出来）。
 */
describe('provenance 由 origin 决定，备注不再有判据职责', () => {
  it('手动交易（origin=manual）+ 备注写着「初始持仓」→ 参与自检', () => {
    const issues = auditTransactions(
      [tx({ origin: 'manual', note: INITIAL_POSITION_NOTE, nav: 1.0386 })],
      { f1: [nav('2026-08-26', 1.048)] },
    );
    expect(issues).toHaveLength(1);
  });

  it('初始持仓（origin=initial-position）→ 照旧跳过', () => {
    const issues = auditTransactions(
      [tx({ origin: 'initial-position', note: '随便写的备注', nav: 1.0386 })],
      { f1: [nav('2026-08-26', 1.048)] },
    );
    expect(issues).toHaveLength(0);
  });
});
