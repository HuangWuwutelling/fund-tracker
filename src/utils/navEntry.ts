/**
 * 录入交易时的**净值可用性**判定。
 *
 * 背景（2026-11-20 实测修复）：`lookupNavForDate()` 找不到交易当日的净值时，
 * 会 fallback 到"≤ 该日期的最近一条"。这个兜底在**待确认**路径上是被明确
 * 拒绝的（见 App.tsx `autoConfirmPending`：`if (result.navDate !== tx.date) continue;`
 * ——注释里就写着"否则会用历史净值计算份额"），但**手动录入**路径一直没
 * 应用这条规则，于是：
 *
 *   用户在 2026-08-26 买入 1575 元，本地净值历史当时只到 08-06（陈旧）
 *   → 兜底取到 08-06 的 1.0386
 *   → 份额被推算成 1575 / 1.0386 = 1516.4645 份
 *   → 而当日真实净值 1.048 对应的平台确认份额是 1502.8626 份（多算 13.60 份）
 *
 * 后果是持仓份额、持仓市值、成本、收益率全错，而界面上只有一句不起眼的
 * "最近交易日"提示。
 *
 * 规则：**只有交易当日的净值才能用来推算份额**。拿不到就按「待确认」记录，
 * 净值发布后由 autoConfirmPending 自动补齐（那条路径本来就做对了）。
 * 用户若从平台抄到了当日的成交净值，可手动录入 —— 以用户填的为准。
 */
export interface NavEntryDecision {
  /** 用于推算份额的净值；0 = 净值未确认（此时不推算） */
  nav: number;
  /** 该净值对应的日期（手动录入时视为交易当日） */
  navDate: string;
  /** 净值是否为交易当日的真实净值 */
  isExact: boolean;
  /** 交易状态：净值未确认时必须是 pending */
  status: 'confirmed' | 'pending';
  /** 给用户看的说明（pending 时非空） */
  warning: string;
}

export function decideNavEntry(input: {
  /** 交易日期（YYYY-MM-DD） */
  txDate: string;
  /** 按日期查到的净值（可能来自"最近交易日"兜底） */
  lookedUp: { nav: number; navDate: string } | null;
  /** 用户手动录入的成交净值（0/负数/缺省 = 没填） */
  manualNav?: number | null;
}): NavEntryDecision {
  const { txDate, lookedUp } = input;
  const manual = input.manualNav ?? 0;

  // 用户手动录入的净值优先——那是平台确认的当日成交净值
  if (manual > 0 && Number.isFinite(manual)) {
    return { nav: manual, navDate: txDate, isExact: true, status: 'confirmed', warning: '' };
  }

  if (!lookedUp) {
    return {
      nav: 0,
      navDate: '',
      isExact: false,
      status: 'pending',
      warning: '未找到该日期的净值，已按「待确认」记录——净值发布后会自动补齐份额。',
    };
  }

  if (lookedUp.navDate === txDate) {
    return { nav: lookedUp.nav, navDate: lookedUp.navDate, isExact: true, status: 'confirmed', warning: '' };
  }

  return {
    nav: 0,
    navDate: lookedUp.navDate,
    isExact: false,
    status: 'pending',
    warning:
      `该日期的净值尚未发布或本地未收录（本地最近的是 ${lookedUp.navDate}）。` +
      '直接用它推算份额会算错，因此已按「待确认」记录——净值发布后自动补齐；' +
      '若平台已显示当日成交净值，可手动填入。',
  };
}
