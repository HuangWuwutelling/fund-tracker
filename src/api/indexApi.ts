import type { IndexSpec } from '../types';
import { formatIndexDate } from '../utils/indexQuote';

/**
 * v1 硬编码的指数清单。后续要做"用户自定义"再加 UI / 持久化。
 *
 * 实现走 pingzhongdata 上的指数跟踪 ETF（push2 quote 接口在 2026-10 之后
 * 间歇性返回空响应 / ERR_EMPTY_RESPONSE；详见设计文档 §9.1 的 fallback 路径）：
 * - 510310 = 沪深300ETF 易方达（贴沪深300）
 * - 513100 = 纳指ETF 国泰（贴纳斯达克100）
 * - 513500 = 标普500ETF 博时（贴标普500）
 *
 * 代价：显示的是 ETF NAV（贴指数但滞后 1 分钟~1 天），而非指数原值。
 * 优点：和 fundApi.ts 同源 / 同模式，CORS 工作正常。
 */
export const INDEX_LIST: IndexSpec[] = [
  { code: 'sh000300', secid: '510310', name: '沪深300',     market: 'CN' },
  { code: 'usNDX',    secid: '513100', name: '纳斯达克100', market: 'US' },
  { code: 'usSPX',    secid: '513500', name: '标普500',    market: 'US' },
];

/**
 * 从 API 取到的 raw 字段，已套用 TZ 转成该市场当地的日期。
 * 与 types/IndexQuote 几乎一致，少一个 `name` 与 `market`（这俩 spec 已知，
 * 不需要 API 告诉 UI；store.updateIndex 时合并）。
 */
export interface IndexQuoteRaw {
  value: number;
  change: number;
  changePercent: number;
  date: string;
  fetchedAt: number;
}

const TIMEOUT_MS = 15000;
const SCRIPT_SRC = 'https://fund.eastmoney.com/pingzhongdata';

/**
 * pingzhongdata 设置的 ~25 个 var 全局（与 fundApi.ts loadPingzhongScript
 * 同名单，独立维护）。cleanup 必须全部 set undefined（不是 delete —— ESM
 * strict mode 禁止删除 var 声明），否则下一只指数会读到上一只的 stale 值。
 */
const PINGZHONG_ALL_VARS = [
  'ishb', 'fS_name', 'fS_code', 'fund_sourceRate', 'fund_Rate', 'fund_minsg',
  'stockCodes', 'zqCodes', 'stockCodesNew', 'zqCodesNew',
  'syl_1n', 'syl_6y', 'syl_3y', 'syl_1y',
  'Data_fundSharesPositions', 'Data_netWorthTrend',
  'Data_ACWorthTrend', 'Data_grandTotal', 'Data_rateInSimilarType',
  'Data_rateInSimilarFund', 'Data_performanceEvaluation',
  'Data_currentFundManager', 'Data_fundSale', 'Data_fundStocks',
  'Data_fundBond', 'Data_fundManager',
] as const;

/**
 * 注入一段 pingzhongdata `<script>`，等 onload 后从 window.Data_netWorthTrend
 * 读 NAV 历史（`[{x: ms, y: NAV}, ...]`）。
 */
function loadIndexScript(fundCode: string): Promise<Array<{ x: number; y: number }>> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const w = window as unknown as Record<string, unknown>;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Index script timeout: ${fundCode}`));
    }, TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      for (const key of PINGZHONG_ALL_VARS) {
        try { w[key] = undefined; } catch { /* ignore */ }
      }
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    script.onload = () => {
      const trend = w['Data_netWorthTrend'] as Array<{ x: number; y: number }> | undefined;
      cleanup();
      resolve(trend ?? []);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error(`Index script load failed: ${fundCode}`));
    };

    // _=Date.now() 强制绕过 CDN / 浏览器缓存，避免开发期被 304 卡住
    script.src = `${SCRIPT_SRC}/${fundCode}.js?_=${Date.now()}`;
    script.setAttribute('charset', 'utf-8');
    script.setAttribute('referrerpolicy', 'no-referrer');
    document.head.appendChild(script);
  });
}

/**
 * 拉一个指数的当前行情（走跟踪 ETF 的 NAV 路径）。失败统一返回 null（不抛）
 * ——App.tsx 的循环靠 null 判断"是否要更新 cache"，抛错会让循环中断、
 * 影响后续指数。
 *
 * 字段来源（Data_netWorthTrend 数组最后 2 条）：
 * - value:  最新一条 NAV（已 = 原生单位，不需 ÷100）
 * - change: (最新 NAV) - (上一条 NAV)
 * - changePercent: change / 上一条 NAV × 100
 * - date:   formatIndexDate(last.x ms, market)
 *
 * 失败 case：网络断 / `<script>` 注入失败 / trend 为空 / trend 长度 < 2 /
 * last.x 缺失或 ≤0。统一 null 返回，让调用方静默保留旧 cache。
 */
export async function fetchMarketIndex(spec: IndexSpec): Promise<IndexQuoteRaw | null> {
  try {
    const trend = await loadIndexScript(spec.secid);
    if (trend.length < 2) return null;

    const last = trend[trend.length - 1];
    const prev = trend[trend.length - 2];
    if (!last || !prev) return null;

    const tsMs = last.x;
    if (typeof tsMs !== 'number' || tsMs <= 0) return null;

    const change = last.y - prev.y;
    const changePercent = prev.y !== 0 ? (change / prev.y) * 100 : 0;

    return {
      value: last.y,
      change,
      changePercent,
      date: formatIndexDate(tsMs, spec.market),
      fetchedAt: Date.now(),
    };
  } catch (err) {
    console.error('[indexApi] fetchMarketIndex failed for', spec.secid, err);
    return null;
  }
}