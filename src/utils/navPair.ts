import type { Fund, NavRecord } from '../types';

/** 占位实现——Task 2 补上美股节假日过滤 */
export function usableNavSeries(_fund: Fund, navHistory: NavRecord[]): NavRecord[] {
  return [...navHistory].sort((a, b) => a.date.localeCompare(b.date));
}
