import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useStore } from './stores';
import AppLayout from './components/Layout';
import Dashboard from './pages/Dashboard';
import FundList from './pages/FundList';
import FundDetail from './pages/FundDetail';
import Transactions from './pages/Transactions';
import DcaPlans from './pages/DcaPlans';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

export default function App() {
  const { settings, loadFromStorage } = useStore();

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

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
