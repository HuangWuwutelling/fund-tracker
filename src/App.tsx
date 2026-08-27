import { useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider, theme, message } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useStore } from './stores';
import { fetchFundEstimate, fetchNavHistory } from './api/fundApi';
import { generateSnapshot } from './utils/snapshot';
import { today } from './utils/formatter';
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

  // Auto-refresh NAV + generate snapshot when funds are loaded
  const refreshAll = useCallback(async () => {
    if (funds.length === 0) return;

    for (let i = 0; i < funds.length; i++) {
      const fund = funds[i]!;
      try {
        const estimate = await fetchFundEstimate(fund.id);
        if (estimate && estimate.lastNav > 0) {
          updateFund(fund.id, {
            currentNav: estimate.lastNav,
            navDate: estimate.navDate,
          });

          // Also fetch recent NAV history (merge with existing)
          const endDate = today();
          const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const history = await fetchNavHistory(fund.id, startDate, endDate);
          if (history.length > 0) {
            updateNavHistory(fund.id, history);
          }
        }
      } catch {
        // Skip failed funds silently
      }
      // Rate limit
      if (i < funds.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // Generate today's snapshot after refresh
    const updatedFunds = useStore.getState().funds;
    const updatedTxs = useStore.getState().transactions;
    const snapshot = generateSnapshot(updatedFunds, updatedTxs);
    addSnapshot(snapshot);
  }, [funds.length, updateFund, updateNavHistory, addSnapshot, transactions]);

  useEffect(() => {
    if (settings.navAutoRefresh && funds.length > 0) {
      refreshAll().then(() => {
        message.success('净值已更新');
      }).catch(() => {
        message.warning('净值刷新失败，请检查网络');
      });
    }
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
