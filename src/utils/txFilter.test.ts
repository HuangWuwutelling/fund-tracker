import { describe, it, expect } from 'vitest';
import {
  parseTxFilters,
  filterTransactions,
  txFilterParams,
  isRealDate,
  type TxFilters,
} from './txFilter';
import type { Transaction } from '../types';

const KNOWN_FUNDS = ['160140', '008163'];

function mkTx(over: Partial<Transaction> & { id: string }): Transaction {
  return {
    fundId: '160140',
    type: 'buy',
    date: '2026-11-26',
    amount: 1000,
    fee: 0,
    shares: 100,
    nav: 1,
    ...over,
  };
}

function params(q: string): URLSearchParams {
  return new URLSearchParams(q);
}

describe('isRealDate —— 日历合法性必须用往返判定', () => {
  it('合法日期通过', () => {
    expect(isRealDate('2026-11-26')).toBe(true);
    expect(isRealDate('2024-02-29')).toBe(true); // 闰年
  });

  it('形状不对的直接拒绝', () => {
    expect(isRealDate('abc')).toBe(false);
    expect(isRealDate('')).toBe(false);
    expect(isRealDate('2026-1-5')).toBe(false);
    expect(isRealDate('2026/11/26')).toBe(false);
  });

  it('进位日期必须拒绝 —— dayjs 的 isValid() 对它们返回 true', () => {
    // dayjs('2026-13-45').isValid() === true（归一化成 2027-02-14）
    // dayjs('2026-02-30').isValid() === true（归一化成 2026-03-02）
    expect(isRealDate('2026-13-45')).toBe(false);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-04-31')).toBe(false);
    expect(isRealDate('0000-00-00')).toBe(false);
  });
});

describe('parseTxFilters —— URL 参数校验', () => {
  it('空参数 → 全空（= 不过滤）', () => {
    expect(parseTxFilters(params(''), KNOWN_FUNDS)).toEqual({
      fundId: '',
      type: '',
      date: '',
      status: '',
    });
  });

  it('合法参数正确解析', () => {
    const f = parseTxFilters(params('fund=160140&type=dividend&date=2026-11-26&status=confirmed'), KNOWN_FUNDS);
    expect(f).toEqual({
      fundId: '160140',
      type: 'dividend',
      date: '2026-11-26',
      status: 'confirmed',
    });
  });

  it('非法 type 被忽略（不能变成 0 条记录的死胡同）', () => {
    expect(parseTxFilters(params('type=foo'), KNOWN_FUNDS).type).toBe('');
    expect(parseTxFilters(params('type=buy'), KNOWN_FUNDS).type).toBe('buy');
  });

  it('非法 date 被忽略', () => {
    expect(parseTxFilters(params('date=abc'), KNOWN_FUNDS).date).toBe('');
    expect(parseTxFilters(params('date=2026-13-45'), KNOWN_FUNDS).date).toBe('');
    expect(parseTxFilters(params('date=2026-11-26'), KNOWN_FUNDS).date).toBe('2026-11-26');
  });

  it('未知 fund id 被忽略 —— 它会驱动「补登初始持仓」入口', () => {
    expect(parseTxFilters(params('fund=999999'), KNOWN_FUNDS).fundId).toBe('');
    expect(parseTxFilters(params('fund=160140'), KNOWN_FUNDS).fundId).toBe('160140');
  });

  it('status 只认 pending / confirmed', () => {
    expect(parseTxFilters(params('status=pending'), KNOWN_FUNDS).status).toBe('pending');
    expect(parseTxFilters(params('status=confirmed'), KNOWN_FUNDS).status).toBe('confirmed');
    expect(parseTxFilters(params('status=whatever'), KNOWN_FUNDS).status).toBe('');
  });
});

describe('filterTransactions —— 过滤', () => {
  const txs = [
    mkTx({ id: 'a', fundId: '160140', type: 'buy', date: '2026-11-26', status: 'confirmed' }),
    mkTx({ id: 'b', fundId: '160140', type: 'dividend', date: '2026-11-26', status: 'pending' }),
    mkTx({ id: 'c', fundId: '008163', type: 'dividend', date: '2026-11-25', status: 'confirmed' }),
    mkTx({ id: 'd', fundId: '008163', type: 'buy', date: '2026-11-25' }), // 未设 status
  ];

  it('fundId 单独生效', () => {
    const out = filterTransactions(txs, { fundId: '008163', type: '', date: '', status: '' });
    expect(out.map((t) => t.id)).toEqual(['c', 'd']);
  });

  it('type 单独生效', () => {
    const out = filterTransactions(txs, { fundId: '', type: 'dividend', date: '', status: '' });
    expect(out.map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('date 单独生效', () => {
    const out = filterTransactions(txs, { fundId: '', type: '', date: '2026-11-26', status: '' });
    expect(out.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('status=pending 只留待确认', () => {
    const out = filterTransactions(txs, { fundId: '', type: '', date: '', status: 'pending' });
    expect(out.map((t) => t.id)).toEqual(['b']);
  });

  it('status=confirmed 必须保留 status 未设的记录（与 onlyConfirmed 一致）', () => {
    const out = filterTransactions(txs, { fundId: '', type: '', date: '', status: 'confirmed' });
    expect(out.map((t) => t.id)).toEqual(['a', 'c', 'd']);
  });

  it('四条条件叠加', () => {
    const out = filterTransactions(txs, {
      fundId: '160140',
      type: 'dividend',
      date: '2026-11-26',
      status: 'pending',
    });
    expect(out.map((t) => t.id)).toEqual(['b']);
  });

  it('不改原数组、不改顺序', () => {
    const input = [...txs];
    const out = filterTransactions(input, { fundId: '', type: '', date: '', status: '' });
    expect(input).toEqual(txs);
    expect(out).not.toBe(input);
    expect(out.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('txFilterParams —— 反向生成 URL 参数', () => {
  it('空值不输出', () => {
    expect(txFilterParams({ fundId: '', type: '', date: '', status: '' })).toEqual({});
  });

  it('非空值输出，参数名固定', () => {
    expect(
      txFilterParams({ fundId: '160140', type: 'buy', date: '2026-11-26', status: 'confirmed' }),
    ).toEqual({ fund: '160140', type: 'buy', date: '2026-11-26', status: 'confirmed' });
  });

  it('往返幂等', () => {
    const f: TxFilters = {
      fundId: '160140',
      type: 'dividend',
      date: '2026-11-26',
      status: 'pending',
    };
    const round = parseTxFilters(new URLSearchParams(txFilterParams(f)), KNOWN_FUNDS);
    expect(round).toEqual(f);
  });
});
