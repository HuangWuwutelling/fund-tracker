import type { Fund, Transaction, DcaPlan, DailySnapshot, Platform } from '../types';
import { calcShares, onlyConfirmed, isInPlanWindow } from './calculator';
import { FUND_TYPE_LABELS } from '../types';
import { countTradingDays, lookupNavForDate } from './navLookup';
import { today } from './formatter';
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
  /** 当天总收益（已扣除期间投入的本金） */
  totalReturn: number;
  /** 各基金贡献的收益 */
  perFund: { fundId: string; fundName: string; returnAmount: number }[];
  /**
   * 今日 NAV 未完全发布（如 QDII T+2 / 节假日 / 尚未刷新）时为 true。
   * 此时 totalReturn=0、perFund 全为 0；UI 用灰格 + "净值更新中" 提示。
   * 与 Dashboard 顶部 / 持仓列表的当日盈亏口径保持严格一致。
   */
  isPending?: boolean;
}

/**
 * 判断"今日"是否所有持有基金的 NAV 都已发布。
 * 任一有正份额的基金，其 navDate !== today 即视为不完整（QDII T+2 / 节假日 / 尚未刷新）。
 * 历史日期（< today）走 fallback 是合理的，不需要 strict。
 */
function isTodayIncomplete(
  funds: Fund[],
  confirmed: Transaction[],
  todayStr: string
): boolean {
  for (const fund of funds) {
    const shares = calcShares(
      confirmed.filter((t) => t.fundId === fund.id && t.date <= todayStr)
    );
    if (shares <= 0) continue; // 未持仓，不需 NAV
    const nav = lookupNavForDate(fund.id, todayStr);
    if (!nav || nav.navDate !== todayStr) return true;
  }
  return false;
}

/**
 * 生成每日收益明细（按日期升序）
 * - 不依赖 snapshot：用 calcPortfolioValueAtDate 按日期算持仓市值，避免"snapshot 不含当天买入"的 bug
 * - 只有 prev 存在时才计算收益（第一个日期没有基线）
 * - perFund 用 "当天每只基金期末市值 − 期初市值 − 期内净投入" 推算
 * - 今日（最新 snapshot 日期 = today）若任一持有基金 NAV 未发布，标 isPending=true，
 *   totalReturn/perFund 全部置 0，与 Dashboard 当日盈亏口径一致
 */
