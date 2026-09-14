import { useMemo } from 'react';
import { Card, Table, Tag, Empty, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Platform, Fund } from '../types';
import { FUND_TYPE_LABELS, FUND_TYPE_COLORS, LATEST_NAV_PNL_LABEL } from '../types';
import { formatMoney, formatPercent, pnlColor } from '../utils/formatter';

/** 与 Dashboard.summaries 形状对齐（fund + calcFundSummary 输出） */
export interface HoldingSummary {
  fund: Fund;
  cost: number;
  marketValue: number;
  totalReturn: number;
  returnRate: number;
  dailyPnl: number | null;
  currNavDate: string;
  prevNavDate: string;
}

/** 一行 = 一个 (平台, 类型) 分组的聚合 */
interface GroupRow {
  /** `${platformId || 'orphan'}__${type}` */
  key: string;
  platformId: string | null;
  platformName: string;
  type: Fund['type'];
  fundCount: number;
  cost: number;
  marketValue: number;
  totalReturn: number;
  returnRate: number;
  /** null = 该组没有任何成员有可用 NAV 对 */
  dailyPnl: number | null;
  /** 净值归属日 → 该日期的成员数，如 { '2026-09-14': 2, '2026-09-11': 1 } */
  navDateCounts: Record<string, number>;
  /** 可用净值不足 2 期的成员数 */
  noNavCount: number;
}

interface HoldingsSummaryProps {
  /** 来自 Dashboard.summaries（已 memo）——保持单一计算源，避免重复 calcFundSummary */
  summaries: HoldingSummary[];
  platforms: Platform[];
}

/**
 * 按"平台 × 类型"二维聚合持仓汇总。
 *
 * 设计要点：
 * - 一行 = (platformId, type) 分组，聚合 cost / mv / totalReturn / returnRate / dailyPnl
 * - 完全清仓分组（cost=0 & mv=0）跳过——无信息量，避免视图噪声
 * - 当日盈亏用 null-aware 求和（与 Dashboard Statistic 卡同款口径）：
 *   - 全 null → 显示 "—"
 *   - 部分 null → 显示已更新成员的合计，下方小字 "已更新 X/Y 只"
 * - 不可点击行：聚合行无明确 drill-down 目标（跳到哪只基金？），保持只读
 */
