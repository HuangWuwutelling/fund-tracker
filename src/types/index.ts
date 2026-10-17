export interface Platform {
  id: string;
  name: string;
}

export interface Fund {
  id: string;
  name: string;
  platformId: string;
  type: 'index' | 'bond' | 'qdii' | 'mixed';
  currentNav: number;
  navDate: string;
}

export interface NavRecord {
  date: string;
  nav: number;
  accNav: number;
}

export interface Transaction {
  id: string;
  fundId: string;
  type: 'buy' | 'sell' | 'dividend';
  date: string;
  amount: number;
  fee: number;
  shares: number;
  nav: number;
  note?: string;
  /** 若该交易由定投计划自动生成，记录来源计划 id（便于去重/打标签） */
  planId?: string;
  status?: 'pending' | 'confirmed';
}

export interface DcaPlan {
  id: string;
  fundId: string;
  amount: number;
  frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly';
  dayOfWeek?: number;
  dayOfMonth?: number;
  active: boolean;
  startDate: string;
}

export interface DailySnapshot {
  date: string;
  totalValue: number;
  totalCost: number;
}

export interface Settings {
  theme: 'light' | 'dark';
  navAutoRefresh: boolean;
  reportFrequency: 'weekly' | 'monthly' | 'both';
  /** 定投计划自动生成交易记录（打开页面时把到期计划补成待确认买入） */
  dcaAutoRecord: boolean;
  /**
   * 美股跟踪 QDII 的节假日过滤模式（详见 `navPair.ts:UsQdiiFilterMode`）。
   * - auto（默认）：数据驱动，剔除与前条 nav+accNav 完全相同的占位条目。
   * - strict：日期驱动，按美股工作日节假日 + 周末剔除。
   * - off：不过滤。
   *
   * 类型上为必填——老备份导入时由 `storage.getSettings()` / `importData()` 与
   * `DEFAULT_SETTINGS` 合并兜底为 'auto'，调用方无需 `?? 'auto'`。
   */
  usQdiiFilterMode: 'auto' | 'strict' | 'off';
}

/**
 * 「当日盈亏」的新名字。取的是每只基金**最新已发布净值日**的涨跌，
 * 不同基金的这个日期可能不同（A 股通常为今天，QDII 常落后 1 个交易日），
 * 所以标题必须带"净值日"三个字，不能再叫"当日"。
 */
export const LATEST_NAV_PNL_LABEL = '最新净值日盈亏';

export const FUND_TYPE_LABELS: Record<Fund['type'], string> = {
  index: '指数型',
  bond: '债券型',
  qdii: 'QDII',
  mixed: '混合型',
};

/** 基金类型 → AntD Tag 颜色（持仓列表 / 报表统一口径） */
export const FUND_TYPE_COLORS: Record<Fund['type'], string> = {
  index: 'cyan',
  bond: 'blue',
  qdii: 'purple',
  mixed: 'orange',
};

/** 基金类型 → 列表行左侧 4px 色条（高风险一目了然） */
export const FUND_TYPE_STRIPE_COLORS: Record<Fund['type'], string> = {
  index: '#13c2c2',
  bond: '#1677ff',
  qdii: '#722ed1',
  mixed: '#fa8c16',
};

/** 交易类型 → 颜色（红买/绿卖/金分红 = 中国市场惯例） */
export const TX_TYPE_COLORS: Record<Transaction['type'], string> = {
  buy: 'red',
  sell: 'green',
  dividend: 'gold',
};

export const TRANSACTION_TYPE_LABELS: Record<Transaction['type'], string> = {
  buy: '买入',
  sell: '卖出',
  dividend: '分红',
};

export const FREQUENCY_LABELS: Record<DcaPlan['frequency'], string> = {
  daily: '每个交易日',
  weekly: '每周',
  biweekly: '双周',
  monthly: '每月',
};

/** 指数所在市场的本地时区分类。决定数据日期格式化与 TZ 显示标签。 */
export type Market = 'CN' | 'US';

/**
 * 单个指数最近一次成功拉取的快照，存进 localStorage 后下次进 app 立刻显示。
 * - `date` 是该市场当地的 YYYY-MM-DD（CN = 北京，US = 美东）；
 * - `time` 是 API 时间戳里的 HH:mm（数据更新时间，不做 TZ 转换），仅 UI 展示；
 * - `fetchedAt` 是本地拉取时间戳 ms —— 仅用于 UI 提示"已更新于 X 分钟前"，
 *   不参与"是不是新数据"的判定（那由 `data.date` 自己说了算，见 utils/indexQuote.ts）。
 */
export interface IndexQuote {
  name: string;
  market: Market;
  value: number;
  change: number;
  changePercent: number;
  date: string;
  time: string;
  fetchedAt: number;
}

/**
 * 硬编码的指数清单（v1 不做"用户自定义"）。
 * - `code` 是项目内部的稳定代号（也是 localStorage 的 key）；
 * - `symbol` 是腾讯 qt.gtimg.cn 的 q= 参数（CN 用 `sh000300` / `sz399006`，
 *   US 用 `us.NDX` / `us.INX` / `us.DJI`，见 indexApi.ts 注释）。
 */
