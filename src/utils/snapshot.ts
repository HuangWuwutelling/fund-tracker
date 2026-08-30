import type { Fund, Transaction, DailySnapshot } from '../types';
import { calcShares, calcCost, calcMarketValue, onlyConfirmed } from './calculator';
import { today } from './formatter';

/** 生成今日快照（仅计入已确认交易，pending 不参与持仓/成本计算） */
export function generateSnapshot(funds: Fund[], transactions: Transaction[]): DailySnapshot {
  let totalValue = 0;
  let totalCost = 0;

  // 一次性过滤 confirmed，避免每只基金都重跑一遍 filter
  const confirmed = onlyConfirmed(transactions);

  for (const fund of funds) {
    const fundTxs = confirmed.filter((t) => t.fundId === fund.id);
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
