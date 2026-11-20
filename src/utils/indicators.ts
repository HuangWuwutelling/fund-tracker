import type { Fund, NavRecord } from '../types';
import type { MacdState } from '../types';
import { usableNavSeries, type UsQdiiFilterMode, DEFAULT_US_QDII_FILTER_MODE } from './navPair';

/* ============================================================
 *  技术指标：MA250 偏离度 / MACD / 净值回撤百分位
 *  纯函数，testable。所有函数假设上游已用 usableNavSeries 过滤
 *  —— 调用方传入的 navHistory 应为已过滤后的 NavRecord[]。
 *  Mirror calculator.ts: typeof x !== 'number' || !Number.isFinite(x) 防御式
 *
 *  口径（2026-11 审计修正）：三项指标全部基于**后复权（分红再投资）序列**
 *  buildAdjustedSeries()，而非单位净值——分红除息日单位净值跳水会让
 *  MA250 系统性偏低、MACD 误判死叉、回撤虚深（行业惯例：基金技术指标
 *  应使用复权净值，见雪球/知乎量化投研等资料）。
 * ============================================================ */

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
 * 当前回撤百分位（0~100）：历史中**比当前更贵**（回撤更浅）的时点占比，
 * 与当前持平的时点各按半票计（mid-rank，统计标准的平局处理）。
 *
 * 语义：
 * - 100% ≈ 当前比历史上任何时刻都便宜（当前是历史最深回撤）
 * - 0%   = 当前比历史上任何时刻都贵（通常 = 处于历史最高点附近）
 * - 全部持平（如一路创新高的基金）→ 50% 中性
 *
 * 为什么用 mid-rank 而不是 `#{v >= last}/N`：后者把"与当前持平"的历史
 * 全部计为"比当前贵"。基金创新高的日子（当前 dd=0）若历史上 x% 的时间
 * 也在高点，读数会被虚高 x/2 个百分点——单边长牛基金会在历史最高点
 * 显示虚假的"接近最便宜"。mid-rank 是分位数统计的标准平局处理。
 *
 * 公式：`(#{v > last} + 0.5 × #{v == last}) / N × 100`。
 * 理论上界 (N-1)/N+0.5/N（唯一最深），N 为真实历史长度（数百期以上）时 ≈ 100%。
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
  let shallower = 0; // 回撤更浅 = 更贵
  let equal = 0;
  for (const v of valid) {
    if (v > last) shallower += 1;
    else if (v === last) equal += 1;
  }
  return ((shallower + 0.5 * equal) / valid.length) * 100;
}

/* ------------------------------- 复权序列 ------------------------------- */

export interface AdjustedSeries {
  /** 后复权（分红再投资）净值序列，与输入等长 */
  values: number[];
  /** 检测到的分红事件数（accNav − nav 差值跳变次数） */
  dividendEvents: number;
}

/**
 * 把可用净值序列重建为**后复权（分红再投资）净值**序列。
 *
 * 背景：MA250 / MACD / 回撤若直接用单位净值，分红除息日会产生虚假的净值悬崖
 * （单位净值跳水但投资者并未亏损；行业惯例基金技术指标应用复权净值，
 * 见雪球 / 知乎量化投研等资料）。标准构造：
 *   adj(t) = adj(t-1) × (nav(t) + div(t)) / nav(t-1)
 * 其中 div(t) 为 t 日每份分红。pingzhongdata 不提供分红事件列表，但（修复
 * accNav 口径后）提供真实累计净值：非分红日 accNav − nav 的差值恒定，
 * 分红日该差值跳增的量 ≈ 每份分红（accNav 除息日不变、nav 跳水）。
 * 因此用差值跳变检测分红：
 *   div(t) = (acc(t) − nav(t)) − (acc(t-1) − nav(t-1))，> 0.001 视为分红
 * （nav / acc 均为 4 位小数，独立舍入噪声 ≤ 0.0004，阈值留 2.5 倍余量）。
 *
 * 注意：
 * - 旧版数据 accNav ≡ nav（旧代码写死的假累计净值）→ 检测不到分红，
 *   复权序列退化为单位净值原样（与修复前行为一致）。分过红的基金要获得
 *   完整复权，请在 Settings 里重置该基金净值历史后重新拉取。
 * - 序列整体是乘性缩放的相对量——MA250 偏离度 / MACD / 回撤都是
 *   within-fund 的比率型指标，缩放不影响其含义。
 * - 负跳变（数据异常）clamp 为 0，防止复权因子反向爆炸；gap ≤ 0
 *   （acc < nav，数据损坏）时同样不识别为分红，双重防御。
 */
export function buildAdjustedSeries(usable: NavRecord[]): AdjustedSeries {
  const values: number[] = [];
  let adj = 0;
  let prevGap = 0;
  let dividendEvents = 0;
  for (let i = 0; i < usable.length; i++) {
    const r = usable[i]!;
    if (i === 0) {
      adj = r.nav;
      prevGap = r.accNav - r.nav;
      values.push(adj);
      continue;
    }
    const gap = r.accNav - r.nav;
    const div = gap - prevGap;
    prevGap = gap;
    const prevNav = usable[i - 1]!.nav;
    // nav 异常（≤0 / 非有限）时保持前值，防复权因子爆炸
    if (!(prevNav > 0) || !(r.nav > 0) || !Number.isFinite(r.nav)) {
      values.push(adj);
      continue;
    }
    const safeDiv = Number.isFinite(div) && div > 0.001 && gap > 0 ? div : 0;
    if (safeDiv > 0) dividendEvents += 1;
    adj = (adj * (r.nav + safeDiv)) / prevNav;
    values.push(adj);
  }
  return { values, dividendEvents };
}

