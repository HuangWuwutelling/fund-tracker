import { useState, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Card, Collapse, Table, Button, Input, Switch, Space, message, Popconfirm, Typography, Modal, Select } from 'antd';
import { PlusOutlined, DownloadOutlined, UploadOutlined, ExclamationCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useStore } from '../stores';
import type { Platform } from '../types';
import type { UsQdiiFilterMode } from '../utils/navPair';


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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div>美股 QDII 节假日过滤</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                仅影响跟踪美股指数的 QDII（纳指 / 标普 / 道指 / 罗素等）。其他基金（含 A 股、港股 QDII）不套用 strict / auto 模式——A 股若选「不过滤」也会生效（数据本就稀缺，跨节假日"压扁"通常更能接受）。
              </Typography.Text>
            </div>
            <Select
              value={settings.usQdiiFilterMode}
              onChange={(v: UsQdiiFilterMode) => updateSettings({ usQdiiFilterMode: v })}
              style={{ width: 220 }}
              options={[
                {
                  value: 'auto',
                  label: '智能（推荐）',
                  title: '智能：剔除与前一条完全相同的占位条目（nav + accNav 都一致）——数据驱动，对所有年份都生效。',
                },
                {
                  value: 'strict',
                  label: '严格（按美股节假日）',
                  title: '严格：按美股工作日节假日 + 周末剔除（仅 2025-2026 精确，其它年退化为仅周末）。仅对美股跟踪 QDII 生效。',
                },
                {
                  value: 'off',
                  label: '不过滤',
                  title: '不过滤：保留所有原始记录，attribution 跨节假日会被压扁，但 MA250 暖机期最短。**对所有基金生效**（含 A 股），不只是 QDII。',
                },
              ]}
            />
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

      <Collapse
        style={{ marginTop: 16 }}
        items={[
          {
            key: 'ma250',
            label: <strong>MA250 偏离度（估值温度）</strong>,
            children: (
              <div>
                <Typography.Paragraph>
                  <strong>公式：</strong>
                </Typography.Paragraph>
                <pre style={formulaPreStyle}>{`MA250(t) = (NAV(t) + NAV(t-1) + ... + NAV(t-249)) / 250
偏离度(t) = (NAV(t) − MA250(t)) / MA250(t) × 100%

暖机期：前 249 个交易日 MA250 为 null（数据不足）`}</pre>
                <Typography.Paragraph>
                  <strong>怎么读：</strong>
                </Typography.Paragraph>
                <ul style={{ paddingLeft: 20, margin: '8px 0' }}>
                  <li>偏离度 −30% ~ −15%：深度低估（深蓝），分批布局</li>
                  <li>偏离度 −15% ~ −5%：偏低（青），适合定投</li>
                  <li>偏离度 −5% ~ +5%：贴近均线（橙），正常持有</li>
                  <li>偏离度 +5% ~ +15%：偏热（深橙），谨慎追高</li>
                  <li>偏离度 &gt; +15%：深度高估（红），考虑止盈</li>
                </ul>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
                  ⚠ MA250 是趋势指标，单用容易在趋势反转时给出错误信号。建议与 MACD、回撤百分位联合判断。
                  <br />
                  ⚠ 美股 QDII 节假日占位（数据源在美股休市日补的"复制 NAV"）会影响 EMA / MA250 精度——
                  上述指标计算时已自动剔除，剔除行为由「其他设置 → 美股 QDII 节假日过滤」控制。
                </Typography.Paragraph>
              </div>
            ),
          },
          {
            key: 'macd',
            label: <strong>MACD（指数平滑异同移动平均线）</strong>,
            children: (
              <div>
                <Typography.Paragraph>
                  <strong>公式：</strong>
                </Typography.Paragraph>
                <pre style={formulaPreStyle}>{`EMA(t) = NAV(t) × k + EMA(t-1) × (1 − k)，其中 k = 2 / (N + 1)
DIF  = EMA12 − EMA26
DEA  = EMA9(DIF)   （DIF 的 9 日 EMA）
MACD 柱 = (DIF − DEA) × 2

默认参数 12/26/9 由 Gerald Appel 在 1970 年代提出，沿用至今。
暖机期：DIF 自 26 日起有效；DEA/HIST 自 34 日起有效。`}</pre>
                <Typography.Paragraph>
                  <strong>怎么读：</strong>
                </Typography.Paragraph>
                <ul style={{ paddingLeft: 20, margin: '8px 0' }}>
                  <li>
                    <strong style={{ color: '#cf1322' }}>金叉</strong>：DIF 上穿 DEA，短期动能转强
                  </li>
                  <li>
                    <strong style={{ color: '#3f8600' }}>死叉</strong>：DIF 下穿 DEA，短期动能转弱
                  </li>
                  <li>MACD 柱由负转正：DIF 上行加速（强多）</li>
                  <li>MACD 柱由正转负：DIF 下行加速（强空）</li>
                  <li>顶背离 / 底背离：价格新高但 DIF 没新高 = 见顶警示；价格新低但 DIF 没新低 = 见底信号</li>
                </ul>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
                  ⚠ MACD 在震荡市频繁假信号（"MACD 反复金叉死叉"），建议先看 MA250 判断大趋势方向。
                </Typography.Paragraph>
              </div>
            ),
          },
          {
            key: 'drawdown',
            label: <strong>净值回撤百分位</strong>,
            children: (
              <div>
                <Typography.Paragraph>
                  <strong>公式：</strong>
                </Typography.Paragraph>
                <pre style={formulaPreStyle}>{`回撤(t) = (NAV(t) − max(NAV(0..t))) / max(NAV(0..t)) × 100%
百分位(t) = #{ i : 回撤(i) ≥ 回撤(t) } / #{ 有效回撤数 } × 100

百分位越高 → 当前净值越接近历史最低点（越便宜）
百分位越低 → 当前净值越接近历史最高点（越贵）`}</pre>
                <Typography.Paragraph>
                  <strong>怎么读：</strong>
                </Typography.Paragraph>
                <ul style={{ paddingLeft: 20, margin: '8px 0' }}>
                  <li>百分位 ≥ 80%：处于历史最便宜 20% 区间，潜在买入时机</li>
                  <li>百分位 50% ~ 80%：偏便宜</li>
                  <li>百分位 &lt; 50%：偏贵，谨慎追高</li>
                </ul>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
                  ⚠ 历史回撤百分位不预测未来，仅反映当前在历史分布里的位置。新成立基金（&lt; 30 个交易日）数据不足，百分位会显示 — 。
                </Typography.Paragraph>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

const formulaPreStyle: CSSProperties = {
  background: '#f5f5f5',
  padding: 12,
  borderRadius: 4,
  overflow: 'auto',
  margin: '8px 0',
  fontSize: 12,
  lineHeight: 1.6,
};
