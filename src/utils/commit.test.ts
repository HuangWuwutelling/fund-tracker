import { describe, it, expect, beforeEach } from 'vitest';
import { commitLedger } from './commit';
import { installFakeStorage, type FakeStorage } from '../test/fakeStorage';
import type { Fund, Transaction } from '../types';

let fake: FakeStorage;

beforeEach(() => {
  fake = installFakeStorage();
});

function fund(id: string): Fund {
  return { id, name: `基金${id}`, platformId: 'p1', type: 'mixed', currentNav: 1, navDate: '2026-11-20' };
}

function tx(id: string): Transaction {
  return {
    id, fundId: 'f1', type: 'buy', date: '2026-11-20',
    amount: 1000, fee: 0, shares: 1000, nav: 1,
  };
}

describe('commitLedger —— 写盘 seam（唯一写盘入口）', () => {
  it('全部写成功 → ok:true，所有 key 都落盘', () => {
    const r = commitLedger({ funds: [fund('a')], transactions: [tx('t1')] });
    expect(r.ok).toBe(true);
    expect(fake.getItem('fund-tracker:funds')).toContain('"a"');
    expect(fake.getItem('fund-tracker:transactions')).toContain('t1');
  });

  it('某个 key 写失败 → ok:false，并报出失败的是哪个 key', () => {
    fake.failOnKey = 'fund-tracker:transactions';
    const r = commitLedger({ funds: [fund('a')], transactions: [tx('t1')] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('write-failed');
    expect(r.key).toBe('transactions');
  });

  it('写失败 → 已写入的 key 回滚成旧值（磁盘不留半套状态）', () => {
    // 先落一套旧值
    commitLedger({ funds: [fund('old')] });
    // 再来一次：funds 改成新值，transactions 写失败
    fake.failOnKey = 'fund-tracker:transactions';
    const r = commitLedger({ funds: [fund('new')], transactions: [tx('t1')] });
    expect(r.ok).toBe(false);
    // funds 必须回到 old —— 不能停在 new
    expect(fake.getItem('fund-tracker:funds')).toContain('"old"');
    expect(fake.getItem('fund-tracker:funds')).not.toContain('"new"');
  });

  it('第一个 key 就失败 → 什么都不写', () => {
    fake.failOnKey = 'fund-tracker:funds';
    const r = commitLedger({ funds: [fund('a')], transactions: [tx('t1')] });
    expect(r.ok).toBe(false);
    expect(fake.getItem('fund-tracker:funds')).toBeNull();
    expect(fake.getItem('fund-tracker:transactions')).toBeNull();
  });

  it('没提供的 key 完全不受影响', () => {
    commitLedger({ funds: [fund('a')] });
    fake.failOnKey = 'fund-tracker:transactions';
    const r = commitLedger({ funds: [fund('b')] });
    expect(r.ok).toBe(true);
    expect(fake.getItem('fund-tracker:funds')).toContain('"b"');
    // transactions 从头到尾没被写过
    expect(fake.getItem('fund-tracker:transactions')).toBeNull();
  });

  it('写失败后存储层要能看到失败状态（用户能收到告警）', () => {
    fake.failOnKey = 'fund-tracker:funds';
    commitLedger({ funds: [fund('a')] });
    expect(fake.events.some((e) => e.type === 'fund-tracker:storage-error')).toBe(true);
  });
});
