import type { Transaction } from '../types';

/**
 * 平台流水（对账单）解析与账本比对。
 *
 * 用途：用户从基金平台导出/抄录自己的交易流水，粘进来与应用账本比对，
 * 找出**账本里漏记的买入/卖出**并一键补录。
 *
 * 为什么需要它：净值历史陈旧时，应用会用"最近交易日"的旧净值推算份额，
 * 份额算错且无感知；反过来，**漏记的买入**应用自己发现不了 ——
 * 只能拿平台流水来对（2026-11 审计南方标普红利低波就发现少记 138.77 份）。
 *
 * 支持的行格式（字段顺序固定，逗号/制表符/分号/空格均可分隔）：
 *   `日期, 类型, 金额, 份额, 净值`
 *   `2026-08-26, 买入, 1575.00, 1516.4645, 1.0386`
 * 类型认：买入/申购/买/buy → buy；卖出/赎回/卖/sell → sell。
 * 金额里的千分位逗号（1,575.00）会被自动合并还原。
 */

/** 平台流水的一行（已解析） */
export interface PlatformRow {
  date: string;
  type: 'buy' | 'sell';
  amount: number;
  shares: number;
  nav: number;
}

/** 解析失败的一行 */
export interface PlatformParseError {
  line: string;
  reason: string;
}

export interface PlatformParseResult {
  rows: PlatformRow[];
  errors: PlatformParseError[];
}

const BUY_WORDS = ['买入', '申购', '买', 'buy', 'BUY', 'Buy'];
const SELL_WORDS = ['卖出', '赎回', '卖', 'sell', 'SELL', 'Sell'];

/**
 * 合并被千分位逗号切开的数字字段：`1` + `575.00` → `1575.00`。
 *
 * 只在"后段恰好 3 位（+可选小数）"时才合并 —— 这是千分位分组的惯例，
 * 避免把两个真实列（如 `100` 和 `0.5`）误粘成一个数。
 */
function mergeThousands(parts: string[]): string[] {
  const merged: string[] = [];
  for (const p of parts) {
    const prev = merged.length > 0 ? merged[merged.length - 1]! : undefined;
    if (prev !== undefined && /^\d{1,6}$/.test(prev) && /^\d{3}(\.\d{1,4})?$/.test(p)) {
      merged[merged.length - 1] = prev + p;
    } else {
      merged.push(p);
    }
  }
  return merged;
}

/** 切分字段：优先按逗号/制表符/分号，字段不够时退回按空白 */
function splitFields(line: string): string[] {
  const t = line.trim();
  if (!t) return [];
  const parts = t.split(/[,\t，;；]/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length > 5) {
    // 字段偏多 → 多半是金额里的千分位逗号被切开了
    const merged = mergeThousands(parts);
    return merged.length === 5 ? merged : parts;
  }
  if (parts.length >= 5) return parts;
  // 逗号切出来的字段不够 → 试空白切分（从表格里复制的情况）
  const ws = t.split(/\s+/);
  return ws.length > parts.length ? ws : parts;
}

/** 解析数字：去掉货币符号与空白 */
function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[¥￥$€,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 解析日期：YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD */
function parseDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const mm = String(Number(mo)).padStart(2, '0');
  const dd = String(Number(d)).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function parseType(raw: string): 'buy' | 'sell' | null {
  const t = raw.trim();
  if (BUY_WORDS.some((w) => t === w)) return 'buy';
  if (SELL_WORDS.some((w) => t === w)) return 'sell';
  return null;
}

/**
 * 解析平台流水文本。
 *
 * 宽松解析：能认的行都收进来，认不出的行进 errors（带行号与原因），
 * 绝不因为一行有问题就丢掉整批。
 */
export function parsePlatformRows(text: string): PlatformParseResult {
  const rows: PlatformRow[] = [];
  const errors: PlatformParseError[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    const fields = splitFields(raw);
    if (fields.length < 5) {
      errors.push({ line: raw.trim(), reason: `字段不足 5 个（日期/类型/金额/份额/净值），实际 ${fields.length} 个` });
      continue;
    }
    if (fields.length > 5) {
      errors.push({ line: raw.trim(), reason: `字段多于 5 个，实际 ${fields.length} 个——请按「日期, 类型, 金额, 份额, 净值」整理` });
      continue;
    }
    const date = parseDate(fields[0]!);
    if (!date) {
      errors.push({ line: raw.trim(), reason: `日期无法识别：${fields[0]}` });
      continue;
    }
    const type = parseType(fields[1]!);
    if (!type) {
      errors.push({ line: raw.trim(), reason: `类型无法识别：${fields[1]}（认 买入/卖出/申购/赎回/buy/sell）` });
      continue;
    }
    const amount = parseNumber(fields[2]!);
    const shares = parseNumber(fields[3]!);
    const nav = parseNumber(fields[4]!);
    if (amount === null || shares === null || nav === null) {
      errors.push({ line: raw.trim(), reason: `金额/份额/净值有非数字：${fields[2]} / ${fields[3]} / ${fields[4]}` });
      continue;
    }
    rows.push({ date, type, amount, shares, nav });
  }

  return { rows, errors };
}

/** 一条流水与账本的比对结果 */
export interface PlatformDiff {
  /** 账本里已有、且一致 */
  matched: PlatformRow[];
  /** 账本里没有 → 可补录 */
  missing: PlatformRow[];
  /** 同日期同类型但份额对不上 → 需人工确认（多半是当初录错了） */
  mismatched: { row: PlatformRow; txId: string; txShares: number; txAmount: number }[];
}

/** 份额比较容差（4 位小数） */
const SHARES_EPS = 0.0001;

/**
 * 把平台流水与某只基金的应用账本比对。
 *
 * 匹配口径：日期 + 类型 相同 → 认为是同一笔；份额一致（≤1e-4）→ 完全一致，
 * 否则份额对不上 → mismatched（不自动补录，避免重复记账）。
 */
export function diffPlatformRows(
  rows: PlatformRow[],
  transactions: Transaction[],
  fundId: string,
): PlatformDiff {
  const matched: PlatformRow[] = [];
  const missing: PlatformRow[] = [];
  const mismatched: PlatformDiff['mismatched'] = [];

  const ledger = transactions.filter((t) => t.fundId === fundId && t.status !== 'pending');

  for (const row of rows) {
    const candidates = ledger.filter(
      (t) => t.date === row.date && t.type === row.type,
    );
    if (candidates.length === 0) {
      missing.push(row);
      continue;
    }
    // 同日期同类型可能有多笔（分笔买入），任一笔份额对得上就算已记
    const hit = candidates.find((t) => Math.abs(t.shares - row.shares) <= SHARES_EPS);
    if (hit) {
      matched.push(row);
      continue;
    }
    const first = candidates[0]!;
    mismatched.push({
      row,
      txId: first.id,
      txShares: first.shares,
      txAmount: first.amount,
    });
  }

  return { matched, missing, mismatched };
}
