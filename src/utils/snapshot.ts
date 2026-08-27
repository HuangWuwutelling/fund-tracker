import type { Fund, Transaction, DailySnapshot } from '../types';
import { calcShares, calcCost, calcMarketValue } from './calculator';
import { today } from './formatter';

/** 生成今日快照 */
export function generateSnapshot(funds: Fund[], transactions: Transaction[]): DailySnapshot {
  let totalValue = 0;
  let totalCost = 0;

  for (const fund of funds) {
    const fundTxs = transactions.filter((t) => t.fundId === fund.id);
    const shares = calcShares(fundTxs);
    const cost = calcCost(fundTxs);
    const marketValue = calcMarketValue(shares, fund.currentNav);
    totalValue += marketValue;
    totalCost += cost;
  }

  return {
    date: today(),
    totalValue: Math.round(totalValue * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
  };
}
