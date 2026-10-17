import type { Fund, Transaction, DcaPlan, DailySnapshot, Platform, NavRecord } from '../types';
import { calcShares, onlyConfirmed, isInPlanWindow } from './calculator';
import { FUND_TYPE_LABELS } from '../types';
import { countTradingDays, lookupNavForDate } from './navLookup';
import { getNavHistory } from './storage';
import { today } from './formatter';
import { usableNavSeries, type UsQdiiFilterMode, DEFAULT_US_QDII_FILTER_MODE } from './navPair';
import { isNonTradingDay } from './chineseHolidays';
import dayjs from 'dayjs';

/**
 * Test seam：单测里通过 `__setNavHistoryForTest(() => records)` 注入 NAV 历史，
 * 避免 vitest node 环境里 localStorage stub 的麻烦。
 * 设为 `null` 恢复走真实 `getNavHistory`。
 *
 * 设计动机：vitest 跑在 node 环境（见 vite.config.ts），`localStorage` 不存在；
 * `getNavHistory` 直接读 localStorage，会抛 ReferenceError。让测试走真实路径
 * 需要 jsdom + 全套存储 stub，反而更脆——纯函数的 wealth-change 算法不依赖
 * 任何存储副作用。
 */
let _navHistoryOverride: ((fundCode: string) => NavRecord[]) | null = null;
export function __setNavHistoryForTest(fn: ((code: string) => NavRecord[]) | null) {
  _navHistoryOverride = fn;
}

/** 内部用：测试 seam 优先，否则走真实 storage。供 reportGenerator 内函数复用 */
function getNavHistoryOverrideable(fundCode: string): NavRecord[] {
  return _navHistoryOverride ? _navHistoryOverride(fundCode) : getNavHistory(fundCode);
}

/**
 * 单只基金的每日收益序列（wealth-change 算法）。
 *
 * 算法核心：
 *   cumulativeReturn(D) = shares(D) × NAV(D)
 *                       − Σ buy.amount(D)
 *                       + Σ (sell.amount − sell.fee)(D)
 *                       + Σ cashDividend.amount(D)
 *
 *   dailyReturn(D) = cumulativeReturn(D) − cumulativeReturn(prevMeaningfulDate)
 *
 * 与"前一个有意义日"的差值是该日收益；非有意义日 / 非交易日 prevCum 不前进。
 *
 * **关键不变量**：
 *   - 月格 = 当月日格之和；年格 = 当年日格之和。portfolio 月/年格 = 各基金月/年格之和。
 *     三种粒度构造上严格相等，无需额外"凑对账"逻辑。
 *   - 单基金日历（FundDetail）和组合日历（Dashboard）走同一函数同一个 cumReturn 时间线，
 *     单基金日格 = 组合日格里这只基金的子集。
 *
 * **现金分红 vs 红利再投资**：两种语义在数据模型上不互斥，按字段独立累加：
 *   - `tx.amount > 0` → 现金分红：`totalCashDiv += tx.amount`
 *   - `tx.shares > 0` → 红利再投资：`shares += tx.shares`
 *
 * **今日格**：与历史格同一形状，`navDate` 取的是这只基金最新已发布 NAV 的归属日
 * （QDII 常落后 1 个交易日）；持仓基金无任何可用 NAV 时标 `noNav: true`。
 *
 * **非交易日**：历史日跳过周末 / 法定节假日（由 `isNonTradingDay` 判定），
 * 今天格若今天是交易日则强制包含；若今天是非交易日，则按历史日规则跳过（与
 * `generateDailyReturns` 历史格一致）。
 */
