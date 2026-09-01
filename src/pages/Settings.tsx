import { useState, useRef } from 'react';
import { Card, Table, Button, Input, Switch, Space, message, Popconfirm, Typography, Modal, Select } from 'antd';
import { PlusOutlined, DownloadOutlined, UploadOutlined, ExclamationCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useStore } from '../stores';
import type { Platform } from '../types';


export default function Settings() {
  const { platforms, funds, settings, addPlatform, removePlatform, updateSettings, exportData, importData, resetNavHistory, reclassifyFunds } = useStore();
  const [newPlatformName, setNewPlatformName] = useState('');
  const [resetTarget, setResetTarget] = useState<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleReclassify = () => {
    const changed = reclassifyFunds();
    message.success(
      changed > 0 ? `已重新分类 ${changed} 只基金（按名称判断）` : '所有基金类型已正确，无需修改'
    );
  };

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

  // 清除指定基金的本地净值历史（不动 Fund/交易/快照）。
  // 用于 API 修正历史净值但增量同步识别不出的场景；下次 refreshAll 会走"全量写"分支。
  const handleResetOne = () => {
    if (!resetTarget) return;
    const fund = funds.find((f) => f.id === resetTarget);
    const label = fund ? `${fund.name} (${fund.id})` : resetTarget;
    Modal.confirm({
      title: '确认清除该基金的净值历史？',
      icon: <ExclamationCircleOutlined />,
      content: (
        <div>
          <p>将删除本地缓存的 <b>{label}</b> 净值历史。</p>
          <p>下次刷新净值时会重新拉取全量数据。</p>
          <p style={{ color: '#cf1322' }}>此操作不可撤销。</p>
        </div>
      ),
      okText: '确认清除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        resetNavHistory(resetTarget);
        setResetTarget(undefined);
        message.success(`已清除 ${label} 的净值历史`);
      },
    });
  };

  const handleResetAll = () => {
    if (funds.length === 0) return;
    Modal.confirm({
      title: '确认清除全部基金的净值历史？',
      icon: <ExclamationCircleOutlined />,
      content: (
        <div>
          <p>将删除本地缓存的全部 <b>{funds.length}</b> 只基金的净值历史。</p>
          <p>下次刷新净值时会重新拉取全量数据（耗时取决于基金数量）。</p>
          <p style={{ color: '#cf1322' }}>此操作不可撤销。</p>
        </div>
      ),
      okText: '确认清除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        resetNavHistory();
        message.success('已清除全部净值历史');
      },
    });
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
      // 二次确认：导入会覆盖所有现有数据
      Modal.confirm({
        title: '确认导入数据？',
        icon: <ExclamationCircleOutlined />,
        content: (
          <div>
            <p>导入将覆盖当前所有数据：</p>
            <ul>
              <li>平台：{(data as { platforms?: unknown[] }).platforms?.length ?? 0} 个</li>
              <li>基金：{(data as { funds?: unknown[] }).funds?.length ?? 0} 个</li>
              <li>交易：{(data as { transactions?: unknown[] }).transactions?.length ?? 0} 笔</li>
              <li>定投计划：{(data as { dcaPlans?: unknown[] }).dcaPlans?.length ?? 0} 个</li>
              <li>快照：{(data as { snapshots?: unknown[] }).snapshots?.length ?? 0} 条</li>
            </ul>
            <p style={{ color: '#cf1322' }}>此操作不可撤销，建议先导出当前数据作为备份。</p>
          </div>
        ),
        okText: '确认覆盖',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => {
          const autoCreated = importData(data as Parameters<typeof importData>[0]);
          message.success(
            autoCreated > 0
              ? `数据导入成功，已按定投计划自动生成 ${autoCreated} 笔待确认买入`
              : '数据导入成功'
          );
        },
      });
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
            <span>自动刷新净值（打开/运行中；晚间 NAV 发布后会自动拉取）</span>
            <Switch
              checked={settings.navAutoRefresh}
              onChange={(checked) => updateSettings({ navAutoRefresh: checked })}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>定投计划自动生成交易记录</span>
            <Switch
              checked={settings.dcaAutoRecord}
              onChange={(checked) => updateSettings({ dcaAutoRecord: checked })}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>按名称重新分类基金类型</span>
            <Button size="small" onClick={handleReclassify}>重新分类</Button>
          </div>
        </Space>
      </Card>

      <Card title="净值历史" style={{ marginBottom: 16 }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            若某只基金的净值历史异常（如基金公司发布净值修正但本地增量同步未识别），
            可在此清除本地缓存，下次刷新净值时会重新拉取全量数据。
          </Typography.Text>
          <Space wrap>
            <Select
              placeholder={funds.length === 0 ? '暂无基金' : '选择要重置的基金'}
              style={{ width: 280 }}
              value={resetTarget}
              onChange={setResetTarget}
              disabled={funds.length === 0}
              options={funds.map((f) => ({ label: `${f.name} (${f.id})`, value: f.id }))}
              showSearch
              optionFilterProp="label"
            />
            <Button
              danger
              icon={<ReloadOutlined />}
              disabled={!resetTarget}
              onClick={handleResetOne}
            >
              重置选中基金
            </Button>
          </Space>
          <div>
            <Button
              danger
              icon={<ReloadOutlined />}
              disabled={funds.length === 0}
              onClick={handleResetAll}
            >
              重置全部净值历史
            </Button>
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
