import { describe, it, expect } from 'vitest';
import { computeFreshness, isNewlyPublished } from './navFreshness';
import type { Fund } from '../types';

function fund(id: string): Fund {
  return { id, name: `基金${id}`, platformId: 'p1', type: 'index', currentNav: 1, navDate: '' };
}

describe('isNewlyPublished', () => {
  it('NAV 日前进 → true', () => {
    expect(isNewlyPublished('2026-09-10', '2026-09-11')).toBe(true);
  });

  it('NAV 日不变 → false', () => {
    expect(isNewlyPublished('2026-09-11', '2026-09-11')).toBe(false);
  });

  it('无基线（首次观测 / 新添加的基金）→ true', () => {
    expect(isNewlyPublished(undefined, '2026-09-11')).toBe(true);
  });

  it('完全没有 NAV → false（哪怕无基线）', () => {
    expect(isNewlyPublished('2026-09-10', undefined)).toBe(false);
    expect(isNewlyPublished(undefined, undefined)).toBe(false);
  });
});

describe('computeFreshness', () => {
  it('NAV 日前进的基金进 fresh，基线被更新', () => {
    const funds = [fund('a'), fund('b')];
    const latest: Record<string, string> = { a: '2026-09-14', b: '2026-09-11' };
    const { fresh, nextSeen } = computeFreshness(funds, (f) => latest[f.id], {
      a: '2026-09-11',
      b: '2026-09-11',
    });
    expect([...fresh]).toEqual(['a']);
    expect(nextSeen).toEqual({ a: '2026-09-14', b: '2026-09-11' });
  });

  it('首次观测（无任何基线）全部视为 fresh', () => {
    const { fresh, nextSeen } = computeFreshness([fund('a')], () => '2026-09-14', {});
    expect([...fresh]).toEqual(['a']);
    expect(nextSeen).toEqual({ a: '2026-09-14' });
  });

  it('拿不到 NAV 的基金不 fresh，且旧基线被保留', () => {
    const { fresh, nextSeen } = computeFreshness([fund('a')], () => undefined, { a: '2026-09-11' });
    expect(fresh.size).toBe(0);
    expect(nextSeen).toEqual({ a: '2026-09-11' });
  });

  it('已移除的基金从基线中剔除', () => {
    const { nextSeen } = computeFreshness([], () => undefined, { gone: '2026-09-11' });
    expect(nextSeen).toEqual({});
  });
});
