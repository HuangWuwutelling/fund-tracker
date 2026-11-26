import dayjs from 'dayjs';
import { TRANSACTION_TYPE_LABELS, type Transaction } from '../types';
import { isPendingTx } from './calculator';

/**
 * 交易记录页的筛选条件 —— **全部由 URL 持有**。
 * 空串 / '' 一律表示"不限 / 全部"，不是"没有值"。
 */
export type TxStatusFilter = '' | 'pending' | 'confirmed';

export interface TxFilters {
  /** 基金 id；'' = 不限 */
  fundId: string;
  /** 交易类型；'' = 不限 */
  type: Transaction['type'] | '';
  /** 交易日期 YYYY-MM-DD；'' = 不限 */
  date: string;
  /** 确认状态；'' = 全部 */
  status: TxStatusFilter;
}

/**
 * 日期合法性判定 —— **必须用往返判定**。
 *
 * dayjs 未开严格解析，非法日期会被**进位**而非判无效：
 *   dayjs('2026-13-45').isValid() === true   （归一化成 2027-02-14）
 *   dayjs('2026-02-30').isValid() === true   （归一化成 2026-03-02）
 *   dayjs('2026-04-31').isValid() === true   （归一化成 2026-05-01）
 *
 * 只靠正则 + isValid() 的话，?date=2026-13-45 会被当成合法日期接受，
 * 落地页查出 0 条 —— 正是"死胡同"。
 */
export function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  if (!dayjs(v).isValid()) return false;
  return dayjs(v).format('YYYY-MM-DD') === v;
}

/**
 * 交易类型是否合法。
 * 不能用 `TRANSACTION_TYPE_LABELS[v]` 判空 —— 项目开了 noUncheckedIndexedAccess，
 * 索引取值是 `string | undefined`，用它判存在性不可靠。
 */
function isRealType(v: string): v is Transaction['type'] {
  return Object.prototype.hasOwnProperty.call(TRANSACTION_TYPE_LABELS, v);
}

function isRealStatus(v: string): v is TxStatusFilter {
  return v === 'pending' || v === 'confirmed';
}

/**
 * 解析 URL 查询参数 → 筛选条件。
 *
 * URL 是外部输入：非法值一律当没传（忽略），而不是变成"0 条记录"的死胡同。
 *
 * @param knownFundIds 账本里真实存在的基金 id。URL 里的 fund 参数必须在此之内，
 *   否则当没传 —— fundId 会驱动「补登初始持仓」入口，未知 id 会写出孤儿交易。
 */
export function parseTxFilters(
  params: URLSearchParams,
  knownFundIds: readonly string[],
): TxFilters {
  const fund = params.get('fund') ?? '';
  const type = params.get('type') ?? '';
  const date = params.get('date') ?? '';
  const status = params.get('status') ?? '';

  return {
    fundId: fund && knownFundIds.includes(fund) ? fund : '',
    type: isRealType(type) ? type : '',
    date: isRealDate(date) ? date : '',
    status: isRealStatus(status) ? status : '',
  };
}

/** 状态筛选是否命中该交易。confirmed 的口径必须与 onlyConfirmed 一致。 */
function statusMatch(tx: Transaction, status: TxStatusFilter): boolean {
  if (status === 'pending') return isPendingTx(tx);
  if (status === 'confirmed') return !isPendingTx(tx);
  return true;
}

/**
 * 按筛选条件过滤交易。
 * 返回**新数组**，不改入参、不改顺序（排序在调用处做）。
 */
export function filterTransactions(txs: Transaction[], f: TxFilters): Transaction[] {
  return txs.filter(
    (t) =>
      (!f.fundId || t.fundId === f.fundId) &&
      (!f.type || t.type === f.type) &&
      (!f.date || t.date === f.date) &&
      (!f.status || statusMatch(t, f.status)),
  );
}

/**
 * 筛选条件 → URL 查询参数（与 parseTxFilters 互为逆运算）。
 * 空值不输出。
 *
 * 这是**重建式**写入：URL 里本模块不认识的参数（如 ?foo=1）会在用户动任何筛选后
 * 消失 —— "URL 词汇是封闭集合"的必然结果，不是 bug。
 */
export function txFilterParams(f: TxFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.fundId) out.fund = f.fundId;
  if (f.type) out.type = f.type;
  if (f.date) out.date = f.date;
  if (f.status) out.status = f.status;
  return out;
}
