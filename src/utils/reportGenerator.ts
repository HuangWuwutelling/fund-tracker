import type { Fund, Transaction, DcaPlan, DailySnapshot, Platform, NavRecord } from '../types';
import { calcShares, calcLatestNavPnl, calcDailyPnlBySegments, onlyConfirmed, isInPlanWindow } from './calculator';
import { FUND_TYPE_LABELS } from '../types';
import { countTradingDays, lookupNavForDate } from './navLookup';
import { getNavHistory } from './storage';
import { today } from './formatter';
import { usableNavSeries } from './navPair';
import { isNonTradingDay } from './chineseHolidays';
import dayjs from 'dayjs';

export interface FundPerformance {
  fundId: string;
  fundName: string;
  returnAmount: number;
  returnRate: number;
}

export interface DcaPlanExecution {
  planId: string;
  fundId: string;
  fundName: string;
  frequency: DcaPlan['frequency'];
  /** 本周是否落入执行周（biweekly/monthly 不是每周都执行） */
  isDueWeek: boolean;
  /** 本周内该基金的 buy 交易笔数（confirmed） */
  actual: number;
  /** 期望笔数：daily 时是本周交易天数，其他都是 0/1 */
  expected: number;
}

export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  totalReturn: number;
  returnRate: number;
  buyCount: number;
  sellCount: number;
  dividendCount: number;
  fundRankings: FundPerformance[];
  dcaExpected: number;
  dcaActual: number;
  dcaDetails: DcaPlanExecution[];
}

export interface MonthlyReport {
  month: string;
  totalReturn: number;
  returnRate: number;
  snapshots: DailySnapshot[];
  platformContributions: { name: string; returnAmount: number }[];
  typeContributions: { type: string; returnAmount: number }[];
  bestFund: FundPerformance | null;
  worstFund: FundPerformance | null;
  fundRankings: FundPerformance[];
}

function getWeekRange(date: Date): [string, string] {
  // 用 dayjs 算本地周一/周日，避免 toISOString 的 UTC 偏移
  const monday = dayjs(date).startOf('week').add(1, 'day'); // dayjs 默认周日为周首，需要 +1 天到周一
  const sunday = monday.add(6, 'day');
  return [monday.format('YYYY-MM-DD'), sunday.format('YYYY-MM-DD')];
}

