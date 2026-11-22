import type { NavRecord } from '../types';
import * as storage from './storage';

/**
 * 净值序列的**唯一 owner**。
 *
 * 之前有三条读路径：store 的缓存版、`navLookup` 直读 storage、`reportGenerator`
 * 直读 storage。后两条绕过了缓存——实测用真实数据（15 只基金 / 1.07 MB 净值历史）
 * 算一年的资金加权持仓市值要走 5,475 次 `JSON.parse`，阻塞主线程 **4,037 ms**。
 * 现在读路径只有一条：这里。
 *
 * 查表语义也在这里定死：
 * - `exactNavOn` —— 只有**当天**的净值。没有就是没有。
 * - `navOnOrBefore` —— 兜底到 ≤ 查询日的最近一条；返回的 `date` 是**那条净值
 *   自己的日期**，调用方必须自己比对，否则就会拿旧净值推算份额
 *   （2026-08-26 买入多算 13.6 份事故的形状）。
 */

/** 查表索引：原始记录 + date 映射 + 升序数组 */
export interface NavIndex {
  /** 原始记录（保持写入时的顺序） */
  records: NavRecord[];
  /** date → 记录（精确查表用） */
  byDate: Map<string, NavRecord>;
  /** 按 date 升序（兜底查表二分用） */
  asc: NavRecord[];
}

/** 为一批净值记录建索引 */
export function buildNavIndex(records: NavRecord[]): NavIndex {
  const byDate = new Map<string, NavRecord>();
  for (const r of records) byDate.set(r.date, r);
  const asc = [...records].sort((a, b) => a.date.localeCompare(b.date));
  return { records, byDate, asc };
}

/** 日期**恰好**等于 date 的那条净值；没有则 null（绝不回退） */
export function exactNavOn(index: NavIndex, date: string): NavRecord | null {
  return index.byDate.get(date) ?? null;
}

/** ≤ date 的最近一条净值；一条都没有则 null */
export function navOnOrBefore(index: NavIndex, date: string): NavRecord | null {
  const asc = index.asc;
  // 二分找最后一个 date <= 查询日
  let lo = 0;
  let hi = asc.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (asc[mid]!.date <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? asc[ans]! : null;
}

/**
 * 累计净值是否来自上游真值。
 *
 * 「acc ≡ nav」有两种完全不同的含义：该基金确实没分过红，或者上游没给
 * （2026-11-17 之前的老数据是写死的假值）。这个判断此前在
 * `navHistoryMerge.ts` 和 `navPair.ts` 各手写了一遍——现在只有这一份。
 */
export function hasRealAcc(records: NavRecord[]): boolean {
  return records.some((r) => r.accNav !== r.nav);
}

/* ------------------------------- 缓存 ------------------------------- */

/**
 * 净值历史缓存。
 *
 * 放在这里而不是 store：读净值的不止 store 一家（页面、报表、指标都要读），
 * 缓存归 owner 管，失效点只有一个。
 */
const cache = new Map<string, NavIndex>();

/** 取某只基金的净值索引（缓存命中则不读盘） */
export function getNavIndex(fundCode: string): NavIndex {
  const hit = cache.get(fundCode);
  if (hit) return hit;
  const index = buildNavIndex(storage.getNavHistory(fundCode));
  cache.set(fundCode, index);
  return index;
}

/** 取某只基金的净值记录（缓存命中则不读盘） */
export function readNavHistory(fundCode: string): NavRecord[] {
  return getNavIndex(fundCode).records;
}

/** 写回净值历史：缓存与落盘同时更新（净值历史是派生数据，写失败只是缓存没更新） */
export function putNavHistory(fundCode: string, records: NavRecord[]): void {
  cache.set(fundCode, buildNavIndex(records));
  storage.saveNavHistory(fundCode, records);
}

/**
 * 让缓存失效。
 *
 * 调用点：重置净值历史、导入备份、跨标签页同步、删除基金。
 * 之前缓存散在 store 的模块级 Map 里，失效点分散在 4 处——现在只有这里一个。
 */
export function invalidateNavHistory(fundCode?: string): void {
  if (fundCode) cache.delete(fundCode);
  else cache.clear();
}
