import type { NavRecord } from '../types';
import { getNavHistory } from './storage';

export interface NavLookupResult {
  nav: number;
  navDate: string;
}

/**
 * Look up NAV for a fund on or before the given date.
 * If no exact match, falls back to the most recent prior trading day.
 * Returns null if the fund has no NAV history at all.
 */
export function lookupNavForDate(fundId: string, date: string | Date): NavLookupResult | null {
  const dateStr = typeof date === 'string' ? date : formatDateOnly(date);
  const history = getNavHistory(fundId);
  if (history.length === 0) return null;

  const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));
  const exact = sorted.find((r: NavRecord) => r.date === dateStr);
  const matched = exact ?? sorted.find((r: NavRecord) => r.date < dateStr);
  return matched ? { nav: matched.nav, navDate: matched.date } : null;
}

/**
 * Count trading days within a date range (inclusive) using the fund's NAV history.
 * Returns 0 if the fund has no history.
 */
export function countTradingDays(fundId: string, startDate: string, endDate: string): number {
  const history = getNavHistory(fundId);
  return history.filter((r) => r.date >= startDate && r.date <= endDate).length;
}

function formatDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}