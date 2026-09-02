import type { Fund, Transaction, DailySnapshot } from '../types';
import { calcShares, calcCost, calcMarketValue, onlyConfirmed } from './calculator';
import { today } from './formatter';
import { isNonTradingDay } from './chineseHolidays';

/** 生成今日快照（仅计入已确认交易，pending 不参与持仓/成本计算）
 *
 * 非交易日（周末 / 节假日）跳过：避免日历里多出 0 涨跌的空格子；
 * 老数据里残留的非交易日快照在 calendar 层过滤，详见 reportGenerator.ts。
 */
export function generateSnapshot(funds: Fund[], transactions: Transaction[]): DailySnapshot | null {
  const todayStr = today();
  if (isNonTradingDay(todayStr)) return null;

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
    date: todayStr,
    totalValue: Math.round(totalValue * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
  };
}
