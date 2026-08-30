import type { NavRecord, Fund } from '../types';

// --- Fund search: load full fund list once for code/name search ---
export interface FundSearchItem {
  code: string;
  abbreviation: string;
  name: string;
  type: string;
  pinyin: string;
}

let fundSearchCache: FundSearchItem[] | null = null;

function mapFundType(rawType: string): Fund['type'] {
  if (rawType.includes('QDII') || rawType.includes('qdi')) return 'qdii';
  if (rawType.includes('债券')) return 'bond';
  if (rawType.includes('指数')) return 'index';
  return 'mixed';
}

export async function loadFundSearchList(): Promise<FundSearchItem[]> {
  if (fundSearchCache) return fundSearchCache;

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Fund list load timeout'));
    }, 20000);

    const cleanup = () => {
      clearTimeout(timeout);
      try { (window as unknown as Record<string, unknown>)['r'] = undefined; } catch { /* ignore */ }
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    script.onload = () => {
      const raw = (window as unknown as Record<string, unknown>)['r'] as string[][] | undefined;
      cleanup();
      if (!raw) {
        resolve([]);
        return;
      }
      fundSearchCache = raw.map((item) => ({
        code: item[0] ?? '',
        abbreviation: item[1] ?? '',
        name: item[2] ?? '',
        type: item[3] ?? '',
        pinyin: item[4] ?? '',
      }));
      resolve(fundSearchCache);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error('Fund list load failed'));
    };

    script.src = 'https://fund.eastmoney.com/js/fundcode_search.js';
    script.setAttribute('charset', 'utf-8');
    script.setAttribute('referrerpolicy', 'no-referrer');
    document.head.appendChild(script);
  });
}

export function searchFunds(keyword: string, items: FundSearchItem[]): FundSearchItem[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [];
  return items
    .filter((item) =>
      item.code.includes(kw) ||
      item.name.toLowerCase().includes(kw) ||
      item.pinyin.toLowerCase().includes(kw)
    )
    .slice(0, 20);
}

export function getFundTypeFromSearch(rawType: string): Fund['type'] {
  return mapFundType(rawType);
}

// --- Fund info + NAV history via pingzhongdata API ---
// This API returns a JS script with global variables:
//   fS_name, fS_code, Data_netWorthTrend, etc.
// We load the script and read the globals.

interface FundEstimate {
  name: string;
  code: string;
  nav: number;
  lastNav: number;
  changePercent: number;
  navDate: string;
}

const PINGZHONG_GLOBALS = [
  'fS_name', 'fS_code', 'Data_netWorthTrend',
] as const;

function loadPingzhongScript(fundCode: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Script load timeout'));
    }, 15000);

    const cleanup = () => {
      clearTimeout(timeout);
      // Clear global variables set by the script (var creates non-configurable
      // properties on window, so we set to undefined instead of delete)
      const allVars = [
        'ishb', 'fS_name', 'fS_code', 'fund_sourceRate', 'fund_Rate', 'fund_minsg',
        'stockCodes', 'zqCodes', 'stockCodesNew', 'zqCodesNew',
        'syl_1n', 'syl_6y', 'syl_3y', 'syl_1y',
        'Data_fundSharesPositions', 'Data_netWorthTrend',
        'Data_ACWorthTrend', 'Data_grandTotal', 'Data_rateInSimilarType',
        'Data_rateInSimilarFund', 'Data_performanceEvaluation',
        'Data_currentFundManager', 'Data_fundSale', 'Data_fundStocks',
        'Data_fundBond', 'Data_fundManager',
      ];
      const w = window as unknown as Record<string, unknown>;
      for (const key of allVars) {
        try { w[key] = undefined; } catch { /* ignore */ }
      }
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    script.onload = () => {
      const w = window as unknown as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of PINGZHONG_GLOBALS) {
        result[key] = w[key];
      }
      result['Data_netWorthTrend'] = w['Data_netWorthTrend'];
      console.debug('[fundApi] Script loaded for', fundCode, 'name:', result['fS_name']);
      cleanup();
      resolve(result);
    };

    script.onerror = (e) => {
      console.error('[fundApi] Script load error for', fundCode, e);
      cleanup();
      reject(new Error(`Script load failed: ${fundCode}`));
    };

    script.src = `https://fund.eastmoney.com/pingzhongdata/${fundCode}.js`;
    script.setAttribute('charset', 'utf-8');
    script.setAttribute('referrerpolicy', 'no-referrer');
    document.head.appendChild(script);
  });
}

