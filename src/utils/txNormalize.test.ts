import { describe, it, expect } from 'vitest';
import { normalizeInitialPositionNav, initialPositionDate, INITIAL_POSITION_NOTE } from './txNormalize';
import type { Transaction } from '../types';

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1', fundId: 'f1', type: 'buy', date: '2026-08-26',
    amount: 1575, fee: 0, shares: 1516.4645, nav: 1.0386, ...over,
  };
}

describe('normalizeInitialPositionNav（归一化初始持仓的 nav 语义）', () => {
  it('初始持仓记录的 nav（实为成本单价）→ 置 0', () => {
    const out = normalizeInitialPositionNav([tx({ note: INITIAL_POSITION_NOTE })]);
    expect(out[0]!.nav).toBe(0);
    // 其它字段不动
    expect(out[0]!.shares).toBe(1516.4645);
    expect(out[0]!.amount).toBe(1575);
  });

  it('普通买卖记录的 nav 保持不变', () => {
    const out = normalizeInitialPositionNav([tx({ nav: 1.048 })]);
    expect(out[0]!.nav).toBe(1.048);
  });

  it('note 含「初始持仓」关键字的记录同样处理', () => {
    const out = normalizeInitialPositionNav([tx({ note: '初始持仓（平台流水）' })]);
    expect(out[0]!.nav).toBe(0);
  });

  it('初始持仓记录的 nav 本来就是 0 → 不动', () => {
    const out = normalizeInitialPositionNav([tx({ note: INITIAL_POSITION_NOTE, nav: 0 })]);
    expect(out[0]!.nav).toBe(0);
  });

  it('无变化时返回原数组引用（调用方靠引用判断是否需要写盘）', () => {
    const txs = [tx({ nav: 1.048 })];
    expect(normalizeInitialPositionNav(txs)).toBe(txs);
  });

  it('空数组 → 原样返回', () => {
    expect(normalizeInitialPositionNav([])).toEqual([]);
  });
});

describe('initialPositionDate（初始持仓日期，重复计算预警用）', () => {
  it('没有初始持仓 → null', () => {
    expect(initialPositionDate([tx({ fundId: 'f1' })], 'f1')).toBeNull();
  });

  it('返回该基金最早的初始持仓日期', () => {
    const txs = [
      tx({ id: 'a', fundId: 'f1', date: '2026-08-26', note: INITIAL_POSITION_NOTE }),
      tx({ id: 'b', fundId: 'f1', date: '2026-07-01', note: INITIAL_POSITION_NOTE }),
    ];
    expect(initialPositionDate(txs, 'f1')).toBe('2026-07-01');
  });

  it('只看指定基金', () => {
    const txs = [tx({ id: 'a', fundId: 'other', date: '2026-01-01', note: INITIAL_POSITION_NOTE })];
    expect(initialPositionDate(txs, 'f1')).toBeNull();
  });
});

/**
 * provenance 改成类型之后，**备注不再决定来源**。
 *
 * 这几条是这次改动真正要挡住的事故形状：用户在备注里写"初始持仓"两个字，
 * 手动交易被静默当成初始持仓——nav 被归零、还触发重复计算预警。
 */
describe('provenance 由 origin 决定，备注不再有判据职责', () => {
  it('手动交易（origin=manual）+ 备注写着「初始持仓」→ nav 不被归零', () => {
    const out = normalizeInitialPositionNav([
      tx({ origin: 'manual', note: INITIAL_POSITION_NOTE, nav: 1.048 }),
    ]);
    expect(out[0]!.nav).toBe(1.048);
  });

  it('手动交易（origin=manual）+ 备注写着「初始持仓」→ 不算初始持仓日期', () => {
    expect(
      initialPositionDate([tx({ origin: 'manual', note: INITIAL_POSITION_NOTE })], 'f1'),
    ).toBeNull();
  });

  it('初始持仓（origin=initial-position）→ 照旧归零', () => {
    const out = normalizeInitialPositionNav([
      tx({ origin: 'initial-position', note: '随便写的备注', nav: 1.048 }),
    ]);
    expect(out[0]!.nav).toBe(0);
  });

  it('老数据（没有 origin）+ 备注是标记 → 按旧规则推断，行为不变', () => {
    const out = normalizeInitialPositionNav([tx({ note: INITIAL_POSITION_NOTE })]);
    expect(out[0]!.nav).toBe(0);
  });
});
