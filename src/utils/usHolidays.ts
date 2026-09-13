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

/**
 * 跟踪美股指数的 QDII 基金判定（用于 attribution 跳过美股节假日）。
 *
 * 背景：QDII 类型不止跟踪美股，还可能跟踪港股、日本、欧洲等市场，
 * 这些市场不遵循美股节假日。若统一按 `fund.type === 'qdii'` 过滤美股节假日，
 * 港股 QDII（如华夏恒生 ETF(QDII)）在美股劳工节会被错误跳过，
 * 下一个 attribution 跨度过大导致 PnL 失真。
 *
 * 启发式：检查基金名是否含明确的「美股指数」关键词。
 * 局限：依赖名称约定，新出现的美股 QDII 名称需要扩充关键词列表。
 *
 * 关键词列表（中英文混合，覆盖国内常见的美股 QDII 命名约定）：
 * - 纳斯达克 / 纳指 / NASDAQ → 纳斯达克 100 指数等
 * - 标普 / S&P / SP500 / S&P500 → 标普 500 指数等
 * - 道琼斯 / 道指 / DJIA → 道琼斯指数
 * - 罗素 / Russell → 罗素 2000 等
 * - 标普 500 ETF 联接 等组合写法
 *
 * 不含「美股」「美国」等过于宽泛的词，避免误判含这些词但跟踪其他市场的基金。
 */
const US_TRACKING_KEYWORDS: readonly string[] = [
  // 纳斯达克
  '纳斯达克', '纳指',
  'NASDAQ', 'Nasdaq',
  // 标普
  '标普', 'S&P', 'SP500', 'S&P500', 'SP 500',
  // 道琼斯
  '道琼斯', '道指',
  'Dow Jones', 'DJIA',
  // 罗素
  '罗素', 'Russell',
];

export function isUsTrackedQdii(fundName: string): boolean {
  return US_TRACKING_KEYWORDS.some((kw) => fundName.includes(kw));
}
