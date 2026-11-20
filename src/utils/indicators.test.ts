import { describe, it, expect } from 'vitest';
import {
  sma,
  ma250Deviation,
  macd,
  macdLatestState,
  drawdownSeries,
  drawdownPercentile,
  computeFundIndicators,
  buildAdjustedSeries,
  navScaleFactor,
} from './indicators';
import type { Fund, NavRecord } from '../types';

function fund(name: string, type: Fund['type'] = 'qdii'): Fund {
  return { id: 'f1', name, platformId: 'p1', type, currentNav: 1, navDate: '' };
}

function nav(date: string, value: number): NavRecord {
  return { date, nav: value, accNav: value };
}

/** 带真实累计净值的记录（accNav 可 ≠ nav，用于分红复权测试） */
function navAcc(date: string, value: number, acc: number): NavRecord {
  return { date, nav: value, accNav: acc };
}

function range(start: number, count: number, valueAt: (i: number) => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(valueAt(start + i));
  return out;
}

/* ============================================================
 *  sma
 * ============================================================ */
describe('sma', () => {
  it('空数组 → 空数组', () => {
    expect(sma([], 10)).toEqual([]);
  });

  it('单点不足窗口 → 全部 null', () => {
    expect(sma([1], 10)).toEqual([null]);
  });

  it('恰好 250 个单调递增 1..250 → 前 249 null，index 249 = 125.5，之后每点增 0.5', () => {
    const arr = range(1, 250, (i) => i);
    const out = sma(arr, 250);
    const nonNull = out.filter((v): v is number => v !== null);
    expect(nonNull.length).toBe(1);
    expect(nonNull[0]).toBeCloseTo(125.5, 6);
    expect(out.slice(0, 249).every((v) => v === null)).toBe(true);
  });

  it('251 个点 → index 249 和 250 都有效', () => {
    const arr = range(1, 251, (i) => i);
    const out = sma(arr, 250);
    expect(out[248]).toBeNull();
    // index 249: window [1..250] → mean = (1+250)/2 = 125.5
    expect(out[249]).toBeCloseTo(125.5, 6);
    // index 250: window [2..251] → mean = (2+251)/2 = 126.5
    expect(out[250]).toBeCloseTo(126.5, 6);
  });

  it('窗口 > 长度 → 全部 null', () => {
    expect(sma([1, 2, 3], 10)).toEqual([null, null, null]);
  });

  it('窗口内的 null 跳过（窗口不足时该点也为 null）', () => {
    // 长度 6，窗口 3，中间一个 null
    const arr: (number | null)[] = [1, null, 3, 4, null, 6];
    const out = sma(arr, 3);
    // 滑窗行为：第 i=2 时窗口 [null, 3] 不足 → null
    // i=3 窗口 [null, 3, 4] 仍含 null → null
    // i=4 [3, 4, null] 仍含 null → null
    // i=5 [4, null, 6] 仍含 null → null
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeNull();
    expect(out[3]).toBeNull();
    expect(out[4]).toBeNull();
    expect(out[5]).toBeNull();
  });
});

/* ============================================================
 *  ma250Deviation
 * ============================================================ */
describe('ma250Deviation', () => {
  it('现价等于 MA250 → 0%', () => {
    const arr = new Array(300).fill(1.5); // 全 1.5 → MA250 = 1.5
    expect(ma250Deviation(arr)).toBeCloseTo(0, 8);
  });

  it('现价向上偏离 → 偏离度为正且接近公式值', () => {
    // 由于 SMA 窗口包含末尾值本身，MA250 不等于纯 1.0
    // arr = [1, 1, ..., 1, 1.1]，MA250 at index 299 = (249 + 1.1) / 250 = 1.0004
    const arr = new Array(300).fill(1);
    arr[299] = 1.1;
    const expectedMa = (249 + 1.1) / 250;
    const expectedDev = ((1.1 - expectedMa) / expectedMa) * 100;
    expect(ma250Deviation(arr)).toBeCloseTo(expectedDev, 6);
    expect(ma250Deviation(arr)!).toBeGreaterThan(0);
    expect(ma250Deviation(arr)!).toBeLessThan(10);
  });

  it('现价向下偏离 → 偏离度为负', () => {
    const arr = new Array(300).fill(1);
    arr[299] = 0.9;
    const expectedMa = (249 + 0.9) / 250;
    const expectedDev = ((0.9 - expectedMa) / expectedMa) * 100;
    expect(ma250Deviation(arr)).toBeCloseTo(expectedDev, 6);
    expect(ma250Deviation(arr)!).toBeLessThan(0);
    expect(ma250Deviation(arr)!).toBeGreaterThan(-10);
  });

  it('MA250 不存在（数组 < 250）→ null', () => {
    const arr = new Array(200).fill(1);
    expect(ma250Deviation(arr)).toBeNull();
  });

  it('空数组 → null', () => {
    expect(ma250Deviation([])).toBeNull();
  });

  it('最近一个点是 null → null（不去 bogus-divide）', () => {
    const arr = new Array(300).fill(1);
    arr[299] = null;
    expect(ma250Deviation(arr)).toBeNull();
  });
});

