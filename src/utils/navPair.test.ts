import { describe, it, expect } from 'vitest';
import { latestNavPair, usableNavSeries } from './navPair';
import type { Fund, NavRecord } from '../types';

function fund(name: string, type: Fund['type'] = 'qdii'): Fund {
  return { id: 'f1', name, platformId: 'p1', type, currentNav: 1, navDate: '' };
}

function nav(date: string, value: number): NavRecord {
  return { date, nav: value, accNav: value };
}

describe('usableNavSeries', () => {
  it('A 股 / 债券基金原样返回并按日期升序', () => {
    const out = usableNavSeries(fund('易方达蓝筹精选混合', 'mixed'), [
      nav('2026-09-11', 1.5),
      nav('2026-09-10', 1.4),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-10', '2026-09-11']);
  });

  it('美股跟踪 QDII 剔除美股节假日（2026-09-07 劳工节）的复制 NAV', () => {
    const out = usableNavSeries(fund('广发纳斯达克100ETF联接(QDII)A'), [
      nav('2026-09-04', 8.1742),
      nav('2026-09-07', 8.1747),
      nav('2026-09-08', 8.06),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-08']);
  });

  it('港股 QDII 不套用美股节假日体系', () => {
    const out = usableNavSeries(fund('华夏恒生ETF联接(QDII)C'), [
      nav('2026-09-04', 1.1),
      nav('2026-09-07', 1.2),
      nav('2026-09-08', 1.3),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-07', '2026-09-08']);
  });
});

describe('latestNavPair', () => {
  it('取最新的相邻一对，且跳过被过滤的复制 NAV', () => {
    const pair = latestNavPair(fund('广发纳斯达克100ETF联接(QDII)A'), [
      nav('2026-09-04', 8.1742),
      nav('2026-09-07', 8.1747),
      nav('2026-09-10', 8.0487),
      nav('2026-09-11', 8.1177),
    ]);
    expect(pair?.curr.date).toBe('2026-09-11');
    expect(pair?.prev.date).toBe('2026-09-10');
  });

  it('0 条或 1 条可用记录返回 null', () => {
    expect(latestNavPair(fund('易方达蓝筹精选混合', 'mixed'), [])).toBeNull();
    expect(latestNavPair(fund('易方达蓝筹精选混合', 'mixed'), [nav('2026-09-11', 1)])).toBeNull();
  });

  it('过滤后只剩 1 条也返回 null', () => {
    // 9/7 是美股劳工节会被剔除，可用记录只剩 9/8 一条
    expect(
      latestNavPair(fund('广发纳斯达克100ETF联接(QDII)A'), [
        nav('2026-09-07', 8.1747),
        nav('2026-09-08', 8.06),
      ])
    ).toBeNull();
  });
});
