import type { IndexSpec, IndexHistoryRecord } from '../types';
import { parseIndexTimestamp } from '../utils/indexQuote';

/**
 * v1 硬编码的指数清单。后续要做"用户自定义"再加 UI / 持久化。
 *
 * 数据源：腾讯 qt.gtimg.cn（理由见设计文档 §9.1 + 2026-10 调试记录）：
 *   - 该接口 `Access-Control-Allow-Origin: *`，浏览器 fetch 直连；
 *   - 一次请求带多个 code，GBK 编码；
 *   - A 股日历来回调，US 周末和节假日正常出数（与 ETF fallback 路径相比，
 *     513100 上 6 天滞后的问题不复存在）；
 *   - 字段是真实指数点位（不是 ETF NAV），与本意一致。
 *
 * 已知 trade-off：
 *   - push2（eastmoney）的字段更规整，但 2026-10 起间歇 ERR_EMPTY_RESPONSE；
 *   - 腾讯接口偶尔会出现 `v_pv_none_match="1"` 空匹配（标的代码下线/输错），落到 catch。
 */
export const INDEX_LIST: IndexSpec[] = [
  { code: 'sh000300', symbol: 'sh000300', name: '沪深300',     market: 'CN' },
  { code: 'sz399006', symbol: 'sz399006', name: '创业板指',    market: 'CN' },
  { code: 'sh000905', symbol: 'sh000905', name: '中证500',     market: 'CN' },
  { code: 'usNDX',    symbol: 'usNDX', klineSymbol: 'us.NDX', name: '纳斯达克100', market: 'US' },
  { code: 'usSPX',    symbol: 'us.INX',   name: '标普500',    market: 'US' },
  { code: 'usDJI',    symbol: 'us.DJI',   name: '道琼斯',     market: 'US' },
];

/**
 * 从 API 取到的 raw 字段。与 types/IndexQuote 几乎一致，少 `name`/`market`（spec 已知，
 * 不需要 API 告诉 UI；store.updateIndex 时合并），且多带 `rawTime`（HH:mm 给 UI 用）。
 */
export interface IndexQuoteRaw {
  value: number;
  change: number;
  changePercent: number;
  date: string;
  rawTime: string;
}

const TENGCENT_URL = 'https://qt.gtimg.cn';

/**
 * 腾讯 qt.gtimg.cn 的响应是 `v_X="...";` 一行行摆开的多条记录，
 * 字段之间用 `~` 分隔。CN 与 US 共用一份格式，但有几个差异：
 *   - CN: `~` 分隔符 + 整型时间戳 `20260930161412` (YYYYMMDDHHmmss, 北京时间)
 *   - US: `~` 分隔符 + 字符串时间戳 `2026-10-02 17:15:59`（具体 TZ 解释有歧义，
 *         我们只用它的 YYYY-MM-DD 部分和 HH:mm 部分，不做时区换算）
 *
 * 我们关心的字段（0-based index）：
 *   [1]  中文名
 *   [3]  现价
 *   [30] 时间戳（CN 是数字串，US 是带分隔符的字符串 —— 共用一个正则剥离）
 *   [31] 涨跌额（绝对值，已带正负号）
 *   [32] 涨跌幅（百分比数字，e.g. 0.29 = +0.29%）
 */
const FIELD_VALUE = 3;
const FIELD_TIMESTAMP = 30;
const FIELD_CHANGE = 31;
const FIELD_CHANGE_PERCENT = 32;

/**
 * 解析单条 `v_X="...";` 记录。失败返回 null（让 fetch 整体 null 返回）。
 */
function parseQuoteLine(line: string): IndexQuoteRaw | null {
  // v_X="...";
  const m = /^v_[^=]+="(.*)";?\s*$/.exec(line);
  if (!m) return null;
  const inner = m[1];
  if (!inner) return null;

  const fields = inner.split('~');
  const valueRaw = fields[FIELD_VALUE];
  const changeRaw = fields[FIELD_CHANGE];
  const changePctRaw = fields[FIELD_CHANGE_PERCENT];
  const timestampRaw = fields[FIELD_TIMESTAMP];
  if (
    valueRaw === undefined ||
    changeRaw === undefined ||
    changePctRaw === undefined ||
    timestampRaw === undefined
  ) {
    return null;
  }

  const value = Number(valueRaw);
  const change = Number(changeRaw);
  const changePercent = Number(changePctRaw);
  if (!Number.isFinite(value) || !Number.isFinite(change) || !Number.isFinite(changePercent)) {
    return null;
  }

  const { date, time } = parseIndexTimestamp(timestampRaw);
  if (!date) return null;

  return {
    value,
    change,
    changePercent,
    date,
    rawTime: time,
  };
}

