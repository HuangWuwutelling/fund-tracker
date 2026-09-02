import { useState, useMemo } from 'react';
import { Card, Tabs, Empty, Table, Tag, Space, Button } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import type { DailyReturn, MonthlyReturn, YearlyReturn } from '../utils/reportGenerator';
import {
  generateDailyReturns,
  generateMonthlyReturns,
  generateYearlyReturns,
} from '../utils/reportGenerator';
import { formatMoney, pnlColor } from '../utils/formatter';
import HeatmapGrid, { type HeatmapCell } from './HeatmapGrid';
import NavLink from './NavLink';
import { useStore } from '../stores';

type Granularity = 'day' | 'month' | 'year';

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** PeriodDetail 共用：选中格子的 per-fund 明细表（三 Tab 复用） */
interface PeriodDetailRow {
  fundId: string;
  fundName: string;
  returnAmount: number;
  isPending?: boolean;
}

interface PeriodDetailProps {
  dateLabel: string;
  total: number;
  perFund: PeriodDetailRow[];
}

function PeriodDetail({ dateLabel, total, perFund }: PeriodDetailProps) {
  const navigate = useNavigate();
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ marginBottom: 8, fontWeight: 500, fontSize: 14 }}>
        {dateLabel} 收益明细
        <Tag
          style={{ marginLeft: 8 }}
          color={total > 0 ? 'green' : total < 0 ? 'red' : 'default'}
        >
          合计 {formatMoney(total)}
        </Tag>
      </div>
      <Table<PeriodDetailRow>
        size="small"
        dataSource={perFund}
        rowKey="fundId"
        pagination={false}
        columns={[
          {
            title: '基金',
            dataIndex: 'fundName',
            key: 'fundName',
            render: (_, r) => (
              <NavLink onClick={() => navigate(`/funds/${r.fundId}`)}>
                {r.fundName}
                {r.isPending && (
                  <Tag color="default" style={{ marginLeft: 6, fontSize: 11 }}>
                    净值更新中
                  </Tag>
                )}
              </NavLink>
            ),
          },
          {
            title: '收益',
            dataIndex: 'returnAmount',
            key: 'returnAmount',
            align: 'right' as const,
            render: (v, r) =>
              r.isPending ? (
                <span style={{ color: '#999' }}>—</span>
              ) : (
                <span style={{ color: pnlColor(v) }}>{formatMoney(v)}</span>
              ),
          },
        ]}
      />
    </div>
  );
}

