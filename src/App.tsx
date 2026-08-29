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
import AppLayout from './components/Layout';
import Dashboard from './pages/Dashboard';
import FundList from './pages/FundList';
import FundDetail from './pages/FundDetail';
import Transactions from './pages/Transactions';
import DcaPlans from './pages/DcaPlans';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

export default function App() {
  const { settings, funds, transactions, loadFromStorage, updateFund, updateNavHistory, addSnapshot } = useStore();

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  // Generation counter to bail out stale refreshAll calls when a newer one starts.
  // refreshAll's deps include `transactions`, so adding a tx fires a new refresh —
  // the in-flight old one must not overwrite with stale state.
  const refreshGenerationRef = useRef(0);

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
    const updatedFunds = useStore.getState().funds;
    const updatedTxs = useStore.getState().transactions;
    const snapshot = generateSnapshot(updatedFunds, updatedTxs);
    addSnapshot(snapshot);
  }, [funds.length, updateFund, updateNavHistory, addSnapshot, transactions]);

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
