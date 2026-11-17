import { useEffect, useCallback, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider, theme, message } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import updateLocale from 'dayjs/plugin/updateLocale';

dayjs.extend(updateLocale);
dayjs.locale('zh-cn');
// 周日作为一周第一天
dayjs.updateLocale('zh-cn', { weekStart: 0 });
import { useStore } from './stores';
import type { IndexQuote, FundRefreshIssue } from './types';
import { fetchFundWithHistory } from './api/fundApi';
import { fetchMarketIndices, INDEX_LIST } from './api/indexApi';
import { shouldUpdateIndexQuote } from './utils/indexQuote';
import { mergeNavTail } from './utils/navHistoryMerge';
import { generateSnapshot } from './utils/snapshot';
import { lookupNavForDate } from './utils/navLookup';
import { calcSharesFromAmount } from './utils/calculator';
import { STORAGE_ERROR_EVENT } from './utils/storage';
import AppLayout from './components/Layout';
import Dashboard from './pages/Dashboard';
import FundList from './pages/FundList';
import FundDetail from './pages/FundDetail';
import Transactions from './pages/Transactions';
import DcaPlans from './pages/DcaPlans';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

/** 按刷新结果分档提示：全部成功 success / 部分失败 warning / 全部失败 error。
 *  此前无条件 message.success('净值已更新')，sc 新格式基金被跳过时用户毫无感知。 */
function reportRefreshOutcome(issues: Record<string, FundRefreshIssue>, total: number) {
  const failedIds = Object.keys(issues);
  if (failedIds.length === 0) {
    message.success('净值已更新');
    return;
  }
  const fundsNow = useStore.getState().funds;
  const nameOf = (id: string) => fundsNow.find((f) => f.id === id)?.name ?? id;
  const shown = failedIds.slice(0, 2).map(nameOf).join('、');
  const names = failedIds.length > 2 ? `${shown} 等 ${failedIds.length} 只` : shown;
  const detail = failedIds.length === total
    ? `净值刷新失败：${names}，数据可能陈旧`
    : `${failedIds.length}/${total} 只基金更新失败：${names}（其余已更新）`;
  if (failedIds.length === total) {
    message.error(detail, 6);
  } else {
    message.warning(detail, 6);
  }
}

