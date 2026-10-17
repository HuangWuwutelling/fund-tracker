import type { Fund, NavRecord } from '../types';
import { isUsHoliday, isUsTrackedQdii } from './usHolidays';

/**
 * 美股跟踪 QDII 的节假日过滤模式。
 *
 * - `auto`（默认）: **数据驱动**——剔除"占位条目"（nav 与 accNav 都和前一条完全相同）。
 *   不依赖日历字典，对 2024 及以前数据同样有效；MA250 等指标暖机期更短。
 *   唯一误杀风险：基金连续 ≥ 2 天真实 0% 变动（罕见，< 1 次/年）。
 *
 * - `strict`: **日期驱动**——按美股工作日节假日 + 周末剔除（依赖 `usHolidays` 字典）。
 *   字典仅覆盖 2025-2026；其它年份退化为「仅按周末」剔除。
 *
 * - `off`: **不过滤**——返回 navHistory 原样，对所有基金都生效（包括 A 股），
 *   不只是 QDII。适用：数据本就稀缺的基金，宁可 attribution 跨节假日"压扁"，
 *   也要 MA250 早点就绪。
 */
export type UsQdiiFilterMode = 'auto' | 'strict' | 'off';

/** 默认过滤模式。新老数据无字段时由 storage 兜底。 */
export const DEFAULT_US_QDII_FILTER_MODE: UsQdiiFilterMode = 'auto';

/**
 * 返回"可用于配对计算"的 NAV 序列（按日期升序）。
 *
 * 过滤行为由 `mode` 决定：
 * - `auto`（默认）：跟踪美股市场的 QDII 剔除"占位条目"（nav 与 accNav 都和前一条相同
 *   的记录）。数据驱动，与日历解耦，对 2024 及以前数据同样有效。
 * - `strict`：按日期剔除美股工作日节假日 + 周末（依赖 `usHolidays` 字典）。
 * - `off`：不过滤，返回原样。
 *
 * 不适用过滤：港股 / 日股 QDII、A 股基金——这些市场不遵循美股节假日体系。
 * 是否「美股跟踪」由 `isUsTrackedQdii` 按基金名关键词启发式判定（见该函数注释），
 * 关键词未覆盖的美股 QDII 不会被过滤。
 *
 * 注意：localStorage 里的 navHistory 始终保持原始记录——FundDetail 的净值曲线仍应
 * 展示这些空档日；只在"配对计算"时跳过。所以本函数返回的是**新数组**，不修改入参。
 */
export function usableNavSeries(
  fund: Fund,
  navHistory: NavRecord[],
  mode: UsQdiiFilterMode = DEFAULT_US_QDII_FILTER_MODE
): NavRecord[] {
  const sorted = [...navHistory].sort((a, b) => a.date.localeCompare(b.date));
  // 三种模式 + 「非美股 QDII」共 4 个分支。先抓最短的早退（off 或非 QDII），
  // 再用 switch 走具体的过滤逻辑——避免链式 if 末尾的 "mode === 'auto'" 注释悬挂。
  if (mode === 'off' || !isUsTrackedQdii(fund.name)) return sorted;
  switch (mode) {
    case 'strict':
      return sorted.filter((r) => !isUsHoliday(r.date));
    case 'auto': {
      // 单次遍历：第 0 条直接收；之后每条与前一条比，nav+accNav 都相同视为占位跳过。
      // 比「detectPlaceholders 返 bool[] + filter 二次遍历」少一次 O(N) 内存分配。
      // 占位语义：当前条目的 nav 与 accNav 都和前一条完全相同（eastmoney / 天天基金
      // 数据源在 QDII 跨美股节假日时的常见模式——基金公司当天不发 NAV，数据源补一条
      // "复制上一交易日"的记录）。同时检查 nav 和 accNav 是为了避免误杀真实派息日
      // （accNav 会跳但 nav 偶有同值）。第 0 条无前序可比，永不被判为占位。
      const out: NavRecord[] = [];
      for (let i = 0; i < sorted.length; i++) {
        if (i === 0) {
          out.push(sorted[i]!);
          continue;
        }
        const prev = sorted[i - 1]!;
        const curr = sorted[i]!;
        if (curr.nav === prev.nav && curr.accNav === prev.accNav) continue;
        out.push(curr);
      }
      return out;
    }
  }
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
  navHistory: NavRecord[],
  mode: UsQdiiFilterMode = DEFAULT_US_QDII_FILTER_MODE
): { curr: NavRecord; prev: NavRecord } | null {
  const usable = usableNavSeries(fund, navHistory, mode);
  if (usable.length < 2) return null;
  return { curr: usable[usable.length - 1]!, prev: usable[usable.length - 2]! };
}
