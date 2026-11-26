import { useState, useRef, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { Alert, Card, Collapse, Table, Button, Input, Switch, Space, message, Popconfirm, Typography, Modal, Select } from 'antd';
import { PlusOutlined, DownloadOutlined, UploadOutlined, ExclamationCircleOutlined, ReloadOutlined, SaveOutlined, AuditOutlined, ImportOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useStore } from '../stores';
import { checkBackup, type CurrentBackupData } from '../utils/backupCheck';
import type { Platform, Settings } from '../types';
import type { UsQdiiFilterMode } from '../utils/navPair';
import * as storage from '../utils/storage';
import { STORAGE_WRITE_FAILED_MSG } from '../utils/storage';
import TransactionAuditModal from '../components/TransactionAuditModal';
import PlatformImportModal from '../components/PlatformImportModal';
import {
  isAutoBackupSupported,
  pickBackupTarget,
  inspectBackupTarget,
  saveBackupHandle,
  runAutoBackup,
  backupNowWithGesture,
  clearBackupHandle,
  queryAutoBackupPermission,
  type AutoBackupPermission,
} from '../utils/autoBackup';


export default function Settings() {
  const { platforms, funds, transactions, dcaPlans, snapshots, settings, addPlatform, removePlatform, updateSettings, exportData, importData, resetNavHistory, reclassifyFunds } = useStore();
  const [newPlatformName, setNewPlatformName] = useState('');
  const [resetTarget, setResetTarget] = useState<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- 备份状态（手动备份时间 + 实验性自动备份权限） ---
  const [backupMeta, setBackupMeta] = useState(() => storage.getBackupMeta());
  const [autoPerm, setAutoPerm] = useState<AutoBackupPermission>('unsupported');
  const [autoBusy, setAutoBusy] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  /** 设置写盘失败（存储空间不足）→ 状态不变、开关视觉回退，给出提示 */
  const handleSetting = (updates: Partial<Settings>) => {
    if (!updateSettings(updates)) message.error(STORAGE_WRITE_FAILED_MSG, 8);
  };

  const refreshBackupState = () => {
    setBackupMeta(storage.getBackupMeta());
    void queryAutoBackupPermission().then(setAutoPerm);
  };
  useEffect(() => { refreshBackupState(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 选定固定备份文件。先检查既有内容：非本应用备份（foreign-json/invalid）需
  // 用户确认覆盖后才持久化 handle；确认前不写入任何内容。
  const handlePickBackupTarget = async () => {
    setAutoBusy(true);
    try {
      const handle = await pickBackupTarget();
      if (!handle) return;

      const adoptAndBackup = async () => {
        await saveBackupHandle(handle);
        // 刚选定的文件 Chrome 已授予 readwrite，静默路径即可完成首次备份
        const ok = await runAutoBackup();
        if (ok) {
          message.success(`已选定备份文件 ${handle.name}，并完成首次备份`);
        } else {
          message.info('已选定备份文件；下次会话首次备份前需点击一次授权');
        }
        refreshBackupState();
      };

      const existing = await inspectBackupTarget(handle);
      if (existing === 'backup' || existing === 'empty') {
        await adoptAndBackup();
      } else {
        Modal.confirm({
          title: '该文件不是本应用的备份文件',
          icon: <ExclamationCircleOutlined />,
          content: (
            <div>
              <p>「{handle.name}」已存在且内容不是本应用的备份（{existing === 'invalid' ? '无法解析为 JSON' : '其他 JSON 数据'}）。</p>
              <p style={{ color: '#cf1322' }}>开启自动备份后，其内容将被本应用的最新数据完全覆盖。</p>
            </div>
          ),
          okText: '仍然使用该文件',
          cancelText: '取消',
          onOk: adoptAndBackup,
        });
      }
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        console.error('[Settings] pick backup target failed', err);
        message.error('选择备份文件失败');
      }
    } finally {
      setAutoBusy(false);
    }
  };

  const handleRunAutoBackup = async () => {
    setAutoBusy(true);
    try {
      // 单次分派：granted 直接写 / prompt 尽早请求授权，手势链中间无多余 await
      const ok = await backupNowWithGesture();
      if (ok) {
        message.success('自动备份完成');
      } else {
        message.warning('备份未完成：权限不足或未设置备份文件');
      }
      refreshBackupState();
    } finally {
      setAutoBusy(false);
    }
  };

  const handleDisableAutoBackup = async () => {
    await clearBackupHandle();
    message.success('已取消自动备份（已生成的备份文件不受影响）');
    refreshBackupState();
  };

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
    if (!addPlatform(name)) {
      message.error(STORAGE_WRITE_FAILED_MSG, 8);
      return;
    }
    setNewPlatformName('');
    message.success('平台已添加');
  };

  const handleRemovePlatform = (id: string) => {
    // 两种失败由 store 一次判定并报出原因（调用方不再自己判一遍）
    const result = removePlatform(id);
    if (!result.ok) {
      message.error(
        result.reason === 'has-funds'
          ? '该平台下还有基金，请先删除或迁移相关基金'
          : STORAGE_WRITE_FAILED_MSG,
        8,
      );
      return;
    }
    message.success('平台已删除');
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
      // 预检：版本 / 逐表结构 / 与当前数据的差异
      const report = checkBackup(data, {
        platforms, funds, transactions, dcaPlans, snapshots,
      } satisfies CurrentBackupData);

      const errors = report.issues.filter((i) => i.level === 'error');
      if (!report.ok) {
        const first = errors.slice(0, 3).map((i) => `${i.table}${i.index ? ` 第 ${i.index} 条` : ''}：${i.message}`);
        message.error(`备份文件有问题，未导入：${first.join('；')}${errors.length > 3 ? ` 等 ${errors.length} 处` : ''}`, 8);
        return;
      }
      const warnings = report.issues.filter((i) => i.level === 'warn');
      const diff = report.diff;

      // 二次确认：导入会覆盖所有现有数据——**先告诉用户会冲掉什么**
      Modal.confirm({
        title: '确认导入数据？',
        icon: <ExclamationCircleOutlined />,
        content: (
          <div>
            <p>导入将覆盖当前所有数据：</p>
            <table style={{ width: '100%', marginBottom: 8 }}>
              <thead>
                <tr><th style={{ textAlign: 'left' }}></th><th style={{ textAlign: 'right' }}>当前</th><th style={{ textAlign: 'right' }}>备份</th></tr>
              </thead>
              <tbody>
                {diff?.tables.map((t) => (
                  <tr key={t.table}>
                    <td>{t.table}</td>
                    <td style={{ textAlign: 'right' }}>{t.current}</td>
                    <td style={{ textAlign: 'right' }}>{t.incoming}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {diff && diff.fundsLost.length > 0 && (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 8 }}
                message={`${diff.fundsLost.length} 只基金不在备份里，导入后会消失`}
                description={
                  `基金 ${diff.fundsLost.join('、')}，连同它们的 ${diff.transactionsLostWithFunds} 笔交易` +
                  `（以及净值历史、定投计划）都会从本设备消失。` +
                  `如果这份备份不是最新的，先导出当前数据再导入。`
                }
              />
            )}
            {warnings.map((w, i) => (
              <Alert key={i} type="warning" showIcon style={{ marginBottom: 8 }} message={w.message} />
            ))}
            <p style={{ color: '#cf1322' }}>此操作不可撤销，建议先导出当前数据作为备份。</p>
          </div>
        ),
        okText: '确认覆盖',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => {
          const autoCreated = importData(data as Parameters<typeof importData>[0]);
          if (autoCreated < 0) {
            // 写盘失败 → 内存状态没变，界面仍显示旧数据
            message.error(STORAGE_WRITE_FAILED_MSG, 8);
            return;
          }
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
              onChange={(checked) => handleSetting({ theme: checked ? 'dark' : 'light' })}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>自动刷新净值（打开/运行中；晚间 NAV 发布后会自动拉取）</span>
            <Switch
              checked={settings.navAutoRefresh}
              onChange={(checked) => handleSetting({ navAutoRefresh: checked })}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>定投计划自动生成交易记录</span>
            <Switch
              checked={settings.dcaAutoRecord}
              onChange={(checked) => handleSetting({ dcaAutoRecord: checked })}
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
              onChange={(v: UsQdiiFilterMode) => handleSetting({ usQdiiFilterMode: v })}
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
                  title: '严格：按美股工作日节假日 + 周末剔除（2025-2027 精确，其它年退化为仅周末）。仅对美股跟踪 QDII 生效。',
                },
                {
                  value: 'off',
                  label: '不过滤',
                  title: '不过滤：保留所有原始记录，attribution 跨节假日会被压扁，但 MA250 暖机期最短。**对所有基金生效**（含 A 股），不只是 QDII。',
                },
              ]}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div>备份提醒周期</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                距上次备份超过该天数时，页面顶部显示备份提醒条；0 = 关闭提醒。数据只存本浏览器，清除浏览数据即丢失——不建议关闭。
              </Typography.Text>
            </div>
            <Select
              value={settings.backupReminderDays}
              onChange={(v: number) => handleSetting({ backupReminderDays: v })}
              style={{ width: 160 }}
              options={[
                { value: 7, label: '每 7 天' },
                { value: 14, label: '每 14 天' },
                { value: 30, label: '每 30 天' },
                { value: 0, label: '关闭提醒' },
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
            另外：技术指标按分红复权净值计算——2026-11-17 之前拉取的历史里累计净值是近似值，
            分过红的基金（债基 / 红利类常见）建议重置后重新拉取，复权才完整生效。
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
              {backupMeta.lastBackupAt
                ? `；上次备份：${dayjs(backupMeta.lastBackupAt).format('YYYY-MM-DD HH:mm')}`
                : '；本设备尚未备份过'}
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
          <div>
            <Button icon={<AuditOutlined />} onClick={() => setAuditOpen(true)}>
              交易自检
            </Button>
            <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
              逐笔核对买卖记录的净值与本地净值历史是否一致，不一致的可一键修正
            </Typography.Text>
          </div>
          <div>
            <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
              导入平台流水
            </Button>
            <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
              粘贴基金平台的交易流水与账本比对，找出漏记的买入 / 卖出并一键补录
            </Typography.Text>
          </div>

          {isAutoBackupSupported() && (
            <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 12 }}>
              <div style={{ marginBottom: 4 }}>
                <Typography.Text strong>自动备份到本地文件（实验性）</Typography.Text>
              </div>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
                选定一个固定备份文件后，应用启动时按自动备份周期静默把最新数据写入该文件（仅本地写盘，不上传）。
                浏览器要求每次会话首次写入前重新授权一次，届时页面顶部会出现授权提示。
              </Typography.Paragraph>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <div>自动备份周期</div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    距上次自动备份超过该天数时静默写盘；0 = 关闭自动备份。与上面的「备份提醒周期」相互独立。
                  </Typography.Text>
                </div>
                <Select
                  value={settings.autoBackupDays}
                  onChange={(v: number) => handleSetting({ autoBackupDays: v })}
                  style={{ width: 120 }}
                  options={[
                    { value: 1, label: '每天' },
                    { value: 3, label: '每 3 天' },
                    { value: 7, label: '每 7 天' },
                    { value: 14, label: '每 14 天' },
                    { value: 30, label: '每 30 天' },
                    { value: 0, label: '关闭' },
                  ]}
                />
              </div>
              <Space wrap>
                {autoPerm === 'none' || autoPerm === 'denied' ? (
                  <Button type="primary" icon={<SaveOutlined />} onClick={handlePickBackupTarget} loading={autoBusy}>
                    选择备份文件
                  </Button>
                ) : (
                  <>
                    <Button icon={<SaveOutlined />} onClick={handleRunAutoBackup} loading={autoBusy}>
                      立即自动备份
                    </Button>
                    <Popconfirm title="确认取消自动备份？" okText="取消自动备份" cancelText="再想想" onConfirm={handleDisableAutoBackup}>
                      <Button danger disabled={autoBusy}>取消自动备份</Button>
                    </Popconfirm>
                  </>
                )}
              </Space>
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                {autoPerm === 'none'
                  ? '尚未设置备份文件。'
                  : autoPerm === 'denied'
                    ? '文件写入权限被拒绝，请重新选择备份文件。'
                    : autoPerm === 'prompt'
                      ? '已设置备份文件，等待授权（下次应用启动时页面顶部会出现授权提示，也可点上方按钮立即备份）。'
                      : `已设置备份文件，权限正常。${backupMeta.lastAutoBackupAt ? `上次自动备份：${dayjs(backupMeta.lastAutoBackupAt).format('YYYY-MM-DD HH:mm')}` : ''}`}
              </Typography.Text>
            </div>
          )}
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
                <pre style={formulaPreStyle}>{`回撤(t) = (复权净值(t) − max(复权净值(0..t))) / max(复权净值(0..t)) × 100%
百分位(t) = ( #{ i : 回撤(i) > 回撤(t) } + 0.5 × #{ i : 回撤(i) = 回撤(t) } )
            / #{ 有效回撤数 } × 100          （mid-rank 平局处理）

百分位越高 → 当前比历史上越多时刻便宜（越便宜）
百分位越低 → 当前越接近历史最高点（越贵）
与历史完全持平（如一路创新高）→ 50% 中性`}</pre>
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
                  <br />
                  ⚠ 三项指标均基于分红复权净值（分红除息不再产生虚假跳变）。2026-11-17 之前拉取的净值历史里累计净值是近似值（= 单位净值），分过红的基金建议在上方「重置净值历史」后重新拉取，复权才完整生效。
                </Typography.Paragraph>
              </div>
            ),
          },
        ]}
      />
      <TransactionAuditModal open={auditOpen} onClose={() => setAuditOpen(false)} />
      <PlatformImportModal open={importOpen} onClose={() => setImportOpen(false)} />
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
