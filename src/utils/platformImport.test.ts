import { describe, it, expect } from 'vitest';
import { parsePlatformRows, diffPlatformRows } from './platformImport';
import type { Transaction } from '../types';

describe('parsePlatformRows（解析平台流水）', () => {
  it('标准逗号格式', () => {
    const { rows, errors } = parsePlatformRows(
      '2026-08-26, 买入, 1575.00, 1516.4645, 1.0386\n' +
      '2026-11-19, 卖出, 14104.83, 12488.7817, 1.1294',
    );
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ date: '2026-08-26', type: 'buy', amount: 1575, shares: 1516.4645, nav: 1.0386 });
    expect(rows[1]!.type).toBe('sell');
  });

  it('制表符分隔', () => {
    const { rows } = parsePlatformRows('2026-08-26\t买入\t1575.00\t1516.4645\t1.0386');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(1575);
  });

  it('空白分隔', () => {
    const { rows } = parsePlatformRows('2026-08-26 买入 1575.00 1516.4645 1.0386');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shares).toBe(1516.4645);
  });

  it('金额里的千分位逗号被还原（1,575.00 → 1575）', () => {
    const { rows, errors } = parsePlatformRows('2026-08-26, 买入, 1,575.00, 1516.4645, 1.0386');
    expect(errors).toHaveLength(0);
    expect(rows[0]!.amount).toBe(1575);
    expect(rows[0]!.shares).toBe(1516.4645);
  });

  it('类型认多种写法', () => {
    for (const w of ['买入', '申购', '买', 'buy']) {
      expect(parsePlatformRows(`2026-08-26, ${w}, 100, 10, 1`).rows[0]!.type).toBe('buy');
    }
    for (const w of ['卖出', '赎回', '卖', 'sell']) {
      expect(parsePlatformRows(`2026-08-26, ${w}, 100, 10, 1`).rows[0]!.type).toBe('sell');
    }
  });

  it('日期认 YYYY/MM/DD 与 YYYY.MM.DD', () => {
    expect(parsePlatformRows('2026/08/26, 买入, 100, 10, 1').rows[0]!.date).toBe('2026-08-26');
    expect(parsePlatformRows('2026.8.6, 买入, 100, 10, 1').rows[0]!.date).toBe('2026-08-06');
  });

  it('空行被忽略', () => {
    const { rows, errors } = parsePlatformRows('\n\n2026-08-26, 买入, 100, 10, 1\n\n');
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it('认不出的行进 errors，不影响其它行（宽松解析）', () => {
    const { rows, errors } = parsePlatformRows(
      '2026-08-26, 买入, 100, 10, 1\n' +
      '乱七八糟的一行\n' +
      '2026-08-27, 未知类型, 100, 10, 1\n' +
      '2026-08-28, 买入, abc, 10, 1\n',
    );
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(3);
    expect(errors[0]!.reason).toContain('字段不足');
    expect(errors[1]!.reason).toContain('类型无法识别');
    expect(errors[2]!.reason).toContain('非数字');
  });

  it('字段不足 5 个 → 报错而不是静默丢弃', () => {
    const { rows, errors } = parsePlatformRows('2026-08-26, 买入, 100');
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toContain('字段不足');
  });

  it('字段多于 5 个 → 报错（不猜哪几个是真列）', () => {
    const { rows, errors } = parsePlatformRows('2026-08-26, 买入, 100, 0.5, 10, 1.04');
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toContain('字段多于');
  });

  it('空白分隔 + 千分位逗号 → 也能解析（从表格复制的常见形态）', () => {
    const { rows, errors } = parsePlatformRows('2026-08-26 买入 1,575.00 1516.4645 1.0386');
    expect(errors).toHaveLength(0);
    expect(rows[0]!.amount).toBe(1575);
    expect(rows[0]!.shares).toBe(1516.4645);
  });
});

describe('diffPlatformRows（平台流水 vs 应用账本）', () => {
  function tx(over: Partial<Transaction> = {}): Transaction {
    return {
      id: 't1', fundId: 'f1', type: 'buy', date: '2026-08-26',
      amount: 1575, fee: 0, shares: 1516.4645, nav: 1.0386, ...over,
    };
  }

  it('账本里没有 → missing（可补录）', () => {
    const rows = parsePlatformRows('2026-09-15, 买入, 500, 480, 1.04').rows;
    const d = diffPlatformRows(rows, [tx()], 'f1');
    expect(d.missing).toHaveLength(1);
    expect(d.matched).toHaveLength(0);
  });

  it('账本里有且份额一致 → matched', () => {
    const rows = parsePlatformRows('2026-08-26, 买入, 1575.00, 1516.4645, 1.0386').rows;
    const d = diffPlatformRows(rows, [tx()], 'f1');
    expect(d.matched).toHaveLength(1);
    expect(d.missing).toHaveLength(0);
  });

  it('同日期同类型但份额不同 → mismatched（不自动补录，避免重复记账）', () => {
    const rows = parsePlatformRows('2026-08-26, 买入, 1575.00, 1600, 1.0386').rows;
    const d = diffPlatformRows(rows, [tx()], 'f1');
    expect(d.mismatched).toHaveLength(1);
    expect(d.mismatched[0]!.txId).toBe('t1');
    expect(d.mismatched[0]!.txShares).toBe(1516.4645);
    expect(d.missing).toHaveLength(0);
  });

  it('只比对指定基金', () => {
    const rows = parsePlatformRows('2026-08-26, 买入, 1575.00, 1516.4645, 1.0386').rows;
    const d = diffPlatformRows(rows, [tx({ fundId: 'other' })], 'f1');
    expect(d.missing).toHaveLength(1);
  });

  it('待确认交易不算已记（它是空的，等净值）', () => {
    const rows = parsePlatformRows('2026-08-26, 买入, 1575.00, 1516.4645, 1.0386').rows;
    const d = diffPlatformRows(rows, [tx({ status: 'pending', shares: 0, nav: 0 })], 'f1');
    expect(d.missing).toHaveLength(1);
  });

  it('分笔买入：同日期多笔，任一笔份额对得上就算已记', () => {
    const rows = parsePlatformRows('2026-08-26, 买入, 500, 480, 1.04').rows;
    const d = diffPlatformRows(rows, [tx({ id: 'a', shares: 400 }), tx({ id: 'b', shares: 480 })], 'f1');
    expect(d.matched).toHaveLength(1);
    expect(d.missing).toHaveLength(0);
  });
});