export default function HoldingsSummary({ summaries, platforms }: HoldingsSummaryProps) {
  const rows: GroupRow[] = useMemo(() => {
    const map = new Map<string, GroupRow>();
    for (const s of summaries) {
      const pid = s.fund.platformId || null;
      const key = `${pid ?? 'orphan'}__${s.fund.type}`;
      let row = map.get(key);
      if (!row) {
        const platformName = pid
          ? platforms.find((p) => p.id === pid)?.name ?? '—'
          : '未分类';
        row = {
          key,
          platformId: pid,
          platformName,
          type: s.fund.type,
          fundCount: 0,
          cost: 0,
          marketValue: 0,
          totalReturn: 0,
          returnRate: 0,
          dailyPnl: null,
          navDateCounts: {},
          noNavCount: 0,
        };
        map.set(key, row);
      }
      row.fundCount += 1;
      row.cost += s.cost;
      row.marketValue += s.marketValue;
      // dailyPnl 聚合：null-aware —— 只有有可用 NAV 对的成员才贡献数字
      if (s.dailyPnl !== null) {
        row.dailyPnl = (row.dailyPnl ?? 0) + s.dailyPnl;
        row.navDateCounts[s.currNavDate] = (row.navDateCounts[s.currNavDate] ?? 0) + 1;
      } else {
        row.noNavCount += 1;
      }
    }

    // 后置：算 return / returnRate + 跳过完全清仓分组
    const out: GroupRow[] = [];
    for (const r of map.values()) {
      r.totalReturn = r.marketValue - r.cost;
      r.returnRate = r.cost > 0 ? (r.totalReturn / r.cost) * 100 : 0;
      // 完全清仓分组：cost=0 & mv=0 → 跳过
      if (r.cost === 0 && r.marketValue === 0) continue;
      out.push(r);
    }
    // 默认按市值降序，与下方持仓列表一致
    out.sort((a, b) => b.marketValue - a.marketValue);
    return out;
  }, [summaries, platforms]);

  const columns: ColumnsType<GroupRow> = [
    {
      title: '平台',
      key: 'platform',
      dataIndex: 'platformName',
      width: 130,
      align: 'left',
      sorter: (a, b) => a.platformName.localeCompare(b.platformName, 'zh-CN'),
      render: (_, r) =>
        r.platformId === null ? (
          <Tooltip title="该基金的 platformId 未关联任何平台，请到「基金设置」修正">
            <span style={{ color: '#999' }}>{r.platformName}</span>
          </Tooltip>
        ) : (
          r.platformName
        ),
    },
    {
      title: '类型',
      key: 'type',
      dataIndex: 'type',
      width: 90,
      align: 'left',
      sorter: (a, b) =>
        FUND_TYPE_LABELS[a.type].localeCompare(FUND_TYPE_LABELS[b.type], 'zh-CN'),
      render: (_, r) => <Tag color={FUND_TYPE_COLORS[r.type]}>{FUND_TYPE_LABELS[r.type]}</Tag>,
    },
    {
      title: '基金只数',
      key: 'fundCount',
      dataIndex: 'fundCount',
      width: 80,
      align: 'right',
      sorter: (a, b) => a.fundCount - b.fundCount,
      render: (v: number) => v,
    },
    {
      title: '持仓成本',
      key: 'cost',
      dataIndex: 'cost',
      width: 130,
      align: 'right',
      sorter: (a, b) => a.cost - b.cost,
      render: (v: number) => formatMoney(v),
    },
    {
      title: '当前市值',
      key: 'marketValue',
      dataIndex: 'marketValue',
      width: 130,
      align: 'right',
      defaultSortOrder: 'descend',
      sorter: (a, b) => a.marketValue - b.marketValue,
      render: (v: number) => formatMoney(v),
    },
    {
      title: '累计收益',
      key: 'totalReturn',
      dataIndex: 'totalReturn',
      width: 130,
      align: 'right',
      sorter: (a, b) => a.totalReturn - b.totalReturn,
      render: (v: number) => (
        <span style={{ color: pnlColor(v) }}>{formatMoney(v)}</span>
      ),
    },
    {
      title: '收益率',
      key: 'returnRate',
      dataIndex: 'returnRate',
      width: 100,
      align: 'right',
      sorter: (a, b) => a.returnRate - b.returnRate,
      render: (v: number) => (
        <span style={{ color: pnlColor(v) }}>{formatPercent(v)}</span>
      ),
    },
    {
      title: LATEST_NAV_PNL_LABEL,
      key: 'dailyPnl',
      width: 160,
      align: 'right',
      sorter: (a, b) => (a.dailyPnl ?? 0) - (b.dailyPnl ?? 0),
      render: (_, r) => {
        if (r.dailyPnl === null) {
          return (
            <Tooltip title="该分组下所有基金的可用净值都不足 2 期">
              <span style={{ color: '#999' }}>—</span>
            </Tooltip>
          );
        }
        const dates = Object.keys(r.navDateCounts).sort((a, b) => b.localeCompare(a));
        return (
          <Tooltip
            title={`净值日 ${dates.map((d) => `${d} ×${r.navDateCounts[d]} 只`).join(' · ')}`}
          >
            <div>
              <span style={{ color: pnlColor(r.dailyPnl) }}>{formatMoney(r.dailyPnl)}</span>
              <div style={{ fontSize: 11, color: '#999' }}>
                {dates.length === 1 ? `净值 ${dates[0]!.slice(5)}` : `净值日 ${dates.length} 个`}
              </div>
            </div>
          </Tooltip>
        );
      },
    },
  ];

  // 完全无有效分组 → 走 Empty 卡片
  if (rows.length === 0) {
    return (
      <Card title="持仓汇总（按平台 / 类型）" style={{ marginTop: 16 }}>
        <Empty description="暂无持仓数据，添加交易后即可查看按平台 / 类型维度的汇总" />
      </Card>
    );
  }

  return (
    <Card title="持仓汇总（按平台 / 类型）" style={{ marginTop: 16 }}>
      <Table<GroupRow>
        dataSource={rows}
        columns={columns}
        rowKey="key"
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: '暂无分组' }}
        size="small"
      />
    </Card>
  );
}