export function generateFundDailyReturns(
  fund: Fund,
  transactions: Transaction[],
  todayStr: string = today(),
  mode: UsQdiiFilterMode = DEFAULT_US_QDII_FILTER_MODE,
): DailyReturn[] {
  // 1. 只看已确认 + 当前基金；按日期升序
  const confirmed = onlyConfirmed(transactions.filter((t) => t.fundId === fund.id));
  const usable = usableNavSeries(fund, getNavHistoryOverrideable(fund.id), mode);
  if (usable.length === 0 && confirmed.length === 0) return [];

  // 2. 有意义日 = NAV 发布日 ∪ 交易确认日
  const meaningful = new Set<string>();
  for (const n of usable) meaningful.add(n.date);
  for (const tx of confirmed) meaningful.add(tx.date);

  // 3. 按日 NAV 查找表（升序的 usable 已是升序）
  const usableByDate = new Map(usable.map((n) => [n.date, n] as const));

  // 4. 遍历升序有意义日，累积 shares / totalBuy / totalSellNet / totalCashDiv，
  //    在每个有 NAV 的日期记下 cumReturn
  const sortedMeaningful = Array.from(meaningful).sort();
  const cumByDate = new Map<string, number>();
  let totalBuy = 0;
  let totalSellNet = 0;
  let totalCashDiv = 0;
  let shares = 0;
  const sortedTxs = [...confirmed].sort((a, b) => a.date.localeCompare(b.date));
  let txIdx = 0;

  for (const date of sortedMeaningful) {
    // 把 date 之前（含）的所有交易应用进状态
    while (txIdx < sortedTxs.length && sortedTxs[txIdx]!.date <= date) {
      const tx = sortedTxs[txIdx]!;
      if (tx.type === 'buy') {
        shares += tx.shares;
        totalBuy += tx.amount;
      } else if (tx.type === 'sell') {
        shares -= tx.shares;
        totalSellNet += tx.amount - tx.fee;
      } else if (tx.type === 'dividend') {
        // 现金分红与红利再投资独立：amount > 0 视为现金；shares > 0 视为再投
        if (tx.amount > 0) totalCashDiv += tx.amount;
        if (tx.shares > 0) shares += tx.shares;
      }
      txIdx++;
    }
    const navRecord = usableByDate.get(date);
    if (navRecord) {
      cumByDate.set(
        date,
        shares * navRecord.nav - totalBuy + totalSellNet + totalCashDiv,
      );
    }
  }

  // 5. 走 [firstDate, todayStr] 的自然日序列，发射 DailyReturn
  const firstDate = sortedMeaningful[0]!;
  const out: DailyReturn[] = [];
  let prevCum = 0;

  for (
    let cursor = dayjs(firstDate);
    cursor.format('YYYY-MM-DD') <= todayStr;
    cursor = cursor.add(1, 'day')
  ) {
    const date = cursor.format('YYYY-MM-DD');
    const isToday = date === todayStr;

    // 历史日：跳过周末 / 法定节假日；今天格若今天是非交易日也跳过
    // （与 generateDailyReturns 历史格口径一致）
    if (!isToday && isNonTradingDay(date)) continue;
    if (isToday && isNonTradingDay(todayStr)) continue;

    const cumToday = cumByDate.get(date) ?? prevCum;
    const dailyReturn = cumToday - prevCum;

    // navDate：cumByDate 命中说明今天/这一天有 NAV 落地，navDate = 这天；
    // 否则（仅在 today 格可能命中）取最新已发布 NAV 的归属日。
    let navDate = '';
    if (cumByDate.has(date)) {
      navDate = date;
    } else if (isToday) {
      const last = usable.length > 0 ? usable[usable.length - 1]! : null;
      navDate = last?.date ?? '';
    }

    const last = usable.length > 0 ? usable[usable.length - 1]! : null;
    const hasUsableNav = !!last;
    const hasPosition = shares > 0;

    out.push({
      date,
      totalReturn: dailyReturn,
      perFund: [
        {
          fundId: fund.id,
          fundName: fund.name,
          returnAmount: dailyReturn,
          navDate,
          noNav: isToday && hasPosition && !hasUsableNav,
        },
      ],
    });
    prevCum = cumToday;
  }

  // 6. 今天格 isPending 传播：与 generateDailyReturns 旧 today 格一致
  const todayEntry = out[out.length - 1];
  if (todayEntry && todayEntry.date === todayStr) {
    const pf = todayEntry.perFund[0]!;
    todayEntry.isPending = pf.noNav === true;
  }
  return out;
}

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
 * **Task 2 重构**：body 改为组合各基金的 `generateFundDailyReturns` 输出。
 * 算法口径完全由单基金函数接管——portfolio 日历天然 = 各基金日历之和，
 * 月/年格（generateMonthlyReturns / generateYearlyReturns）也是日格之和，
 * 三种粒度构造上严格相等，不再有"日 vs 月/年算法分叉"。
 *
 * **isPending 判定**：只看有持仓（shares>0）的基金——所有这些基金的 perFund.noNav 都为
 * true 才视为待更新；空持仓（已清仓）基金的 NAV 缺失不阻塞持仓基金显示。
 */
