import { describe, it, expect, beforeEach } from 'vitest';
import {
  STORAGE_ERROR_EVENT,
  STORAGE_RECOVERED_EVENT,
  hasStorageWriteFailure,
  saveFunds,
} from './storage';
import type { Fund } from '../types';

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

const events: Array<{ type: string; detail?: unknown }> = [];

beforeEach(() => {
  const fake = new FakeStorage();
  (globalThis as unknown as { localStorage: unknown }).localStorage = fake;
  (globalThis as unknown as { window: unknown }).window = {
    dispatchEvent: (e: { type: string; detail?: unknown }) => {
      events.push({ type: e.type, detail: e.detail });
      return true;
    },
  };
  events.length = 0;
  (globalThis as unknown as { CustomEvent: unknown }).CustomEvent = class {
    type: string;
    detail?: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  // 失败标记是模块级状态，跨用例残留 —— 先做一次成功写入把它清掉
  saveFunds([]);
  events.length = 0;
});

function fund(id: string): Fund {
  return { id, name: 'x', platformId: 'p', type: 'mixed', currentNav: 1, navDate: '2026-01-01' };
}

describe('storage 写入失败处理', () => {
  it('写入成功 → 无失败标记，不广播任何事件', () => {
    saveFunds([fund('a')]);
    expect(hasStorageWriteFailure()).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('写入失败 → 标记失败并广播 STORAGE_ERROR_EVENT（带 key）', () => {
    (globalThis as unknown as { localStorage: FakeStorage }).localStorage.failOnWrite = true;
    saveFunds([fund('a')]);
    expect(hasStorageWriteFailure()).toBe(true);
    expect(events.map((e) => e.type)).toEqual([STORAGE_ERROR_EVENT]);
    expect((events[0]!.detail as { key: string }).key).toBe('funds');
  });

  it('连续失败只广播一次（不刷屏）', () => {
    (globalThis as unknown as { localStorage: FakeStorage }).localStorage.failOnWrite = true;
    saveFunds([fund('a')]);
    saveFunds([fund('a'), fund('b')]);
    saveFunds([fund('a'), fund('b'), fund('c')]);
    expect(events.filter((e) => e.type === STORAGE_ERROR_EVENT)).toHaveLength(1);
  });

  it('失败后写入恢复 → 广播 STORAGE_RECOVERED_EVENT 并清除标记', () => {
    const fake = globalThis as unknown as { localStorage: FakeStorage };
    fake.localStorage.failOnWrite = true;
    saveFunds([fund('a')]);
    expect(hasStorageWriteFailure()).toBe(true);

    fake.localStorage.failOnWrite = false;
    saveFunds([fund('a')]);
    expect(hasStorageWriteFailure()).toBe(false);
    expect(events.map((e) => e.type)).toEqual([STORAGE_ERROR_EVENT, STORAGE_RECOVERED_EVENT]);
  });

  it('失败时新数据确实没落盘（内存有、磁盘无的分裂是真实的）', () => {
    const fake = globalThis as unknown as { localStorage: FakeStorage };
    fake.localStorage.failOnWrite = true;
    saveFunds([fund('a')]);
    // 落盘的仍是失败前的内容，不是这次要写的
    expect(fake.localStorage.getItem('fund-tracker:funds')).not.toContain('"a"');
  });
});