export default function App() {
  const { settings, funds, refreshTrigger, loadFromStorage, updateFund, updateNavHistory, updateTransaction, addSnapshot, updateIndex } = useStore();

  useEffect(() => {
    loadFromStorage();
    // 定投自动记录：用 getState() 读刚加载的最新 settings（渲染闭包里的还是默认值），
    // 启用时把到期计划补成待确认买入。放在 refreshAll 之前，让刚生成的过去日期
    // pending 记录能在同一次刷新里被 autoConfirmPending 确认。
    if (useStore.getState().settings.dcaAutoRecord) {
      const autoCreated = useStore.getState().autoRecordDcaPlans();
      if (autoCreated > 0) {
        message.success(`已按定投计划自动生成 ${autoCreated} 笔待确认买入，请到「交易记录」核对`);
      }
    }
  }, [loadFromStorage]);

  // localStorage 写失败（QuotaExceededError 写满 5MB / 隐私模式禁写等）→ storage 层
  // 广播 STORAGE_ERROR_EVENT → 这里弹提示。30s 冷却防每次写入重复弹。
  useEffect(() => {
    let lastWarnedAt = 0;
    const handler = () => {
      if (Date.now() - lastWarnedAt < 30000) return;
      lastWarnedAt = Date.now();
      message.error('浏览器存储空间不足，最近的数据可能没有保存！请立即导出备份，并清理不再持有的基金', 8);
    };
    window.addEventListener(STORAGE_ERROR_EVENT, handler);
    return () => window.removeEventListener(STORAGE_ERROR_EVENT, handler);
  }, []);

  // Generation counter to bail out stale refreshAll calls when a newer one starts.
  // refreshAll's deps include `transactions`, so adding a tx fires a new refresh —
  // the in-flight old one must not overwrite with stale state.
  const refreshGenerationRef = useRef(0);

  // Auto-confirm pending transactions: any buy/sell whose date is in the past and
  // whose NAV is now available in the fund's NAV history can be confirmed automatically.
  // Today's pending tx stays pending — user confirms manually to avoid stale-NAV mistakes.
  // 不订阅 transactions（避免 addTransaction 触发 refreshAll 无限循环）；用 useStore.getState() 读最新值
  const autoConfirmPending = useCallback(() => {
    const today = dayjs().format('YYYY-MM-DD');
    const pendingTxs = useStore.getState().transactions.filter((t) => t.status === 'pending');
    if (pendingTxs.length === 0) return 0;

    let confirmed = 0;
    for (const tx of pendingTxs) {
      // Skip today's pending (T+1 NAV not yet released) and future-dated entries
      if (tx.date >= today) continue;
      // Dividend has no NAV lookup — just flip status
      if (tx.type === 'dividend') {
        updateTransaction(tx.id, { status: 'confirmed' });
        confirmed++;
        continue;
      }
      const result = lookupNavForDate(tx.fundId, new Date(tx.date));
      if (!result) continue; // NAV not yet available, leave as pending
      // 必须等到 tx.date 当天的 NAV 实际发布后才能确认——QDII 等净值延迟基金
      // 的 lookup 总会 fallback 到 ≤ tx.date 的最新一条（旧日期），如果直接用会被
      // 误认为当日成交 NAV，导致用历史净值计算份额（南方纳斯达克100 8/26 NAV
      // 被错误应用到 8/27、8/28 交易）。A 股基金 T+1 NAV 在 D+1 晚间更新到历史，
      // 等用户下次打开 app 时 navDate === txDate，会正常自动确认。
      if (result.navDate !== tx.date) continue;
      const shares = calcSharesFromAmount(tx.amount, tx.fee, result.nav);
      updateTransaction(tx.id, {
        status: 'confirmed',
        nav: result.nav,
        shares: Math.round(shares * 10000) / 10000,
      });
      confirmed++;
    }
    return confirmed;
  }, [updateTransaction]);

  // Auto-refresh NAV + generate snapshot when funds are loaded
  const refreshAll = useCallback(async () => {
    const myGen = ++refreshGenerationRef.current;
    if (funds.length === 0) return;

    // per-fund 失败上报：本轮结束后整体写入 store，UI（Dashboard/FundDetail Alert）
    // 据此展示醒目警告。跳过更新不写错数据的既有语义不变，只是不再静默。
    const issues: Record<string, FundRefreshIssue> = {};

    for (let i = 0; i < funds.length; i++) {
      if (refreshGenerationRef.current !== myGen) return; // superseded
      const fund = funds[i]!;
      try {
        const result = await fetchFundWithHistory(fund.id);
        if (refreshGenerationRef.current !== myGen) return;
        if (!result.ok) {
          // new-format / not-found / network / timeout：跳过更新（防写错 NAV），上报原因
          issues[fund.id] = { reason: result.reason, at: Date.now() };
        } else if (result.estimate.lastNav > 0) {
          updateFund(fund.id, {
            currentNav: result.estimate.lastNav,
            navDate: result.estimate.navDate,
          });

          // 增量合并净值历史：mergeNavTail 与 FundList 手动刷新共用同一语义
          // （边界日期保留本地值；API 修正历史净值请走 Settings 的"重置净值历史"）
          const merged = mergeNavTail(
            useStore.getState().getNavHistory(fund.id),
            result.navHistory,
          );
          if (merged) {
            updateNavHistory(fund.id, merged);
          }
        } else {
          // 加载成功但 trend 为空——此前静默跳过，现在上报让用户看到
          issues[fund.id] = { reason: 'no-data', at: Date.now() };
        }
      } catch (err) {
        console.error('[App] refreshAll failed for', fund.id, err);
        issues[fund.id] = { reason: 'network', at: Date.now() };
      }
      if (i < funds.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // 上报整体替换（成功基金不保留旧失败标记）
    if (refreshGenerationRef.current !== myGen) return;
    useStore.getState().setRefreshIssues(issues);

    // --- Index 批量拉取 ---
    // 腾讯 qt.gtimg.cn 支持 `q=a,b,c` 一次拿 3 条，所以这里只发 1 个 HTTP。
    // 设计决策：index 不接 `hasStale` 闸门（那个闸门判断的是"基金 NAV 是否过时"），
    // 也不接 chineseHolidays（A股休市时美股正常交易，反之亦然）——每个 index 自己判断。
    try {
      const allData = await fetchMarketIndices();
      if (refreshGenerationRef.current !== myGen) return;
      for (const spec of INDEX_LIST) {
        if (refreshGenerationRef.current !== myGen) return;
        const raw = allData[spec.code];
        if (!raw) continue;
        const cached = useStore.getState().indices[spec.code];
        const newQuote: IndexQuote = {
          name: spec.name,
          market: spec.market,
          value: raw.value,
          change: raw.change,
          changePercent: raw.changePercent,
          date: raw.date,
          time: raw.rawTime,
          fetchedAt: Date.now(),
        };
        if (shouldUpdateIndexQuote(cached, newQuote)) {
          updateIndex(spec.code, newQuote);
        }
      }
    } catch (err) {
      console.error('[App] refreshAll index batch failed:', err);
    }

    if (refreshGenerationRef.current !== myGen) return;
    // NAV history is now fresh — try to auto-confirm pending transactions whose NAV is available
    // 用 useStore.getState() 读最新 transactions，避免把 transactions 加进依赖
    const confirmedCount = autoConfirmPending();
    if (refreshGenerationRef.current !== myGen) return;
    if (confirmedCount > 0) {
      message.success(`已自动确认 ${confirmedCount} 笔历史交易`);
    }
    // 所有 updateNavHistory 都已完成 → 用刚写入的 navHistory 对比上次观测基线。
    // 必须放在循环之后：freshness 读的就是 navHistory，提前调用会看到旧数据。
    useStore.getState().recordNavFreshness();
    if (refreshGenerationRef.current !== myGen) return;
    const updatedFunds = useStore.getState().funds;
    const updatedTxs = useStore.getState().transactions;
    const snapshot = generateSnapshot(updatedFunds, updatedTxs);
    if (snapshot) addSnapshot(snapshot);
  }, [funds.length, updateFund, updateNavHistory, updateTransaction, addSnapshot, updateIndex, autoConfirmPending]);

  useEffect(() => {
    if (!settings.navAutoRefresh || funds.length === 0) return;
    const myGen = refreshGenerationRef.current + 1;
    refreshAll().then(() => {
      if (refreshGenerationRef.current !== myGen) return; // a newer refresh is in flight
      reportRefreshOutcome(useStore.getState().refreshIssues, useStore.getState().funds.length);
    }).catch((err) => {
      if (refreshGenerationRef.current !== myGen) return;
      console.error('[App] refreshAll error:', err);
      message.warning('净值刷新失败，请检查网络');
    });
  }, [settings.navAutoRefresh, funds.length, refreshAll]);

  // Manual refresh trigger: Settings 的 "重置净值历史" 会调用 store.requestRefresh()
  // 把 refreshTrigger 计数 +1，本 effect 借此触发一次全量刷新
  // （refreshTrigger 初始为 0，跳过首次挂载——交给上面的自动刷新 effect 处理）
  useEffect(() => {
    if (refreshTrigger === 0) return;
    if (funds.length === 0) return;
    const myGen = refreshGenerationRef.current + 1;
    refreshAll().then(() => {
      if (refreshGenerationRef.current !== myGen) return;
      reportRefreshOutcome(useStore.getState().refreshIssues, useStore.getState().funds.length);
    }).catch((err) => {
      if (refreshGenerationRef.current !== myGen) return;
      console.error('[App] refreshAll error:', err);
      message.warning('净值刷新失败，请检查网络');
    });
  }, [refreshTrigger, funds.length, refreshAll]);

  // 定时刷新：覆盖晚间 NAV 实际发布时间（通常 20:30-22:00；QDII 节奏靠 navFreshness 观测法自适配），
  // 让 app 持续打开的用户无需手动操作即可看到最新净值日盈亏。
  // 不绑死时间点：纯靠 hasStale 闸门——任一基金 navDate < today 才发起请求，
  // 数据跟齐后所有 tick 早 return，无 API 配额消耗。
  // 退避：同一批 stale 基金连续 tick 无变化 → 隔次跳过。失效基金（如 sc 新格式
  // 永久跳过）原本每 30 分钟空轮询一次；跳 3 次后强制跑一次，给数据源自愈留窗口，
  // 等效把空轮询降到 2 小时一次。集合一有变化（有基金更新/新增/删除）立即恢复正常。
  const lastStaleIdsRef = useRef<Set<string> | null>(null);
  const skippedTicksRef = useRef(0);

  useEffect(() => {
    if (!settings.navAutoRefresh || funds.length === 0) return;

    const sameSet = (a: Set<string>, b: Set<string>) =>
      a.size === b.size && Array.from(a).every((id) => b.has(id));

    const tick = () => {
      const today = dayjs().format('YYYY-MM-DD');
      const staleIds = new Set(
        useStore.getState().funds.filter((f) => f.navDate < today).map((f) => f.id),
      );
      if (staleIds.size === 0) {
        lastStaleIdsRef.current = null;
        skippedTicksRef.current = 0;
        return;
      }
      const unchanged = lastStaleIdsRef.current !== null && sameSet(lastStaleIdsRef.current, staleIds);
      lastStaleIdsRef.current = staleIds;
      if (unchanged && skippedTicksRef.current < 3) {
        skippedTicksRef.current++;
        console.debug('[App] periodic refresh: stale set unchanged, backing off (skipped', skippedTicksRef.current, 'ticks)');
        return;
      }
      skippedTicksRef.current = 0;
      console.debug('[App] periodic refresh: stale NAV detected, fetching');
      refreshAll().catch((err) => {
        console.error('[App] periodic refresh error:', err);
      });
    };

    const intervalId = setInterval(tick, 30 * 60 * 1000); // 30 分钟粒度
    return () => clearInterval(intervalId);
  }, [settings.navAutoRefresh, funds.length, refreshAll]);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: settings.theme === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1677ff',
        },
      }}
    >
      <BrowserRouter
        basename="/fund-tracker"
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/funds" element={<FundList />} />
            <Route path="/funds/:id" element={<FundDetail />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/dca" element={<DcaPlans />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  );
}
