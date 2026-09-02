import type { Fund, Transaction, DcaPlan, DailySnapshot, Platform, NavRecord } from '../types';
import { calcShares, calcDailyPnl, onlyConfirmed, isInPlanWindow } from './calculator';
import { FUND_TYPE_LABELS } from '../types';
import { countTradingDays, lookupNavForDate } from './navLookup';
import { getNavHistory } from './storage';
import { today } from './formatter';
import { getPublishDate } from './tradingDays';
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
  /** 各基金贡献的收益 */
  perFund: {
    fundId: string;
    fundName: string;
    returnAmount: number;
    /**
     * 仅对"今日"行的某只基金可能为 true：该基金今日 NAV 未发布（QDII T+2 / 节假日 /
     * 刷新失败），returnAmount 强制为 0。UI 渲染时区别于"持平=0"——显示"— 净值更新中"。
     * 历史日的 perFund 不会出现 isPending=true（归属已确定）。
     */
    isPending?: boolean;
  }[];
  /**
   * 任一基金的当日 NAV 未发布时为 true（A 股白天 / QDII T+2 延迟 / 节假日 / 刷新失败）。
   * 历史格也可能为 true（QDII 在发布前回看当天归属日）。
   * UI 用灰格 + "净值更新中" 提示；totalReturn 仅汇总已发布的基金，与 Dashboard
   * 顶部 "已更新 X/Y 只" 的口径一致。
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
 * 注意：「历史格归属日 = navDate」与 Dashboard 顶部「当日盈亏判定 = publishDate」
 * 是两个不同的概念：
 *   - 历史格：用户回看某天（9/1），QDII 用 9/1 真实 NAV − 8/29 NAV
 *   - 当日格：用户看今天（9/3），QDII 用最新已发布的 NAV 对（即 9/1 vs 8/29，标 T+2 延迟）
 *
 * QDII 历史格的"是否显示"由 generateDailyReturns 内层 publishDate(curr.date) ≤ snap.date
 * 判定（发布前显示 pending，发布后才计入）。
 *
 * 返回嵌套 Map<归属日, Map<fundId, Attribution>>，按 fundId O(1) 查找，
 * 替代之前的 Map<date, Attribution[]> + 内层 .find()（O(M) 每格）。
 */
function buildAttributionMap(funds: Fund[]): Map<string, Map<string, Attribution>> {
  const map = new Map<string, Map<string, Attribution>>();
  for (const fund of funds) {
    const hist = getNavHistory(fund.id);
    if (hist.length < 2) continue;
    const sorted = [...hist].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i++) {
      const curr = sorted[i]!;
      const prev = sorted[i - 1]!;
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
 *   归属——与 A 股同口径，QDII 9/1 NAV 涨跌归到 9/1 这一天）。"是否已发布"由
 *   publishDate(curr.date) ≤ snap.date 判定，未发布则该基金标 pending（避免"未发布
 *   数据提前泄露"）。
 * - **今天格**：**完全旁路 attribution map，直接调 calcDailyPnl per fund**。这确保
 *   Calendar 当日盈亏 ≡ Dashboard 当日盈亏（共用同一份 publishDate(curr) === today
 *   判定），解决之前几个修复 commit 反复踩的"两边口径漂移"问题：
 *     1) 跨午夜数据回溯——同一份数据 23:59 看是 ¥0、00:01 看是 QDII 涨幅（同源不同果）。
 *     2) HK QDII 当日 NAV 公布时 Dashboard 收、Calendar 不收。
 *     3) 今天不在 snapshots 时 today 格退化为 ¥0 而非"净值更新中"。
 *     4) 已清仓基金（shares=0）新鲜 NAV 不再错误地让 isPending=false。
 *
 * **isPending 判定**：只看有持仓（shares>0）的基金——全部的"今日 NAV 都未发布"才视为待刷新。
 * 排除空持仓基金（已清仓的基金 NAV 更新不应阻塞显示）。
 *
 * 注意：Day/Month/Year 三 Tab 现在**统一用 attribution 算法**——Month/Year Tab 直接聚合
 * 本函数的 dailyReturns 结果，保证「月格 = 当月日格之和」「年格 = 当年日格之和」，
 * 彻底消除之前"日 vs 月/年"算法分叉导致的查表对账差异（QDII 跨月归属尤其明显）。
 */