export interface IndexSpec {
  code: string;
  /** 行情接口（qt.gtimg.cn）的 symbol。多数标的无需特殊处理，用这个字段即可。 */
  symbol: string;
  /**
   * K 线接口（web.ifzq.gtimg.cn）的 symbol。**仅**当行情与 K 线需要的格式不同时
   * 才需设置——例：usNDX 在 qt.gtimg.cn 端需要 `usNDX`（带点会被解析为 DX.N 股票），
   * 但 K 线端需要 `us.NDX` 才能识别为指数（不带点时只匹配到不索引的标的，回 1 条）。
   * 未设置时 fallback 到 `symbol`。
   */
  klineSymbol?: string;
  name: string;
  market: Market;
}

/**
 * 指数历史每日收盘点位。Modal 曲线用；
 * `date` 为该市场当地的 YYYY-MM-DD，`value` 为当日收盘点位（原单位，非 ETF NAV）。
 */
export interface IndexHistoryRecord {
  date: string;
  value: number;
}

/* ============================================================
 *  技术指标（MA250 偏离度 / MACD / 回撤百分位）相关常量与类型
 *  阈值与色档按中国散户惯例；调整请同步更新 Settings 的说明面板
 * ============================================================ */

/** MA250 偏离度温度档位。6 档：deep_cold（极冷）→ deep_hot（过热） */
export type TemperatureLevel = 'deep_cold' | 'cold' | 'cool' | 'warm' | 'hot' | 'deep_hot';

/** 偏离度阈值表（百分比）。负值越深越冷，正值越深越热 */
export const TEMPERATURE_THRESHOLDS: readonly number[] = [-30, -15, -5, 5, 15] as const;

/** MA250 偏离度颜色档（蓝→青→橙→红梯度） */
export const TEMPERATURE_COLORS: Record<TemperatureLevel, string> = {
  deep_cold: '#003a8c', // 深蓝：< -30%
  cold: '#1677ff', // 蓝：-30% ~ -15%
  cool: '#13c2c2', // 青：-15% ~ -5%
  warm: '#fa8c16', // 橙：-5% ~ +5%
  hot: '#fa541c', // 深橙：+5% ~ +15%
  deep_hot: '#cf1322', // 红：> +15%
};

/** 偏离度 → 中文档位标签 */
export const TEMPERATURE_LABELS: Record<TemperatureLevel, string> = {
  deep_cold: '极冷',
  cold: '偏冷',
  cool: '微冷',
  warm: '适中',
  hot: '偏热',
  deep_hot: '过热',
};

/** 偏离度 → 一行建议（Dashboard 温度计用） */
export const TEMPERATURE_ADVICE: Record<TemperatureLevel, string> = {
  deep_cold: '深度低估，分批布局',
  cold: '低于均线，估值偏低',
  cool: '略低于均线，适合定投',
  warm: '贴近均线，正常持有',
  hot: '高于均线，谨慎追高',
  deep_hot: '深度高估，考虑止盈',
};

/** 把 (curr - MA250)/MA250 × 100 映射到档位。null/无效值返回 null */
export function classifyTemperature(deviationPct: number | null | undefined): TemperatureLevel | null {
  if (deviationPct === null || deviationPct === undefined) return null;
  if (!Number.isFinite(deviationPct)) return null;
  if (deviationPct < TEMPERATURE_THRESHOLDS[0]!) return 'deep_cold';
  if (deviationPct < TEMPERATURE_THRESHOLDS[1]!) return 'cold';
  if (deviationPct < TEMPERATURE_THRESHOLDS[2]!) return 'cool';
  if (deviationPct < TEMPERATURE_THRESHOLDS[3]!) return 'warm';
  if (deviationPct < TEMPERATURE_THRESHOLDS[4]!) return 'hot';
  return 'deep_hot';
}

/** MACD 当前状态 */
export type MacdState = 'golden_cross' | 'death_cross' | 'above_zero' | 'below_zero' | 'unknown';

/** MACD 状态 → 中文标签 */
export const MACD_STATE_LABELS: Record<MacdState, string> = {
  golden_cross: '金叉',
  death_cross: '死叉',
  above_zero: '多头',
  below_zero: '空头',
  unknown: '—',
};

/** MACD 状态 → 颜色（中国红涨绿跌） */
export const MACD_STATE_COLORS: Record<MacdState, string> = {
  golden_cross: '#cf1322', // 红
  death_cross: '#3f8600', // 绿
  above_zero: '#fa541c', // 深橙（强势但未交叉）
  below_zero: '#1677ff', // 蓝（弱势但未交叉）
  unknown: '#999',
};

/** MACD 状态 → 行动提示（一行文案，给 FundDetail 指标卡用） */
export const MACD_STATE_HINTS: Record<MacdState, string> = {
  golden_cross: '↗ 短期动能转强，注意追高风险',
  death_cross: '↘ 短期动能转弱，可分批布局',
  above_zero: '↗ 多头排列，趋势向上',
  below_zero: '↘ 空头排列，趋势向下',
  unknown: '— 数据不足',
};
