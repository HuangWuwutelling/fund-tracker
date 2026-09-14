import { describe, it, expect } from 'vitest';
import { usableNavSeries } from './navPair';
import type { Fund, NavRecord } from '../types';

function fund(name: string, type: Fund['type'] = 'qdii'): Fund {
  return { id: 'f1', name, platformId: 'p1', type, currentNav: 1, navDate: '' };
}

function nav(date: string, value: number): NavRecord {
  return { date, nav: value, accNav: value };
}

describe('usableNavSeries', () => {
  it('按日期升序返回', () => {
    const out = usableNavSeries(fund('测试基金', 'index'), [
      nav('2026-09-11', 1.5),
      nav('2026-09-10', 1.4),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-10', '2026-09-11']);
  });
});
