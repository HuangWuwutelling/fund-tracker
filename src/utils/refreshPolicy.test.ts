import { describe, it, expect } from 'vitest';
import { decideTickAction, MAX_SKIPPED_TICKS } from './refreshPolicy';

describe('decideTickAction（定时 tick 该做什么）', () => {
  it('stale 集合为空 → idle（无需任何请求）', () => {
    expect(decideTickAction(new Set(), null, 0)).toBe('idle');
    expect(decideTickAction(new Set(), new Set(['a']), 2)).toBe('idle');
  });

  it('首次观测（没有上轮集合）→ full', () => {
    expect(decideTickAction(new Set(['a']), null, 0)).toBe('full');
  });

  it('stale 集合与上轮完全相同 → indices-only：基金净值退避，但指数行情照刷', () => {
    expect(decideTickAction(new Set(['a']), new Set(['a']), 0)).toBe('indices-only');
  });

  it('连续跳满 MAX_SKIPPED_TICKS 次后强制 full（给数据源自愈留窗口）', () => {
    expect(decideTickAction(new Set(['a']), new Set(['a']), MAX_SKIPPED_TICKS)).toBe('full');
    expect(decideTickAction(new Set(['a']), new Set(['a']), MAX_SKIPPED_TICKS - 1)).toBe('indices-only');
  });

  it('stale 集合变化（增/减/换成员）→ 立即 full（恢复正常节奏）', () => {
    expect(decideTickAction(new Set(['a', 'b']), new Set(['a']), 3)).toBe('full');
    expect(decideTickAction(new Set(['a']), new Set(['a', 'b']), 3)).toBe('full');
    expect(decideTickAction(new Set(['b']), new Set(['a']), 0)).toBe('full');
  });

  it('退避只影响基金净值，绝不出现"什么都不做"的第三种结果', () => {
    // 回归：曾经指数行情被包在 refreshAll 里，退避时整条链路（含指数）一起被跳过，
    // 导致指数点位从每 30 分钟退化到 ~2 小时一次。
    for (const skipped of [0, 1, 2, 3, 4]) {
      const action = decideTickAction(new Set(['a']), new Set(['a']), skipped);
      expect(action).not.toBe('idle');
    }
  });
});
