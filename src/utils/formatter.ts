/** 格式化金额，带千分位 */
export function formatMoney(value: number, decimals = 2): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** 格式化百分比 */
export function formatPercent(value: number, decimals = 2): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;
}

/** 格式化带正负号的金额 */
export function formatSignedMoney(value: number): string {
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}¥${formatMoney(Math.abs(value))}`;
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
