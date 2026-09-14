/** 格式化金额，带千分位（负数自带 - 号） */
export function formatMoney(value: number, decimals = 2): string {
  // 把 -0 归一化为 +0，避免出现 "-0.00"（如 0 × -1 = -0，或 0 - 0 = -0）
  const normalized = value === 0 ? 0 : value;
  return normalized.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** 格式化百分比 */
export function formatPercent(value: number, decimals = 2): string {
  // 防御：非 number（null/undefined/string/object）会触发 value.toFixed is not a function，
  // 整页崩溃。命中时退化为 '—'，与 Statistic 等组件的 null 处理口径一致。
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;
}

/** 格式化日期 */
export function formatDate(date: string): string {
  if (!date) return '—';
  return date;
}

/** 获取今天的日期字符串 YYYY-MM-DD（使用本地时间，避免 UTC 偏移问题） */
export function today(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 计算两个日期之间的天数差 */
export function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
}

/** 盈亏颜色（中国惯例：红涨绿跌） */
export function pnlColor(value: number): string {
  if (value > 0) return '#cf1322';
  if (value < 0) return '#3f8600';
  return '#666';
}

/**
 * 盈亏背景色（淡色填充，用于大数字卡片的"涨用浅红底+深红字、跌用浅绿底+深绿字"配色）。
 * 透明度约 0.08-0.1，避免大块色彩压过数字。
 */
export function pnlBg(value: number, dark = false): string | undefined {
  if (value > 0) return dark ? 'rgba(207,19,34,0.18)' : 'rgba(207,19,34,0.08)';
  if (value < 0) return dark ? 'rgba(63,134,0,0.20)' : 'rgba(63,134,0,0.08)';
  return undefined;
}

/**
 * 简写金额：>=1万 显示 "1.23万"，>=1亿 显示 "0.12亿"，负数前缀 "-"
 * 用于 Dashboard 顶部大数字卡片、Reports 标题等空间有限的地方。
 */
export function formatMoneyShort(value: number, decimals = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(decimals)}亿`;
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(decimals)}万`;
  return `${sign}${abs.toFixed(0)}`;
}

/** 简写金额 + 前缀 ¥ */
export function formatMoneyShortWithSign(value: number, decimals = 2): string {
  return `¥${formatMoneyShort(value, decimals)}`;
}
