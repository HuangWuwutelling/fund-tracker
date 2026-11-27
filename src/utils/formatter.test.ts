import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatMoney,
  formatPercent,
  formatDate,
  today,
  pnlColor,
  pnlBg,
  formatMoneyShort,
  formatMoneyShortWithSign,
  moneyStatFormatter,
  percentStatFormatter,
} from './formatter';

/*
 * 说明：`daysBetween` 是死代码（待删除），按约定不在此覆盖。
 * 本文件是 formatter 的「现状锁定」测试 —— 重构 formatter 时数字不能变。
 */

/**
 * 本地时区的 YYYY-MM-DD —— 与 formatter.today() 的取值口径一致。
 * 必须用 getFullYear/getMonth/getDate（本地），不能用 toISOString（UTC）。
 */
function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** UTC 的 YYYY-MM-DD —— toISOString 的口径，today() 明确不能走这条 */
function utcYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 找一个「本地日期 ≠ UTC 日期」的时刻。
 * 逐小时扫过同一个 UTC 日，保证在除 UTC 以外的任意时区都能命中；
 * 运行环境时区恰好是 UTC 时返回 null（此时本地日与 UTC 日本就相同，无法区分）。
 */
function findLocalUtcMismatchInstant(): number | null {
  const dayStart = Date.UTC(2026, 5, 15, 0, 0, 0); // 2026-06-15T00:00:00Z
  for (let h = 0; h < 24; h++) {
    const t = dayStart + h * 3600_000;
    const d = new Date(t);
    if (localYmd(d) !== utcYmd(d)) return t;
  }
  return null;
}

/**
 * 找一个「本地日期落在个位月 + 个位日」的时刻，用来验证月/日是否补零。
 * 逐小时扫描 40 天，任何时区都能命中。
 */
