import type { Fund, Transaction, DcaPlan, DailySnapshot, Platform } from '../types';
import { calcShares, calcCost, calcMarketValue } from './calculator';
import { FUND_TYPE_LABELS } from '../types';

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
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return [
    monday.toISOString().slice(0, 10),
    sunday.toISOString().slice(0, 10),
  ];
}

function getMonthRange(year: number, month: number): [string, string] {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return [start, end];
}

function findNearestSnapshot(snapshots: DailySnapshot[], date: string): DailySnapshot | undefined {
  const sorted = [...snapshots]
    .filter((s) => s.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date));
  return sorted[0];
}

function calcFundPerformanceInRange(
  fund: Fund,
  transactions: Transaction[],
  snapshots: DailySnapshot[],
  startDate: string,
  endDate: string
): FundPerformance {
  const txBeforeEnd = transactions.filter((t) => t.fundId === fund.id && t.date <= endDate);
  const txBeforeStart = transactions.filter((t) => t.fundId === fund.id && t.date < startDate);

  const sharesStart = calcShares(txBeforeStart);

  const sharesEnd = calcShares(txBeforeEnd);
  const costEnd = calcCost(txBeforeEnd);

  // Use fund's current nav as approximation if no snapshot available
  const startSnapshot = findNearestSnapshot(snapshots, startDate);
  const endSnapshot = findNearestSnapshot(snapshots, endDate);

  // Simplified: use transaction data to estimate return
  const buyInRange = transactions
    .filter((t) => t.fundId === fund.id && t.type === 'buy' && t.date >= startDate && t.date <= endDate)
    .reduce((sum, t) => sum + t.amount + t.fee, 0);
  const sellInRange = transactions
    .filter((t) => t.fundId === fund.id && t.type === 'sell' && t.date >= startDate && t.date <= endDate)
    .reduce((sum, t) => sum + t.amount - t.fee, 0);

  // If we have snapshots, use them
  if (startSnapshot && endSnapshot) {
    const valueStart = sharesStart * fund.currentNav; // approximation
    const valueEnd = sharesEnd * fund.currentNav;
    const returnAmount = valueEnd - valueStart + sellInRange - buyInRange;
    const returnRate = valueStart > 0 ? (returnAmount / valueStart) * 100 : 0;
    return { fundId: fund.id, fundName: fund.name, returnAmount, returnRate };
  }

  // Fallback: use cost-based calculation
  const valueEnd = calcMarketValue(sharesEnd, fund.currentNav);
  const returnAmount = valueEnd - costEnd + sellInRange - buyInRange;
  const returnRate = costEnd > 0 ? (returnAmount / costEnd) * 100 : 0;

  return { fundId: fund.id, fundName: fund.name, returnAmount, returnRate };
}

export function generateWeeklyReport(
  date: Date,
  funds: Fund[],
  transactions: Transaction[],
  dcaPlans: DcaPlan[],
  snapshots: DailySnapshot[]
): WeeklyReport {
  const [weekStart, weekEnd] = getWeekRange(date);

  const startSnap = findNearestSnapshot(snapshots, weekStart);
  const endSnap = findNearestSnapshot(snapshots, weekEnd);

  const startValue = startSnap?.totalValue ?? 0;
  const endValue = endSnap?.totalValue ?? 0;

  const weekTxs = transactions.filter((t) => t.date >= weekStart && t.date <= weekEnd);
  const buyCount = weekTxs.filter((t) => t.type === 'buy').length;
  const sellCount = weekTxs.filter((t) => t.type === 'sell').length;
  const dividendCount = weekTxs.filter((t) => t.type === 'dividend').length;

  const buyTotal = weekTxs
    .filter((t) => t.type === 'buy')
    .reduce((sum, t) => sum + t.amount, 0);
  const sellTotal = weekTxs
    .filter((t) => t.type === 'sell')
    .reduce((sum, t) => sum + t.amount, 0);

  const totalReturn = endValue - startValue + sellTotal - buyTotal;
  const returnRate = startValue > 0 ? (totalReturn / startValue) * 100 : 0;

  const fundRankings = funds
    .map((f) => calcFundPerformanceInRange(f, transactions, snapshots, weekStart, weekEnd))
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
    }
    const planBuyTxs = transactions.filter(
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

  const startSnap = findNearestSnapshot(snapshots, monthStart);
  const endSnap = findNearestSnapshot(snapshots, monthEnd);

  const startValue = startSnap?.totalValue ?? 0;
  const endValue = endSnap?.totalValue ?? 0;

  const monthTxs = transactions.filter((t) => t.date >= monthStart && t.date <= monthEnd);
  const buyTotal = monthTxs
    .filter((t) => t.type === 'buy')
    .reduce((sum, t) => sum + t.amount, 0);
  const sellTotal = monthTxs
    .filter((t) => t.type === 'sell')
    .reduce((sum, t) => sum + t.amount, 0);

  const totalReturn = endValue - startValue + sellTotal - buyTotal;
  const returnRate = startValue > 0 ? (totalReturn / startValue) * 100 : 0;

  // Per-platform contribution
  const platformContributions = platforms.map((p) => {
    const platformFunds = funds.filter((f) => f.platformId === p.id);
    const returnAmount = platformFunds.reduce((sum, f) => {
      const perf = calcFundPerformanceInRange(f, transactions, snapshots, monthStart, monthEnd);
      return sum + perf.returnAmount;
    }, 0);
    return { name: p.name, returnAmount };
  });

  // Per-type contribution
  const types: Fund['type'][] = ['index', 'bond', 'qdii', 'mixed'];
  const typeContributions = types.map((type) => {
    const typeFunds = funds.filter((f) => f.type === type);
    const returnAmount = typeFunds.reduce((sum, f) => {
      const perf = calcFundPerformanceInRange(f, transactions, snapshots, monthStart, monthEnd);
      return sum + perf.returnAmount;
    }, 0);
    return { type: FUND_TYPE_LABELS[type], returnAmount };
  });

  // Fund rankings
  const rankings = funds
    .map((f) => calcFundPerformanceInRange(f, transactions, snapshots, monthStart, monthEnd))
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