export function generateDailyReturns(
  funds: Fund[],
  transactions: Transaction[],
  snapshots: DailySnapshot[]
): DailyReturn[] {
  // 只用 snapshot 的日期序列来驱动"哪天有数据"——不读 totalValue
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return [];

  // 一次性过滤 confirmed，避免每个循环迭代重复 filter
  const confirmed = onlyConfirmed(transactions);
  const todayStr = today();
  const latestDate = sorted[sorted.length - 1]!.date;
  // "今日"严格判定：必须是最新 snapshot 日期 + 等于 today 才走 strict 校验
  const todayIsLatest = latestDate === todayStr;
  const todayIncomplete = todayIsLatest && isTodayIncomplete(funds, confirmed, todayStr);

  const result: DailyReturn[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const currDate = sorted[i]!.date;
    const prevDate = i > 0 ? sorted[i - 1]!.date : null;
    const isToday = currDate === todayStr;
    const isPending = isToday && todayIncomplete;

    // 当天内所有 confirmed buy/sell 净额（用来排除本金影响）
    const netFlow = confirmed
      .filter((t) => t.date === currDate)
      .reduce((sum, t) => {
        if (t.type === 'buy') return sum + t.amount;
        if (t.type === 'sell') return sum - (t.amount - t.fee);
        return sum;
      }, 0);

    // 总收益：curr 当天末持仓市值（含今天的买入）− prev 当天末持仓市值 − 当天净投入
    // 没有"昨天"的第一个日期：无法计算收益（避免把首日买入金额当成负收益）
    // 今日 NAV 未完整发布：归零并标 pending（与 Dashboard 当日盈亏口径一致）
    const totalReturn =
      !prevDate || isPending
        ? 0
        : calcPortfolioValueAtDate(currDate, funds, confirmed) -
          calcPortfolioValueAtDate(prevDate, funds, confirmed) -
          netFlow;

    // 各基金收益：每只基金今日末市值 − 昨日末市值 − 当日净投入
    // 没有"昨天"或今日 pending 时：returnAmount 全部置 0
    // 不再过滤 0 收益/无交易基金——保持与 generateMonthlyReturns / generateYearlyReturns 的
    // perFund 拆分一致（验收清单：日/月/年三者合计自洽）
    const perFund = !prevDate || isPending
      ? funds.map((fund) => ({ fundId: fund.id, fundName: fund.name, returnAmount: 0 }))
      : funds.map((fund) => {
          const prevValue = calcPortfolioValueAtDate(prevDate!, [fund], confirmed);
          const currValue = calcPortfolioValueAtDate(currDate, [fund], confirmed);
          const fundFlow = confirmed
            .filter((t) => t.fundId === fund.id && t.date === currDate)
            .reduce((sum, t) => {
              if (t.type === 'buy') return sum + t.amount;
              if (t.type === 'sell') return sum - (t.amount - t.fee);
              return sum;
            }, 0);
          return {
            fundId: fund.id,
            fundName: fund.name,
            returnAmount: currValue - prevValue - fundFlow,
          };
        });

    result.push({ date: currDate, totalReturn, perFund, isPending });
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
 * - 不依赖 snapshot 全覆盖：用 calcPortfolioValueAtDate(monthStart) vs calcPortfolioValueAtDate(monthEnd)
 * - perFund 拆分复用 calcFundPerformanceInRange
 * - 空月：totalReturn=0, perFund=[]（保证 12 格完整）
 * - 只算 confirmed 交易
 */
export function generateMonthlyReturns(
  funds: Fund[],
  transactions: Transaction[],
  year: number,
  _platforms?: Platform[]  // 暂未使用，与 generateMonthlyReport 签名保持一致；后续可加平台/类型分布
): MonthlyReturn[] {
  const result: MonthlyReturn[] = [];
  for (let month = 1; month <= 12; month++) {
    const [monthStart, monthEnd] = getMonthRange(year, month);
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;

    const startValue = calcPortfolioValueAtDate(monthStart, funds, transactions);
    const endValue = calcPortfolioValueAtDate(monthEnd, funds, transactions);

    const confirmed = onlyConfirmed(transactions);
    const monthTxs = confirmed.filter((t) => t.date >= monthStart && t.date <= monthEnd);
    const buyTotal = monthTxs
      .filter((t) => t.type === 'buy')
      .reduce((sum, t) => sum + t.amount, 0);
    const sellTotal = monthTxs
      .filter((t) => t.type === 'sell')
      .reduce((sum, t) => sum + (t.amount - t.fee), 0);

    const totalReturn = endValue - startValue - buyTotal + sellTotal;
    const returnRate = startValue > 0 ? (totalReturn / startValue) * 100 : 0;

    const perFund: MonthlyReturn['perFund'] = funds.map((f) => {
      const perf = calcFundPerformanceInRange(f, transactions, monthStart, monthEnd);
      return { fundId: perf.fundId, fundName: perf.fundName, returnAmount: perf.returnAmount };
    });

    result.push({ month: monthStr, totalReturn, returnRate, perFund });
  }
  return result;
}

/**
 * 生成从首笔交易年到今年的年度收益列表（升序）
 * - 范围推断：Math.min(...transactions.map(t => t.date.slice(0,4))) 到今年
 * - 算法与 generateMonthlyReturns 一致（用 calcPortfolioValueAtDate）
 * - 无交易时返回仅含今年一格
 */
export function generateYearlyReturns(
  funds: Fund[],
  transactions: Transaction[],
  _platforms?: Platform[]
): YearlyReturn[] {
  const currentYear = new Date().getFullYear();
  const confirmedTxs = onlyConfirmed(transactions);
  const startYear = confirmedTxs.length > 0
    ? Math.min(...confirmedTxs.map((t) => parseInt(t.date.slice(0, 4), 10)))
    : currentYear;

  const result: YearlyReturn[] = [];
  for (let year = startYear; year <= currentYear; year++) {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const yearStr = String(year);

    const startValue = calcPortfolioValueAtDate(yearStart, funds, transactions);
    const endValue = calcPortfolioValueAtDate(yearEnd, funds, transactions);

    const yearTxs = confirmedTxs.filter((t) => t.date >= yearStart && t.date <= yearEnd);
    const buyTotal = yearTxs
      .filter((t) => t.type === 'buy')
      .reduce((sum, t) => sum + t.amount, 0);
    const sellTotal = yearTxs
      .filter((t) => t.type === 'sell')
      .reduce((sum, t) => sum + (t.amount - t.fee), 0);

    const totalReturn = endValue - startValue - buyTotal + sellTotal;
    const returnRate = startValue > 0 ? (totalReturn / startValue) * 100 : 0;

    const perFund: YearlyReturn['perFund'] = funds.map((f) => {
      const perf = calcFundPerformanceInRange(f, transactions, yearStart, yearEnd);
      return { fundId: perf.fundId, fundName: perf.fundName, returnAmount: perf.returnAmount };
    });

    result.push({ year: yearStr, totalReturn, returnRate, perFund });
  }
  return result;
}
