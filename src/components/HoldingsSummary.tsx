import { useMemo } from 'react';
import { Card, Table, Tag, Empty, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Platform, Fund } from '../types';
import { FUND_TYPE_LABELS } from '../types';
import { formatMoney, formatPercent, pnlColor, today as todayStr } from '../utils/formatter';
import { isNonTradingDay } from '../utils/chineseHolidays';

/** 与 Dashboard.summaries 形状对齐（fund + calcFundSummary 输出） */
export interface HoldingSummary {
  fund: Fund;
  cost: number;
  marketValue: number;
  totalReturn: number;
  returnRate: number;
  dailyPnl: number | null;
  /** true = 今日 pnl 数值可信（NAV 已发布），null 时 dailyPnl 必然为 null */
  isDailyPnlToday: boolean;
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
  /** null = 该组所有成员今日 NAV 均未发布 */
  dailyPnl: number | null;
  dailyPnlUpdatedCount: number;
  dailyPnlPendingCount: number;
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
  const today = todayStr();
  const isNonTrading = isNonTradingDay(today);

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
          dailyPnlUpdatedCount: 0,
          dailyPnlPendingCount: 0,
        };
        map.set(key, row);
      }
      row.fundCount += 1;
      row.cost += s.cost;
      row.marketValue += s.marketValue;
      // dailyPnl 聚合：null-aware ——任何一个成员 null，整组保留 null 标签
      if (s.isDailyPnlToday && s.dailyPnl !== null) {
        row.dailyPnl = (row.dailyPnl ?? 0) + s.dailyPnl;
        row.dailyPnlUpdatedCount += 1;
      } else {
        row.dailyPnlPendingCount += 1;
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
      render: (_, r) => <Tag>{FUND_TYPE_LABELS[r.type]}</Tag>,
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
      title: '当日盈亏',
      key: 'dailyPnl',
      width: 150,
      align: 'right',
      sorter: (a, b) => (a.dailyPnl ?? 0) - (b.dailyPnl ?? 0),
      render: (_, r) => {
        // 全员 pending
        if (r.dailyPnlPendingCount === r.fundCount) {
          if (isNonTrading) {
            return (
              <Tooltip title="今日为非交易日，无当日 NAV">
                <div>
                  <span style={{ color: '#999' }}>—</span>
                  <div style={{ fontSize: 11, color: '#999' }}>今日休市</div>
                </div>
              </Tooltip>
            );
          }
          return (
            <Tooltip title="该分组下所有基金今日 NAV 均未发布">
              <div>
                <span style={{ color: '#999' }}>—</span>
                <div style={{ fontSize: 11, color: '#999' }}>净值更新中</div>
              </div>
            </Tooltip>
          );
        }
        // 部分或全部已更新
        const value = r.dailyPnl ?? 0;
        const isPartial = r.dailyPnlPendingCount > 0;
        return (
          <Tooltip
            title={
              isPartial
                ? `${r.dailyPnlUpdatedCount} 只已更新，${r.dailyPnlPendingCount} 只净值待发布`
                : '当日 NAV 已全部发布'
            }
          >
            <div>
              <span style={{ color: pnlColor(value) }}>{formatMoney(value)}</span>
              {isPartial && (
                <div style={{ fontSize: 11, color: '#999' }}>
                  已更新 {r.dailyPnlUpdatedCount}/{r.fundCount} 只
                </div>
              )}
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
