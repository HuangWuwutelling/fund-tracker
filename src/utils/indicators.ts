import type { Fund, NavRecord } from '../types';
import type { MacdState } from '../types';
import { usableNavSeries, type UsQdiiFilterMode, DEFAULT_US_QDII_FILTER_MODE } from './navPair';

/* ============================================================
 *  技术指标：MA250 偏离度 / MACD / 净值回撤百分位
 *  纯函数，testable。所有函数假设上游已用 usableNavSeries 过滤
 *  —— 调用方传入的 navHistory 应为已过滤后的 NavRecord[]。
 *  Mirror calculator.ts: typeof x !== 'number' || !Number.isFinite(x) 防御式
 * ============================================================ */

/**
 * 把任意输入清洗成 `number[]`。把 null / 非数 / NaN 都当作"hole"，但其他保留。
 *
 * 这里直接过滤掉非法值，保证 EMA / SMA / 回撤的数学运算不被污染。FundDetail
 * 用 `filteredNav` 时这部分通常为空过滤，但接口上保留宽容以测试边界。
 */
function toDenseNumbers(values: readonly (number | null | undefined)[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out.push(v);
  }
  return out;
}

/* ------------------------------- SMA ------------------------------- */

/**
 * N 日简单移动平均。返回与输入等长的数组；前 `window - 1` 个位置为 null。
 *
 * 关键点：null 不参与平均（被排除），若窗口内所有值都是 null，结果也是 null。
 * 这与 EMA 不同：SMA 是顺序窗口求和，缺失值只能靠后续窗口"自我修复"，
 * 因此 SAD 文档明确 SMA 在数据有 hole 时输出会变得稀疏——这是符合预期的。
 */
export function sma(values: readonly (number | null | undefined)[], window: number): (number | null)[] {
  const N = values.length;
  const out: (number | null)[] = new Array(N).fill(null);
  if (window <= 0 || N < window) return out;

  // 滑动窗口求和；遇到 null 重置窗口
  let sum = 0;
  let count = 0;
  for (let i = 0; i < N; i++) {
    const raw = values[i];
    const v = raw === null || raw === undefined ? null : typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    if (v === null) {
      sum = 0;
      count = 0;
      continue;
    }
    sum += v;
    count += 1;
    if (count > window) {
      // 退出最旧的一个
      const oldestRaw = values[i - window]!;
      if (oldestRaw !== null && typeof oldestRaw === 'number' && Number.isFinite(oldestRaw)) {
        sum -= oldestRaw;
        count -= 1;
      }
    }
    if (count === window) {
      out[i] = sum / window;
    }
  }
  return out;
}

/**
 * MA250 偏离度（百分比）。公式：(curr - MA250) / MA250 × 100。
 * MA250 缺失 / ≤ 0 返回 null。
 */
export function ma250Deviation(values: readonly (number | null | undefined)[]): number | null {
  if (values.length === 0) return null;
  const ma = sma(values, 250);
  return calcDeviationPct(values[values.length - 1], ma[ma.length - 1] ?? null);
}

/* ------------------------------- EMA / MACD ------------------------------- */

