/**
 * 测试用的 localStorage 桩。
 *
 * vitest 跑在 node 环境（见 vite.config.ts），node 没有 localStorage，而
 * `utils/storage.ts` 直接读写它。这个桩补上缺口，并支持**模拟写入失败**
 * （配额超限 / 隐私模式禁写），用来验证「写盘失败 → 磁盘不变」这类不变式。
 *
 * 放在 `src/test/` 而不是 `src/utils/`：它只被测试文件引用，不进生产包
 * （vite 不会把不可达模块打进 bundle；tsc 仍会对它做类型检查）。
 */

export interface CapturedEvent {
  type: string;
  detail?: unknown;
}

export class FakeStorage {
  private map = new Map<string, string>();

  /** 所有写入都失败 */
  failOnWrite = false;
  /** 只让这个 key 的写入失败（传完整 key，如 'fund-tracker:funds'） */
  failOnKey: string | null = null;
  /** removeItem 也失败（模拟删不掉） */
  failOnRemove = false;

  /** storage.ts 广播的事件（写失败 / 恢复） */
  events: CapturedEvent[] = [];
  /** getItem 被调用的次数——用来断言"缓存命中时不再读盘" */
  getItemCalls = 0;

  get length(): number {
    return this.map.size;
  }

  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }

  getItem(k: string): string | null {
    this.getItemCalls++;
    return this.map.has(k) ? this.map.get(k)! : null;
  }

  setItem(k: string, v: string): void {
    if (this.failOnWrite || this.failOnKey === k) {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(k, v);
  }

  removeItem(k: string): void {
    if (this.failOnRemove) {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.delete(k);
  }

  clear(): void {
    this.map.clear();
  }
}

/** 把桩装到 globalThis 上，返回它以便断言 */
export function installFakeStorage(): FakeStorage {
  const fake = new FakeStorage();
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage = fake;
  g.window = {
    dispatchEvent: (e: CapturedEvent) => {
      fake.events.push({ type: e.type, detail: e.detail });
      return true;
    },
  };
  g.CustomEvent = class {
    type: string;
    detail?: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  return fake;
}