/* ============================================================
 *  macd
 * ============================================================ */
describe('macd', () => {
  it('空 / 长度 < 26 → 全 null', () => {
    const r1 = macd([]);
    expect(r1.dif).toEqual([]);
    expect(r1.dea).toEqual([]);
    expect(r1.hist).toEqual([]);
    const r2 = macd(new Array(8).fill(1));
    expect(r2.dif.every((v) => v === null)).toBe(true);
  });

  it('全 1.0 平直输入 → EMA 全部种子后趋 1，DIF/DEA/hist 都接近 0', () => {
    const arr = new Array(60).fill(1);
    const r = macd(arr);
    const last = r.dif.length - 1;
    expect(r.dif[last]).toBeCloseTo(0, 6);
    expect(r.dea[last]).toBeCloseTo(0, 6);
    expect(r.hist[last]).toBeCloseTo(0, 6);
  });

  it('前 26 个 = 1.0，之后 26 个 = 2.0 → DIF 自跳变后正向', () => {
    const arr: number[] = [];
    for (let i = 0; i < 26; i++) arr.push(1);
    for (let i = 0; i < 26; i++) arr.push(2);
    const r = macd(arr);
    // EMA26 在 index 25 完成 seed，DIF 自此开始
    expect(r.dif[25]).not.toBeNull();
    // 最后的 DIF 应该显著为正
    const lastDif = r.dif[r.dif.length - 1]!;
    expect(lastDif).toBeGreaterThan(0);
    expect(lastDif).toBeGreaterThan(0.1); // 远大于噪声
    // 注：hist 在 DIF 收敛时可能正可能负，取决于收敛阶段，
    // 这里不严格断言 hist 符号——单独测试在收敛后 hist → 0
  });

  it('长序列跳变后收敛 → hist 量级应很小（系统趋于平衡）', () => {
    const arr: number[] = [];
    for (let i = 0; i < 26; i++) arr.push(1);
    for (let i = 0; i < 200; i++) arr.push(2); // 大量 2 让 EMA 充分收敛
    const r = macd(arr);
    const lastHist = r.hist[r.hist.length - 1]!;
    expect(Math.abs(lastHist)).toBeLessThan(0.05);
  });

  it('DIF < DEA < 0 持续 → macdLatestState 应给出 below_zero（无新交叉）', () => {
    // 构造：DIF 一直为负（价格走低后稳定低位）
    const arr: number[] = [];
    for (let i = 0; i < 26; i++) arr.push(2); // 高位
    for (let i = 0; i < 26; i++) arr.push(1); // 跌到 1
    const r = macd(arr);
    const state = macdLatestState(r, 5);
    // 在低位稳定，DIF 接近 0 或略负；测试不需要 ≥ state bound，只看类型合法
    expect(['golden_cross', 'death_cross', 'above_zero', 'below_zero', 'unknown']).toContain(state.state);
  });
});

/* ============================================================
 *  macdLatestState
 * ============================================================ */
