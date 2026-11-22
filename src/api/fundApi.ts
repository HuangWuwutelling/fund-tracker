import type { NavRecord, FundFetchFailureReason } from '../types';
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