export async function fetchFundEstimate(fundCode: string): Promise<FundEstimate | null> {
  try {
    const data = await loadPingzhongScript(fundCode);
    const name = data['fS_name'] as string;
    const code = data['fS_code'] as string;
    if (!name || !code) return null;

    // Extract latest NAV from Data_netWorthTrend
    const trend = data['Data_netWorthTrend'] as Array<{ x: number; y: number }> | undefined;
    if (!trend || trend.length === 0) {
      return { name, code, nav: 0, lastNav: 0, changePercent: 0, navDate: '' };
    }

    const latest = trend[trend.length - 1]!;
    const prev = trend.length > 1 ? trend[trend.length - 2]! : latest;
    const navDate = new Date(latest.x).toISOString().slice(0, 10);
    const lastNav = latest.y;
    const prevNav = prev.y;
    const changePercent = prevNav > 0 ? ((lastNav - prevNav) / prevNav) * 100 : 0;

    return {
      name,
      code,
      nav: lastNav,
      lastNav,
      changePercent,
      navDate,
    };
  } catch (err) {
    console.error('[fundApi] fetchFundEstimate failed for', fundCode, err);
    return null;
  }
}

// --- Historical NAV from pingzhongdata ---
export async function fetchNavHistory(
  fundCode: string,
  startDate: string,
  endDate: string
): Promise<NavRecord[]> {
  try {
    const data = await loadPingzhongScript(fundCode);
    const trend = data['Data_netWorthTrend'] as Array<{ x: number; y: number }> | undefined;
    if (!trend || trend.length === 0) return [];

    const records: NavRecord[] = trend.map((item) => ({
      date: new Date(item.x).toISOString().slice(0, 10),
      nav: item.y,
      accNav: item.y, // pingzhongdata only provides unit NAV, not accumulated
    }));

    // Filter by date range
    return records.filter((r) => r.date >= startDate && r.date <= endDate);
  } catch (err) {
    console.error('[fundApi] fetchNavHistory failed for', fundCode, err);
    return [];
  }
}

// --- Fetch fund info + full NAV history in one call ---
export async function fetchFundWithHistory(fundCode: string): Promise<{
  estimate: FundEstimate;
  navHistory: NavRecord[];
} | null> {
  try {
    const data = await loadPingzhongScript(fundCode);
    const name = data['fS_name'] as string;
    const code = data['fS_code'] as string;
    if (!name || !code) return null;

    const trend = data['Data_netWorthTrend'] as Array<{ x: number; y: number }> | undefined;
    const navHistory: NavRecord[] = (trend ?? []).map((item) => ({
      date: new Date(item.x).toISOString().slice(0, 10),
      nav: item.y,
      accNav: item.y,
    }));

    const latest = trend?.[trend.length - 1];
    const prev = trend && trend.length > 1 ? trend[trend.length - 2] : latest;
    const lastNav = latest?.y ?? 0;
    const prevNav = prev?.y ?? lastNav;
    const navDate = latest ? new Date(latest.x).toISOString().slice(0, 10) : '';
    const changePercent = prevNav > 0 ? ((lastNav - prevNav) / prevNav) * 100 : 0;

    return {
      estimate: { name, code, nav: lastNav, lastNav, changePercent, navDate },
      navHistory,
    };
  } catch (err) {
    console.error('[fundApi] fetchFundWithHistory failed for', fundCode, err);
    return null;
  }
}

// --- Batch fetch with rate limiting ---
export async function batchFetchNav(
  fundCodes: string[],
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, FundEstimate>> {
  const results = new Map<string, FundEstimate>();

  for (let i = 0; i < fundCodes.length; i++) {
    const code = fundCodes[i]!;
    const estimate = await fetchFundEstimate(code);
    if (estimate) {
      results.set(code, estimate);
    }
    onProgress?.(i + 1, fundCodes.length);
    if (i < fundCodes.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return results;
}