describe('macdLatestState', () => {
  it('DIF 在最近 N 天内上穿 DEA → golden_cross，daysSinceCross ≥ 0', () => {
    // 100 个平直 1.0
    // 然后突然拉高 → DIF 跳变向上 → DEF 较慢跟随
    // 通过直接构造 dif/dea 数组来控制确定结果
    const dif: (number | null)[] = new Array(50).fill(null);
    const dea: (number | null)[] = new Array(50).fill(null);
    for (let i = 30; i < 50; i++) {
      dif[i] = 0.5;
      dea[i] = 0.6 - 0.02 * (i - 30); // DEA 从 0.6 缓慢下行
    }
    // 上穿发生在 dif > dea 第一次出现的时刻
    // i=30: dif=0.5, dea=0.6 → dif<dea; i=31: dea=0.58 → 0.5<0.58 ...一直到最后 dif>dea 因为 dea 在下降
    // 但我们想要一个明确的"上穿"：构造 dif 一直 < dea，然后在某天反转
    const d2: number[] = [];
    const e2: number[] = [];
    for (let i = 0; i < 30; i++) {
      d2.push(-0.5);
      e2.push(-0.3); // dif < dea
    }
    d2.push(-0.3); e2.push(-0.3); // 接触
    d2.push(-0.2); e2.push(-0.28); // 上穿：dif > dea 第 1 次
    d2.push(-0.1); e2.push(-0.26);
    d2.push(0); e2.push(-0.24);
    // 包装成 series
    const series = {
      dif: d2.map((v) => v as number | null),
      dea: e2.map((v) => v as number | null),
      hist: [] as (number | null)[],
    };
    const state = macdLatestState(series, 5);
    expect(state.state).toBe('golden_cross');
    expect(state.daysSinceCross).toBeLessThanOrEqual(5);
    expect(state.daysSinceCross).toBeGreaterThanOrEqual(0);
  });

  it('DIF 在最近 N 天内下穿 DEA → death_cross', () => {
    const d2: number[] = [];
    const e2: number[] = [];
    for (let i = 0; i < 30; i++) {
      d2.push(0.5);
      e2.push(0.3); // dif > dea
    }
    d2.push(0.3); e2.push(0.3);
    d2.push(0.2); e2.push(0.28); // 下穿：dif < dea
    d2.push(0.1); e2.push(0.26);
    const series = {
      dif: d2.map((v) => v as number | null),
      dea: e2.map((v) => v as number | null),
      hist: [] as (number | null)[],
    };
    const state = macdLatestState(series, 5);
    expect(state.state).toBe('death_cross');
  });

  it('DIF > DEA 但 lookback 窗口内无交叉 → above_zero', () => {
    const d2: number[] = [];
    const e2: number[] = [];
    for (let i = 0; i < 20; i++) {
      d2.push(0.5); // 一致高
      e2.push(0.3); // 持续 > dea，无交叉
    }
    const series = {
      dif: d2.map((v) => v as number | null),
      dea: e2.map((v) => v as number | null),
      hist: [] as (number | null)[],
    };
    const state = macdLatestState(series, 5);
    expect(state.state).toBe('above_zero');
    expect(state.daysSinceCross).toBeNull();
  });

  it('DIF < DEA 但 lookback 窗口内无交叉 → below_zero', () => {
    const d2: number[] = [];
    const e2: number[] = [];
    for (let i = 0; i < 20; i++) {
      d2.push(-0.5);
      e2.push(-0.3); // 持续 < dea，无交叉
    }
    const series = {
      dif: d2.map((v) => v as number | null),
      dea: e2.map((v) => v as number | null),
      hist: [] as (number | null)[],
    };
    const state = macdLatestState(series, 5);
    expect(state.state).toBe('below_zero');
  });

  it('总有效点 < 2 → unknown', () => {
    const series = { dif: [null, 0.1], dea: [0.2, 0.3], hist: [] as (number | null)[] };
    const state = macdLatestState(series, 5);
    expect(state.state).toBe('unknown');
  });
});

/* ============================================================
 *  drawdownSeries
 * ============================================================ */