export function generateDailyReturns(
  funds: Fund[],
  transactions: Transaction[],
  snapshots: DailySnapshot[]
): DailyReturn[] {
  const confirmed = onlyConfirmed(transactions);
  const todayStr = today();
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));

  // 一次性构建：归属 map + 份额时间线（避免内层每次循环 filter+sort 全表）
  const attributionMap = buildAttributionMap(funds);
  const sharesTimeline = buildSharesTimeline(funds, confirmed);
  const result: DailyReturn[] = [];

  // 历史格：用 attribution + 份额时间线（O(M·log K) / 格，替代 O(M·(T + K log K))）
  for (const snap of sorted) {
    if (snap.date === todayStr) continue; // 今天格单独算，不走 attribution
    const dayAttrs = attributionMap.get(snap.date);
    const perFund = funds.map((fund) => {
      const attr = dayAttrs?.get(fund.id);
      if (attr) {
        // QDII 跨日判定：归属日 = navDate，但只有 publishDate(curr.date) ≤ snap.date 才"已发布"
        // 例：9/1 早上看 9/1，QDII 9/1 NAV 还没发布（要 9/3 发布）→ 标 pending
        //     9/3 晚上看 9/1，QDII 9/1 NAV 已发布 → 计入
        if (getPublishDate(fund, attr.curr.date) > snap.date) {
          return { fundId: fund.id, fundName: fund.name, returnAmount: 0, isPending: true };
        }
        // 历史日 shares 按 snap.date 截断（不能用未来的持仓算当日盈亏）
        const shares = getSharesAsOf(sharesTimeline.get(fund.id), snap.date);
        if (shares <= 0) return { fundId: fund.id, fundName: fund.name, returnAmount: 0 };
        return {
          fundId: fund.id,
          fundName: fund.name,
          returnAmount: shares * (attr.curr.nav - attr.prev.nav),
        };
      }
      // 没有 attribution：QDII 可能是"应该有但未发布"（NAV 数据里还没出现）
      // 例：9/1 那一格 QDII → lastNAV=8/31, lastNAV.date=8/31 ≤ snap.date=9/1,
      //     publishDate(QDII, 8/31)=9/2 > 9/1 → pending
      if (fund.type === 'qdii') {
        const hist = getNavHistory(fund.id);
        if (hist.length > 0) {
          const sorted = [...hist].sort((a, b) => b.date.localeCompare(a.date));
          const lastNAV = sorted[0]!;
          if (lastNAV.date <= snap.date && getPublishDate(fund, lastNAV.date) > snap.date) {
            return { fundId: fund.id, fundName: fund.name, returnAmount: 0, isPending: true };
          }
        }
      }
      return { fundId: fund.id, fundName: fund.name, returnAmount: 0 };
    });
    const totalReturn = perFund.reduce((sum, p) => sum + p.returnAmount, 0);
    // 仅当所有基金都 pending 时这一格才标 pending（整格显示"净值更新中"）。
    // 部分基金 pending 时整格按 totalReturn 着色，明细面板里 pending 基金单独标。
    // 例：8/31 A 股有数据 + QDII pending → 整格按 A 股涨跌着色，QDII 在明细里"净值更新中"
    const isPending = perFund.length > 0 && perFund.every((p) => p.isPending);
    result.push({ date: snap.date, totalReturn, perFund, isPending });
  }

  // 今天格：旁路 attribution map，直接用 calcDailyPnl per fund（同 Dashboard 口径）
  // 即便 today 不在 snapshots 列表也照常生成——避免"关闭自动刷新 → today 显示 ¥0"的退化
  if (funds.length > 0) {
    const perFund = funds.map((fund) => {
      // 与 calcFundSummary 一致：不限 date（包含未来日期 confirmed 的"预期持仓"），
      // 让两边口径完全相同；这是 Dashboard 已有的 quirk，Calendar 同步跟随
      const timeline = sharesTimeline.get(fund.id);
      const shares = timeline && timeline.length > 0 ? timeline[timeline.length - 1]!.cumShares : 0;
      const daily = calcDailyPnl(shares, getNavHistory(fund.id), fund, todayStr);
      return {
        fundId: fund.id,
        fundName: fund.name,
        returnAmount: daily.pnl ?? 0,
        // pnl=null → 该基金今日 NAV 未发布，UI 渲染时与"持平=0"区分
        isPending: daily.pnl === null,
      };
    });
    const totalReturn = perFund.reduce((sum, p) => sum + p.returnAmount, 0);

    // 只看"有持仓"的基金：所有持有基金的"发布日"都还没到 today 才标 pending
    // 排除空持仓（已清仓）基金——它们的 NAV 更新不应阻塞持仓基金的当日显示
    // 判定必须与 calcDailyPnl 对齐：publishDate(hist.last.date) === todayStr
    // 例：QDII 9/3 晚上，hist.last=9/1 NAV，publishDate(9/1)=9/3 === todayStr → 已发布
    const heldFunds = funds.filter((f) => {
      const timeline = sharesTimeline.get(f.id);
      return timeline && timeline.length > 0 && timeline[timeline.length - 1]!.cumShares > 0;
    });
    const isPending =
      heldFunds.length > 0 &&
      heldFunds.every((f) => {
        const hist = getNavHistory(f.id);
        if (hist.length === 0) return true;
        return getPublishDate(f, hist[hist.length - 1]!.date) !== todayStr;
      });

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
    // 实际笔数：金额匹配 + 日期落在计划执行窗口内的 buy 交易（含 pending——定投自动生成的
    // 待确认记录应立刻计入"定投执行"，否则周报/月报要等 T+1（QDII 还要 T+2）净值确认
    // 后才显示数字，与累计投入口径不一致）。
    // 手动买入也会被命中（同样满足"金额±¥1 + 窗口内"），但这是预期行为：
    // 手动操作本身就是在执行计划，无需区分自动/手动来源。
    const planBuyTxs = transactions.filter(
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
 * - returnRate 仍用月初持仓市值做分母（保留原有百分比语义，便于和 Dashboard 收益率口径对照）
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

  // 每只基金都出现（无贡献则 0），returnRate 用月初持仓市值做分母
  const confirmed = onlyConfirmed(transactions);
  for (const monthResult of result) {
    const fundMap = perFundSums.get(monthResult.month);
    for (const fund of funds) {
      monthResult.perFund.push({
        fundId: fund.id,
        fundName: fund.name,
        returnAmount: fundMap?.get(fund.id) ?? 0,
      });
    }
    const monthStart = `${monthResult.month}-01`;
    const startValue = calcPortfolioValueAtDate(monthStart, funds, confirmed);
    monthResult.returnRate = startValue > 0 ? (monthResult.totalReturn / startValue) * 100 : 0;
  }

  return result;
}

/**
 * 生成从首笔交易年到今年的年度收益列表（升序）
 *
 * 算法同 generateMonthlyReturns：直接对 dailyReturns 按年分组聚合，
 * 保证年格 = 当年所有月格之和 = 当年所有日格之和。
 * 无交易时返回仅含今年一格（与原行为一致）。
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
    const startValue = calcPortfolioValueAtDate(yearStart, funds, confirmed);
    yearResult.returnRate = startValue > 0 ? (yearResult.totalReturn / startValue) * 100 : 0;
  }

  return result;
}
