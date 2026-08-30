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
  const { settings, funds, loadFromStorage, updateFund, updateNavHistory, updateTransaction, addSnapshot } = useStore();

  useEffect(() => {
    loadFromStorage();
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

          if (result.navHistory.length > 0) {
            updateNavHistory(fund.id, result.navHistory);
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
    addSnapshot(snapshot);
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