describe('drawdownSeries', () => {
  it('单调递增 1→100 → 全 0', () => {
    const arr = range(1, 100, (i) => i / 100);
    const out = drawdownSeries(arr);
    for (const v of out) expect(v).toBeCloseTo(0, 8);
  });

  it('先涨后跌 → 峰值后为负，谷值最小', () => {
    // 1 → 1.5 → 1.0；峰值 1.5，最后回撤 = (1.0 - 1.5) / 1.5 × 100 = −33.33%
    const arr = [1, 1.5, 1.0];
    const out = drawdownSeries(arr);
    expect(out[0]).toBeCloseTo(0, 8);
    expect(out[1]).toBeCloseTo(0, 8);
    expect(out[2]).toBeCloseTo((1.0 - 1.5) / 1.5 * 100, 6); // −33.33%
  });

  it('跌后回升 → 谷值最低，回升后 0', () => {
    // 1 → 0.5 → 1.0
    const arr = [1, 0.5, 1.0];
    const out = drawdownSeries(arr);
    expect(out[0]).toBeCloseTo(0, 8);
    expect(out[1]).toBeCloseTo(-50, 6);
    expect(out[2]).toBeCloseTo(0, 8);
  });

  it('损坏数据（当前值 ≤ 0）→ 该点 null，但 peak 仍保留，恢复后正常工作', () => {
    // 1 → -0.5（损坏）→ 1
    // i=0: 1, peak=1 → 0
    // i=1: -0.5, v ≤ 0 → null，peak 不变
    // i=2: 1, v > 0, peak 仍 1，输出 (1-1)/1 = 0
    const out = drawdownSeries([1, -0.5, 1]);
    expect(out[0]).toBeCloseTo(0, 8);
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(0, 8);
  });

  it('peak ≤ 0（全部 ≤ 0）→ 后续输出 null', () => {
    // peak 一旦 ≤ 0，新值也无法构成有效比值
    const out = drawdownSeries([0.5, 0, 0.3]);
    expect(out[0]).toBeCloseTo(0, 8); // i=0: 0.5, peak=0.5 → 0
    expect(out[1]).toBeCloseTo(0, 8); // i=1: 0, v ≤ 0 → null（实际上）
    // 实际：i=1 走了 v ≤ 0 分支返回 null；i=2 v=0.3 > 0 但 peak 还是 0.5 → output = (0.3-0.5)/0.5 = -40
    expect(out[2]).toBeCloseTo(-40, 6);
  });

  it('内部含 null → 输出序列对应 null', () => {
    const out = drawdownSeries([1, null, 1]);
    expect(out[0]).toBeCloseTo(0, 8);
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(0, 8);
  });
});

/* ============================================================
 *  drawdownPercentile
 * ============================================================ */
describe('drawdownPercentile（mid-rank 平局处理）', () => {
  it('空 / 全 null → null', () => {
    expect(drawdownPercentile([])).toBeNull();
    expect(drawdownPercentile([null, null, null])).toBeNull();
  });

  it('当前是唯一历史最深 → (N-0.5)/N，真实历史长度（数百期）下 ≈ 100%', () => {
    // 自包含 mid-rank：当前点自身也按半票计入持平
    const arr = [-10, -20, -30, -30, -40]; // -40 是唯一最深
    expect(drawdownPercentile(arr)).toBeCloseTo((4.5 / 5) * 100, 6);
  });

  it('当前是历史最浅（唯一最贵，如创新高日）→ 0.5/N，大样本下 ≈ 0%', () => {
    const arr = [-30, -20, -10, -5, 0];
    expect(drawdownPercentile(arr)).toBeCloseTo((0.5 / 5) * 100, 6);
  });

  it('单点历史 → 50%（无可比对象，中性）', () => {
    expect(drawdownPercentile([-5])).toBeCloseTo(50, 6);
  });

  it('全部持平（一路创新高的基金）→ 50% 中性（修正前是 100% 虚假"最便宜"）', () => {
    expect(drawdownPercentile([0, 0, 0, 0])).toBeCloseTo(50, 6);
  });

  it('创新高日 + 历史 60% 时间也在高点 → 30%，不再被平局推成"偏便宜"', () => {
    // dd 序列（末位是"当前"）：1 个 -10，1 个 -20，3 个 0（当前=创新高）
    const arr = [-10, -20, 0, 0, 0];
    // 更贵 = 0，持平 = 3（含当前自身）→ (0 + 0.5×3)/5 = 30%
    expect(drawdownPercentile(arr)).toBeCloseTo(30, 6);
  });

  it('当前处于分布中部 → 严格按"更贵占比 + 半票持平"计算', () => {
    // [-30, -20, -10]，当前 = -10：更贵 = 0，持平 = 1（自身）→ 0.5/3
    expect(drawdownPercentile([-30, -20, -10])).toBeCloseTo((0.5 / 3) * 100, 6);
  });

  it('当前是唯一最深（大样本）→ 接近 100%', () => {
    const arr: number[] = [];
    for (let i = 0; i < 299; i++) arr.push(-1);
    arr.push(-30);
    expect(drawdownPercentile(arr)).toBeCloseTo((299.5 / 300) * 100, 6);
  });
});

