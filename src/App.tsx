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
import { INDEX_LIST } from './types';
import { fetchFundWithHistory } from './api/fundApi';
import { fetchMarketIndices } from './api/indexApi';
import { shouldUpdateIndexQuote } from './utils/indexQuote';
import { decideTickAction, PLAN_FULL, type RefreshPlan } from './utils/refreshPolicy';
import { runRefreshCycle } from './refresh/refreshCycle';
import { hasStorageWriteFailure, STORAGE_WRITE_FAILED_MSG } from './utils/storage';
import AppLayout from './components/Layout';
import Dashboard from './pages/Dashboard';
import FundList from './pages/FundList';
import FundDetail from './pages/FundDetail';
import Transactions from './pages/Transactions';
import DcaPlans from './pages/DcaPlans';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

/**
 * 指数行情批量刷新（独立于基金净值刷新链路）。
 *
 * 腾讯 qt.gtimg.cn 支持 `q=a,b,c` 一次拿 3 条，所以这里只发 1 个 HTTP。
 * 设计决策：index 不接 `hasStale` 闸门（那个闸门判断的是"基金 NAV 是否过时"），
 * 也不接 chineseHolidays（A股休市时美股正常交易，反之亦然）——每个 index 自己判断。
 *
 * ⚠️ 必须是独立函数：曾经这段逻辑内联在 refreshAll 里，而定时 tick 的"基金净值
 * 退避"会整条跳过 refreshAll —— 于是指数点位跟着被降到 ~2 小时一次，Dashboard
 * 上的指数长时间不更新。指数与基金净值没有依赖关系，不该被那个闸门牵连。
 *
 * 写入用 shouldUpdateIndexQuote 兜底（只接受比 cache 更新的日期），所以不需要
 * refreshAll 那套 generation 中断机制——过期的响应写不进去。
 */
async function refreshMarketIndices(): Promise<IndexQuote[]> {
  try {
    const allData = await fetchMarketIndices();
    for (const spec of INDEX_LIST) {
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
        useStore.getState().updateIndex(spec.code, newQuote);
      }
    }
  } catch (err) {
    console.error('[App] index batch failed:', err);
  }
  return [];
}

/** 按刷新结果分档提示：全部成功 success / 部分失败 warning / 全部失败 error。
 *  此前无条件 message.success('净值已更新')，sc 新格式基金被跳过时用户毫无感知。 */