/**
 * 把复权序列映射回**单位净值刻度**的缩放系数 k = nav末 / adj末。
 *
 * 背景：FundDetail 的 NAV 图主折线画的是「单位净值」，而 MA250 指标卡算的是
 * **分红复权**序列——两个口径直接混用会让同一屏出现"图上 MA250 明显偏低、
 * 卡片偏离度却接近 0%"的自相矛盾（分红基金的复权因子是乘性缩放，不是平移）。
 *
 * 用末点的比值 k 把复权 MA 线缩回净值刻度：缩放后末点恰好等于单位净值末点，
 * 因此图上 MA250 与卡片偏离度**同口径**（无分红基金 adj ≡ nav → k = 1，
 * 图形与旧版逐点一致，零视觉变化）。
 *
 * 退化：序列为空 / 长度不一致 / 末点非正或非有限 → 返回 1（不缩放，退回原行为）。
 */
export function navScaleFactor(
  adjusted: readonly number[],
  navs: readonly number[],
): number {
  if (adjusted.length === 0 || adjusted.length !== navs.length) return 1;
  const adjLast = adjusted[adjusted.length - 1]!;
  const navLast = navs[navs.length - 1]!;
  if (!Number.isFinite(adjLast) || !Number.isFinite(navLast)) return 1;
  if (!(adjLast > 0) || !(navLast > 0)) return 1;
  return navLast / adjLast;
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
  /** (curr − MA250) / MA250 × 100，基于复权序列 */
  ma250Deviation: number | null;
  /** 当前 MACD 状态判定（复权序列） */
  macdState: { state: MacdState; daysSinceCross: number | null; lastHist: number | null };
  /** 当前回撤百分位（0~100，复权序列 + mid-rank 平局） */
  drawdownPercentile: number | null;
  /** usable 数据长度 ≥ 250（MA250 完全有效） */
  hasEnoughHistory: boolean;
  /** 检测到的分红事件数；0 = 无分红或 accNav 尚为旧版假数据（≈ 单位净值） */
  dividendEvents: number;
  /** 复权后的净值序列（脱敏后的数据，调用方无需再过滤） */
  adjustedNavs: number[];
  /** usable 的日期序列（与 adjustedNavs 一一对应） */
  usableDates: string[];
}

/**
 * 一站式计算单只基金的三指标。
 *
 * 自动调用 `usableNavSeries` 过滤美股跟踪 QDII 的节假日复制 NAV，
 * 再经 `buildAdjustedSeries` 重建分红复权序列——三项指标全部基于
 * **后复权（分红再投资）口径**，分红除息不再产生虚假信号。
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
  const { values: adjustedNavs, dividendEvents } = buildAdjustedSeries(usable);

  // MA250 偏离度：只取最后一个有效值
  const ma250Arr = sma(adjustedNavs, 250);
  const lastMa = ma250Arr[ma250Arr.length - 1] ?? null;
  const dev = calcDeviationPct(adjustedNavs[adjustedNavs.length - 1], lastMa);

  // MACD：内部完整计算只为拿 macdState
  const macdState = macdLatestState(macd(adjustedNavs));

  // 回撤百分位：内部完整计算只为拿百分位
  const ddPct = drawdownPercentile(drawdownSeries(adjustedNavs));

  return {
    ma250Deviation: dev,
    macdState,
    drawdownPercentile: ddPct,
    hasEnoughHistory: adjustedNavs.length >= 250,
    dividendEvents,
    adjustedNavs,
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
    '过去 250 个交易日**分红复权净值**的简单移动均线（分红除息不再产生虚假跳变）。' +
    '偏离度 = (现值 − MA250) / MA250 × 100%。深度负偏离通常意味着低估机会，' +
    '但需结合基本面与其他指标判断；对债券等低波动基金，±5% 档位内的偏离意义有限。' +
    '完整公式与解读见「设置 → 技术指标说明」。',
  macd:
    '12 日 EMA 减 26 日 EMA = DIF；DIF 的 9 日 EMA = DEA；柱 = (DIF − DEA) × 2。' +
    '基于分红复权净值计算。DIF 上穿 DEA 为金叉（看多信号），下穿为死叉（看空信号）。' +
    '完整公式与解读见「设置 → 技术指标说明」。',
  drawdown:
    '分红复权净值从历史最高点回撤的幅度百分位：100% 表示当前比历史上任何时刻都便宜' +
    '（深度低估），0% 表示当前与历史最高点相当（估值偏贵）；与历史持平的时点各计半票' +
    '（mid-rank 平局处理）。百分位高通常对应较好的买入时机。' +
    '完整公式与解读见「设置 → 技术指标说明」。',
};
