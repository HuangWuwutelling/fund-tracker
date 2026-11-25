import { describe, it, expect, beforeEach } from 'vitest';
import { lookupExactNavOn, lookupNavOnOrBefore, countTradingDays } from './navLookup';
import { putNavHistory, invalidateNavHistory } from './navSeries';
import { installFakeStorage } from '../test/fakeStorage';
import type { NavRecord } from '../types';

/**
 * `navLookup` 是 `navSeries` 之上的适配层：把"某只基金在某天的净值"翻译成
 * 调用方要的形状。
 *
 * 两个查表接口**必须分开选**——旧的 `lookupNavForDate` 名字看不出有兜底，
 * 三处调用方里有两处**以为**它是"当天"就用，把旧净值当成了当日成交净值
 * （2026-08-26 买入多算 13.6 份那次事故的形状）。
 *
 * 底层语义由 `navSeries.test.ts` 覆盖；这里覆盖**适配层自己的语义**——
 * 尤其�� `navDate` 必须是**那条净值自己的日期**，而不是查询日。
 */

beforeEach(() => {
  installFakeStorage();
  invalidateNavHistory();
});

function nav(date: string, n: number, acc = n): NavRecord {
  return { date, nav: n, accNav: acc };
}

describe('lookupExactNavOn（只要当天）', () => {
  it('当天有记录 → 返回它，且 navDate 就是当天', () => {
    putNavHistory('f1', [nav('2026-08-06', 1.0386), nav('2026-08-26', 1.048)]);
    const r = lookupExactNavOn('f1', '2026-08-26');
    expect(r).not.toBeNull();
    expect(r!.nav).toBe(1.048);
    expect(r!.navDate).toBe('2026-08-26');
  });

  it('当天没有记录 → null（**绝不**回退到前一条）', () => {
    putNavHistory('f1', [nav('2026-08-06', 1.0386), nav('2026-08-26', 1.048)]);
    expect(lookupExactNavOn('f1', '2026-08-20')).toBeNull();
  });

  it('基金没有净值历史 → null', () => {
    expect(lookupExactNavOn('nope', '2026-08-26')).toBeNull();
  });
});

describe('lookupNavOnOrBefore（兜底到 ≤ 查询日的最近一条）', () => {
  it('查询日之前有记录 → 返回它，且 navDate 是**那条净值自己的日期**', () => {
    putNavHistory('f1', [nav('2026-08-06', 1.0386), nav('2026-08-26', 1.048)]);
    const r = lookupNavOnOrBefore('f1', '2026-08-20');
    expect(r).not.toBeNull();
    expect(r!.nav).toBe(1.0386);
    // ⚠️ 关键：不是查询日 08-20，而是那条净值自己的 08-06
    // 调用方必须自己比对 navDate 与交易日期，否则会把旧净值当成当日成交净值
    expect(r!.navDate).toBe('2026-08-06');
    expect(r!.navDate).not.toBe('2026-08-20');
  });

  it('查询日当天有记录 → 返回当天的', () => {
    putNavHistory('f1', [nav('2026-08-06', 1.0386), nav('2026-08-26', 1.048)]);
    const r = lookupNavOnOrBefore('f1', '2026-08-26');
    expect(r!.nav).toBe(1.048);
    expect(r!.navDate).toBe('2026-08-26');
  });

  it('查询日之前一条都没有 → null（不往后找）', () => {
    putNavHistory('f1', [nav('2026-08-26', 1.048)]);
    expect(lookupNavOnOrBefore('f1', '2026-08-20')).toBeNull();
  });

  it('查询日之后的记录不得被返回', () => {
    putNavHistory('f1', [nav('2026-08-06', 1.0386), nav('2026-08-26', 1.048)]);
    const r = lookupNavOnOrBefore('f1', '2026-08-20');
    expect(r!.navDate).toBe('2026-08-06');
  });

  it('基金没有净值历史 → null', () => {
    expect(lookupNavOnOrBefore('nope', '2026-08-26')).toBeNull();
  });
});

describe('countTradingDays（区间内的净值记录条数）', () => {
  const history = [
    nav('2026-08-05', 1.0),
    nav('2026-08-06', 1.1),
    nav('2026-08-07', 1.2),
  ];

  it('闭区间计数', () => {
    expect(countTradingDays(history, '2026-08-06', '2026-08-07')).toBe(2);
  });

  it('包含两端', () => {
    expect(countTradingDays(history, '2026-08-05', '2026-08-07')).toBe(3);
  });

  it('区间外不算', () => {
    expect(countTradingDays(history, '2026-09-01', '2026-09-30')).toBe(0);
  });

  it('空历史 → 0', () => {
    expect(countTradingDays([], '2026-08-05', '2026-08-07')).toBe(0);
  });
});
