import { useState, useEffect, useCallback } from 'react';
import { Button, Card, Table, Modal, Form, Select, Input, Tag, message, Popconfirm, Space, Typography, Empty } from 'antd';
import { PlusOutlined, SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../stores';
import { fetchFundWithHistory, loadFundSearchList, searchFunds, getFundTypeFromSearch } from '../api/fundApi';
import { formatDate } from '../utils/formatter';
import InitialPositionModal from '../components/InitialPositionModal';
import NavLink from '../components/NavLink';
import { FUND_TYPE_LABELS } from '../types';
import type { Fund } from '../types';
import type { FundSearchItem } from '../api/fundApi';

const { Text } = Typography;

export default function FundList() {
  const { funds, platforms, addFund, removeFund, updateNavHistory, updateFund, getNavHistory } = useStore();
  const navigate = useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [searchItems, setSearchItems] = useState<FundSearchItem[]>([]);
  const [searchResults, setSearchResults] = useState<FundSearchItem[]>([]);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [listLoaded, setListLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<Fund['type'] | null>(null);
  const [initModalOpen, setInitModalOpen] = useState(false);
  const [initFundId, setInitFundId] = useState<string | null>(null);

  // Load fund search list when modal opens
  useEffect(() => {
    if (modalOpen && !listLoaded) {
      loadFundSearchList()
        .then((items) => {
          setSearchItems(items);
          setListLoaded(true);
        })
        .catch(() => {
          message.warning('基金列表加载失败，仍可使用代码查询');
        });
    }
  }, [modalOpen, listLoaded]);

  const handleSearch = useCallback((keyword: string) => {
    setSearchKeyword(keyword);
    if (!keyword.trim() || searchItems.length === 0) {
      setSearchResults([]);
      return;
    }
    const results = searchFunds(keyword, searchItems);
    setSearchResults(results);
  }, [searchItems]);

  const handleSelectFund = (item: FundSearchItem) => {
    form.setFieldsValue({
      id: item.code,
      name: item.name,
    });
    setSelectedType(getFundTypeFromSearch(item.type, item.name));
    setSearchKeyword('');
    setSearchResults([]);
  };

  const handleRefreshNav = async (fundId: string) => {
    setRefreshing(fundId);
    try {
      const result = await fetchFundWithHistory(fundId);
      if (!result) {
        message.error('刷新失败，请检查网络');
        return;
      }
      const records = result.navHistory;
      if (records.length > 0) {
        updateNavHistory(fundId, records);
      }
      if (result.estimate.lastNav > 0) {
        updateFund(fundId, {
          currentNav: result.estimate.lastNav,
          navDate: result.estimate.navDate,
        });
      }
      message.success(`已加载 ${records.length} 条历史净值`);
    } catch {
      message.error('刷新失败');
    } finally {
      setRefreshing(null);
    }
  };

  const handleAdd = async () => {
    try {
      const values = await form.validateFields();
      const code = values.id as string;

      if (funds.some((f) => f.id === code)) {
        message.warning('该基金已存在');
        return;
      }

      setLoading(true);
      let result: Awaited<ReturnType<typeof fetchFundWithHistory>>;
      try {
        result = await fetchFundWithHistory(code);
      } catch (err) {
        console.error('[FundList] fetchFundWithHistory failed', err);
        message.error('获取基金数据失败，请检查网络或基金代码');
        setLoading(false);
        return;
      }

      // API 返回 null 通常表示代码无效或暂时无法访问——拒绝添加，
      // 避免后续所有"净值缺失"症状都被静默累积（持仓、市值、当日盈亏全为空）
      if (!result) {
        message.error('未找到该基金，请确认代码后重试');
        setLoading(false);
        return;
      }

      const estimate = result.estimate;
      const fund: Fund = {
        id: code,
        name: estimate?.name ?? values.name,
        platformId: values.platformId as string,
        type: selectedType ?? 'mixed',
        currentNav: estimate?.lastNav ?? 0,
        navDate: estimate?.navDate ?? '',
      };

      addFund(fund);

      const records = result.navHistory ?? [];
      if (records.length > 0) {
        updateNavHistory(code, records);
        message.success(`添加成功，已加载 ${records.length} 条历史净值`);
      } else {
        message.warning('添加成功，但暂无历史净值数据，建议稍后刷新');
      }

      // 询问是否设置初始持仓
      setInitFundId(code);
      setInitModalOpen(true);

      setModalOpen(false);
      form.resetFields();
      setSelectedType(null);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  };

  const columns = [
    { title: '基金代码', dataIndex: 'id', key: 'id', width: 100, sorter: (a: Fund, b: Fund) => a.id.localeCompare(b.id) },
    {
      title: '基金名称',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      sorter: (a: Fund, b: Fund) => a.name.localeCompare(b.name, 'zh-CN'),
      render: (name: string, record: Fund) => (
        <NavLink onClick={() => navigate(`/funds/${record.id}`)}>{name}</NavLink>
      ),
    },
    {
      title: '平台',
      key: 'platform',
      width: 100,
      sorter: (a: Fund, b: Fund) => {
        const an = platforms.find((p) => p.id === a.platformId)?.name ?? '';
        const bn = platforms.find((p) => p.id === b.platformId)?.name ?? '';
        return an.localeCompare(bn, 'zh-CN');
      },
      render: (_: unknown, record: Fund) =>
        platforms.find((p) => p.id === record.platformId)?.name ?? '—',
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 100,
      sorter: (a: Fund, b: Fund) => FUND_TYPE_LABELS[a.type].localeCompare(FUND_TYPE_LABELS[b.type], 'zh-CN'),
      render: (type: Fund['type']) => <Tag>{FUND_TYPE_LABELS[type]}</Tag>,
    },
    {
      title: '最新净值',
      dataIndex: 'currentNav',
      key: 'currentNav',
      width: 120,
      sorter: (a: Fund, b: Fund) => a.currentNav - b.currentNav,
      render: (nav: number) => nav.toFixed(4),
    },
    {
      title: '净值日期',
      dataIndex: 'navDate',
      key: 'navDate',
      width: 120,
      sorter: (a: Fund, b: Fund) => a.navDate.localeCompare(b.navDate),
      render: (date: string) => formatDate(date),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_: unknown, record: Fund) => {
        const hasHistory = getNavHistory(record.id).length > 0;
        return (
          <Space>
            <Button
              type="link"
              size="small"
              icon={<ReloadOutlined />}
              loading={refreshing === record.id}
              onClick={() => handleRefreshNav(record.id)}
            >
              {hasHistory ? '刷新净值' : '加载净值'}
            </Button>
            <Popconfirm
              title="确定删除该基金？"
              description="关联的交易记录和定投计划也会被删除"
              onConfirm={() => {
                removeFund(record.id);
                message.success('已删除');
              }}
            >
              <Button type="link" danger size="small">
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <Card
      title="基金管理"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
          添加基金
        </Button>
      }
    >
      <Table
        dataSource={funds}
        columns={columns}
        rowKey="id"
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: '暂无基金，点击"添加基金"开始' }}
      />

      <Modal
        title="添加基金"
        open={modalOpen}
        onOk={handleAdd}
        onCancel={() => {
          setModalOpen(false);
          form.resetFields();
          setSearchKeyword('');
          setSearchResults([]);
          setSelectedType(null);
        }}
        okText="添加"
        cancelText="取消"
        confirmLoading={loading}
        width={560}
      >
        {/* Standalone search box - NOT bound to form */}
        <div style={{ marginBottom: 16 }}>
          <Input
            size="large"
            prefix={<SearchOutlined />}
            placeholder="搜索基金代码、名称或拼音"
            value={searchKeyword}
            onChange={(e) => handleSearch(e.target.value)}
            allowClear
          />
          {searchItems.length === 0 && (
            <div style={{ color: '#999', fontSize: 12, marginTop: 4 }}>正在加载基金列表...</div>
          )}
          {searchResults.length > 0 && (
            <Card size="small" style={{ marginTop: 8, maxHeight: 240, overflow: 'auto' }}>
              {searchResults.map((item) => {
                const mappedType = getFundTypeFromSearch(item.type, item.name);
                return (
                  <div
                    key={item.code}
                    onClick={() => handleSelectFund(item)}
                    style={{
                      padding: '8px 12px',
                      cursor: 'pointer',
                      borderBottom: '1px solid #f0f0f0',
                    }}
                  >
                    <Space>
                      <Text strong style={{ minWidth: 60 }}>{item.code}</Text>
                      <Text>{item.name}</Text>
                      <Tag color="blue">{FUND_TYPE_LABELS[mappedType]}</Tag>
                    </Space>
                  </div>
                );
              })}
            </Card>
          )}
          {searchKeyword && searchResults.length === 0 && searchItems.length > 0 && (
            <div style={{ marginTop: 8 }}><Empty description="无匹配结果" /></div>
          )}
        </div>

        <Form form={form} layout="vertical">
          <Form.Item label="基金代码" name="id" rules={[{ required: true, message: '请搜索选择或手动输入代码' }]}>
            <Input placeholder="上方搜索后自动填充" />
          </Form.Item>
          <Form.Item label="基金名称" name="name" rules={[{ required: true, message: '请搜索选择或手动输入名称' }]}>
            <Input placeholder="搜索选择后自动填充，也可手动修改" />
          </Form.Item>
          <Form.Item label="投资平台" name="platformId" rules={[{ required: true, message: '请选择平台' }]}>
            <Select placeholder="选择平台">
              {platforms.map((p) => (
                <Select.Option key={p.id} value={p.id}>
                  {p.name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          {selectedType && (
            <div style={{ color: '#666', fontSize: 13, marginBottom: 16 }}>
              已识别基金类型：<Tag color="blue">{FUND_TYPE_LABELS[selectedType]}</Tag>
            </div>
          )}
        </Form>
      </Modal>

      <InitialPositionModal
        fundId={initFundId}
        open={initModalOpen}
        onClose={() => { setInitModalOpen(false); setInitFundId(null); }}
      />
    </Card>
  );
}