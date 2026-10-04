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

/** 基金类型 → AntD Tag 颜色（持仓列表 / HoldingsSummary / 报表统一口径） */
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
 * `date` 是该市场当地的 YYYY-MM-DD（CN = 北京，US = 美东），
 * `fetchedAt` 是本地拉取时间戳 ms —— 仅用于 UI 提示"已更新于 X 分钟前"，
 * 不参与"是不是新数据"的判定（那由 `data.date` 自己说了算，见 utils/indexQuote.ts）。
 */
export interface IndexQuote {
  name: string;
  market: Market;
  value: number;
  change: number;
  changePercent: number;
  date: string;
  fetchedAt: number;
}

/**
 * 硬编码的指数清单（v1 不做"用户自定义"）。
 * `code` 是项目内部的稳定代号（也是 localStorage 的 key），
 * `secid` 是 eastmoney push2 的 secid 编码（`{market前缀}.{指数代码}`）。
 */
export interface IndexSpec {
  code: string;
  secid: string;
  name: string;
  market: Market;
}
