import { useState } from 'react';
import { Button, Card, Table, Modal, Form, Input, Select, Tag, message, Popconfirm } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useStore } from '../stores';
import { fetchFundEstimate } from '../api/fundApi';
import { formatDate } from '../utils/formatter';
import { FUND_TYPE_LABELS } from '../types';
import type { Fund } from '../types';

export default function FundList() {
  const { funds, platforms, addFund, removeFund } = useStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [_fetchedInfo, setFetchedInfo] = useState<{ name: string; code: string } | null>(null);

  const handleFetchFund = async () => {
    const code = form.getFieldValue('id');
    if (!code) {
      message.warning('请先输入基金代码');
      return;
    }
    setLoading(true);
    try {
      const estimate = await fetchFundEstimate(code);
      if (estimate) {
        form.setFieldsValue({ name: estimate.name });
        setFetchedInfo({ name: estimate.name, code: estimate.code });
        message.success(`已找到: ${estimate.name}`);
      } else {
        message.error('未找到该基金，请检查代码');
      }
    } catch {
      message.error('查询失败，请检查网络');
    }
    setLoading(false);
  };

  const handleAdd = async () => {
    try {
      const values = await form.validateFields();
      const code = values.id as string;

      // Check duplicate
      if (funds.some((f) => f.id === code)) {
        message.warning('该基金已存在');
        return;
      }

      // Re-fetch latest NAV (user may have waited after initial query)
      const estimate = await fetchFundEstimate(code);
      const fund: Fund = {
        id: code,
        name: values.name as string,
        platformId: values.platformId as string,
        type: values.type as Fund['type'],
        currentNav: estimate?.lastNav ?? (values.currentNav as number) ?? 0,
        navDate: estimate?.navDate ?? '',
      };

      addFund(fund);
      message.success('添加成功');
      setModalOpen(false);
      form.resetFields();
      setFetchedInfo(null);
    } catch {
      // validation failed
    }
  };

  const columns = [
    { title: '基金代码', dataIndex: 'id', key: 'id', width: 100 },
    { title: '基金名称', dataIndex: 'name', key: 'name' },
    {
      title: '平台',
      key: 'platform',
      render: (_: unknown, record: Fund) =>
        platforms.find((p) => p.id === record.platformId)?.name ?? '—',
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      render: (type: Fund['type']) => <Tag>{FUND_TYPE_LABELS[type]}</Tag>,
    },
    {
      title: '最新净值',
      dataIndex: 'currentNav',
      key: 'currentNav',
      render: (nav: number) => nav.toFixed(4),
    },
    {
      title: '净值日期',
      dataIndex: 'navDate',
      key: 'navDate',
      render: (date: string) => formatDate(date),
    },
    {
      title: '操作',
      key: 'actions',
      width: 80,
      render: (_: unknown, record: Fund) => (
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
      ),
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
        locale={{ emptyText: '暂无基金，点击"添加基金"开始' }}
      />

      <Modal
        title="添加基金"
        open={modalOpen}
        onOk={handleAdd}
        onCancel={() => {
          setModalOpen(false);
          form.resetFields();
          setFetchedInfo(null);
        }}
        okText="添加"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item label="基金代码" name="id" rules={[{ required: true, message: '请输入基金代码' }]}>
            <Input.Search
              placeholder="如 160140"
              enterButton="查询"
              loading={loading}
              onSearch={handleFetchFund}
            />
          </Form.Item>
          <Form.Item label="基金名称" name="name" rules={[{ required: true, message: '请先查询基金' }]}>
            <Input placeholder="查询后自动填充" disabled />
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
          <Form.Item label="基金类型" name="type" initialValue="index" rules={[{ required: true }]}>
            <Select>
              {Object.entries(FUND_TYPE_LABELS).map(([key, label]) => (
                <Select.Option key={key} value={key}>
                  {label}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
