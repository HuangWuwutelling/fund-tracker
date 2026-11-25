import type { DailySnapshot } from '../types';
import { portfolioView, type PortfolioInput } from './portfolio';
import { today } from './formatter';
import { isNonTradingDay } from './chineseHolidays';

/** 生成今日快照（仅计入已确认交易，pending 不参与持仓/成本计算）
 *
 * 非交易日（周末 / 节假日）跳过：避免日历里多出 0 涨跌的空格子；
 * 老数据里残留的非交易日快照在 calendar 层过滤，详见 reportGenerator.ts。
 *
 * 合计**取自 portfolioView**——与 Dashboard 同一份实现，快照与组合总览不可能对不上。
 * 以前这里是独立的一份 calcShares + calcCost 循环，两处各算各的。
 */
export function generateSnapshot(input: PortfolioInput): DailySnapshot | null {
  const todayStr = today();
  if (isNonTradingDay(todayStr)) return null;

  const { totals } = portfolioView(input);

  return {
    date: todayStr,
    totalValue: Math.round(totals.totalValue * 100) / 100,
    totalCost: Math.round(totals.totalCost * 100) / 100,
  };
}