function findLocalSingleDigitMonthDayInstant(): number {
  const start = Date.UTC(2026, 5, 1, 0, 0, 0); // 2026-06-01T00:00:00Z
  const end = start + 40 * 86_400_000;
  for (let t = start; t < end; t += 3600_000) {
    const d = new Date(t);
    if (d.getMonth() + 1 < 10 && d.getDate() < 10) return t;
  }
  throw new Error('找不到本地日期为「个位月 + 个位日」的时刻');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('today —— 必须走本地时区，不能走 UTC', () => {
  it('等于同一时刻按本地 getters 计算出的 YYYY-MM-DD', () => {
    // 直接对照本地取值口径：getFullYear/getMonth/getDate 都是本地时区。
    const d = new Date();
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(today()).toBe(expected);
  });

  it('形状固定为 YYYY-MM-DD', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('本地日 ≠ UTC 日的时刻：返回本地日，而不是 toISOString 的日期', () => {
    // UTC+8 的早晨 08:00 之前，toISOString().slice(0,10) 会比本地日期晚一天，
    // 交易/快照日期会整体错位一天 —— 这是 today() 存在的原因。
    const instant = findLocalUtcMismatchInstant();
    vi.useFakeTimers();
    vi.setSystemTime(instant ?? Date.UTC(2026, 5, 15, 12, 0, 0));

    const d = new Date();
    const local = localYmd(d);
    const utc = utcYmd(d);

    expect(today()).toBe(local);
    if (instant !== null) {
      // 本次运行确实存在「本地日 ≠ UTC 日」的时刻 → 必须取本地日
      expect(local).not.toBe(utc);
      expect(today()).not.toBe(utc);
    }
  });

  it('月/日补零（个位月、个位日也要两位）', () => {
    const instant = findLocalSingleDigitMonthDayInstant();
    vi.useFakeTimers();
    vi.setSystemTime(instant);

    const d = new Date();
    expect(today()).toBe(localYmd(d));
    expect(today()).toMatch(/^\d{4}-0\d-0\d$/);
  });

  it('不调用 toISOString（防止重构回 UTC 口径）', () => {
    // today() 一旦改成 new Date().toISOString().slice(0,10)，本用例立刻炸。
    const spy = vi.spyOn(Date.prototype, 'toISOString');
    try {
      today();
      expect(spy).not.toHaveBeenCalled();
      // 自检：确认 spy 确实挂上了，否则上面那句"没被调用"是假绿。
      new Date().toISOString();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('pnlColor —— 中国惯例：红涨绿跌', () => {
  it('正数（盈利）→ 红色', () => {
    expect(pnlColor(1)).toBe('#cf1322');
    expect(pnlColor(0.01)).toBe('#cf1322');
    expect(pnlColor(12345.67)).toBe('#cf1322');
  });

  it('负数（亏损）→ 绿色', () => {
    expect(pnlColor(-1)).toBe('#3f8600');
    expect(pnlColor(-0.01)).toBe('#3f8600');
    expect(pnlColor(-12345.67)).toBe('#3f8600');
  });

  it('0 → 中性灰（-0 也走中性分支）', () => {
    expect(pnlColor(0)).toBe('#666');
    expect(pnlColor(-0)).toBe('#666');
  });
});

describe('pnlBg —— 盈亏背景色', () => {
  it('盈利：浅红底（深色模式更浓）', () => {
    expect(pnlBg(1)).toBe('rgba(207,19,34,0.08)');
    expect(pnlBg(1, true)).toBe('rgba(207,19,34,0.18)');
  });

  it('亏损：浅绿底（深色模式更浓）', () => {
    expect(pnlBg(-1)).toBe('rgba(63,134,0,0.08)');
    expect(pnlBg(-1, true)).toBe('rgba(63,134,0,0.20)');
  });

  it('0 → undefined（不加背景）', () => {
    expect(pnlBg(0)).toBeUndefined();
    expect(pnlBg(0, true)).toBeUndefined();
  });
});

describe('formatMoney —— 千分位 + 固定小数位', () => {
  it('默认 2 位小数，带千分位', () => {
    expect(formatMoney(1234.5)).toBe('1,234.50');
    expect(formatMoney(0)).toBe('0.00');
    expect(formatMoney(-1234.5)).toBe('-1,234.50');
    expect(formatMoney(1_000_000)).toBe('1,000,000.00');
  });

  it('-0 归一化为 +0（不显示 "-0.00"）', () => {
    // 0 × -1 = -0，或 0 - 0 = -0；toLocaleString 会把它渲染成 "-0.00"。
    expect(formatMoney(-0)).toBe('0.00');
    expect(formatMoney(0)).toBe('0.00');
  });

  it('decimals 可调', () => {
    expect(formatMoney(1234.567, 0)).toBe('1,235');
    expect(formatMoney(1234.5, 1)).toBe('1,234.5');
    expect(formatMoney(1234.567, 4)).toBe('1,234.5670');
  });

  it('小数位不足时补零（四舍五入）', () => {
    expect(formatMoney(1234, 2)).toBe('1,234.00');
    expect(formatMoney(0.005)).toBe('0.01');
  });

  it('当前行为：极小的负数仍渲染成 "-0.00"（只归一化精确的 0）', () => {
    // 现状锁定：value === 0 的判断是精确相等，-0.001 会带着负号显示为 "-0.00"。
    // 重构若改成"四舍五入后为 0 就不带号"，本用例会失败 —— 那属于口径变更，需要显式决策。
    expect(formatMoney(-0.001)).toBe('-0.00');
  });
});

describe('formatPercent —— 带符号百分比', () => {
  it('正数带 + 号，负数带 - 号', () => {
    expect(formatPercent(1.5)).toBe('+1.50%');
    expect(formatPercent(-1.5)).toBe('-1.50%');
    expect(formatPercent(0)).toBe('+0.00%');
    expect(formatPercent(-0)).toBe('+0.00%');
  });

  it('decimals 可调', () => {
    expect(formatPercent(1.234, 1)).toBe('+1.2%');
    expect(formatPercent(1.5, 0)).toBe('+2%');
  });

  it('非数字 / 非有限值 → "—"（不抛异常）', () => {
    // 没有这层防御时 value.toFixed is not a function 会让整页崩溃。
    expect(formatPercent(NaN)).toBe('—');
    expect(formatPercent(Infinity)).toBe('—');
    expect(formatPercent(-Infinity)).toBe('—');
    expect(formatPercent(null as unknown as number)).toBe('—');
    expect(formatPercent(undefined as unknown as number)).toBe('—');
    expect(formatPercent('1.5' as unknown as number)).toBe('—');
    expect(formatPercent({} as unknown as number)).toBe('—');
  });
});

describe('formatDate —— 原样透传', () => {
  it('有值 → 原样返回', () => {
    expect(formatDate('2026-09-08')).toBe('2026-09-08');
    expect(formatDate('2026-09-08 12:00:00')).toBe('2026-09-08 12:00:00');
  });

  it('空值 → "—"', () => {
    expect(formatDate('')).toBe('—');
    expect(formatDate(undefined as unknown as string)).toBe('—');
    expect(formatDate(null as unknown as string)).toBe('—');
  });
});

describe('formatMoneyShort —— 万/亿 简写', () => {
  it('小于 1 万 → 整数显示（无小数、无千分位）', () => {
    expect(formatMoneyShort(999)).toBe('999');
    expect(formatMoneyShort(9999)).toBe('9999');
    expect(formatMoneyShort(9999.99)).toBe('10000');
    expect(formatMoneyShort(0)).toBe('0');
  });

  it('1 万 ~ 1 亿 → "x.xx万"', () => {
    expect(formatMoneyShort(10_000)).toBe('1.00万');
    expect(formatMoneyShort(12_345)).toBe('1.23万');
    expect(formatMoneyShort(12_345.678, 3)).toBe('1.235万');
  });

  it('≥ 1 亿 → "x.xx亿"', () => {
    expect(formatMoneyShort(100_000_000)).toBe('1.00亿');
    expect(formatMoneyShort(123_456_789)).toBe('1.23亿');
  });

  it('负数保留 - 前缀（对绝对值取简写）', () => {
    expect(formatMoneyShort(-12_345)).toBe('-1.23万');
    expect(formatMoneyShort(-123_456_789)).toBe('-1.23亿');
    expect(formatMoneyShort(-999)).toBe('-999');
  });

  it('非数字 / 非有限值 → "—"', () => {
    expect(formatMoneyShort(NaN)).toBe('—');
    expect(formatMoneyShort(Infinity)).toBe('—');
    expect(formatMoneyShort(null as unknown as number)).toBe('—');
    expect(formatMoneyShort(undefined as unknown as number)).toBe('—');
  });
});

describe('formatMoneyShortWithSign —— 简写 + ¥ 前缀', () => {
  it('正常带 ¥', () => {
    expect(formatMoneyShortWithSign(12_345)).toBe('¥1.23万');
    expect(formatMoneyShortWithSign(999)).toBe('¥999');
    expect(formatMoneyShortWithSign(-12_345)).toBe('¥-1.23万');
  });

  it('当前行为：非法值也会带上 ¥（变成 "¥—"）', () => {
    // 现状锁定：前缀是无条件拼上去的，脏值会渲染成 "¥—"。
    // 重构若改成非法值返回 "—"，本用例会失败 —— 那属于展示口径变更。
    expect(formatMoneyShortWithSign(NaN)).toBe('¥—');
  });
});

/**
 * Statistic 的 formatter —— 统一四舍五入，不走 AntD 自带的 precision。
 *
 * AntD 内部对精度是**截断**（antd/es/statistic/Number.js:30）：
 *   decimal = decimal.padEnd(precision,'0').slice(0, precision)
 * 而 formatMoney / toFixed 是四舍五入。同一笔「累计分红 72.238598」在 Dashboard
 * 显示 72.24、在基金详情页显示 72.23 —— 差 1 分钱。金额按四舍五入显示才是对的。
 */
describe('Statistic 的 formatter —— 统一四舍五入', () => {
  /** 复刻 antd/es/statistic/Number.js 的截断行为，用作对照 */
  const antdTruncate = (v: number | string, precision = 2): string => {
    const val = String(v);
    const cells = val.match(/^(-?)(\d*)(\.(\d+))?$/);
    if (!cells || val === '-') return val;
    let decimal = cells[4] || '';
    decimal = decimal.padEnd(precision, '0').slice(0, precision > 0 ? precision : 0);
    return `${cells[1]}${cells[2] || '0'}${decimal ? `.${decimal}` : ''}`;
  };

  it('moneyStatFormatter：四舍五入 + 千分位', () => {
    expect(moneyStatFormatter(72.238598)).toBe('72.24');
    expect(moneyStatFormatter(1234.5678)).toBe('1,234.57');
    expect(moneyStatFormatter(0)).toBe('0.00');
    expect(moneyStatFormatter(-1234.5678)).toBe('-1,234.57');
  });

  it('moneyStatFormatter：非数字原样透传（Statistic 用 "—" 表示无数据）', () => {
    expect(moneyStatFormatter('—')).toBe('—');
    expect(moneyStatFormatter(NaN)).toBe('NaN');
  });

  it('percentStatFormatter：四舍五入到 2 位，不带符号（% 由 suffix 补）', () => {
    expect(percentStatFormatter(5.678)).toBe('5.68');
    expect(percentStatFormatter(-3.456)).toBe('-3.46');
    expect(percentStatFormatter('—')).toBe('—');
  });

  it('对照：AntD 的 precision 会截断，同一数值两者差一分 —— 这就是不能用它的原因', () => {
    expect(antdTruncate(72.238598)).toBe('72.23');
    expect(moneyStatFormatter(72.238598)).toBe('72.24');
    expect(antdTruncate(5.678)).toBe('5.67');
    expect(percentStatFormatter(5.678)).toBe('5.68');
  });
});
