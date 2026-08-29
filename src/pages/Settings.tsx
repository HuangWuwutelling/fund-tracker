import { useState, useRef } from 'react';
import { Card, Table, Button, Input, Switch, Space, message, Popconfirm, Typography } from 'antd';
import { PlusOutlined, DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import { useStore } from '../stores';
import type { Platform } from '../types';


export default function Settings() {
  const { platforms, funds, settings, addPlatform, removePlatform, updateSettings, exportData, importData } = useStore();
  const [newPlatformName, setNewPlatformName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAddPlatform = () => {
    const name = newPlatformName.trim();
    if (!name) {
      message.warning('请输入平台名称');
      return;
    }
    addPlatform(name);
    setNewPlatformName('');
    message.success('平台已添加');
  };

  const handleRemovePlatform = (id: string) => {
    const ok = removePlatform(id);
    if (!ok) {
      message.error('该平台下还有基金，请先删除或迁移相关基金');
    } else {
      message.success('平台已删除');
    }
  };

/** 校验导入的备份 JSON 是否结构合法；返回 ok=true 或错误描述 */
function validateBackup(data: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: '顶层必须是对象' };
  }
  const d = data as Record<string, unknown>;

  if (!Array.isArray(d.platforms)) return { ok: false, error: 'platforms 必须是数组' };
  if (!Array.isArray(d.funds)) return { ok: false, error: 'funds 必须是数组' };
  if (!Array.isArray(d.transactions)) return { ok: false, error: 'transactions 必须是数组' };
  if (!Array.isArray(d.dcaPlans)) return { ok: false, error: 'dca-plans 必须是数组' };

  // 校验关键字段类型（snapshot/settings 可选，但若存在需正确）
  for (const p of d.platforms) {
    if (typeof p !== 'object' || p === null || typeof (p as Record<string, unknown>).id !== 'string' || typeof (p as Record<string, unknown>).name !== 'string') {
      return { ok: false, error: 'platforms 中存在格式不正确的条目' };
    }
  }
  for (const f of d.funds) {
    if (typeof f !== 'object' || f === null || typeof (f as Record<string, unknown>).id !== 'string') {
      return { ok: false, error: 'funds 中存在格式不正确的条目' };
    }
  }
  for (const t of d.transactions) {
    if (typeof t !== 'object' || t === null || typeof (t as Record<string, unknown>).id !== 'string') {
      return { ok: false, error: 'transactions 中存在格式不正确的条目' };
    }
  }

  if (d.snapshots !== undefined && !Array.isArray(d.snapshots)) {
    return { ok: false, error: 'snapshots 必须是数组' };
  }
  if (d.navHistories !== undefined && (typeof d.navHistories !== 'object' || d.navHistories === null)) {
    return { ok: false, error: 'navHistories 必须是对象' };
  }

  return { ok: true };
}

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      let data: unknown;
      try {
        data = JSON.parse(ev.target?.result as string);
      } catch (err) {
        console.error('[Settings] import parse failed', err);
        message.error('文件解析失败：不是有效的 JSON');
        return;
      }
      const validation = validateBackup(data);
      if (!validation.ok) {
        message.error(`无效的备份文件：${validation.error}`);
        return;
      }
      importData(data as Parameters<typeof importData>[0]);
      message.success('数据导入成功');
    };
    reader.readAsText(file);
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const platformColumns = [
    { title: '平台名称', dataIndex: 'name', key: 'name' },
    {
      title: '关联基金数',
      key: 'fundCount',
      render: (_: unknown, record: Platform) => funds.filter((f) => f.platformId === record.id).length,
    },
    {
      title: '操作',
      key: 'actions',
      width: 80,
      render: (_: unknown, record: Platform) => (
        <Popconfirm title="确定删除该平台？" onConfirm={() => handleRemovePlatform(record.id)}>
          <Button type="link" danger size="small">删除</Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <Card title="平台管理" style={{ marginBottom: 16 }}>
        <Table
          dataSource={platforms}
          columns={platformColumns}
          rowKey="id"
          pagination={false}
          locale={{ emptyText: '暂无平台' }}
        />
        <Space style={{ marginTop: 12 }}>
          <Input
            placeholder="新平台名称"
            value={newPlatformName}
            onChange={(e) => setNewPlatformName(e.target.value)}
            onPressEnter={handleAddPlatform}
            style={{ width: 200 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAddPlatform}>
            添加平台
          </Button>
        </Space>
      </Card>

      <Card title="其他设置" style={{ marginBottom: 16 }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>暗色主题</span>
            <Switch
              checked={settings.theme === 'dark'}
              onChange={(checked) => updateSettings({ theme: checked ? 'dark' : 'light' })}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>自动刷新净值（打开页面时）</span>
            <Switch
              checked={settings.navAutoRefresh}
              onChange={(checked) => updateSettings({ navAutoRefresh: checked })}
            />
          </div>
        </Space>
      </Card>

      <Card title="数据管理">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Button icon={<DownloadOutlined />} onClick={exportData}>
              导出数据备份
            </Button>
            <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
              下载 JSON 文件，包含所有投资数据
            </Typography.Text>
          </div>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleImport}
              style={{ display: 'none' }}
            />
            <Button
              icon={<UploadOutlined />}
              onClick={() => fileInputRef.current?.click()}
              danger
            >
              导入数据
            </Button>
            <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
              从 JSON 备份文件恢复（将覆盖当前数据）
            </Typography.Text>
          </div>
        </Space>
      </Card>
    </div>
  );
}
