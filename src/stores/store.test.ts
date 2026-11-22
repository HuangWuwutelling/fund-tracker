import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';
import type { Transaction } from '../types';

/** 极简 localStorage 桩：可模拟配额超限导致的写入失败 */
class FakeStorage {
  private map = new Map<string, string>();
  failOnWrite = false;
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.failOnWrite) {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1', fundId: 'f1', type: 'buy', date: '2026-08-26',
    amount: 1575, fee: 0, shares: 1516.4645, nav: 1.0386, ...over,
  };
}

let fake: FakeStorage;

beforeEach(() => {
  fake = new FakeStorage();
  (globalThis as unknown as { localStorage: unknown }).localStorage = fake;
  useStore.setState({ transactions: [], funds: [], dcaPlans: [], platforms: [] });
});

describe('store：写盘失败时不改内存状态（内存 == 磁盘）', () => {
  it('addTransaction：写盘失败 → 返回 false，账本没变', () => {
    fake.failOnWrite = true;
    const ok = useStore.getState().addTransaction(tx());
    expect(ok).toBe(false);
    expect(useStore.getState().transactions).toHaveLength(0);
  });

  it('addTransaction：写盘成功 → 返回 true，账本已更新', () => {
    const ok = useStore.getState().addTransaction(tx());
    expect(ok).toBe(true);
    expect(useStore.getState().transactions).toHaveLength(1);
    expect(fake.getItem('fund-tracker:transactions')).toContain('2026-08-26');
  });

  it('updateTransaction：写盘失败 → 返回 false，原记录不变', () => {
    useStore.getState().addTransaction(tx());
    fake.failOnWrite = true;
    const ok = useStore.getState().updateTransaction('t1', { amount: 999 });
    expect(ok).toBe(false);
    expect(useStore.getState().transactions[0]!.amount).toBe(1575);
  });

  it('removeTransaction：写盘失败 → 返回 false，记录还在', () => {
    useStore.getState().addTransaction(tx());
    fake.failOnWrite = true;
    const ok = useStore.getState().removeTransaction('t1');
    expect(ok).toBe(false);
    expect(useStore.getState().transactions).toHaveLength(1);
  });

  it('updateSettings：写盘失败 → 返回 false，设置没变', () => {
    const before = useStore.getState().settings.theme;
    fake.failOnWrite = true;
    const ok = useStore.getState().updateSettings({ theme: 'dark' });
    expect(ok).toBe(false);
    expect(useStore.getState().settings.theme).toBe(before);
  });

  it('失败后恢复写入 → 下一次操作正常保存（状态位会清）', () => {
    fake.failOnWrite = true;
    expect(useStore.getState().addTransaction(tx())).toBe(false);
    fake.failOnWrite = false;
    expect(useStore.getState().addTransaction(tx())).toBe(true);
    expect(useStore.getState().transactions).toHaveLength(1);
  });
});
