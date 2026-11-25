import type { Fund, Transaction, NavRecord } from '../types';
import {
  calcCost,
  calcDividendTotal,
  calcLatestNavPnl,
  calcMarketValue,
  calcReturn,
  calcReturnRate,
  calcShares,
  calcXIRR,
  onlyConfirmed,
} from './calculator';
import type { UsQdiiFilterMode } from './navPair';

/**
 * 「我持有什么」——组合与单只基金头寸的**唯一计算入口**。
 *
 * 背景：这份计算过去散在四个地方，各算各的——
 * - `Dashboard.tsx` —— `calcFundSummary` 映射 + reduce
 * - `FundDetail.tsx` —— `calcFundSummary`，外加**又用 calcCost + calcShares 重算一遍均价**
 * - `utils/snapshot.ts` —— `calcShares` + `calcCost` 循环累加
 * - `utils/reportGenerator.ts` —— 独立的份额累积实现
 *
 * 而且**每个调用点都得记得传 `usQdiiFilterMode`**——漏传不报错，只是安静地改变数字。
 * 本模块把 mode 收进接口里，漏传就变成编译错误。
 */
export interface FundPosition {
  fund: Fund;
  shares: number;
  cost: number;
  /** 成本均价 = cost / shares；无持仓时为 0 */
  avgCost: number;
  marketValue: number;
  totalReturn: number;
  returnRate: number;
  dailyPnl: number | null;
  currNavDate: string;
  prevNavDate: string;
  xirr: number;
  dividend: number;
}

export interface PortfolioTotals {
  totalValue: number;
  totalCost: number;
  totalReturn: number;
  totalReturnRate: number;
  /** 各基金"最新一对已发布 NAV"涨跌之和；没有一只基金有可用净值时为 null */
  totalDailyPnl: number | null;
  /**
   * 按"最新净值日"分桶——不同基金的最新净值日可能不同（A 股今天、QDII 常落后
   * 一个交易日），把口径直接写出来而不是藏进 tooltip。
   */
  navDateBuckets: { date: string; count: number }[];
  /** 没有可用净值的基金数 */
  noNavCount: number;
  /** 有可用净值的基金数 */
  coveredCount: number;
}

export interface PortfolioInput {
  funds: Fund[];
  transactions: Transaction[];
  /** 该基金的净值历史。调用方给缓存/读盘——本模块不碰 localStorage */
  navHistoryOf: (fundId: string) => NavRecord[];
  /** 关键：收在接口里，调用方无从遗漏 */
  mode: UsQdiiFilterMode;
}

/** 单只基金的头寸计算（组合计算与单只查询共用这一份） */
function positionOf(
  fund: Fund,
  transactions: Transaction[],
  navHistory: NavRecord[],
  mode: UsQdiiFilterMode,
): FundPosition {
  // pending（待确认）交易不进持仓，也不进成本
  const fundTransactions = onlyConfirmed(transactions).filter((t) => t.fundId === fund.id);
  const shares = calcShares(fundTransactions);
  const cost = calcCost(fundTransactions);
  const marketValue = calcMarketValue(shares, fund.currentNav);
  const totalReturn = calcReturn(marketValue, cost);
  const returnRate = calcReturnRate(totalReturn, cost);
  const latest = calcLatestNavPnl(fund, navHistory, fundTransactions, mode);

  return {
    fund,
    shares,
    cost,
    avgCost: shares > 0 ? cost / shares : 0,
    marketValue,
    totalReturn,
    returnRate,
    dailyPnl: latest.pnl,
    currNavDate: latest.currDate,
    prevNavDate: latest.prevDate,
    xirr: calcXIRR(fundTransactions, marketValue),
    dividend: calcDividendTotal(fundTransactions),
  };
}

/** 组合合计。无持仓的基金对合计没有贡献（市值与成本都是 0） */
function totalsOf(positions: FundPosition[]): PortfolioTotals {
  const totalValue = positions.reduce((sum, p) => sum + p.marketValue, 0);
  const totalCost = positions.reduce((sum, p) => sum + p.cost, 0);
  const totalReturn = totalValue - totalCost;
  const totalReturnRate = totalCost > 0 ? (totalReturn / totalCost) * 100 : 0;

  let totalDailyPnl: number | null = null;
  const bucketCount = new Map<string, number>();
  let noNavCount = 0;
  for (const p of positions) {
    if (p.dailyPnl === null) {
      noNavCount++;
      continue;
    }
    totalDailyPnl = (totalDailyPnl ?? 0) + p.dailyPnl;
    bucketCount.set(p.currNavDate, (bucketCount.get(p.currNavDate) ?? 0) + 1);
  }
  const navDateBuckets = [...bucketCount.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    totalValue,
    totalCost,
    totalReturn,
    totalReturnRate,
    totalDailyPnl,
    navDateBuckets,
    noNavCount,
    coveredCount: positions.length - noNavCount,
  };
}

/** 整个组合的头寸与合计 */
export function portfolioView(input: PortfolioInput): {
  positions: FundPosition[];
  totals: PortfolioTotals;
} {
  const { funds, transactions, navHistoryOf, mode } = input;
  const positions = funds.map((fund) => positionOf(fund, transactions, navHistoryOf(fund.id), mode));
  return { positions, totals: totalsOf(positions) };
}

/** 单只基金的头寸；基金不在 input.funds 里则返回 null */
export function fundPosition(input: PortfolioInput, fundId: string): FundPosition | null {
  const { funds, transactions, navHistoryOf, mode } = input;
  const fund = funds.find((f) => f.id === fundId);
  if (!fund) return null;
  return positionOf(fund, transactions, navHistoryOf(fund.id), mode);
}
