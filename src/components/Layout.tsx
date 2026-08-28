import { Layout, Menu } from 'antd';
import {
  DashboardOutlined,
  FundOutlined,
  SwapOutlined,
  ScheduleOutlined,
  BarChartOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';

const { Header, Sider, Content, Footer } = Layout;

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '资产总览' },
  { key: '/funds', icon: <FundOutlined />, label: '基金管理' },
  { key: '/transactions', icon: <SwapOutlined />, label: '交易记录' },
  { key: '/dca', icon: <ScheduleOutlined />, label: '定投计划' },
  { key: '/reports', icon: <BarChartOutlined />, label: '周报/月报' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' },
];

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  // Determine selected key from path (match exactly or by top-level segment)
  const selectedKey = (() => {
    const path = location.pathname;
    // Exact match first
    const exact = menuItems.find((item) => item.key === path);
    if (exact) return exact.key;
    // For /funds/:id, highlight /funds
    if (path.startsWith('/funds/')) return '/funds';
    // Match top-level segment
    const top = '/' + path.split('/').filter(Boolean)[0];
    return menuItems.find((item) => item.key === top)?.key ?? '/';
  })();

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        breakpoint="lg"
        collapsedWidth="0"
        style={{ background: '#fff' }}
      >
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 700,
            fontSize: 18,
            color: '#1677ff',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          💰 基金记账
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ borderRight: 0 }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            borderBottom: '1px solid #f0f0f0',
            display: 'flex',
            alignItems: 'center',
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          {menuItems.find((m) => m.key === selectedKey)?.label ?? '基金投资记录'}
        </Header>
        <Content style={{ margin: 24 }}>
          <Outlet />
        </Content>
        <Footer style={{ textAlign: 'center', color: '#999', fontSize: 12, padding: '16px 24px' }}>
          仅为个人记录，不构成投资建议。数据为 T+1，仅供参考。投资有风险，入市需谨慎。
        </Footer>
      </Layout>
    </Layout>
  );
}
