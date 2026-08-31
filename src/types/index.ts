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

export const FUND_TYPE_LABELS: Record<Fund['type'], string> = {
  index: '指数型',
  bond: '债券型',
  qdii: 'QDII',
  mixed: '混合型',
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