function ema(values: readonly (number | null | undefined)[], period: number): (number | null)[] {
  const N = values.length;
  const out: (number | null)[] = new Array(N).fill(null);
  if (period <= 0) return out;

  const k = 2 / (period + 1);
  let seedSum = 0;
  let seedCount = 0;
  let prev: number | null = null;
  let seedDone = false;

  for (let i = 0; i < N; i++) {
    const raw = values[i];
    const v = raw === null || raw === undefined ? null : typeof raw === 'number' && Number.isFinite(raw) ? raw : null;

    if (!seedDone) {
      // 种子阶段：累计到 period 个连续有效值，种子 = SMA
      if (v === null) {
        seedSum = 0;
        seedCount = 0;
        out[i] = null;
        continue;
      }
      seedSum += v;
      seedCount += 1;
      if (seedCount === period) {
        prev = seedSum / period;
        seedDone = true;
        out[i] = prev;
      } else {
        out[i] = null;
      }
    } else {
      // 已 seed：EMA(t) = v * k + prev * (1 − k)
      if (v === null) {
        // 数据 hole：输出 null 但 prev EMA 保持不变，链条不断
        out[i] = null;
        continue;
      }
      prev = v * k + prev! * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export interface MacdSeries {
  /** EMA12 − EMA26 */
  dif: (number | null)[];
  /** DIF 的 9 日 EMA */
  dea: (number | null)[];
  /** (DIF − DEA) × 2 的柱状图 */
  hist: (number | null)[];
}

/**
 * 标准 MACD (12, 26, 9)。暖机期输出 null：
 * - DIF 自 index 25 有效（EMA26 完成 seed）
 * - DEA 自 index 33 有效（DIF 上 EMA9 完成 seed）
 * - hist 同 DEA
 */
export function macd(values: readonly (number | null | undefined)[], fast = 12, slow = 26, signal = 9): MacdSeries {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const N = values.length;
  const dif: (number | null)[] = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (typeof f === 'number' && typeof s === 'number') dif[i] = f - s;
  }
  // DIF 上的 EMA(signal)
  const dea = ema(dif, signal);
  // hist = (DIF − DEA) × 2
  const hist: (number | null)[] = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    const d = dif[i];
    const de = dea[i];
    if (typeof d === 'number' && typeof de === 'number') hist[i] = (d - de) * 2;
  }
  return { dif, dea, hist };
}

/**
 * 当前 MACD 状态。重点关注最近 `lookback` 天内是否发生金叉/死叉。
 *
 * 判定规则：
 * - golden_cross: 在最近 lookback 个有效 DIF/DEA 对里检测到 DIF 上穿 DEA
 * - death_cross : 在最近 lookback 个有效 DIF/DEA 对里检测到 DIF 下穿 DEA
 * - above_zero  : DIF − DEA > 0，但 lookback 窗口内无新交叉
 * - below_zero  : DIF − DEA < 0，同上
 * - unknown     : 数据不足（少于 2 个有效对）或最后差值恰好为 0
 */
export function macdLatestState(
  series: MacdSeries,
  lookback = 5
): { state: MacdState; daysSinceCross: number | null; lastHist: number | null } {
  const { dif, dea } = series;
  const N = dif.length;
  let prevDiff: number | null = null;
  let validCount = 0;
  let lastCrossValidIdx: number | null = null;
  let lastCrossType: 'up' | 'down' | null = null;
  let lastDiff: number | null = null;

  for (let i = 0; i < N; i++) {
    const d = dif[i];
    const de = dea[i];
    if (typeof d !== 'number' || typeof de !== 'number') continue;
    const diff = d - de;
    if (prevDiff !== null) {
      if (prevDiff <= 0 && diff > 0) {
        lastCrossValidIdx = validCount;
        lastCrossType = 'up';
      } else if (prevDiff >= 0 && diff < 0) {
        lastCrossValidIdx = validCount;
        lastCrossType = 'down';
      }
    }
    prevDiff = diff;
    lastDiff = diff;
    validCount += 1;
  }

  if (validCount < 2 || lastDiff === null) {
    return { state: 'unknown', daysSinceCross: null, lastHist: null };
  }

  const lastHist = lastDiff * 2;

  if (lastCrossValidIdx !== null) {
    // 距离交叉的天数 = 交叉发生之后的有效 DIF/DEA 对数量
    const daysSince = validCount - 1 - lastCrossValidIdx;
    if (daysSince <= lookback) {
      if (lastCrossType === 'up') return { state: 'golden_cross', daysSinceCross: daysSince, lastHist };
      return { state: 'death_cross', daysSinceCross: daysSince, lastHist };
    }
  }

  if (lastDiff > 0) return { state: 'above_zero', daysSinceCross: null, lastHist };
  if (lastDiff < 0) return { state: 'below_zero', daysSinceCross: null, lastHist };
  return { state: 'unknown', daysSinceCross: null, lastHist };
}

/* ------------------------------- Drawdown ------------------------------- */

/**
 * 累计最大回撤序列。`dd[i] = (values[i] − max(values[0..i])) / max(values[0..i]) × 100`
 * 最大值 ≤ 0 或当前值为 null 时输出 null。
 * 单调递增序列全部为 0。
 */
export function drawdownSeries(values: readonly (number | null | undefined)[]): (number | null)[] {
  const N = values.length;
  const out: (number | null)[] = new Array(N).fill(null);
  let peak = -Infinity;
  for (let i = 0; i < N; i++) {
    const raw = values[i];
    const v = raw === null || raw === undefined ? null : typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    if (v === null) {
      // 数据 hole：不更新 peak，输出 null
      continue;
    }
    if (v <= 0) {
      // 损坏数据（NAV ≤ 0 视为不可信）：输出 null，不更新 peak
      out[i] = null;
      continue;
    }
    if (v > peak) peak = v;
    if (peak <= 0) {
      out[i] = null;
      continue;
    }
    out[i] = ((v - peak) / peak) * 100;
  }
  return out;
}

/**
 * 当前回撤百分位：在历史回撤序列里，**比当前回撤更深的（数值更小的）** 历史占多少。
 *
 * 语义：当前净值回撤百分位 ∈ [0, 100]
 * - 100% = 当前是历史最深回撤（最便宜）
 * - 0%   = 当前没有任何历史比它更便宜（最贵）
 *
 * 公式：`#{i : dd[i] >= dd[last]} / N × 100`。所有回撤相等时（全部 0），返回 100%
 * 作为退化结果（"无法区分优劣"自然取上界）。
 *
 * 少于 1 个有效点返回 null。
 */
export function drawdownPercentile(ddSeries: readonly (number | null | undefined)[]): number | null {
  const valid: number[] = [];
  for (const v of ddSeries) {
    if (v === null || v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    valid.push(v);
  }
  if (valid.length === 0) return null;
  const last = valid[valid.length - 1]!;
  let countAtLeast = 0;
  for (const v of valid) {
    if (v >= last) countAtLeast += 1;
  }
  return (countAtLeast / valid.length) * 100;
}

/* ------------------------------- Top-level wrapper ------------------------------- */

/** MA250 偏离度（百分比）的内联计算。lastMa ≤ 0 / 缺数据 → null */
function calcDeviationPct(
  lastValue: number | null | undefined,
  lastMa: number | null | undefined
): number | null {
  if (typeof lastValue !== 'number' || !Number.isFinite(lastValue)) return null;
  if (typeof lastMa !== 'number' || !Number.isFinite(lastMa) || lastMa <= 0) return null;
  return ((lastValue - lastMa) / lastMa) * 100;
}

export interface FundIndicators {
  /** (curr − MA250) / MA250 × 100 */
  ma250Deviation: number | null;
  /** 当前 MACD 状态判定 */
  macdState: { state: MacdState; daysSinceCross: number | null; lastHist: number | null };
  /** 当前回撤百分位（0~100） */
  drawdownPercentile: number | null;
  /** usable 数据长度 ≥ 250（MA250 完全有效） */
  hasEnoughHistory: boolean;
  /** 经过 usableNavSeries 过滤后的净值序列（脱敏后的数据，调用方无需再过滤） */
  usableNavs: number[];
  /** usable 的日期序列（与 usableNavs 一一对应） */
  usableDates: string[];
}

/**
 * 一站式计算单只基金的三指标。
 *
 * 自动调用 `usableNavSeries` 过滤美股跟踪 QDII 的节假日复制 NAV。
 *
 * 注意：MA250 全序列、MACD 全序列、回撤全序列在内部计算后**不返回**——
 * UI 只关心三个标量（deviation / macdState / drawdownPercentile）+ 数据完整度。
 * 想拿完整序列请直接调 `sma()` / `macd()` / `drawdownSeries()`，本函数避免重复计算。
 */
export function computeFundIndicators(
  fund: Fund,
  navHistory: NavRecord[],
  mode: UsQdiiFilterMode = DEFAULT_US_QDII_FILTER_MODE
): FundIndicators {
  const usable = usableNavSeries(fund, navHistory, mode);
  const rawNavs = usable.map((r) => r.nav);

  // MA250 偏离度：只取最后一个有效值
  const ma250Arr = sma(rawNavs, 250);
  const lastMa = ma250Arr[ma250Arr.length - 1] ?? null;
  const dev = calcDeviationPct(rawNavs[rawNavs.length - 1], lastMa);

  // MACD：内部完整计算只为拿 macdState
  const macdState = macdLatestState(macd(rawNavs));

  // 回撤百分位：内部完整计算只为拿百分位
  const ddPct = drawdownPercentile(drawdownSeries(rawNavs));

  return {
    ma250Deviation: dev,
    macdState,
    drawdownPercentile: ddPct,
    hasEnoughHistory: rawNavs.length >= 250,
    usableNavs: toDenseNumbers(rawNavs),
    usableDates: usable.map((r) => r.date),
  };
}

/* ------------------------------- UI 文案 ------------------------------- */

/**
 * 三段统一的 Tooltip 中文文案。Dashboard 温度计 / FundDetail 三指标卡 / Settings 折叠面板
 * 都引用这里，确保措辞一致。文案末尾都指向「设置 → 技术指标说明」以引导用户查阅完整文档。
 */
export const INDICATOR_TOOLTIPS = {
  ma250:
    '过去 250 个交易日净值的简单移动均线。偏离度 = (现价 − MA250) / MA250 × 100%。' +
    '深度负偏离通常意味着低估机会，但需结合基本面与其他指标判断。' +
    '完整公式与解读见「设置 → 技术指标说明」。',
  macd:
    '12 日 EMA 减 26 日 EMA = DIF；DIF 的 9 日 EMA = DEA；柱 = (DIF − DEA) × 2。' +
    'DIF 上穿 DEA 为金叉（看多信号），下穿为死叉（看空信号）。' +
    '完整公式与解读见「设置 → 技术指标说明」。',
  drawdown:
    '从历史最高点回撤的幅度百分位：100% 表示当前净值与历史最便宜时相当（深度低估），' +
    '0% 表示当前净值高于历史上的任何时刻（估值偏贵）。百分位高通常对应较好的买入时机。' +
    '完整公式与解读见「设置 → 技术指标说明」。',
};
