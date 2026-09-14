import type { Fund, NavRecord } from '../types';
import { isUsHoliday, isUsTrackedQdii } from './usHolidays';

/**
 * 返回"可用于配对计算"的 NAV 序列（按日期升序）。
 *
 * 过滤：跟踪美股市场的 QDII 剔除「非交易日」记录，判定交给 `isUsHoliday`
 * —— 周末 ∪ 美股工作日法定节假日（如 2026-09-07 美股劳工节）。这两类日子
 * 基金公司当天不发布新净值，数据源会补一条占位记录。
 * 不剔除时，节假日前后的真实涨跌会被摊开：9/4 → 9/7(占位) → 9/8 会把
 * 9/8 的全部涨跌只归到 9/8 那一天，而 9/8 的 attribution 本该是 9/4 → 9/8 的合计。
 * 周末同样适用——调休补班的周末 A 股照常开市，但 QDII 基金公司当天仍不发 NAV
 * （参考 2025-10-11，见 `chineseHolidays.ts` 顶部注释）。
 *
 * 港股 / 日股 QDII、A 股基金不套用美股节假日体系，原样返回。
 * 是否「美股跟踪」由 `isUsTrackedQdii` 按基金名关键词启发式判定（见该函数注释），
 * 关键词未覆盖的美股 QDII 不会被过滤。
 *
 * 注意：localStorage 里的 navHistory 始终保持原始记录——FundDetail 的净值曲线仍应
 * 展示这些空档日；只在"配对计算"时跳过。所以本函数返回的是**新数组**，不修改入参。
 */
export function usableNavSeries(fund: Fund, navHistory: NavRecord[]): NavRecord[] {
  const sorted = [...navHistory].sort((a, b) => a.date.localeCompare(b.date));
  return isUsTrackedQdii(fund.name) ? sorted.filter((r) => !isUsHoliday(r.date)) : sorted;
}

/**
 * 最新一对可用 NAV：curr = 最新的已发布净值，prev = 前一期。
 *
 * 这是"最新净值日盈亏"的数据源。它**不判断今天、不推算发布日、不看基金类型**——
 * 只问"这只基金现在能拿到的最后两期净值是哪两期"。理由：QDII 的披露延迟按基金 /
 * 按市场浮动（普遍 1 个交易日，法规上限 2 个交易日，见《QDII 基金运作指引》），
 * 任何写死的常数都会在部分基金上错位一天，把涨幅显示成跌幅。
 *
 * 排序依赖：`usableNavSeries` 已升序，因此取尾部两个即最新一对；相邻性即"上一期"，
 * 中间不会有被跳过的记录。
 *
 * 可用记录不足 2 条返回 null（新基金 / 净值尚未拉到 / 过滤后只剩 1 条）。
 */
export function latestNavPair(
  fund: Fund,
  navHistory: NavRecord[]
): { curr: NavRecord; prev: NavRecord } | null {
  const usable = usableNavSeries(fund, navHistory);
  if (usable.length < 2) return null;
  return { curr: usable[usable.length - 1]!, prev: usable[usable.length - 2]! };
}
