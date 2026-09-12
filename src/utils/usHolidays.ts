/**
 * 美国 NYSE / NASDAQ 全天休市日判定。
 *
 * 数据维护窗口：2025-2026。下一年度安排由 NYSE / NASDAQ 在前一年底公布。
 * 每年底前需补全年数据后，QDII 跨节假日的归属才能精确到下一个真实交易日。
 *
 * 数据源：
 * - NYSE 2025 Holiday Calendar
 * - NYSE 2026 Holiday Calendar
 *
 * 判定规则：
 *   非交易日 = 周末 ∪ 工作日法定节假日
 * - 周末（含被假期块自然衔接进去的周六/周日）默认是非交易日
 * - 工作日的法定节假日单独列入 WEEKDAY_HOLIDAYS 集合
 * - 周末 observance（如 7/4 落在周六 → 7/3 周五闭市）单独列入对应年份
 *
 * 范围：仅覆盖 NYSE/NASDAQ 共识的 10 个全天休市日；
 * 半天休市（如 7/3 中午收市）对 QDII NAV 发布无实质影响，未纳入。
 *
 * 超过 2026 年的数据暂未公布——isUsHoliday 对未知年份退化为「仅按周末判定」。
 */

/** 工作日法定节假日（仅列周一至周五；周末部分由 getDay() 推断） */
const WEEKDAY_HOLIDAYS_2025: Set<string> = new Set([
  '2025-01-01', // New Year's Day (Wed)
  '2025-01-20', // MLK Jr. Day (Mon)
  '2025-02-17', // Presidents Day (Mon)
  '2025-04-18', // Good Friday (Fri)
  '2025-05-26', // Memorial Day (Mon)
  '2025-06-19', // Juneteenth (Thu)
  '2025-07-04', // Independence Day (Fri)
  '2025-09-01', // Labor Day (Mon)
  '2025-11-27', // Thanksgiving (Thu)
  '2025-12-25', // Christmas (Thu)
]);

const WEEKDAY_HOLIDAYS_2026: Set<string> = new Set([
  '2026-01-01', // New Year's Day (Thu)
  '2026-01-19', // MLK Jr. Day (Mon)
  '2026-02-16', // Presidents Day (Mon)
  '2026-04-03', // Good Friday (Fri)
  '2026-05-25', // Memorial Day (Mon)
  '2026-06-19', // Juneteenth (Fri)
  '2026-07-03', // Independence Day observed (7/4 Sat → 7/3 Fri)
  '2026-09-07', // Labor Day (Mon) ← 触发的根因日
  '2026-11-26', // Thanksgiving (Thu)
  '2026-12-25', // Christmas (Fri)
]);

const WEEKDAY_HOLIDAYS_BY_YEAR = new Map<number, Set<string>>([
  [2025, WEEKDAY_HOLIDAYS_2025],
  [2026, WEEKDAY_HOLIDAYS_2026],
]);

/**
 * 判断指定日期（YYYY-MM-DD）是否为 NYSE / NASDAQ 全天休市日。
 *
 * - 已收录年份（2025、2026）：精确判定（周末 ∪ 工作日法定节假日）
 * - 未收录年份：退化为「仅按周末判定」——与未引入本工具前一致
 *
 * 仅供 QDII attribution map 构建使用；
 * A 股 / QDII T+2 发布日等其他场景仍走 chineseHolidays。
 */
export function isUsHoliday(date: string): boolean {
  const year = parseInt(date.slice(0, 4), 10);
  const d = new Date(`${date}T00:00:00`);
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return true; // 周末（QDII 也不会在周末发布 NAV）

  const holidaySet = WEEKDAY_HOLIDAYS_BY_YEAR.get(year);
  return holidaySet?.has(date) ?? false; // 未知年：不在节假日 → 交易日
}