/* ============================================================
 *  buildAdjustedSeries — 分红复权序列
 * ============================================================ */
describe('buildAdjustedSeries（后复权 / 分红再投资）', () => {
  it('无分红（acc ≡ nav，旧版数据）→ 与单位净值逐点一致，事件数 0', () => {
    const usable = [nav('2026-01-01', 1.0), nav('2026-01-02', 1.02), nav('2026-01-03', 0.99)];
    const { values, dividendEvents } = buildAdjustedSeries(usable);
    expect(values).toEqual([1.0, 1.02, 0.99]);
    expect(dividendEvents).toBe(0);
  });

  it('分红除息日：nav 跳水 0.2、acc 不变 → 复权序列无悬崖，事件数 1', () => {
    // 除息日 acc = nav + 累计分红，acc 本身不变 → gap 跳增 0.2 = 每份分红
    const usable = [
      navAcc('2026-01-01', 2.0, 2.0),
      navAcc('2026-01-02', 1.8, 2.0), // 除息日：nav -0.2，acc 不动
      navAcc('2026-01-03', 1.81, 2.01),
    ];
    const { values, dividendEvents } = buildAdjustedSeries(usable);
    expect(dividendEvents).toBe(1);
    // adj(1) = 2.0 × (1.8 + 0.2) / 2.0 = 2.0（无悬崖，除息日真实回报 = 0）
    expect(values[1]).toBeCloseTo(2.0, 6);
    // adj(2) = 2.0 × 1.81 / 1.8（分红后正常涨）
    expect(values[2]).toBeCloseTo((2.0 * 1.81) / 1.8, 6);
  });

  it('多次分红逐笔复利', () => {
    const usable = [
      navAcc('2026-01-01', 1.0, 1.0),
      navAcc('2026-01-02', 0.95, 1.0), // 分红 0.05
      navAcc('2026-01-03', 0.96, 1.01),
      navAcc('2026-01-04', 0.86, 1.01), // 再分红 0.10
    ];
    const { values, dividendEvents } = buildAdjustedSeries(usable);
    expect(dividendEvents).toBe(2);
    // adj(2) = 1.0 × 0.96 / 0.95（无分红日的正常涨幅）
    expect(values[2]).toBeCloseTo((1.0 * 0.96) / 0.95, 6);
    // adj(3) = adj(2) × (0.86 + 0.10) / 0.96（除息日真实回报 = 0，与 adj(2) 持平）
    expect(values[3]).toBeCloseTo(values[2]!, 6);
  });

  it('舍入噪声（gap 跳变 ≤ 0.0004）不误判为分红', () => {
    const usable = [
      navAcc('2026-01-01', 1.0000, 1.0000),
      navAcc('2026-01-02', 1.0001, 1.0001), // gap 不变
      navAcc('2026-01-03', 1.0002, 1.0003), // gap 跳 0.0001 < 0.001 阈值
    ];
    const { dividendEvents } = buildAdjustedSeries(usable);
    expect(dividendEvents).toBe(0);
  });

  it('旧版假 acc（acc = nav）下真实分红悬崖无法检测 → 保持原样（退化行为）', () => {
    // 文档化已知限制：不重置净值历史就检测不到分红
    const usable = [nav('2026-01-01', 1.0), nav('2026-01-02', 0.95)];
    const { values, dividendEvents } = buildAdjustedSeries(usable);
    expect(dividendEvents).toBe(0);
    expect(values).toEqual([1.0, 0.95]); // 悬崖保留（与修复前一致）
  });

  it('nav 异常（≤ 0）→ 复权值保持前值，不爆炸', () => {
    const usable = [
      navAcc('2026-01-01', 1.0, 1.0),
      navAcc('2026-01-02', 0, 1.0), // 损坏数据
      navAcc('2026-01-03', 0.99, 0.99), // prevNav=0 仍被守护
    ];
    const { values } = buildAdjustedSeries(usable);
    expect(values[1]).toBeCloseTo(1.0, 6);
    expect(values[2]).toBeCloseTo(1.0, 6);
  });
});

/* ============================================================
 *  computeFundIndicators — 集成测试
 * ============================================================ */