export function generateDailyReturns(
  funds: Fund[],
  transactions: Transaction[],
  mode: UsQdiiFilterMode = DEFAULT_US_QDII_FILTER_MODE
): DailyReturn[] {
  const todayStr = today();
  const confirmed = onlyConfirmed(transactions);

  // Per-fund series → 按日期合并
  const mergedByDate = new Map<string, DailyReturn>();
  for (const fund of funds) {
    const series = generateFundDailyReturns(fund, transactions, todayStr, mode);
    for (const dr of series) {
      let entry = mergedByDate.get(dr.date);
      if (!entry) {
        entry = { date: dr.date, totalReturn: 0, perFund: [], isPending: false };
        mergedByDate.set(dr.date, entry);
      }
      entry.totalReturn += dr.totalReturn;
      // 每个基金最多贡献一个 perFund entry（assert）
      entry.perFund.push(dr.perFund[0]!);
    }
  }

  const result = Array.from(mergedByDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  // isPending 传播：所有持仓基金的 perFund 都标 noNav 才标 pending
  const todayEntry = result.find((r) => r.date === todayStr);
  if (todayEntry) {
    const heldFundIds = new Set(
      funds
        .filter((f) => {
          const fundTxs = confirmed.filter((t) => t.fundId === f.id);
          return fundTxs.length > 0 && calcShares(fundTxs) > 0;
        })
        .map((f) => f.id),
    );
    todayEntry.isPending =
      heldFundIds.size > 0 &&
      todayEntry.perFund
        .filter((p) => heldFundIds.has(p.fundId))
        .every((p) => p.noNav === true);
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

export function generateWeeklyReport(
  date: Date,
  funds: Fund[],
  transactions: Transaction[],
  dcaPlans: DcaPlan[],
  _snapshots: DailySnapshot[],
  mode: UsQdiiFilterMode = DEFAULT_US_QDII_FILTER_MODE
): WeeklyReport {
  const [weekStart, weekEnd] = getWeekRange(date);

  // **WC 算法**：聚合自 generateDailyReturns 的周内日格（portfolio + 每基金），
  // 保证 totalReturn = sum(weekDailies.totalReturn) = sum(weekDailies.perFund[*].returnAmount)
  //   即 cashDelta = shares×NAV_end - shares×NAV_start - buyCashOut + (sellCashIn + cashDiv) - fee
  // 与 portfolio 日历（generateMonthlyReturns 周聚合）口径完全一致——"日 vs 周/月/年算法分叉"消除。
  // 旧 `endValue - startValue - buy + sell` 公式漏现金分红且把卖出视为投资回报，导致与日历对不上。
  const allDailies = generateDailyReturns(funds, transactions, mode);
  const weekDailies = allDailies.filter((d) => d.date >= weekStart && d.date <= weekEnd);
  const totalReturn = weekDailies.reduce((sum, d) => sum + d.totalReturn, 0);

  // 区间内交易只看已确认的——pending 买入尚未成交，不计入本期投入/笔数
  const weekTxs = onlyConfirmed(transactions).filter((t) => t.date >= weekStart && t.date <= weekEnd);
  const buyCount = weekTxs.filter((t) => t.type === 'buy').length;
  const sellCount = weekTxs.filter((t) => t.type === 'sell').length;
  const dividendCount = weekTxs.filter((t) => t.type === 'dividend').length;

  // 周 returnRate：分母用"资金加权持仓市值"（同 generateMonthlyReturns 的口径），
  // 解决"周中买入的份额贡献收益但分母未含买入资金"导致的 returnRate 偏高
  const confirmed = onlyConfirmed(transactions);
  const sharesTimeline = buildSharesTimeline(funds, confirmed);
  const weightedValue = calcWeightedPortfolioValueInRange(weekStart, weekEnd, funds, sharesTimeline);
  const returnRate = weightedValue > 0 ? (totalReturn / weightedValue) * 100 : 0;

  // 每只基金：从 weekDailies.perFund 聚合 returnAmount，returnRate 用 startValue 做分母
  // （与 generateMonthlyReport 行为对齐，便于跨函数排序）
  const periodPerFundByFund = new Map<string, number>();
  for (const d of weekDailies) {
    for (const pf of d.perFund) {
      periodPerFundByFund.set(pf.fundId, (periodPerFundByFund.get(pf.fundId) ?? 0) + pf.returnAmount);
    }
  }
  const fundRankings = funds
    .map((f) => {
      const returnAmount = periodPerFundByFund.get(f.id) ?? 0;
      const startValue = calcPortfolioValueAtDate(weekStart, [f], transactions);
      return {
        fundId: f.id,
        fundName: f.name,
        returnAmount,
        returnRate: startValue > 0 ? (returnAmount / startValue) * 100 : 0,
      };
    })
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
  platforms: Platform[],
  mode: UsQdiiFilterMode = DEFAULT_US_QDII_FILTER_MODE
): MonthlyReport {
  const [monthStart, monthEnd] = getMonthRange(year, month);
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;

  const monthSnapshots = snapshots
    .filter((s) => s.date >= monthStart && s.date <= monthEnd)
    .sort((a, b) => a.date.localeCompare(b.date));

  // **WC 算法**：聚合自 generateDailyReturns 的月内日格（portfolio + 每基金），
  // 与 portfolio 日历（generateMonthlyReturns）口径完全一致——"日 vs 月报算法分叉"消除。
  // 旧 `endValue - startValue - buy + sell` 漏现金分红（Aug 6.66 仅 ¥200 而已、
  // Sep 漏 14.95 + 卖出视为投资回报导致符号反转到 -448.75）。
  const allDailies = generateDailyReturns(funds, transactions, mode);
  const monthDailies = allDailies.filter((d) => d.date >= monthStart && d.date <= monthEnd);
  const totalReturn = monthDailies.reduce((sum, d) => sum + d.totalReturn, 0);

  // 月 returnRate：分母用"资金加权持仓市值"（同 generateMonthlyReturns 口径）
  const confirmed = onlyConfirmed(transactions);
  const sharesTimeline = buildSharesTimeline(funds, confirmed);
  const weightedValue = calcWeightedPortfolioValueInRange(monthStart, monthEnd, funds, sharesTimeline);
  const returnRate = weightedValue > 0 ? (totalReturn / weightedValue) * 100 : 0;

  // 每只基金：从 monthDailies.perFund 聚合 returnAmount，returnRate 用 startValue 做分母
  const periodPerFundByFund = new Map<string, number>();
  for (const d of monthDailies) {
    for (const pf of d.perFund) {
      periodPerFundByFund.set(pf.fundId, (periodPerFundByFund.get(pf.fundId) ?? 0) + pf.returnAmount);
    }
  }

  const fundRankings = funds
    .map((f) => {
      const returnAmount = periodPerFundByFund.get(f.id) ?? 0;
      const startValue = calcPortfolioValueAtDate(monthStart, [f], transactions);
      return {
        fundId: f.id,
        fundName: f.name,
        returnAmount,
        returnRate: startValue > 0 ? (returnAmount / startValue) * 100 : 0,
      };
    })
    .sort((a, b) => b.returnRate - a.returnRate);

  // Per-platform contribution: 平台内所有基金的 returnAmount 之和（WC）
  const platformContributions = platforms.map((p) => {
    const platformFunds = funds.filter((f) => f.platformId === p.id);
    const returnAmount = platformFunds.reduce(
      (sum, f) => sum + (periodPerFundByFund.get(f.id) ?? 0),
      0
    );
    return { name: p.name, returnAmount };
  });

  // Per-type contribution
  const types: Fund['type'][] = ['index', 'bond', 'qdii', 'mixed'];
  const typeContributions = types.map((type) => {
    const typeFunds = funds.filter((f) => f.type === type);
    const returnAmount = typeFunds.reduce(
      (sum, f) => sum + (periodPerFundByFund.get(f.id) ?? 0),
      0
    );
    return { type: FUND_TYPE_LABELS[type], returnAmount };
  });

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
