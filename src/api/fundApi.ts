import type { NavRecord, Fund, FundFetchFailureReason } from '../types';
import dayjs from 'dayjs';

// --- Fund search: load full fund list once for code/name search ---
export interface FundSearchItem {
  code: string;
  abbreviation: string;
  name: string;
  type: string;
  pinyin: string;
}

let fundSearchCache: FundSearchItem[] | null = null;

/** 仅当名称不携带类型线索时，退回用 search 接口的 type 字段判断 */
function mapRawType(rawType: string): Fund['type'] {
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

/**
 * 判断基金类型，名称优先（比 search 接口的 type 字段可靠）：
 * - QDII 指数基金（纳指/标普）在 search 里常被标成"指数型"，但名称带 "(QDII)"
 * - 债券指数基金（中债7-10年国开）同理，名称带"债券"
 * 顺序：QDII → 债券 → 指数 → 混合；名称无线索时退回 rawType。
 */
export function getFundTypeFromSearch(rawType: string, name?: string): Fund['type'] {
  const n = name ?? '';
  if (n.includes('(QDII)') || n.includes('QDII')) return 'qdii';
  if (n.includes('债券') || n.includes('中债') || n.includes('国债')) return 'bond';
  if (n.includes('ETF') || n.includes('指数') || n.includes('联接') || n.includes('LOF')) return 'index';
  return mapRawType(rawType);
}

/**
 * 仅按名称分类，无名称线索返回 null（用于"按名称重新分类"场景，避免把手动设置的
  类型覆盖成 'mixed'）。语义与 getFundTypeFromSearch 的名称分支一致。
 */
export function getFundTypeFromName(name: string): Fund['type'] | null {
  if (name.includes('(QDII)') || name.includes('QDII')) return 'qdii';
  if (name.includes('债券') || name.includes('中债') || name.includes('国债')) return 'bond';
  if (name.includes('ETF') || name.includes('指数') || name.includes('联接') || name.includes('LOF')) return 'index';
  return null;
}

// --- Fund info + NAV history via pingzhongdata API ---
// This API returns a JS script with global variables:
//   fS_name, fS_code, Data_netWorthTrend, etc.
// We load the script and read the globals.

export interface FundEstimate {
  name: string;
  code: string;
  nav: number;
  lastNav: number;
  changePercent: number;
  navDate: string;
}

/** pingzhongdata 脚本加载超时（15s）——与普通加载失败区分，供失败原因分类 */
class PingzhongTimeoutError extends Error {
  constructor() {
    super('Pingzhongdata script load timeout');
    this.name = 'PingzhongTimeoutError';
  }
}

/** pingzhongdata 脚本加载失败（网络/被拦/404 等） */
class PingzhongLoadError extends Error {
  constructor(fundCode: string) {
    super(`Pingzhongdata script load failed: ${fundCode}`);
    this.name = 'PingzhongLoadError';
  }
}

const PINGZHONG_GLOBALS = [
  'fS_name', 'fS_code', 'Data_netWorthTrend', 'Data_ACWorthTrend',
] as const;

/** 检测 pingzhongdata API 新格式：部分基金返回 { y: 小整数, sc: "..." }，
 *  sc 字段编码规则官方未公开且与基金类型相关，无法通用解码。
 *  检测到任一记录含 sc 字段时，整只基金放弃更新（避免写入错 NAV）。
 *
 *  长期方案验证结论（2026-11-17 curl 实测）：
 *  api.fund.eastmoney.com/f10/lsjz 返回 200 且数据形状符合预期
 *  （FSRQ/DWJZ/LJJZ/JZZZL），但**不带任何 Access-Control-Allow-Origin 头**
 *  （带 fund.eastmoney.com Referer、带 GitHub Pages Origin、裸请求三种场景均无）
 *  ——原 TODO"该端点有 CORS"的说法不成立，浏览器直连 fetch 会被 CORS 拦截，
 *  且 lsjz 返回纯 JSON 无法走 <script> 注入。
 *  可行路径只剩：Cloudflare Worker 代理（Worker 端加 CORS + 转发 Referer），
 *  或继续守着 pingzhongdata 的 isNewFormat 防御检测（当前未触发，见上）。
 */
function isNewFormat(trend: Array<{ x: number; y: number; sc?: unknown }>): boolean {
  return trend.some((item) => typeof item.sc === 'string');
}

function loadPingzhongScript(fundCode: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      cleanup();
      reject(new PingzhongTimeoutError());
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
      reject(new PingzhongLoadError(fundCode));
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
    const navDate = dayjs(latest.x).format('YYYY-MM-DD');
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

/**
 * 把单位净值走势与累计净值走势按日期配对，产出 NavRecord[]。
 *
 * pingzhongdata 的 Data_netWorthTrend 只有单位净值；Data_ACWorthTrend 是
 * [[timestamp, 累计净值], ...] 的二维数组（2026-11 实测 016452：934 条与
 * trend 逐日等长）。分红基金的累计净值 ≠ 单位净值——此前 accNav 恒等 nav
 * 是口径错误，这里修正。
 *
 * 覆盖率是**全有或全无**（2026-11-20 修正）：真实累计净值必须覆盖 trend 的
 * 全部日期，否则整只退回旧口径（acc ≡ nav）。
 * 逐日回退会在除息日把 gap 打到 0、次日又跳回 → 被 buildAdjustedSeries 误判成
 * 一次"分红"，静默污染 MA250 / MACD / 回撤百分位。宁可整只不给复权信号，
 * 也不要错误信号——用户可到 Settings → 重置净值历史 重拉一次。
 */
export function pairNavWithAcc(
  trend: Array<{ x: number; y: number }> | undefined,
  accTrend: Array<[number, number]> | undefined,
): NavRecord[] {
  const accByDate = new Map<string, number>();
  for (const pair of accTrend ?? []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [x, val] = pair as [unknown, unknown];
    if (typeof x !== 'number' || typeof val !== 'number') continue;
    if (!Number.isFinite(val) || val <= 0) continue;
    accByDate.set(dayjs(x).format('YYYY-MM-DD'), val);
  }
  const rows = trend ?? [];
  const covered =
    rows.length > 0 &&
    rows.every((item) => accByDate.has(dayjs(item.x).format('YYYY-MM-DD')));
  return rows.map((item) => {
    const date = dayjs(item.x).format('YYYY-MM-DD');
    const acc = covered ? accByDate.get(date) : undefined;
    return { date, nav: item.y, accNav: acc !== undefined ? acc : item.y };
  });
}

export async function fetchNavHistory(
  fundCode: string,
  startDate: string,
  endDate: string
): Promise<NavRecord[]> {
  try {
    const data = await loadPingzhongScript(fundCode);
    const trend = data['Data_netWorthTrend'] as Array<{ x: number; y: number }> | undefined;
    if (!trend || trend.length === 0) return [];

    const accTrend = data['Data_ACWorthTrend'] as Array<[number, number]> | undefined;
    const records: NavRecord[] = pairNavWithAcc(trend, accTrend);

    // Filter by date range
    return records.filter((r) => r.date >= startDate && r.date <= endDate);
  } catch (err) {
    console.error('[fundApi] fetchNavHistory failed for', fundCode, err);
    return [];
  }
}

// --- Fetch fund info + full NAV history in one call ---

/** 判别联合返回：失败必带 reason，调用方按原因分档提示，不再"一律怪网络" */
export type FetchFundResult =
  | { ok: true; estimate: FundEstimate; navHistory: NavRecord[] }
  | { ok: false; reason: FundFetchFailureReason; detail?: string };

export async function fetchFundWithHistory(fundCode: string): Promise<FetchFundResult> {
  let data: Record<string, unknown>;
  try {
    data = await loadPingzhongScript(fundCode);
  } catch (err) {
    console.error('[fundApi] fetchFundWithHistory failed for', fundCode, err);
    return {
      ok: false,
      reason: err instanceof PingzhongTimeoutError ? 'timeout' : 'network',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const name = data['fS_name'] as string;
  const code = data['fS_code'] as string;
  if (!name || !code) {
    return { ok: false, reason: 'not-found', detail: 'fS_name/fS_code missing' };
  }

  const trend = data['Data_netWorthTrend'] as Array<{ x: number; y: number; sc?: unknown }> | undefined;
  // 新格式检测：任何记录含 sc 字段则放弃更新整只基金
  if (trend && isNewFormat(trend)) {
    console.warn(
      '[fundApi] pingzhongdata returned new NAV format (sc field) for',
      code, '— skipping update to avoid writing incorrect NAV'
    );
    return { ok: false, reason: 'new-format', detail: 'Data_netWorthTrend 含 sc 字段' };
  }

  const accTrend = data['Data_ACWorthTrend'] as Array<[number, number]> | undefined;
  const navHistory = pairNavWithAcc(trend, accTrend);

  const latest = trend?.[trend.length - 1];
  const prev = trend && trend.length > 1 ? trend[trend.length - 2] : latest;
  const lastNav = latest?.y ?? 0;
  const prevNav = prev?.y ?? lastNav;
  const navDate = latest ? dayjs(latest.x).format('YYYY-MM-DD') : '';
  const changePercent = prevNav > 0 ? ((lastNav - prevNav) / prevNav) * 100 : 0;

  return {
    ok: true,
    estimate: { name, code, nav: lastNav, lastNav, changePercent, navDate },
    navHistory,
  };
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
