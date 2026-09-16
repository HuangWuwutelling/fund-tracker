import { useState } from 'react';
import { Layout, Menu, Button, Modal, Typography, Switch, Tooltip, Space } from 'antd';
import {
  DashboardOutlined,
  FundOutlined,
  SwapOutlined,
  ScheduleOutlined,
  BarChartOutlined,
  SettingOutlined,
  InfoCircleOutlined,
  BulbOutlined,
  BulbFilled,
} from '@ant-design/icons';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useStore } from '../stores';

const { Header, Sider, Content, Footer } = Layout;
const { Title, Paragraph, Text } = Typography;

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '资产总览' },
  { key: '/funds', icon: <FundOutlined />, label: '基金管理' },
  { key: '/transactions', icon: <SwapOutlined />, label: '交易记录' },
  { key: '/dca', icon: <ScheduleOutlined />, label: '定投计划' },
  { key: '/reports', icon: <BarChartOutlined />, label: '周报/月报' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' },
];

// 面包屑路径映射（顶级菜单路径 → 父级 / 当前标题）
const breadcrumbMap: Record<string, { parent?: string; title: string }> = {
  '/': { title: '资产总览' },
  '/funds': { title: '基金管理' },
  '/transactions': { title: '交易记录' },
  '/dca': { title: '定投计划' },
  '/reports': { title: '周报/月报' },
  '/settings': { title: '设置' },
};

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [aboutOpen, setAboutOpen] = useState(false);
  const { settings, updateSettings } = useStore();
  const isDark = settings.theme === 'dark';

  // Determine selected key from path (match exactly or by top-level segment)
  const selectedKey = (() => {
    const path = location.pathname;
    const exact = menuItems.find((item) => item.key === path);
    if (exact) return exact.key;
    if (path.startsWith('/funds/')) return '/funds';
    const top = '/' + path.split('/').filter(Boolean)[0];
    return menuItems.find((item) => item.key === top)?.key ?? '/';
  })();

  const breadcrumb = breadcrumbMap[selectedKey] ?? { title: '基金投资记录' };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        breakpoint="lg"
        collapsedWidth="0"
        style={{
          background: isDark ? '#141414' : '#fff',
        }}
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
            borderBottom: isDark ? '1px solid #303030' : '1px solid #f0f0f0',
          }}
        >
          💰 基金记账
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ borderRight: 0, background: 'transparent' }}
        />
      </Sider>
      <Layout style={{ background: isDark ? '#000' : '#f5f5f5' }}>
        <Header
          style={{
            background: isDark ? '#1f1f1f' : '#fff',
            padding: '0 24px',
            borderBottom: isDark ? '1px solid #303030' : '1px solid #f0f0f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          <Space size="small" style={{ color: isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)' }}>
            {breadcrumb.parent && (
              <>
                <span style={{ fontWeight: 400, color: '#999' }}>{breadcrumb.parent}</span>
                <span style={{ color: '#999' }}>/</span>
              </>
            )}
            <span>{breadcrumb.title}</span>
          </Space>

          <Space size="middle">
            <Tooltip title={isDark ? '切换到浅色主题' : '切换到深色主题'}>
              <Switch
                size="small"
                checked={isDark}
                onChange={(checked) => updateSettings({ theme: checked ? 'dark' : 'light' })}
                checkedChildren={<BulbFilled />}
                unCheckedChildren={<BulbOutlined />}
              />
            </Tooltip>
            <Button
              type="text"
              icon={<SettingOutlined />}
              onClick={() => navigate('/settings')}
              title="设置"
            />
          </Space>
        </Header>
        <Content style={{ margin: 24 }}>
          <Outlet />
        </Content>
        <Footer style={{ textAlign: 'center', color: '#999', fontSize: 12, padding: '16px 24px', background: 'transparent' }}>
          仅为个人记录，不构成投资建议。数据延迟以各基金实际披露为准（A 股 T+1、QDII 普遍 T+2），仅供参考。投资有风险，入市需谨慎。
          <Button
            type="link"
            size="small"
            icon={<InfoCircleOutlined />}
            onClick={() => setAboutOpen(true)}
            style={{ marginLeft: 8, padding: 0, fontSize: 12 }}
          >
            关于
          </Button>
        </Footer>
      </Layout>

      <Modal
        title="关于本应用"
        open={aboutOpen}
        onCancel={() => setAboutOpen(false)}
        footer={<Button onClick={() => setAboutOpen(false)}>关闭</Button>}
        width={560}
      >
        <Title level={4} style={{ marginTop: 0 }}>基金投资记录</Title>
        <Paragraph>
          这是一个<strong>个人向</strong>的基金投资跟踪工具，把分散在多个直销平台（南方基金、摩根、广发基金等）的持仓聚合到一处，
          做收益分析（总收益、最新净值日盈亏、年化 XIRR、累计分红）和定投管理（多频率执行追踪 + 周报月报）。
        </Paragraph>

        <Title level={5}>技术栈</Title>
        <Paragraph>
          <ul style={{ marginBottom: 0, paddingLeft: 20 }}>
            <li>React 18 + TypeScript 5.6 + Vite 6</li>
            <li>Ant Design 5（中文本地化）</li>
            <li>ECharts（echarts-for-react）—— 饼图、折线图</li>
            <li>Zustand 5 —— 全局状态管理</li>
            <li>React Router 6 —— GitHub Pages 部署</li>
            <li>dayjs —— 日期处理</li>
            <li>uuid —— 交易 / 定投 ID</li>
          </ul>
        </Paragraph>

        <Title level={5}>数据说明</Title>
        <Paragraph>
          纯前端应用，所有数据存储在访问者<strong>自己浏览器</strong>的 localStorage，<Text type="danger">不上传到任何服务器</Text>。
          多设备同步需要手动在「设置 → 数据管理」导出 / 导入 JSON 备份。
        </Paragraph>

        <Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12 }}>
          仅为个人记录，不构成投资建议。数据延迟以各基金实际披露为准（A 股 T+1、QDII 普遍 T+2），仅供参考。投资有风险，入市需谨慎。
        </Paragraph>
      </Modal>
    </Layout>
  );
}
