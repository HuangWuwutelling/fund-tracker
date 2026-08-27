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

const { Header, Sider, Content } = Layout;

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

  // Determine selected key from path
  const selectedKey = menuItems.find((item) => {
    if (item.key === '/') return location.pathname === '/';
    return location.pathname.startsWith(item.key);
  })?.key ?? '/';

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
      </Layout>
    </Layout>
  );
}
