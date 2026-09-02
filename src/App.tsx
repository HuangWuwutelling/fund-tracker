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
import { fetchFundWithHistory } from './api/fundApi';
import { generateSnapshot } from './utils/snapshot';
import { lookupNavForDate } from './utils/navLookup';
import { calcSharesFromAmount } from './utils/calculator';
import AppLayout from './components/Layout';
import Dashboard from './pages/Dashboard';
import FundList from './pages/FundList';
import FundDetail from './pages/FundDetail';
import Transactions from './pages/Transactions';
import DcaPlans from './pages/DcaPlans';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

export default function App() {
  const { settings, funds, refreshTrigger, loadFromStorage, updateFund, updateNavHistory, updateTransaction, addSnapshot } = useStore();

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

    for (let i = 0; i < funds.length; i++) {
      if (refreshGenerationRef.current !== myGen) return; // superseded
      const fund = funds[i]!;
      try {
        const result = await fetchFundWithHistory(fund.id);
        if (refreshGenerationRef.current !== myGen) return;
        if (result && result.estimate.lastNav > 0) {
          updateFund(fund.id, {
            currentNav: result.estimate.lastNav,
            navDate: result.estimate.navDate,
          });

          // 增量合并净值历史：避免每次刷新都 JSON.stringify + 写 localStorage 全量历史
          // - API 强制返回全量（pingzhongdata 无增量接口），但本地写入可以只追加尾部
          // - 边界日期（localLatest）保留本地值，不覆盖——若 API 修正历史净值，
          //   用户可在 Settings 里点"重置净值历史"强制全量刷新
          if (result.navHistory.length > 0) {
            const localHistory = useStore.getState().getNavHistory(fund.id);
            const localLatest = localHistory[localHistory.length - 1]?.date;
            const remoteLatest = result.navHistory[result.navHistory.length - 1]?.date;
            if (remoteLatest === undefined) continue;

            if (!localLatest) {
              // 本地无历史（首次添加 / import 后被清空）→ 全量写
              updateNavHistory(fund.id, result.navHistory);
            } else if (localLatest === remoteLatest) {
              // 尾部日期一致 → 跳过 navHistory 写入，只更新 Fund 字段（已上面完成）
            } else if (localLatest < remoteLatest) {
              // 远程有更新 → 只追加严格晚于 localLatest 的尾部
              const tail = result.navHistory.filter((r) => r.date > localLatest);
              if (tail.length > 0) {
                updateNavHistory(fund.id, [...localHistory, ...tail]);
              }
            } else {
              // localLatest > remoteLatest：API 缓存陈旧 → 信任本地，跳过 navHistory 写入
              console.debug('[App] nav history remote is older than local for', fund.id, {
                local: localLatest,
                remote: remoteLatest,
              });
            }
          }
        }
      } catch (err) {
        console.error('[App] refreshAll failed for', fund.id, err);
      }
      if (i < funds.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (refreshGenerationRef.current !== myGen) return;
    // NAV history is now fresh — try to auto-confirm pending transactions whose NAV is available
    // 用 useStore.getState() 读最新 transactions，避免把 transactions 加进依赖
    const confirmedCount = autoConfirmPending();
    if (refreshGenerationRef.current !== myGen) return;
    if (confirmedCount > 0) {
      message.success(`已自动确认 ${confirmedCount} 笔历史交易`);
    }
    const updatedFunds = useStore.getState().funds;
    const updatedTxs = useStore.getState().transactions;
    const snapshot = generateSnapshot(updatedFunds, updatedTxs);
    if (snapshot) addSnapshot(snapshot);
  }, [funds.length, updateFund, updateNavHistory, updateTransaction, addSnapshot, autoConfirmPending]);

  useEffect(() => {
    if (!settings.navAutoRefresh || funds.length === 0) return;
    const myGen = refreshGenerationRef.current + 1;
    refreshAll().then(() => {
      if (refreshGenerationRef.current !== myGen) return; // a newer refresh is in flight
      message.success('净值已更新');
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
      message.success('净值已更新');
    }).catch((err) => {
      if (refreshGenerationRef.current !== myGen) return;
      console.error('[App] refreshAll error:', err);
      message.warning('净值刷新失败，请检查网络');
    });
  }, [refreshTrigger, funds.length, refreshAll]);

  // 定时刷新：覆盖晚间 NAV 实际发布时间（A 股 20:30-22:00、QDII T+2 同窗口），
  // 让 app 持续打开的用户无需手动操作即可看到当日盈亏。
  // 不绑死时间点：纯靠 hasStale 闸门——任一基金 navDate < today 才发起请求，
  // 数据跟齐后所有 tick 早 return，无 API 配额消耗。
  useEffect(() => {
    if (!settings.navAutoRefresh || funds.length === 0) return;

    const tick = () => {
      const today = dayjs().format('YYYY-MM-DD');
      const hasStale = useStore.getState().funds.some((f) => f.navDate < today);
      if (!hasStale) return;
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
      <BrowserRouter basename="/fund-tracker">
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
