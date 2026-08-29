import type { Fund, Transaction, DcaPlan, DailySnapshot, Platform } from '../types';
import { calcShares, onlyConfirmed } from './calculator';
import { FUND_TYPE_LABELS } from '../types';
import { countTradingDays, lookupNavForDate } from './navLookup';
import dayjs from 'dayjs';

export interface FundPerformance {
  fundId: string;
  fundName: string;
  returnAmount: number;
  returnRate: number;
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

/**
 * 计算某日期的总持仓市值（基于交易 + 历史净值查询）
 * 替代 snapshot.totalValue：解决"没有期初快照时 startValue=0，把本金算成收益"的 bug
 * 只看已确认交易——pending 买入尚未成交，不应计入持仓市值
 */
function calcPortfolioValueAtDate(
  date: string,
  funds: Fund[],
  transactions: Transaction[]
): number {
  let total = 0;
  for (const fund of funds) {
    const txs = onlyConfirmed(transactions).filter((t) => t.fundId === fund.id && t.date <= date);
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
  for (const plan of dcaPlans.filter((p) => p.active)) {
    if (plan.frequency === 'weekly') {
      dcaExpected += 1;
    } else if (plan.frequency === 'biweekly') {
      // Check if this week falls on a DCA week based on start date
      const start = new Date(plan.startDate);
      const weekMonday = new Date(weekStart);
      const diffDays = Math.round((weekMonday.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      const diffWeeks = Math.floor(diffDays / 7);
      if (diffWeeks >= 0 && diffWeeks % 2 === 0) {
        dcaExpected += 1;
      }
    } else if (plan.frequency === 'monthly') {
      const planDay = plan.dayOfMonth ?? 1;
      const weekDays = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        return d.getDate();
      });
      if (weekDays.includes(planDay)) dcaExpected += 1;
    } else if (plan.frequency === 'daily') {
      // Count actual trading days in this week from the fund's NAV history
      dcaExpected += countTradingDays(plan.fundId, weekStart, weekEnd);
    }
    const planBuyTxs = onlyConfirmed(transactions).filter(
      (t) => t.fundId === plan.fundId && t.type === 'buy' && t.date >= weekStart && t.date <= weekEnd
    );
    dcaActual += planBuyTxs.length;
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

  // Per-platform contribution
  const platformContributions = platforms.map((p) => {
    const platformFunds = funds.filter((f) => f.platformId === p.id);
    const returnAmount = platformFunds.reduce((sum, f) => {
      const perf = calcFundPerformanceInRange(f, transactions, monthStart, monthEnd);
      return sum + perf.returnAmount;
    }, 0);
    return { name: p.name, returnAmount };
  });

  // Per-type contribution
  const types: Fund['type'][] = ['index', 'bond', 'qdii', 'mixed'];
  const typeContributions = types.map((type) => {
    const typeFunds = funds.filter((f) => f.type === type);
    const returnAmount = typeFunds.reduce((sum, f) => {
      const perf = calcFundPerformanceInRange(f, transactions, monthStart, monthEnd);
      return sum + perf.returnAmount;
    }, 0);
    return { type: FUND_TYPE_LABELS[type], returnAmount };
  });

  // Fund rankings
  const rankings = funds
    .map((f) => calcFundPerformanceInRange(f, transactions, monthStart, monthEnd))
    .sort((a, b) => b.returnRate - a.returnRate);

  const bestFund = rankings[0] ?? null;
  const worstFund = rankings[rankings.length - 1] ?? null;

  return {
    month: monthStr,
    totalReturn,
    returnRate,
    snapshots: monthSnapshots,
    platformContributions,
    typeContributions,
    bestFund,
    worstFund,
  };
}