function getMonthRange(year: number, month: number): [string, string] {
  // month is 1-12 (dayjs convention); dayjs is 1-12 too
  const start = dayjs(`${year}-${String(month).padStart(2, '0')}-01`);
  const end = start.endOf('month');
  return [start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD')];
}

/** 月度收益聚合（沿用 calcPortfolioValueAtDate 算法，与 WeeklyReport/MonthlyReport 一致） */
export interface MonthlyReturn {
  month: string;        // 'YYYY-MM'
  totalReturn: number;  // 整月收益金额（元）
  returnRate: number;   // 月度收益率 %
  perFund: { fundId: string; fundName: string; returnAmount: number }[];
}

/** 年度收益聚合（同上） */
export interface YearlyReturn {
  year: string;         // 'YYYY'
  totalReturn: number;
  returnRate: number;
  perFund: { fundId: string; fundName: string; returnAmount: number }[];
}

export interface DailyReturn {
  date: string;
  /** 当天总收益（仅含价格变动 × 份额，不扣除当日净投入；当日投入见 Dashboard 顶部 StatCard） */
  totalReturn: number;
  /**
   * 各基金贡献的收益。
   * - 历史格：`navDate === date`（归属日就是这一天）
   * - 今日格：`navDate` 是该基金**最新已发布 NAV 的归属日**，可能早于 `date`
   *   （A 股通常当天，QDII 常落后 1 个交易日）。UI 用它把口径写在界面上。
   */
  perFund: {
    fundId: string;
    fundName: string;
    returnAmount: number;
    navDate: string;
    /**
     * 仅"今日"行可能为 true：该基金可用 NAV 不足 2 期，returnAmount 强制为 0。
     * UI 渲染时区别于"持平=0"——显示 "— 无净值数据"。
     * 历史日的 perFund 永远是 false（归属已确定，一定有成对的 NAV）。
     */
    noNav?: boolean;
  }[];
  /**
   * 仅"今日"行可能为 true：**有持仓**的基金全部没有可用 NAV 对（数据未拉到 / 刷新失败）。
   * UI 用灰格 + "净值待更新"提示。历史格永远是 false。
   */
  isPending?: boolean;
}

interface Attribution {
  fund: Fund;
  curr: NavRecord;
  prev: NavRecord;
}

/**
 * 预计算每只基金的"相邻 NAV 变化"及其归属日：
 * 对每对相邻 NAV（prev → curr），把 (curr.nav - prev.nav) 的收益归属到 navDate = curr.date
 * （与 A 股同口径：QDII 9/1 NAV 涨跌归到 9/1 这一天）。
 *
 * 注意：「历史格归属日 = navDate」与 Dashboard 顶部「最新净值日盈亏」是两个不同的概念：
 *   - 历史格：用户回看某天（9/1），QDII 用 9/1 真实 NAV − 8/29 NAV
 *   - 最新净值日盈亏：取该基金最新一对已发布 NAV（见 utils/navPair.ts），
 *     用 NAV 自己的日期标注，不假设任何发布延迟
 *
 * 历史格与 A 股同口径：只看该归属日在 attributionMap 里有没有 attr，
 * 有就用、没有则该基金当天涨跌为 0。**不判定发布日**，历史格没有 pending 态。
 *
 * 返回嵌套 Map<归属日, Map<fundId, Attribution>>，按 fundId O(1) 查找，
 * 替代之前的 Map<date, Attribution[]> + 内层 .find()（O(M) 每格）。
 */
function buildAttributionMap(funds: Fund[]): Map<string, Map<string, Attribution>> {
  const map = new Map<string, Map<string, Attribution>>();
  for (const fund of funds) {
    // 可用性规则（含美股节假日复制 NAV 的剔除）统一收敛在 usableNavSeries，
    // 与 latestNavPair 共用同一份判断，避免"日历不算、卡片算"的口径分叉。
    //
    // QDII 的「复制 NAV」条目（基金公司从上一交易日复制 NAV 填充，如 9/7 美股劳工节）
    // 剔除后，9/8 attribution 自动跳到 prev=9/4 的真实涨跌；9/7 不在 attribution map 中
    // → perFund 里 QDII 不计入（A 股 / 债仍正常显示）。
    // A 股 / 港股通（type='index'）不动 —— US 假日与它们无关。
    // 不在 fundApi.ts ingestion 时剔除：navHistory 保持原始记录，让 FundDetail 的
    // NAV 曲线仍能展示 US 节假日空档；仅在 attribution 配对时跳过。
    const usable = usableNavSeries(fund, getNavHistory(fund.id));
    if (usable.length < 2) continue;
    for (let i = 1; i < usable.length; i++) {
      const curr = usable[i]!;
      const prev = usable[i - 1]!;
      const attributionDate = curr.date;
      let inner = map.get(attributionDate);
      if (!inner) {
        inner = new Map();
        map.set(attributionDate, inner);
      }
      inner.set(fund.id, { fund, curr, prev });
    }
  }
  return map;
}

/**
 * 按基金预分桶 confirmed 交易，附加"截至各交易日"的累计份额时间线。
 * 历史格计算 shares 时不再 filter+sort 全表——直接对时间线二分定位到 snap.date 的最新累计值，
 * 单格 O(log K) 替代原来的 O(T) + O(K log K)。
 *
 * 返回 Map<fundId, { cumShares }[]>（按日期升序，cumShares = 处理完该日交易后的份额）
 */
function buildSharesTimeline(funds: Fund[], confirmed: Transaction[]): Map<string, Array<{ date: string; cumShares: number }>> {
  const txsByFund = new Map<string, Transaction[]>();
  for (const f of funds) txsByFund.set(f.id, []);
  for (const tx of confirmed) {
    const arr = txsByFund.get(tx.fundId);
    if (arr) arr.push(tx);
  }
  const out = new Map<string, Array<{ date: string; cumShares: number }>>();
  for (const f of funds) {
    const txs = txsByFund.get(f.id) ?? [];
    txs.sort((a, b) => a.date.localeCompare(b.date));
    const timeline: Array<{ date: string; cumShares: number }> = [];
    let cum = 0;
    for (const tx of txs) {
      if (tx.type === 'buy') cum += tx.shares;
      else if (tx.type === 'sell') cum -= tx.shares;
      else if (tx.type === 'dividend') cum += tx.shares;
      timeline.push({ date: tx.date, cumShares: cum });
    }
    out.set(f.id, timeline);
  }
  return out;
}

/** 二分查找：截至 date（含）的最新累计份额。无交易返回 0 */
function getSharesAsOf(
  timeline: Array<{ date: string; cumShares: number }> | undefined,
  date: string
): number {
  if (!timeline || timeline.length === 0) return 0;
  let lo = 0;
  let hi = timeline.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (timeline[mid]!.date <= date) {
      result = timeline[mid]!.cumShares;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/**
 * 生成每日收益明细（按日期升序）
 *
 * **今天格 vs 历史格的算法分叉**：
 * - **历史格**：用 attribution map（每只基金的相邻 NAV 对 (prev → curr) 按 navDate
 *   归属——与 A 股同口径，QDII 9/1 NAV 涨跌归到 9/1 这一天）。只看该归属日有没有
 *   attr，不判定发布日，历史格没有 pending 态（只有今天格可能标 isPending）。
 * - **今天格**：**完全旁路 attribution map，直接取每只基金最新一对已发布 NAV**
 *   （`calcLatestNavPnl`）。这确保 Calendar 今日格 ≡ Dashboard 顶部卡片（共用同一份
 *   "最新已发布 NAV 对"），解决之前几个修复 commit 反复踩的"两边口径漂移"问题。
 *   注意今天格的 `navDate` 可能早于 `date`（A 股当天发布、QDII 常落后 1 个交易日），
 *   UI 必须把 `navDate` 展示出来，不要假装它就是"今天的"。
 *
 * **isPending 判定**：只看有持仓（shares>0）的基金——全部**没有可用 NAV 对**才视为待更新。
 * 排除空持仓基金（已清仓的基金 NAV 更新不应阻塞显示）。
 *
 * 注意：Day/Month/Year 三 Tab 现在**统一用 attribution 算法**——Month/Year Tab 直接聚合
 * 本函数的 dailyReturns 结果，保证「月格 = 当月日格之和」「年格 = 当年日格之和」，
 * 彻底消除之前"日 vs 月/年"算法分叉导致的查表对账差异（QDII 跨月归属尤其明显）。
 */
export function generateDailyReturns(
  funds: Fund[],
  transactions: Transaction[]
): DailyReturn[] {
  const confirmed = onlyConfirmed(transactions);
  const todayStr = today();

  // 历史格日期序列：自驱动生成 [firstTxDate, today] 的所有应展示日
  // - 起点：用户最早一笔 confirmed 交易日期（仅含持有期，与 yearlyReturns.minYear 口径一致）
  // - 终点：今天（含 today 格——独立判定 isPending，不走 attribution map）
  // - 跳过：周末 / A 股法定节假日（isNonTradingDay 已含调休补班周末判定）
  //
  // 修复前：snapshots 缺失的日子（如 9/8 没打开 App）不会生成格子 → UI fallback 0
  // 修复后：日期序列完整 → 9/8 显示真实涨跌 ≈ +73.5 元（QDII -12.34 + 非 QDII +85.84）
  const firstTxDate = confirmed.length > 0
    ? confirmed.map((t) => t.date).sort()[0]!
    : todayStr;
  const sorted: Array<{ date: string }> = [];
  for (
    let cursor = dayjs(firstTxDate);
    cursor.format('YYYY-MM-DD') <= todayStr;
    cursor = cursor.add(1, 'day')
  ) {
    const date = cursor.format('YYYY-MM-DD');
    if (!isNonTradingDay(date) || date === todayStr) {
      sorted.push({ date });
    }
  }

  // 一次性构建：归属 map + 份额时间线（避免内层每次循环 filter+sort 全表）
  const attributionMap = buildAttributionMap(funds);
  const sharesTimeline = buildSharesTimeline(funds, confirmed);

  // 按基金预分桶 confirmed 交易——今日格要按 fund 调 calcLatestNavPnl，
  // 它内部用 calcShares 算份额，与 calcFundSummary 完全同源，
  // 保证「日历今日格合计 === Dashboard 卡片数字」这个来之不易的不变量继续成立。
  const txsByFund = new Map<string, Transaction[]>();
  for (const tx of confirmed) {
    const arr = txsByFund.get(tx.fundId);
    if (arr) arr.push(tx);
    else txsByFund.set(tx.fundId, [tx]);
  }

  const result: DailyReturn[] = [];

  // 历史格：QDII 与 A 股统一用 attributionMap（按 navDate 归属，与 A 股同口径）
  // - QDII 9/1 NAV 涨跌归到 9/1（与 A 股完全对称，不按 publishDate 判 isPending）
  // - QDII 发布后正常计入收益，与 A 股完全对称
  // - 按持仓时长拆分 PnL（calcDailyPnlBySegments）：避免买入/卖出日过度计入新份额
  // 修复前：QDII 用「最新已发布对」覆盖所有历史日，导致 5/1-5/5 同一数字；
  //        且买入日 NAV 涨跌全归新份额（pnl 高估）
  // 历史格：只看 attr 是否存在，存在就用 curr/prev + 持仓算 PnL。
  // 不判定 publishDate；今天格取的是最新一对已发布 NAV（见下方"今天格"分支）。
  // 历史回看时数据已发布就一定能在 attributionMap 里查到；attr 不存在说明当天没有
  // NAV 变化（如节假日 / 当日无交易 / QDII NAV 复制填充被 usHolidays 过滤），returnAmount=0，
  // UI 显示为 0 涨跌——历史格无"未发布"概念，无需"净值更新中"提示。
  // 与 aa740c6 语义一致：历史格永远不 pending。
  for (const snap of sorted) {
    if (snap.date === todayStr) continue; // 今天格单独算，不走 attribution
    const dayAttrs = attributionMap.get(snap.date);
    const perFund = funds.map((fund) => {
      const attr = dayAttrs?.get(fund.id);
      // 无 attr：当天该基金没有 NAV 变化（节假日 / QDII 复制 NAV 被过滤）→ 0 涨跌。
      // navDate 留空，UI 不显示归属日标签（没变化谈不上归属哪天）。
      if (!attr) return { fundId: fund.id, fundName: fund.name, returnAmount: 0, navDate: '' };
      const timeline = sharesTimeline.get(fund.id);
      const sharesAfter = getSharesAsOf(timeline, snap.date);
      if (sharesAfter <= 0) {
        return { fundId: fund.id, fundName: fund.name, returnAmount: 0, navDate: '' };
      }
      // 按子时段拆分：shares_before = snap.date 之前的累计份额（不含当日交易）
      // 避免买入/卖出日过度计入新份额（参见 calcDailyPnlBySegments 注释）
      const sharesBefore = getSharesAsOf(timeline, attr.prev.date);
      return {
        fundId: fund.id,
        fundName: fund.name,
        returnAmount: calcDailyPnlBySegments(attr.prev.nav, attr.curr.nav, sharesBefore, sharesAfter),
        navDate: attr.curr.date,
      };
    });
    const totalReturn = perFund.reduce((sum, p) => sum + p.returnAmount, 0);
    // 历史格不 pending——"净值更新中"语义只用于今天格
    result.push({ date: snap.date, totalReturn, perFund });
  }

  // 今天格：旁路 attribution map，直接取每只基金"最新一对已发布 NAV"（同 Dashboard 口径）
  // 即便 today 不在 snapshots 列表也照常生成——避免"关闭自动刷新 → today 显示 ¥0"的退化
  // 但如果 today 是非交易日（周末 / 节假日），今天格不生成——与历史格一致
  //
  // 与历史格的区别：历史格回答"9/1 那天赚了多少"（navDate === date）；
  // 今天格回答"现在屏幕上这只基金最近一期净值赚了多少"（navDate 可能 < date）。
  // 两者都是"净值的真实归属日"口径，所以合计值天然可比、不需要凑发布节奏。
  if (funds.length > 0 && !isNonTradingDay(todayStr)) {
    const perFund = funds.map((fund) => {
      const daily = calcLatestNavPnl(fund, getNavHistory(fund.id), txsByFund.get(fund.id) ?? []);
      return {
        fundId: fund.id,
        fundName: fund.name,
        returnAmount: daily.pnl ?? 0,
        navDate: daily.currDate,
        // pnl=null → 该基金可用 NAV 不足 2 期，UI 渲染时与"持平=0"区分
        noNav: daily.pnl === null,
      };
    });
    const totalReturn = perFund.reduce((sum, p) => sum + p.returnAmount, 0);

    // 只看"有持仓"的基金：所有持有基金都没有可用 NAV 对才标 pending
    // 排除空持仓（已清仓）基金——它们的净值缺失不应阻塞持仓基金的显示
    const heldFundIds = new Set(
      funds
        .filter((f) => {
          const timeline = sharesTimeline.get(f.id);
          return !!timeline && timeline.length > 0 && timeline[timeline.length - 1]!.cumShares > 0;
        })
        .map((f) => f.id)
    );
    const isPending =
      heldFundIds.size > 0 &&
      perFund.filter((p) => heldFundIds.has(p.fundId)).every((p) => p.noNav);

    result.push({ date: todayStr, totalReturn, perFund, isPending });
    result.sort((a, b) => a.date.localeCompare(b.date));
  }

  return result;
}

/**
 * 计算某日期的总持仓市值（基于交易 + 历史净值查询）
 * 替代 snapshot.totalValue：解决"没有期初快照时 startValue=0，把本金算成收益"的 bug
 * 调用方传入已 confirmed 过滤的数组，避免每次循环重新 filter
 */
function calcPortfolioValueAtDate(
  date: string,
  funds: Fund[],
  transactions: Transaction[]
): number {
  let total = 0;
  for (const fund of funds) {
    const txs = transactions.filter((t) => t.fundId === fund.id && t.date <= date);
    const shares = calcShares(txs);
    if (shares <= 0) continue;
    const nav = lookupNavForDate(fund.id, date);
    if (nav) total += shares * nav.nav;
  }
  return total;
}

/**
 * 计算区间内的资金加权持仓市值（用于月/年收益率分母）
 *
 * 算法：遍历 [start, end] 内每天（自然日，含周末/节假日），
 * 每只基金 = shares × lookupNavForDate（无当日 NAV 时回退到最近已发布 NAV），
 * 累加每日总市值，最后除以天数 = 时间加权平均持仓市值。
 *
 * 修复前：月/年 returnRate 用月初持仓市值做分母，但 totalReturn 是日格之和，
 * 包含月中新买入份额的涨跌 → 分母偏小，returnRate 偏高。
 * 例：6/15 买入 10000 元（NAV=1.0），当月 NAV 涨 2%：
 *   - 旧：totalReturn=¥200, startValue=月初市值(假设 50000) → returnRate=0.40%
 *   - 新：日均持仓市值≈55000（含新购 10000 元×15/30 权重）→ returnRate=0.36%
 *
 * sharesTimeline 复用 generateDailyReturns 预建的时间线，避免内层 filter+sort 全表。
 */
function calcWeightedPortfolioValueInRange(
  startDate: string,
  endDate: string,
  funds: Fund[],
  sharesTimeline: Map<string, Array<{ date: string; cumShares: number }>>
): number {
  const days = dayjs(endDate).diff(dayjs(startDate), 'day') + 1;
  if (days <= 0) return 0;

  let sumDailyValue = 0;
  let countedDays = 0;
  let cursor = dayjs(startDate);
  for (let i = 0; i < days; i++) {
    const dateStr = cursor.format('YYYY-MM-DD');
    let dailyValue = 0;
    for (const fund of funds) {
      const timeline = sharesTimeline.get(fund.id);
      const shares = getSharesAsOf(timeline, dateStr);
      if (shares <= 0) continue;
      const nav = lookupNavForDate(fund.id, dateStr);
      if (nav) dailyValue += shares * nav.nav;
    }
    sumDailyValue += dailyValue;
    countedDays++;
    cursor = cursor.add(1, 'day');
  }
  return countedDays > 0 ? sumDailyValue / countedDays : 0;
}

function calcFundPerformanceInRange(
  fund: Fund,
  transactions: Transaction[],
  startDate: string,
  endDate: string
): FundPerformance {
  // 只看已确认交易——pending 买入尚未成交，不计入持仓份额也不计入本期投入
  const confirmed = onlyConfirmed(transactions);
  const txBeforeStart = confirmed.filter((t) => t.fundId === fund.id && t.date < startDate);
  const txBeforeEnd = confirmed.filter((t) => t.fundId === fund.id && t.date <= endDate);

  const sharesStart = calcShares(txBeforeStart);
  const sharesEnd = calcShares(txBeforeEnd);

  const navStart = lookupNavForDate(fund.id, startDate);
  const navEnd = lookupNavForDate(fund.id, endDate);

  // 拿不到期初或期末净值，无法计算区间收益
  if (!navStart || !navEnd) {
    return { fundId: fund.id, fundName: fund.name, returnAmount: 0, returnRate: 0 };
  }

  const valueStart = sharesStart * navStart.nav;
  const valueEnd = sharesEnd * navEnd.nav;

  // fee 内扣：用户的总付出/总收入就是 tx.amount（不再额外加/减 fee，否则重复计算）
  const buyInRange = confirmed
    .filter((t) => t.fundId === fund.id && t.type === 'buy' && t.date >= startDate && t.date <= endDate)
    .reduce((sum, t) => sum + t.amount, 0);
  const sellInRange = confirmed
    .filter((t) => t.fundId === fund.id && t.type === 'sell' && t.date >= startDate && t.date <= endDate)
    .reduce((sum, t) => sum + (t.amount - t.fee), 0);

  const returnAmount = valueEnd - valueStart - buyInRange + sellInRange;
  const returnRate = valueStart > 0 ? (returnAmount / valueStart) * 100 : 0;
  return { fundId: fund.id, fundName: fund.name, returnAmount, returnRate };
}

export function generateWeeklyReport(
  date: Date,
  funds: Fund[],
  transactions: Transaction[],
  dcaPlans: DcaPlan[],
  _snapshots: DailySnapshot[]
): WeeklyReport {
  const [weekStart, weekEnd] = getWeekRange(date);

  // 用"期初持仓×期初净值"和"期末持仓×期末净值"算总市值——比 snapshot 更可靠：
  //   1) 没有期初快照时 startValue 不会是 0（不再把本金算成收益）
  //   2) 净值用真实历史数据，能正确反映期内涨跌
  const startValue = calcPortfolioValueAtDate(weekStart, funds, transactions);
  const endValue = calcPortfolioValueAtDate(weekEnd, funds, transactions);

  // 区间内交易只看已确认的——pending 买入尚未成交，不计入本期投入/笔数
  const weekTxs = onlyConfirmed(transactions).filter((t) => t.date >= weekStart && t.date <= weekEnd);
  const buyCount = weekTxs.filter((t) => t.type === 'buy').length;
  const sellCount = weekTxs.filter((t) => t.type === 'sell').length;
  const dividendCount = weekTxs.filter((t) => t.type === 'dividend').length;

  const buyTotal = weekTxs
    .filter((t) => t.type === 'buy')
    .reduce((sum, t) => sum + t.amount, 0);
  const sellTotal = weekTxs
    .filter((t) => t.type === 'sell')
    .reduce((sum, t) => sum + (t.amount - t.fee), 0);

  const totalReturn = endValue - startValue - buyTotal + sellTotal;
  const returnRate = startValue > 0 ? (totalReturn / startValue) * 100 : 0;

  const fundRankings = funds
    .map((f) => calcFundPerformanceInRange(f, transactions, weekStart, weekEnd))
    .sort((a, b) => b.returnRate - a.returnRate);

  // DCA: count expected vs actual for active plans
  let dcaExpected = 0;
  let dcaActual = 0;
  const dcaDetails: DcaPlanExecution[] = [];
  for (const plan of dcaPlans.filter((p) => p.active)) {
    const fund = funds.find((f) => f.id === plan.fundId);
    const fundName = fund?.name ?? plan.fundId;

    // 计划还没到 startDate，整周都不算执行周（不管什么频率）
    const planStart = new Date(plan.startDate);
    const weekEndDate = new Date(weekEnd);
    if (planStart.getTime() > weekEndDate.getTime()) {
      dcaDetails.push({
        planId: plan.id,
        fundId: plan.fundId,
        fundName,
        frequency: plan.frequency,
        isDueWeek: false,
        actual: 0,
        expected: 0,
      });
      continue;
    }

    let isDueWeek = true;
    let expected = 0;
    if (plan.frequency === 'weekly') {
      expected = 1;
    } else if (plan.frequency === 'biweekly') {
      // Check if this week falls on a DCA week based on start date
      const weekMonday = new Date(weekStart);
      const diffDays = Math.round((weekMonday.getTime() - planStart.getTime()) / (1000 * 60 * 60 * 24));
      const diffWeeks = Math.floor(diffDays / 7);
      isDueWeek = diffWeeks >= 0 && diffWeeks % 2 === 0;
      expected = isDueWeek ? 1 : 0;
    } else if (plan.frequency === 'monthly') {
      const planDay = plan.dayOfMonth ?? 1;
      const weekDays = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        return d.getDate();
      });
      isDueWeek = weekDays.includes(planDay);
      expected = isDueWeek ? 1 : 0;
    } else if (plan.frequency === 'daily') {
      // Count actual trading days in this week from the fund's NAV history
      expected = countTradingDays(plan.fundId, weekStart, weekEnd);
    }
    // 实际笔数：金额匹配 + 日期落在计划执行窗口内的 buy 交易（**仅 confirmed**）
    // 口径与周报 totalReturn / fundRankings 一致——都基于 onlyConfirmed 交易。
    // 修复前：planBuyTxs 含 pending，导致 dcaActual 与 totalReturn 在 buy 总金额上不一致
    // （例如 9/3 自动生成 pending 买入：dcaActual=1 但 totalReturn 还看不到这笔投入）。
    // 手动买入也会被命中（同样满足"金额±¥1 + 窗口内"），这是预期行为：
    // 手动操作本身就是在执行计划，无需区分自动/手动来源。
    const planBuyTxs = onlyConfirmed(transactions).filter(
      (t) =>
        t.fundId === plan.fundId &&
        t.type === 'buy' &&
        t.date >= weekStart &&
        t.date <= weekEnd &&
        Math.abs(t.amount - plan.amount) < 1 &&
        isInPlanWindow(plan, t.date)
    );
    const actual = planBuyTxs.length;

    dcaExpected += expected;
    dcaActual += actual;
    dcaDetails.push({
      planId: plan.id,
      fundId: plan.fundId,
      fundName,
      frequency: plan.frequency,
      isDueWeek,
      actual,
      expected,
    });
  }

  return {
    weekStart,
    weekEnd,
    totalReturn,
    returnRate,
    buyCount,
    sellCount,
    dividendCount,
    fundRankings,
    dcaExpected,
    dcaActual,
    dcaDetails,
  };
}

export function generateMonthlyReport(
  year: number,
  month: number,
  funds: Fund[],
  transactions: Transaction[],
  snapshots: DailySnapshot[],
  platforms: Platform[]
): MonthlyReport {
  const [monthStart, monthEnd] = getMonthRange(year, month);
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;

  const monthSnapshots = snapshots
    .filter((s) => s.date >= monthStart && s.date <= monthEnd)
    .sort((a, b) => a.date.localeCompare(b.date));

  // 用"期初持仓×期初净值"和"期末持仓×期末净值"算总市值
  const startValue = calcPortfolioValueAtDate(monthStart, funds, transactions);
  const endValue = calcPortfolioValueAtDate(monthEnd, funds, transactions);

  // 区间内交易只看已确认的——pending 买入尚未成交，不计入本期投入
  const monthTxs = onlyConfirmed(transactions).filter((t) => t.date >= monthStart && t.date <= monthEnd);
  const buyTotal = monthTxs
    .filter((t) => t.type === 'buy')
    .reduce((sum, t) => sum + t.amount, 0);
  const sellTotal = monthTxs
    .filter((t) => t.type === 'sell')
    .reduce((sum, t) => sum + (t.amount - t.fee), 0);

  const totalReturn = endValue - startValue - buyTotal + sellTotal;
  const returnRate = startValue > 0 ? (totalReturn / startValue) * 100 : 0;

  // 每只基金算一次，Map 缓存供下面三处复用
  const perfByFund = new Map<string, FundPerformance>();
  for (const f of funds) {
    perfByFund.set(f.id, calcFundPerformanceInRange(f, transactions, monthStart, monthEnd));
  }

  // Per-platform contribution
  const platformContributions = platforms.map((p) => {
    const platformFunds = funds.filter((f) => f.platformId === p.id);
    const returnAmount = platformFunds.reduce(
      (sum, f) => sum + (perfByFund.get(f.id)?.returnAmount ?? 0),
      0
    );
    return { name: p.name, returnAmount };
  });

  // Per-type contribution
  const types: Fund['type'][] = ['index', 'bond', 'qdii', 'mixed'];
  const typeContributions = types.map((type) => {
    const typeFunds = funds.filter((f) => f.type === type);
    const returnAmount = typeFunds.reduce(
      (sum, f) => sum + (perfByFund.get(f.id)?.returnAmount ?? 0),
      0
    );
    return { type: FUND_TYPE_LABELS[type], returnAmount };
  });

  // Fund rankings
  const fundRankings = Array.from(perfByFund.values()).sort((a, b) => b.returnRate - a.returnRate);

  const bestFund = fundRankings[0] ?? null;
  const worstFund = fundRankings[fundRankings.length - 1] ?? null;

  return {
    month: monthStr,
    totalReturn,
    returnRate,
    snapshots: monthSnapshots,
    platformContributions,
    typeContributions,
    bestFund,
    worstFund,
    fundRankings,
  };
}

/**
 * 生成指定年份 12 个月的月度收益列表（升序）
 *
 * 算法：直接对 generateDailyReturns 的结果按月分组聚合 totalReturn + perFund.returnAmount，
 * 保证「月格 = 当月所有日格之和」「年格 = 当年所有月格之和」三者口径完全一致，
 * 解决之前"日 vs 月/年算法分叉"导致的查表对账差异（QDII 跨月归属尤其明显）。
 *
 * - returnRate 用"资金加权持仓市值"做分母（calcWeightedPortfolioValueInRange），
 *   解决"月中买入的份额已贡献收益，但分母未包含买入资金"导致的 returnRate 偏高
 * - perFund 始终包含所有基金（无贡献则为 0），与原行为对齐
 * - 12 个月即使没数据也输出 0 格，保证日历视图完整
 */
export function generateMonthlyReturns(
  funds: Fund[],
  transactions: Transaction[],
  dailyReturns: DailyReturn[],
  year: number
): MonthlyReturn[] {
  // 初始化 12 个月（无论有没有数据都填 0 格，保证视图完整）
  const result: MonthlyReturn[] = [];
  for (let month = 1; month <= 12; month++) {
    result.push({
      month: `${year}-${String(month).padStart(2, '0')}`,
      totalReturn: 0,
      returnRate: 0,
      perFund: [],
    });
  }

  // 一次性：把 dailyReturns 按月聚合。预建 perFund Map<fundId, sumAmount> 减少嵌套循环
  const perFundSums = new Map<string, Map<string, number>>();
  for (const daily of dailyReturns) {
    const monthStr = daily.date.slice(0, 7);
    if (monthStr.slice(0, 4) !== String(year)) continue;
    const monthResult = result.find((r) => r.month === monthStr);
    if (!monthResult) continue;
    monthResult.totalReturn += daily.totalReturn;
    let fundMap = perFundSums.get(monthStr);
    if (!fundMap) {
      fundMap = new Map();
      perFundSums.set(monthStr, fundMap);
    }
    for (const pf of daily.perFund) {
      fundMap.set(pf.fundId, (fundMap.get(pf.fundId) ?? 0) + pf.returnAmount);
    }
  }

  // 每只基金都出现（无贡献则 0），returnRate 用资金加权持仓市值做分母
  const confirmed = onlyConfirmed(transactions);
  const sharesTimeline = buildSharesTimeline(funds, confirmed);
  for (const monthResult of result) {
    const fundMap = perFundSums.get(monthResult.month);
    for (const fund of funds) {
      monthResult.perFund.push({
        fundId: fund.id,
        fundName: fund.name,
        returnAmount: fundMap?.get(fund.id) ?? 0,
      });
    }
    const [monthStart, monthEnd] = getMonthRange(year, parseInt(monthResult.month.slice(5, 7), 10));
    const weightedValue = calcWeightedPortfolioValueInRange(monthStart, monthEnd, funds, sharesTimeline);
    monthResult.returnRate = weightedValue > 0 ? (monthResult.totalReturn / weightedValue) * 100 : 0;
  }

  return result;
}

/**
 * 生成从首笔交易年到今年的年度收益列表（升序）
 *
 * 算法同 generateMonthlyReturns：直接对 dailyReturns 按年分组聚合，
 * 保证年格 = 当年所有月格之和 = 当年所有日格之和。
 * 无交易时返回仅含今年一格（与原行为一致）。
 *
 * returnRate 用"资金加权持仓市值"做分母（同 generateMonthlyReturns），
 * 解决年中新买入的份额贡献收益但年初市值未包含买入资金导致的 returnRate 偏高。
 */
export function generateYearlyReturns(
  funds: Fund[],
  transactions: Transaction[],
  dailyReturns: DailyReturn[]
): YearlyReturn[] {
  const currentYear = new Date().getFullYear();
  const confirmed = onlyConfirmed(transactions);
  const startYear = confirmed.length > 0
    ? Math.min(...confirmed.map((t) => parseInt(t.date.slice(0, 4), 10)))
    : currentYear;

  const result: YearlyReturn[] = [];
  for (let year = startYear; year <= currentYear; year++) {
    result.push({
      year: String(year),
      totalReturn: 0,
      returnRate: 0,
      perFund: [],
    });
  }

  const perFundSums = new Map<string, Map<string, number>>();
  for (const daily of dailyReturns) {
    const yearStr = daily.date.slice(0, 4);
    const yearResult = result.find((r) => r.year === yearStr);
    if (!yearResult) continue;
    yearResult.totalReturn += daily.totalReturn;
    let fundMap = perFundSums.get(yearStr);
    if (!fundMap) {
      fundMap = new Map();
      perFundSums.set(yearStr, fundMap);
    }
    for (const pf of daily.perFund) {
      fundMap.set(pf.fundId, (fundMap.get(pf.fundId) ?? 0) + pf.returnAmount);
    }
  }

  // 预建一次 sharesTimeline，所有年份共用，避免每年重复 filter+sort
  const sharesTimeline = buildSharesTimeline(funds, confirmed);
  for (const yearResult of result) {
    const fundMap = perFundSums.get(yearResult.year);
    for (const fund of funds) {
      yearResult.perFund.push({
        fundId: fund.id,
        fundName: fund.name,
        returnAmount: fundMap?.get(fund.id) ?? 0,
      });
    }
    const yearStart = `${yearResult.year}-01-01`;
    const yearEnd = `${yearResult.year}-12-31`;
    const weightedValue = calcWeightedPortfolioValueInRange(yearStart, yearEnd, funds, sharesTimeline);
    yearResult.returnRate = weightedValue > 0 ? (yearResult.totalReturn / weightedValue) * 100 : 0;
  }

  return result;
}
