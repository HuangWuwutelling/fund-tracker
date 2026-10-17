import { describe, it, expect } from 'vitest';
import { latestNavPair, usableNavSeries } from './navPair';
import type { Fund, NavRecord } from '../types';

function fund(name: string, type: Fund['type'] = 'qdii'): Fund {
  return { id: 'f1', name, platformId: 'p1', type, currentNav: 1, navDate: '' };
}

function nav(date: string, value: number): NavRecord {
  return { date, nav: value, accNav: value };
}

function navFull(date: string, navValue: number, accValue: number): NavRecord {
  return { date, nav: navValue, accNav: accValue };
}

describe('usableNavSeries — auto 模式（默认）', () => {
  it('A 股 / 债券基金原样返回并按日期升序', () => {
    const out = usableNavSeries(fund('易方达蓝筹精选混合', 'mixed'), [
      nav('2026-09-11', 1.5),
      nav('2026-09-10', 1.4),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-10', '2026-09-11']);
  });

  it('美股跟踪 QDII：nav 与 accNav 都和前一条完全相同 → 视为占位剔除', () => {
    // 9/4 真值 8.1742；9/7 占位（nav=accNav=前一交易日值）；9/8 真值 8.06
    const out = usableNavSeries(fund('广发纳斯达克100ETF联接(QDII)A'), [
      navFull('2026-09-04', 8.1742, 8.1742),
      navFull('2026-09-07', 8.1742, 8.1742), // 复制 9/4
      navFull('2026-09-08', 8.06, 8.06),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-08']);
  });

  it('美股跟踪 QDII：仅 nav 相同但 accNav 不同 → 不视为占位（保留）', () => {
    // 防误杀：当天有真实派息时 accNav 会跳，nav 偶有同值
    const out = usableNavSeries(fund('广发纳斯达克100ETF联接(QDII)A'), [
      navFull('2026-09-04', 1.5, 1.5),
      navFull('2026-09-07', 1.5, 1.51), // accNav 跳了 → 真实变动
      navFull('2026-09-08', 1.52, 1.52),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-07', '2026-09-08']);
  });

  it('美股跟踪 QDII：连号两天 NAV 完全相同（占位串）→ 全部剔除', () => {
    // 9/11 真值；9/12 周六占位；9/13 周日占位
    const out = usableNavSeries(fund('广发纳斯达克100ETF联接(QDII)A'), [
      nav('2026-09-11', 8.1177),
      nav('2026-09-12', 8.1177),
      nav('2026-09-13', 8.1177),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-11']);
  });

  it('美股跟踪 QDII：跨节假日 NAV 真有变动（如定息日）→ 不误杀', () => {
    // 数据源偶发真实跳变：9/4 → 9/7 → 9/8，每条 nav 都不同
    const out = usableNavSeries(fund('广发纳斯达克100ETF联接(QDII)A'), [
      nav('2026-09-04', 8.1742),
      nav('2026-09-07', 8.1750), // 真实跳变 +0.001
      nav('2026-09-08', 8.06),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-07', '2026-09-08']);
  });

  it('首条记录无前序可比 → 不被检测为占位', () => {
    const out = usableNavSeries(fund('广发纳斯达克100ETF联接(QDII)A'), [
      nav('2026-09-04', 1.5),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-04']);
  });

  it('港股 QDII 不套用美股节假日体系', () => {
    const out = usableNavSeries(fund('华夏恒生ETF联接(QDII)C'), [
      nav('2026-09-04', 1.1),
      nav('2026-09-07', 1.2),
      nav('2026-09-08', 1.3),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-07', '2026-09-08']);
  });

  it('A 股 QDII 不被误判为美股跟踪', () => {
    // 不含美股关键词 → 关键词启发式返回 false → 不过滤
    const out = usableNavSeries(fund('华夏大中华企业精选灵活配置混合(QDII)'), [
      nav('2026-09-04', 1.1),
      nav('2026-09-07', 1.1), // 即便 nav 相同也不剔除
      nav('2026-09-08', 1.1),
    ]);
    expect(out.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-07', '2026-09-08']);
  });
});

describe('usableNavSeries — strict 模式（按美股节假日字典）', () => {
  it('美股跟踪 QDII 剔除 2026-09-07 劳工节', () => {
    const out = usableNavSeries(
      fund('广发纳斯达克100ETF联接(QDII)A'),
      [
        nav('2026-09-04', 8.1742),
        nav('2026-09-07', 8.1747), // 劳工节，与前条 nav 不同但仍按日历剔除
        nav('2026-09-08', 8.06),
      ],
      'strict'
    );
    expect(out.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-08']);
  });

  it('美股跟踪 QDII 剔除周末（调休补班的周末同样不发 NAV）', () => {
    const out = usableNavSeries(
      fund('广发纳斯达克100ETF联接(QDII)A'),
      [
        nav('2026-09-11', 8.1177),
        nav('2026-09-12', 8.1177), // 周六
        nav('2026-09-13', 8.1177), // 周日
      ],
      'strict'
    );
    expect(out.map((r) => r.date)).toEqual(['2026-09-11']);
  });
});

describe('usableNavSeries — off 模式（不过滤）', () => {
  it('美股跟踪 QDII 全部原样返回', () => {
    const out = usableNavSeries(
      fund('广发纳斯达克100ETF联接(QDII)A'),
      [
        nav('2026-09-04', 8.1742),
        nav('2026-09-07', 8.1742), // 占位也不剔除
        nav('2026-09-08', 8.06),
      ],
      'off'
    );
    expect(out.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-07', '2026-09-08']);
  });

  it('A 股基金 off 模式也是原样', () => {
    const out = usableNavSeries(
      fund('易方达蓝筹精选混合', 'mixed'),
      [nav('2026-09-11', 1.5), nav('2026-09-10', 1.4)],
      'off'
    );
    expect(out.map((r) => r.date)).toEqual(['2026-09-10', '2026-09-11']);
  });
});

describe('latestNavPair', () => {
  it('auto 模式：取最新的相邻一对，且跳过被识别的占位', () => {
    const pair = latestNavPair(
      fund('广发纳斯达克100ETF联接(QDII)A'),
      [
        navFull('2026-09-04', 8.1742, 8.1742),
        navFull('2026-09-07', 8.1742, 8.1742), // 占位
        navFull('2026-09-10', 8.0487, 8.0487),
        navFull('2026-09-11', 8.1177, 8.1177),
      ]
    );
    expect(pair?.curr.date).toBe('2026-09-11');
    expect(pair?.prev.date).toBe('2026-09-10');
  });

  it('strict 模式：被过滤的记录落在尾部时，最新一对取过滤后的相邻两条', () => {
    // 9/12 是周六，会被 isUsHoliday 判为非交易日而剔除
    const pair = latestNavPair(
      fund('广发纳斯达克100ETF联接(QDII)A'),
      [nav('2026-09-10', 8.0487), nav('2026-09-11', 8.1177), nav('2026-09-12', 8.1177)],
      'strict'
    );
    expect(pair?.curr.date).toBe('2026-09-11');
    expect(pair?.prev.date).toBe('2026-09-10');
  });

  it('0 条或 1 条可用记录返回 null', () => {
    expect(latestNavPair(fund('易方达蓝筹精选混合', 'mixed'), [])).toBeNull();
    expect(latestNavPair(fund('易方达蓝筹精选混合', 'mixed'), [nav('2026-09-11', 1)])).toBeNull();
  });

  it('过滤后只剩 1 条也返回 null', () => {
    // 9/7 是真值，9/8 是占位（nav+accNav 与 9/7 完全相同）→ 剔除后只剩 9/7
    expect(
      latestNavPair(fund('广发纳斯达克100ETF联接(QDII)A'), [
        navFull('2026-09-07', 8.20, 8.20),
        navFull('2026-09-08', 8.20, 8.20),
      ])
    ).toBeNull();
  });
});
