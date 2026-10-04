import type { IndexSpec } from '../types';
import { formatIndexDate } from '../utils/indexQuote';

/**
 * v1 硬编码的指数清单。后续要做"用户自定义"再加 UI / 持久化。
 * - secid 是 eastmoney push2 的 secid 编码：`{market 前缀}.{指数代码}`
 * - market 前缀：CN=1., US=100.
 */
export const INDEX_LIST: IndexSpec[] = [
  { code: 'sh000300', secid: '1.000300', name: '沪深300',     market: 'CN' },
  { code: 'usNDX',    secid: '100.NDX',  name: '纳斯达克100', market: 'US' },
  { code: 'usSPX',    secid: '100.SPX',  name: '标普500',     market: 'US' },
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
const SCRIPT_SRC = 'https://push2.eastmoney.com/api/qt/stock/get';

/**
 * 注入一段 JSONP `<script>`，cb 回调名每次唯一，避免并发调用互相覆盖。
 * 仿 fundApi.ts 的 loadPingzhongScript：var 全局 set undefined（不是 delete），
 * script.removeChild 摘掉。**唯一差异**：pingzhongdata 用 var 声明固定名字
 * （fS_name 等），push2 是 `?cb=xxx` 把回调名传给服务端，服务端回 `xxx({...})`。
 */
function loadIndexScript(secid: string, cb: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const w = window as unknown as Record<string, unknown>;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Index script timeout: ${secid}`));
    }, TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      try { w[cb] = undefined; } catch { /* ignore */ }
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    w[cb] = (data: unknown) => { cleanup(); resolve(data); };

    script.onerror = () => {
      cleanup();
      reject(new Error(`Index script load failed: ${secid}`));
    };

    // _=Date.now() 强制绕过 CDN / 浏览器缓存，避免开发期被 304 卡住
    const fields = 'f43,f169,f170,f86';
    script.src =
      `${SCRIPT_SRC}?cb=${encodeURIComponent(cb)}` +
      `&secid=${encodeURIComponent(secid)}` +
      `&fields=${encodeURIComponent(fields)}` +
      `&_=${Date.now()}`;
    script.setAttribute('charset', 'utf-8');
    script.setAttribute('referrerpolicy', 'no-referrer');
    document.head.appendChild(script);
  });
}

/**
 * 拉一个指数的当前行情。失败统一返回 null（不抛）——App.tsx 的循环靠 null
 * 判断"是否要更新 cache"，抛错会让循环中断、影响后续指数。
 *
 * 字段映射：
 * - f43: 当前点位
 * - f169: 涨跌额
 * - f170: 涨跌幅 (%)
 * - f86: 时间戳 ms
 *
 * 失败 case：网络断 / `<script>` 注入失败 / 返回 `{ data: null }`（基金代码错或退市）/
 * `f86` 缺失或 0。统一 null 返回，让调用方静默保留旧 cache。
 */
export async function fetchMarketIndex(spec: IndexSpec): Promise<IndexQuoteRaw | null> {
  // 每次唯一回调名 —— push2 不像 pingzhongdata 用固定 var 名，必须避免并发覆盖。
  const cb = `__idxCb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    const resp = await loadIndexScript(spec.secid, cb);
    // 响应形如 { rc, rt, svr, lt, full, dlmkts, data: { f43, ..., f86 } | null }
    const data = (resp as { data?: Record<string, number> | null } | null)?.data;
    if (!data) return null;

    const tsMs = data.f86;
    if (typeof tsMs !== 'number' || tsMs <= 0) return null;

    return {
      value: data.f43 ?? 0,
      change: data.f169 ?? 0,
      changePercent: data.f170 ?? 0,
      date: formatIndexDate(tsMs, spec.market),
      fetchedAt: Date.now(),
    };
  } catch (err) {
    console.error('[indexApi] fetchMarketIndex failed for', spec.secid, err);
    return null;
  }
}
