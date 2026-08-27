import type { Transaction, Fund, NavRecord } from '../types';

/** 计算某只基金的持有份额 */
export function calcShares(transactions: Transaction[]): number {
  return transactions.reduce((sum, tx) => {
    switch (tx.type) {
      case 'buy':
        return sum + tx.shares;
      case 'sell':
        return sum - tx.shares;
      case 'dividend':
        return sum + tx.shares;
      default:
        return sum;
    }
  }, 0);
}

/** 计算某只基金的持仓成本（卖出时按成本比例扣减） */
export function calcCost(transactions: Transaction[]): number {
  let totalCost = 0;
  let totalShares = 0;

  for (const tx of transactions) {
    switch (tx.type) {
      case 'buy':
        totalCost += tx.amount + tx.fee;
        totalShares += tx.shares;
        break;
      case 'sell': {
        // 按平均成本比例扣减
        if (totalShares > 0) {
          const avgCost = totalCost / totalShares;
          totalCost -= avgCost * tx.shares;
          totalShares -= tx.shares;
        }
        break;
      }
      case 'dividend':
        totalShares += tx.shares;
        break;
    }
  }

  return Math.max(0, totalCost);
}

/** 计算当前市值 */
export function calcMarketValue(shares: number, currentNav: number): number {
  return shares * currentNav;
}

/** 计算总收益 */
export function calcReturn(marketValue: number, cost: number): number {
  return marketValue - cost;
}

/** 计算收益率 */
export function calcReturnRate(totalReturn: number, cost: number): number {
  if (cost === 0) return 0;
  return (totalReturn / cost) * 100;
}

/** 计算当日盈亏 */
export function calcDailyPnl(shares: number, navHistory: NavRecord[]): number | null {
  if (navHistory.length < 2) return null;
  const sorted = [...navHistory].sort((a, b) => b.date.localeCompare(a.date));
  const today = sorted[0];
  const yesterday = sorted[1];
  if (!today || !yesterday) return null;
  return shares * (today.nav - yesterday.nav);
}

/** 根据金额和净值计算份额（含手续费） */
export function calcSharesFromAmount(amount: number, fee: number, nav: number): number {
  if (nav === 0) return 0;
  return (amount - fee) / nav;
}

/** 计算基金汇总信息 */
export function calcFundSummary(
  fund: Fund,
  transactions: Transaction[],
  navHistory: NavRecord[]
) {
  const fundTransactions = transactions.filter((t) => t.fundId === fund.id);
  const shares = calcShares(fundTransactions);
  const cost = calcCost(fundTransactions);
  const marketValue = calcMarketValue(shares, fund.currentNav);
  const totalReturn = calcReturn(marketValue, cost);
  const returnRate = calcReturnRate(totalReturn, cost);
  const dailyPnl = calcDailyPnl(shares, navHistory);

  return { shares, cost, marketValue, totalReturn, returnRate, dailyPnl };
}