function reportRefreshOutcome(issues: Record<string, FundRefreshIssue>, total: number) {  const failedIds = Object.keys(issues);
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
  const { settings, funds, refreshTrigger, loadFromStorage, updateFund, updateNavHistory, updateTransaction, regenerateTodaySnapshot, updateIndex } = useStore();

  /**
   * 多标签页同步。
   *
   * 内存状态是**启动时**从 localStorage 读一次的，此后一直拿内存写盘。所以同一
   * 浏览器开两个标签页时，两个标签页各有一份内存状态 —— 后写的会覆盖先写的
   * （丢数据），而且"内存 == 磁盘"的不变式只在单标签页内成立：一个标签页的内存
   * 可能已被另一个改过期，它再写就是拿过期状态盖掉对方的新数据。
   *
   * `storage` 事件只在**其它**标签页写 localStorage 时触发，正好用来重新加载。
   * 合并 500ms 窗口：一次刷新会写十几个 key（15 只基金的净值历史），逐个重载太浪费。
   */
  useEffect(() => {
    let timer: number | undefined;
    const onStorage = (e: StorageEvent) => {
      if (e.key && !e.key.startsWith('fund-tracker:')) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        loadFromStorage();
      }, 500);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('storage', onStorage);
    };
  }, [loadFromStorage]);

  useEffect(() => {
    loadFromStorage();
    // 定投自动记录：用 getState() 读刚加载的最新 settings（渲染闭包里的还是默认值），
    // 启用时把到期计划补成待确认买入。放在 refreshAll 之前，让刚生成的过去日期
    // pending 记录能在同一次刷新里被 autoConfirmPending 确认。
    if (useStore.getState().settings.dcaAutoRecord) {
      const auto = useStore.getState().autoRecordDcaPlans();
      if (auto.writeFailed) {
        message.error(STORAGE_WRITE_FAILED_MSG, 8);
      } else if (auto.created > 0) {
        message.success(`已按定投计划自动生成 ${auto.created} 笔待确认买入，请到「交易记录」核对`);
      }
    }
  }, [loadFromStorage]);

  // localStorage 写失败（QuotaExceededError 写满 5MB / 隐私模式禁写等）→ storage 层
  // 广播 STORAGE_ERROR_EVENT → 由 components/StorageErrorBanner.tsx 常驻展示
  // （必须常驻：写入失败时数据只在内存里，刷新即丢，toast 会被错过）。
  useEffect(() => {
    // 挂载时若已处于失败状态，提示一次（Banner 组件自己也会检查）
    if (hasStorageWriteFailure()) {
      message.error('浏览器存储空间不足，最近的数据可能没有保存！请立即导出备份', 8);
    }
  }, []);

  // Generation counter to bail out stale refreshAll calls when a newer one starts.
  // refreshAll's deps include `transactions`, so adding a tx fires a new refresh —
  // the in-flight old one must not overwrite with stale state.
  const refreshGenerationRef = useRef(0);


  // Auto-refresh NAV + generate snapshot when funds are loaded
  //
  // 顺序约束（指数先拉 / 确认在净值写入之后 / 基线在循环之后 / 快照最后）
  // 写在 refresh/refreshCycle.ts 的函数体里，并在那边有测试钉住——
  // 重排任何一个都不会报错，只会静默产出错误数字。
  const refreshAll = useCallback(async (plan: RefreshPlan = PLAN_FULL) => {
    const myGen = ++refreshGenerationRef.current;
    const store = useStore.getState();
    const fundIds = store.funds.map((f) => f.id);

    const outcome = await runRefreshCycle(
      {
        fundIds,
        fetchFundNav: fetchFundWithHistory,
        fetchIndexQuotes: refreshMarketIndices,
        navOf: (id) => useStore.getState().getNavHistory(id),
        pendingTransactions: () => useStore.getState().transactions,
        commitFund: (id, nav, navDate) => updateFund(id, { currentNav: nav, navDate }),
        commitNavHistory: (id, records) => updateNavHistory(id, records),
        commitTransaction: (id, patch) => updateTransaction(id, patch),
        commitSnapshot: () => regenerateTodaySnapshot(),
        recordBaseline: () => useStore.getState().recordNavFreshness(),
        paceMs: 500,
        isAborted: () => refreshGenerationRef.current !== myGen,
      },
      // 没有基金时只刷指数（与旧实现一致：空账户不该产生零值快照）
      fundIds.length === 0 ? { runIndices: plan.runIndices, runFundNavs: false } : plan,
    );

    // 上报整体替换（成功基金不保留旧失败标记）
    useStore.getState().setRefreshIssues(outcome.issues);

    if (outcome.confirmedCount > 0) {
      message.success(`已自动确认 ${outcome.confirmedCount} 笔历史交易`);
    }
    return outcome;
  }, [updateFund, updateNavHistory, updateTransaction, regenerateTodaySnapshot, updateIndex]);

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

  // Manual refresh trigger: Settings 的 "重置净值历史" 会把 refreshTrigger 计数 +1
  // （store.resetNavHistory 里直接 set），本 effect 借此触发一次全量刷新
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
  // 退避：同一批 stale 基金连续 tick 无变化 → 基金净值部分隔次跳过。失效基金
  // （如 sc 新格式永久跳过）原本每 30 分钟空轮询一次；跳 3 次后强制跑一次，
  // 给数据源自愈留窗口，等效把空轮询降到 2 小时一次。集合一有变化立即恢复正常。
  //
  // ⚠️ 指数行情不受这个退避影响——指数与基金净值没有依赖关系，退避时照刷。
  // 决策抽到 utils/refreshPolicy.ts（纯函数、可单测），避免"退避"被误实现成
  // "整条链路都不动"。
  const lastStaleIdsRef = useRef<Set<string> | null>(null);
  const skippedTicksRef = useRef(0);

  useEffect(() => {
    if (!settings.navAutoRefresh || funds.length === 0) return;

    const tick = () => {
      const today = dayjs().format('YYYY-MM-DD');
      const staleIds = new Set(
        useStore.getState().funds.filter((f) => f.navDate < today).map((f) => f.id),
      );
      const plan = decideTickAction(staleIds, lastStaleIdsRef.current, skippedTicksRef.current);
      lastStaleIdsRef.current = staleIds;

      if (!plan.runIndices && !plan.runFundNavs) {
        skippedTicksRef.current = 0;
        return;
      }
      if (!plan.runFundNavs) {
        // 基金净值退避，**指数行情照刷**——指数与基金净值没有依赖关系，
        // 曾经指数拉取被包在整条刷新链路里，退避时一起被跳过，
        // Dashboard 的指数点位从每 30 分钟退化到 ~2 小时一次。
        skippedTicksRef.current++;
        console.debug('[App] periodic refresh: stale set unchanged, backing off (skipped', skippedTicksRef.current, 'ticks) — 指数行情照常刷新');
        void refreshMarketIndices();
        return;
      }
      skippedTicksRef.current = 0;
      console.debug('[App] periodic refresh: stale NAV detected, fetching');
      refreshAll(plan).catch((err) => {
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