/**
 * 一次拉 3 个指数（qt.gtimg.cn 支持 `q=sh000300,us.NDX,us.INX` 逗号分隔）。
 * 失败统一返回 null（不抛）——App.tsx 的循环靠 null 判断"是否要更新 cache"，
 * 抛错会让循环中断、影响后续指数。
 */
export async function fetchMarketIndices(): Promise<Record<string, IndexQuoteRaw | null>> {
  const symbols = INDEX_LIST.map((s) => s.symbol).join(',');
  const url = `${TENGCENT_URL}/q=${symbols}?_=${Date.now()}`;
  try {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) {
      console.error('[indexApi] fetchMarketIndices HTTP', resp.status);
      return {};
    }
    // 腾讯响应是 GBK / GB18030 编码
    const buf = await resp.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const out: Record<string, IndexQuoteRaw | null> = {};
    for (const spec of INDEX_LIST) {
      const needle = `v_${spec.symbol}=`;
      const line = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.startsWith(needle));
      if (!line) {
        out[spec.code] = null;
        continue;
      }
      try {
        out[spec.code] = parseQuoteLine(line);
      } catch (err) {
        console.error('[indexApi] parseQuoteLine failed for', spec.symbol, err);
        out[spec.code] = null;
      }
    }
    return out;
  } catch (err) {
    console.error('[indexApi] fetchMarketIndices failed:', err);
    return {};
  }
}

/**
 * 兼容旧调用点（App.tsx refreshAll 里仍然按 spec 单个拉）。
 * 内部走 fetchMarketIndices 再 filter，避免发多次请求。
 */
export async function fetchMarketIndex(spec: IndexSpec): Promise<IndexQuoteRaw | null> {
  const all = await fetchMarketIndices();
  return all[spec.code] ?? null;
}

// ===== Index History (daily K-line for chart) =====
const KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

/**
 * 拉指数的每日 K 线 → 取 [date, close] 对，输出 IndexHistoryRecord[]。
 *
 * 端点：`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},day,,,{count},qfq`
 *   - 单 symbol 一次请求（不带其他指数）；
 *   - 字段 0 = date (YYYY-MM-DD), 1 = open, 2 = close, 3 = high, 4 = low, 5 = volume；
 *   - `count` 实测最大 2000（≈8 年日线），够个人图表用；
 *   - `qfq` = 前复权；指数没有分红，影响甚微但加 qfq 保持口径一致；
 *   - `Access-Control-Allow-Origin: *`，浏览器 fetch 直连；UTF-8（与 qt.gtimg.cn 的 GBK 不同）。
 *
 * 失败统一返回 []（不抛）——Modal 自己判空显示"暂无数据"，不用 try-catch。
 */
export async function fetchIndexHistory(
  spec: IndexSpec,
  days: number = 2000,
): Promise<IndexHistoryRecord[]> {
  // 行情 / K 线 symbol 不同的情况（如 usNDX）：klineSymbol 优先，fallback 到 symbol。
  const klineParam = spec.klineSymbol ?? spec.symbol;
  const url = `${KLINE_URL}?param=${klineParam},day,,,${days},qfq&_=${Date.now()}`;
  try {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) {
      console.error('[indexApi] fetchIndexHistory HTTP', resp.status, klineParam);
      return [];
    }
    const data = await resp.json();
    const rows = data?.data?.[klineParam]?.day;
    if (!Array.isArray(rows)) return [];
    const out: IndexHistoryRecord[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const date = row[0];
      const close = Number(row[2]);
      if (typeof date !== 'string' || !Number.isFinite(close)) continue;
      out.push({ date, value: close });
    }
    return out;
  } catch (err) {
    console.error('[indexApi] fetchIndexHistory failed for', klineParam, err);
    return [];
  }
}