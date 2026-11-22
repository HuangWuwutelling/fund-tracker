import { getNavIndex, readNavHistory, exactNavOn, navOnOrBefore } from './navSeries';

/**
 * 净值查表。
 *
 * 这里是 `navSeries.ts` 之上的一层薄适配：把"某只基金在某个日期的净值"
 * 翻译成调用方要的形状。**读盘与缓存全部由 navSeries 管**——本模块不碰
 * localStorage。
 *
 * 两个函数必须分开，不能合并成一个带兜底的：
 * - `lookupExactNavOn` —— 只要当天。查不到就是查不到。
 * - `lookupNavOnOrBefore` —— 兜底到 ≤ 查询日的最近一条。
 *
 * 旧实现只有一个 `lookupNavForDate`（名字看不出有兜底），三处调用方里
 * 有两处**以为**它是"当天"就用——于是把旧净值当成了当日成交净值。
 * 分开命名之后，调用方被迫自己想清楚要哪一种。
 */

export interface NavLookupResult {
  nav: number;
  /** 这条净值**自己的日期**——不等于查询日时，说明用的是兜底值 */
  navDate: string;
}

/** 查询日**当天**的净值；没有则 null（绝不回退到更早的） */
export function lookupExactNavOn(fundId: string, date: string): NavLookupResult | null {
  const r = exactNavOn(getNavIndex(fundId), date);
  return r ? { nav: r.nav, navDate: r.date } : null;
}

/** ≤ 查询日的最近一条净值；一条都没有则 null */
export function lookupNavOnOrBefore(fundId: string, date: string): NavLookupResult | null {
  const r = navOnOrBefore(getNavIndex(fundId), date);
  return r ? { nav: r.nav, navDate: r.date } : null;
}

/**
 * 统计区间内的交易日数（按该基金的净值历史）。
 * 没有净值历史时返回 0。
 */
export function countTradingDays(fundId: string, startDate: string, endDate: string): number {
  const history = readNavHistory(fundId);
  return history.filter((r) => r.date >= startDate && r.date <= endDate).length;
}