/** 日 Tab：月内日格子（1 个月，~30 格） */
function DayView({
  dailyReturns,
  selectedKey,
  onSelect,
}: {
  dailyReturns: DailyReturn[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const [viewMonth, setViewMonth] = useState<string>(() => {
    if (dailyReturns.length > 0) {
      return dailyReturns[dailyReturns.length - 1]!.date.slice(0, 7);
    }
    return dayjs().format('YYYY-MM');
  });

  const maxAbsReturn = useMemo(
    () => dailyReturns.reduce((m, d) => Math.max(m, Math.abs(d.totalReturn)), 0),
    [dailyReturns]
  );

  const cells = useMemo(() => {
    const map = new Map<string, DailyReturn>();
    for (const d of dailyReturns) map.set(d.date, d);

    const monthStart = dayjs(`${viewMonth}-01`);
    const firstDayOfWeek = monthStart.day();
    const gridStart = monthStart.subtract(firstDayOfWeek, 'day');
    const daysInMonth = monthStart.daysInMonth();
    const monthEnd = monthStart.date(daysInMonth);
    const lastDayOfWeek = monthEnd.day();
    const gridEnd = monthEnd.add(6 - lastDayOfWeek, 'day');
    const totalCells = gridEnd.diff(gridStart, 'day') + 1;

    const out: HeatmapCell[] = [];
    const todayStr = dayjs().format('YYYY-MM-DD');
    for (let i = 0; i < totalCells; i++) {
      const d = gridStart.add(i, 'day');
      const date = d.format('YYYY-MM-DD');
      const data = map.get(date);
      const inMonth = d.format('YYYY-MM') === viewMonth;
      out.push({
        key: date,
        label: String(d.date()),
        // pending 时强制传 0，避免红绿热力上色（HeatmapGrid 内部用 pending 短路）
        value: data?.isPending ? 0 : (data?.totalReturn ?? 0),
        dim: !inMonth,
        accent: date === todayStr ? 'today' : undefined,
        pending: data?.isPending,
      });
    }
    return out;
  }, [dailyReturns, viewMonth]);

  const hasPrev = dailyReturns.some((d) => d.date.slice(0, 7) < viewMonth);
  const hasNext =
    dailyReturns.some((d) => d.date.slice(0, 7) > viewMonth) ||
    dayjs().format('YYYY-MM') > viewMonth;

  const selected = selectedKey ? dailyReturns.find((d) => d.date === selectedKey) ?? null : null;

  return (
    <>
      <Space style={{ marginBottom: 12 }} size="middle">
        <Button
          size="small"
          icon={<LeftOutlined />}
          disabled={!hasPrev}
          onClick={() =>
            setViewMonth(dayjs(`${viewMonth}-01`).subtract(1, 'month').format('YYYY-MM'))
          }
        />
        <span style={{ minWidth: 100, textAlign: 'center', fontWeight: 500, fontSize: 16 }}>
          {viewMonth}
        </span>
        <Button
          size="small"
          icon={<RightOutlined />}
          disabled={!hasNext}
          onClick={() =>
            setViewMonth(dayjs(`${viewMonth}-01`).add(1, 'month').format('YYYY-MM'))
          }
        />
      </Space>

      <HeatmapGrid
        cells={cells}
        maxAbsValue={maxAbsReturn}
        weekdayLabels={WEEKDAY_LABELS}
        columns={7}
        selectedKey={selectedKey}
        onCellClick={onSelect}
        formatTooltip={(c) =>
          c.pending
            ? `${c.key}：净值更新中`
            : c.value === 0
            ? c.key
            : `${c.key}: ${formatMoney(c.value)}`
        }
      />

      {selected && (
        // 仅当所有基金都 pending 时才显示整格 pending；只要有任一基金有数据，
        // 就走明细面板（每个基金单独标 isPending，让 A 股能看到自己的涨跌）
        selected.perFund.every((p) => p.isPending) ? (
          <div style={{ marginTop: 16, padding: 12, background: '#fafafa', borderRadius: 6, color: '#999', fontSize: 13 }}>
            {selected.date}：净值更新中（QDII 通常 T+2 延迟，或当日 NAV 尚未发布）
          </div>
        ) : (
          <PeriodDetail
            dateLabel={selected.date}
            total={selected.totalReturn}
            perFund={selected.perFund}
          />
        )
      )}
    </>
  );
}

/** 月 Tab：12 个月格子（一年视图） */
function MonthView({
  monthlyReturns,
  year,
  minYear,
  selectedKey,
  onSelect,
  onShiftYear,
}: {
  monthlyReturns: MonthlyReturn[];
  year: number;
  /** 数据最早年份（首笔交易年），用于禁用「往前再切」的按钮 */
  minYear: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onShiftYear: (delta: number) => void;
}) {
  const maxAbsReturn = useMemo(
    () => monthlyReturns.reduce((m, r) => Math.max(m, Math.abs(r.totalReturn)), 0),
    [monthlyReturns]
  );

  const cells: HeatmapCell[] = useMemo(
    () =>
      monthlyReturns.map((r) => ({
        key: r.month,
        label: `${parseInt(r.month.slice(5, 7), 10)}月`,
        value: r.totalReturn,
      })),
    [monthlyReturns]
  );

  const selected = selectedKey ? monthlyReturns.find((r) => r.month === selectedKey) ?? null : null;
  const currentYear = dayjs().year();
  // 修正：原 Math.min(...monthlyReturns) 永远是 viewYear（monthlyReturns 只含当前年的 12 个月），
  // 导致 hasPrev 永远是 false，用户无法回到历史年。改用父组件从 yearlyReturns 算出的 minYear。
  const hasPrev = year > minYear;
  // 简化：hasNext 只允许切到当前年（不要给"未来年"按钮）
  const hasNext = year < currentYear;

  return (
    <>
      <Space style={{ marginBottom: 12 }} size="middle">
        <Button
          size="small"
          icon={<LeftOutlined />}
          disabled={!hasPrev}
          onClick={() => onShiftYear(-1)}
        />
        <span style={{ minWidth: 100, textAlign: 'center', fontWeight: 500, fontSize: 16 }}>
          {year} 年
        </span>
        <Button
          size="small"
          icon={<RightOutlined />}
          disabled={!hasNext}
          onClick={() => onShiftYear(1)}
        />
      </Space>

      <HeatmapGrid
        cells={cells}
        maxAbsValue={maxAbsReturn}
        columns={12}
        selectedKey={selectedKey}
        onCellClick={onSelect}
        formatTooltip={(c) =>
          c.value === 0 ? c.key : `${c.key}: ${formatMoney(c.value)}`
        }
      />

      {selected && (
        <PeriodDetail
          dateLabel={selected.month}
          total={selected.totalReturn}
          perFund={selected.perFund}
        />
      )}
    </>
  );
}

/** 年 Tab：自首笔交易年起所有年份格子（单行，无分页） */
function YearView({
  yearlyReturns,
  selectedKey,
  onSelect,
}: {
  yearlyReturns: YearlyReturn[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const maxAbsReturn = useMemo(
    () => yearlyReturns.reduce((m, r) => Math.max(m, Math.abs(r.totalReturn)), 0),
    [yearlyReturns]
  );

  const cells: HeatmapCell[] = useMemo(
    () =>
      yearlyReturns.map((r) => ({
        key: r.year,
        label: r.year,
        value: r.totalReturn,
      })),
    [yearlyReturns]
  );

  const selected = selectedKey ? yearlyReturns.find((r) => r.year === selectedKey) ?? null : null;

  return (
    <>
      <HeatmapGrid
        cells={cells}
        maxAbsValue={maxAbsReturn}
        columns={yearlyReturns.length || 1}
        selectedKey={selectedKey}
        onCellClick={onSelect}
        formatTooltip={(c) =>
          c.value === 0 ? c.key : `${c.key} 年: ${formatMoney(c.value)}`
        }
      />

      {selected && (
        <PeriodDetail
          dateLabel={`${selected.year} 年`}
          total={selected.totalReturn}
          perFund={selected.perFund}
        />
      )}
    </>
  );
}

/** 主组件：Tabs 容器，自包含从 useStore() 取数据 */
export default function ReturnCalendar() {
  const { funds, transactions, snapshots } = useStore();
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [selected, setSelected] = useState<{ g: Granularity; key: string } | null>(null);

  // MonthView 当前查看的年（独立 state，DayView 切月不影响）
  const [viewYear, setViewYear] = useState<number>(() => dayjs().year());

  // 各粒度数据（日粒度由现有 generateDailyReturns 算；月/年用 Task 1 新增）
  const dailyReturns = useMemo(
    () => generateDailyReturns(funds, transactions, snapshots),
    [funds, transactions, snapshots]
  );
  const monthlyReturns = useMemo(
    () => generateMonthlyReturns(funds, transactions, dailyReturns, viewYear),
    [funds, transactions, dailyReturns, viewYear]
  );
  const yearlyReturns = useMemo(
    () => generateYearlyReturns(funds, transactions, dailyReturns),
    [funds, transactions, dailyReturns]
  );

  // 月 Tab 切年下界：从 yearlyReturns 推得（覆盖数据首笔交易年至今），
  // 避免 monthlyReturns 里 Math.min 永远等于 viewYear 导致 hasPrev 失效。
  const minYear = useMemo(
    () =>
      yearlyReturns.length > 0
        ? Math.min(...yearlyReturns.map((r) => parseInt(r.year, 10)))
        : dayjs().year(),
    [yearlyReturns]
  );

  // Tab 切换时调整选中态：
  // - 日 → 月：把选中日的 'YYYY-MM-DD' 截到 'YYYY-MM'，如有该月则保留
  // - 月 → 年：把选中月的 'YYYY-MM' 截到 'YYYY'，如有该年则保留
  // - 反向（年→月、月→日）或 key 不匹配 → 清空
  const handleTabChange = (next: Granularity) => {
    if (!selected) {
      setGranularity(next);
      return;
    }
    let nextKey: string | null = null;
    if (selected.g === 'day' && next === 'month') {
      const m = selected.key.slice(0, 7);
      nextKey = monthlyReturns.some((r) => r.month === m) ? m : null;
    } else if (selected.g === 'month' && next === 'year') {
      const y = selected.key.slice(0, 4);
      nextKey = yearlyReturns.some((r) => r.year === y) ? y : null;
    }
    setSelected(nextKey ? { g: next, key: nextKey } : null);
    setGranularity(next);
  };

  const handleSelect = (key: string) => {
    setSelected((prev) => (prev?.key === key && prev.g === granularity ? null : { g: granularity, key }));
  };

  if (dailyReturns.length === 0 && monthlyReturns.every((m) => m.totalReturn === 0) && yearlyReturns.every((y) => y.totalReturn === 0)) {
    return (
      <Card title="收益日历" style={{ marginBottom: 16 }}>
        <Empty description="暂无数据，添加交易或等首次刷新后即可查看" />
      </Card>
    );
  }

  return (
    <Card title="收益日历" style={{ marginBottom: 16 }}>
      <Tabs
        activeKey={granularity}
        onChange={(k) => handleTabChange(k as Granularity)}
        items={[
          {
            key: 'day',
            label: '日',
            children: (
              <DayView
                dailyReturns={dailyReturns}
                selectedKey={selected?.g === 'day' ? selected.key : null}
                onSelect={handleSelect}
              />
            ),
          },
          {
            key: 'month',
            label: '月',
            children: (
              <MonthView
                monthlyReturns={monthlyReturns}
                year={viewYear}
                minYear={minYear}
                selectedKey={selected?.g === 'month' ? selected.key : null}
                onSelect={handleSelect}
                onShiftYear={(d) => setViewYear((y) => y + d)}
              />
            ),
          },
          {
            key: 'year',
            label: '年',
            children: (
              <YearView
                yearlyReturns={yearlyReturns}
                selectedKey={selected?.g === 'year' ? selected.key : null}
                onSelect={handleSelect}
              />
            ),
          },
        ]}
      />

      {/* 颜色图例（三 Tab 共用） */}
      <div
        style={{
          marginTop: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: '#666',
        }}
      >
        <span>盈利</span>
        {['rgba(255, 77, 79, 0.15)', 'rgba(255, 77, 79, 0.5)', 'rgba(255, 77, 79, 0.85)'].map(
          (c, i) => (
            <div key={i} style={{ width: 16, height: 16, background: c, borderRadius: 3 }} />
          )
        )}
        <span style={{ marginLeft: 8 }}>亏损</span>
        {['rgba(82, 196, 26, 0.15)', 'rgba(82, 196, 26, 0.5)', 'rgba(82, 196, 26, 0.85)'].map(
          (c, i) => (
            <div key={i} style={{ width: 16, height: 16, background: c, borderRadius: 3 }} />
          )
        )}
        <span>多</span>
      </div>
    </Card>
  );
}