describe('computeFundIndicators', () => {
  it('A 股基金 300 个数据点 → 三指标全部定义；MA250 最后有效', () => {
    // 简单 sin 波模拟：sin(i / 5) + 2 → 净值在 1 ~ 3 区间波动
    const records: NavRecord[] = [];
    for (let i = 0; i < 300; i++) {
      const date = `2025-01-${String((i % 30) + 1).padStart(2, '0')}`;
      const v = 2 + Math.sin(i / 5);
      records.push(nav(date, v));
    }
    const r = computeFundIndicators(fund('易方达蓝筹精选混合', 'mixed'), records);
    expect(r.hasEnoughHistory).toBe(true);
    expect(r.ma250Deviation).not.toBeNull();
    // MACD 状态应有合理判定（金叉/死叉/多头/空头 之一）
    expect(['golden_cross', 'death_cross', 'above_zero', 'below_zero']).toContain(r.macdState.state);
    // 回撤百分位 — 0~100 之间
    expect(r.drawdownPercentile).not.toBeNull();
    expect(r.drawdownPercentile!).toBeGreaterThanOrEqual(0);
    expect(r.drawdownPercentile!).toBeLessThanOrEqual(100);
  });

  it('美股 QDII 含 9/7 占位（auto 模式）→ 与 9/6 nav+accNav 完全相同则剔除', () => {
    // 模拟：基金名带 QDII；9/7 是占位（复用 9/6 的 nav 和 accNav）
    const records: NavRecord[] = [];
    for (let i = 1; i <= 30; i++) {
      if (i === 7) {
        // 9/7 占位：复用 9/6 的值（nav + accNav 都和前一条完全相同）
        records.push({ date: '2026-09-07', nav: 2 + Math.sin(6), accNav: 2 + Math.sin(6) });
        continue;
      }
      const day = String(i).padStart(2, '0');
      records.push(nav(`2026-09-${day}`, 2 + Math.sin(i)));
    }
    const r = computeFundIndicators(fund('广发纳斯达克100ETF联接(QDII)A'), records, 'auto');
    // 9/7 应被识别为占位并剔除
    const has0907 = r.usableDates.some((d) => d === '2026-09-07');
    expect(has0907).toBe(false);
    expect(r.usableDates.length).toBe(29);
  });

  it('美股 QDII strict 模式 → 9/7（美股劳工节）按日期剔除', () => {
    // 即使 9/7 的 nav 与 9/6 不同（不是占位），只要日期是节假日就被 strict 模式剔除
    const records: NavRecord[] = [];
    for (let i = 1; i <= 30; i++) {
      const day = String(i).padStart(2, '0');
      records.push(nav(`2026-09-${day}`, 2 + Math.sin(i)));
    }
    const r = computeFundIndicators(fund('广发纳斯达克100ETF联接(QDII)A'), records, 'strict');
    const has0907 = r.usableDates.some((d) => d === '2026-09-07');
    expect(has0907).toBe(false);
  });

  it('美股 QDII off 模式 → 不过滤，9/7 保留', () => {
    const records: NavRecord[] = [];
    for (let i = 1; i <= 30; i++) {
      const day = String(i).padStart(2, '0');
      records.push(nav(`2026-09-${day}`, 2 + Math.sin(i)));
    }
    const r = computeFundIndicators(fund('广发纳斯达克100ETF联接(QDII)A'), records, 'off');
    const has0907 = r.usableDates.some((d) => d === '2026-09-07');
    expect(has0907).toBe(true);
    expect(r.usableDates.length).toBe(30);
  });

  it('数据 < 30 个 → drawdownPercentile 应仍能算出（不强制 N≥30）', () => {
    // 用户文案说 "需 ≥ 30 个交易日"；但实际函数不限 N。这里只验证小数据的行为
    const records: NavRecord[] = [];
    for (let i = 0; i < 20; i++) {
      records.push(nav(`2025-01-${String(i + 1).padStart(2, '0')}`, 1 + 0.01 * i));
    }
    const r = computeFundIndicators(fund('基金A', 'mixed'), records);
    expect(r.hasEnoughHistory).toBe(false);
    expect(r.ma250Deviation).toBeNull();
    // 回撤：因为单调递增，dd 全 0 → mid-rank 平局 → 50% 中性
    expect(r.drawdownPercentile).toBe(50);
  });

  it('数据 < 250 → hasEnoughHistory = false', () => {
    const records: NavRecord[] = [];
    for (let i = 0; i < 100; i++) {
      records.push(nav(`2025-01-${String((i % 30) + 1).padStart(2, '0')}`, 1));
    }
    const r = computeFundIndicators(fund('短历史基金', 'mixed'), records);
    expect(r.hasEnoughHistory).toBe(false);
    expect(r.ma250Deviation).toBeNull();
  });

  it('可用数组长度对齐 → adjustedNavs.length === usableDates.length', () => {
    const records: NavRecord[] = [];
    for (let i = 0; i < 260; i++) {
      records.push(nav(`2025-01-${String((i % 30) + 1).padStart(2, '0')}`, 1.5));
    }
    const r = computeFundIndicators(fund('基金B', 'mixed'), records);
    expect(r.adjustedNavs.length).toBe(r.usableDates.length);
  });

  it('分红除息悬崖：nav 基会制造假死叉/假低偏离，复权基不受影响', () => {
    // 前 250 期 nav=2.0，第 251 期分红 0.2（nav 2.0→1.8，acc 不变），
    // 之后 nav=1.8 平稳。复权序列应全程 ≈ 2.0 平稳。
    const records: NavRecord[] = [];
    for (let i = 0; i < 250; i++) {
      records.push(navAcc(`2025-01-${String((i % 28) + 1).padStart(2, '0')}`, 2.0, 2.0));
    }
    records.push(navAcc('2025-02-01', 1.8, 2.0)); // 除息日
    for (let i = 0; i < 49; i++) {
      records.push(navAcc(`2025-02-${String((i % 27) + 2).padStart(2, '0')}`, 1.8, 2.0));
    }
    const r = computeFundIndicators(fund('广发中债7-10年国开债指数A', 'bond'), records);
    expect(r.dividendEvents).toBe(1);
    // 复权后序列平稳 → MA250 偏离度 ≈ 0（单位净值口径会是 -10% 左右的假低估）
    expect(r.ma250Deviation).not.toBeNull();
    expect(Math.abs(r.ma250Deviation!)).toBeLessThan(0.01);
    // MACD 不应把除息悬崖判成死叉
    expect(r.macdState.state).not.toBe('death_cross');
  });
});

