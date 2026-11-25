import { describe, it, expect } from 'vitest';
import { detectOrigin, backfillOrigin, originOf } from './txOrigin';
import { INITIAL_POSITION_NOTE, PLATFORM_IMPORT_NOTE } from './txNormalize';
import type { Transaction } from '../types';

/**
 * provenance（这笔交易从哪来）由**类型**表达，不再靠备注字符串匹配。
 *
 * 旧实现用 `note.includes('初始持仓')` 判断来源。后果：用户在备注里写
 * "初始持仓"两个字，这笔**手动**交易会被静默当成初始持仓——排除交易自检、
 * nav 被归一化成 0、还触发重复计算预警。规则靠子串匹配，用户无法回避。
 */

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1', fundId: 'f1', type: 'buy', date: '2026-08-26',
    amount: 1000, fee: 0, shares: 1000, nav: 1, ...over,
  };
}

describe('detectOrigin —— 从老数据推断来源（判定顺序固定）', () => {
  it('备注含「平台流水导入」→ platform-import', () => {
    expect(detectOrigin(tx({ note: PLATFORM_IMPORT_NOTE }))).toBe('platform-import');
  });

  it('备注含「初始持仓」→ initial-position', () => {
    expect(detectOrigin(tx({ note: INITIAL_POSITION_NOTE }))).toBe('initial-position');
  });

  it('有 planId → dca-auto', () => {
    expect(detectOrigin(tx({ planId: 'p1' }))).toBe('dca-auto');
  });

  it('其余 → manual', () => {
    expect(detectOrigin(tx())).toBe('manual');
    expect(detectOrigin(tx({ note: '随便写点什么' }))).toBe('manual');
  });

  it('判定顺序：平台流水导入优先于初始持仓', () => {
    // 两个标记都命中时，平台流水优先——与旧实现（先判平台流水）一致
    expect(
      detectOrigin(tx({ note: `${PLATFORM_IMPORT_NOTE} ${INITIAL_POSITION_NOTE}` })),
    ).toBe('platform-import');
  });

  it('判定顺序：初始持仓优先于 planId', () => {
    expect(detectOrigin(tx({ note: INITIAL_POSITION_NOTE, planId: 'p1' }))).toBe('initial-position');
  });
});

describe('originOf —— 消费端读来源', () => {
  it('有 origin → 用 origin，不再看 note', () => {
    // 关键修复：手动交易 + 备注里写了「初始持仓」→ 仍然是 manual
    expect(originOf(tx({ origin: 'manual', note: INITIAL_POSITION_NOTE }))).toBe('manual');
  });

  it('没有 origin（老数据）→ 按 note/planId 推断一次', () => {
    expect(originOf(tx({ note: INITIAL_POSITION_NOTE }))).toBe('initial-position');
    expect(originOf(tx({ note: PLATFORM_IMPORT_NOTE }))).toBe('platform-import');
    expect(originOf(tx({ planId: 'p1' }))).toBe('dca-auto');
    expect(originOf(tx())).toBe('manual');
  });
});

describe('backfillOrigin —— 给老数据补上 origin', () => {
  it('回填出正确的来源', () => {
    const out = backfillOrigin([
      tx({ id: 'a', note: INITIAL_POSITION_NOTE }),
      tx({ id: 'b', note: PLATFORM_IMPORT_NOTE }),
      tx({ id: 'c', planId: 'p1' }),
      tx({ id: 'd' }),
    ]);
    expect(out.map((t) => t.origin)).toEqual([
      'initial-position', 'platform-import', 'dca-auto', undefined,
    ]);
  });

  it('幂等：已经有 origin 的不动', () => {
    const once = backfillOrigin([tx({ id: 'a', note: INITIAL_POSITION_NOTE })]);
    const twice = backfillOrigin(once);
    expect(twice).toEqual(once);
    expect(twice[0]!.origin).toBe('initial-position');
  });

  it('manual 不写 origin（缺省就是 manual，写了只是噪音）', () => {
    const out = backfillOrigin([tx({ id: 'a' })]);
    expect(out[0]!.origin).toBeUndefined();
  });

  it('保留 note 原值（最坏情况用户可以人工改回）', () => {
    const out = backfillOrigin([tx({ id: 'a', note: '我的备注' })]);
    expect(out[0]!.note).toBe('我的备注');
  });

  it('无变化时返回原数组引用（调用方据此判断要不要写盘）', () => {
    const input = [tx({ id: 'a', origin: 'manual' })];
    expect(backfillOrigin(input)).toBe(input);
  });

  it('有变化时返回新数组', () => {
    const input = [tx({ id: 'a', note: INITIAL_POSITION_NOTE })];
    const out = backfillOrigin(input);
    expect(out).not.toBe(input);
    expect(input[0]!.origin).toBeUndefined();
  });
});