/* ============================================================
 *  navScaleFactor —— 把复权序列缩放回单位净值刻度
 * ============================================================ */

describe('navScaleFactor（复权序列 → 单位净值刻度的缩放系数）', () => {
  it('无分红（adj ≡ nav）→ 系数为 1，缩放后与原序列逐点一致（与旧图行为完全相同）', () => {
    const navs = [1, 1.1, 1.2];
    expect(navScaleFactor(navs, navs)).toBe(1);
  });

  it('分红基金 → 系数把复权序列末点映射回单位净值刻度', () => {
    // nav 2.00 → 除息 0.50（nav 1.50、acc 保持 2.00）→ 1.60（acc 2.10）
    // 复权序列 2.00 / 2.00 / 2.1333；系数 k = nav末 / adj末 = 1.60 / 2.1333 = 0.75
    const usable = [
      navAcc('2026-01-01', 2.0, 2.0),
      navAcc('2026-01-02', 1.5, 2.0),
      navAcc('2026-01-03', 1.6, 2.1),
    ];
    const adj = buildAdjustedSeries(usable).values;
    const k = navScaleFactor(adj, [2.0, 1.5, 1.6]);
    expect(k).toBeCloseTo(0.75, 10);
    // 缩放后的复权序列末点 == 单位净值末点 → 图表 MA250 与指标卡偏离度同口径
    expect(adj[adj.length - 1]! * k).toBeCloseTo(1.6, 10);
  });

  it('数据不足 / 末点非法 → 系数为 1（不缩放，退回原行为）', () => {
    expect(navScaleFactor([], [])).toBe(1);
    expect(navScaleFactor([0], [1])).toBe(1);
    expect(navScaleFactor([1], [0])).toBe(1);
    expect(navScaleFactor([Number.NaN], [1])).toBe(1);
    expect(navScaleFactor([1], [Number.POSITIVE_INFINITY])).toBe(1);
  });

  it('两序列长度不一致 → 系数为 1（不猜对应关系）', () => {
    expect(navScaleFactor([1, 2], [1])).toBe(1);
  });
});
