import { useState, useMemo } from 'react';
import { Card, Tooltip, Table, Tag, Empty, Button, Space } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { DailyReturn } from '../utils/reportGenerator';
import { formatMoney, pnlColor } from '../utils/formatter';

interface Props {
  /** 按日期升序的每日收益列表 */
  dailyReturns: DailyReturn[];
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 月历视图的收益日历
 * - 每个月一个 7×6 网格
 * - 每格显示：日期数字 + 当日收益金额
 * - 颜色：绿涨红跌，灰色 = 无数据
 * - 支持月份切换（左/右箭头）
 * - 点击格子展开当天每只基金明细
 */
export default function ReturnCalendar({ dailyReturns }: Props) {
  // 视图月份：YYYY-MM
  const [viewMonth, setViewMonth] = useState<string>(() => {
    if (dailyReturns.length > 0) {
      // 默认显示有数据的最新月份
      return dailyReturns[dailyReturns.length - 1]!.date.slice(0, 7);
    }
    return dayjs().format('YYYY-MM');
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const { cells, maxAbsReturn } = useMemo(() => {
    const map = new Map<string, DailyReturn>();
    for (const d of dailyReturns) map.set(d.date, d);

    const monthStart = dayjs(`${viewMonth}-01`);
    // 该月第一天是星期几（0=日）
    const firstDayOfWeek = monthStart.day();
    // 网格起点：回退到该周周日
    const gridStart = monthStart.subtract(firstDayOfWeek, 'day');
    // 该月总天数
    const daysInMonth = monthStart.daysInMonth();
    // 该月最后一天是星期几
    const monthEnd = monthStart.date(daysInMonth);
    const lastDayOfWeek = monthEnd.day();
    // 网格终点：补到该周六
    const gridEnd = monthEnd.add(6 - lastDayOfWeek, 'day');
    // 网格格子数（向上取整到 7 的倍数）
    const totalCells = gridEnd.diff(gridStart, 'day') + 1;

    const cells: { date: string; dayNum: number; inMonth: boolean; data: DailyReturn | null }[] = [];
    for (let i = 0; i < totalCells; i++) {
      const d = gridStart.add(i, 'day');
      const ds = d.format('YYYY-MM-DD');
      cells.push({
        date: ds,
        dayNum: d.date(),
        inMonth: d.format('YYYY-MM') === viewMonth,
        data: map.get(ds) ?? null,
      });
    }

    const maxAbsReturn = dailyReturns.reduce((m, d) => Math.max(m, Math.abs(d.totalReturn)), 0);
    return { cells, maxAbsReturn };
  }, [dailyReturns, viewMonth]);

  const selected = selectedDate ? dailyReturns.find((d) => d.date === selectedDate) ?? null : null;

  // 月份切换边界
  const hasPrev = dailyReturns.some((d) => d.date.slice(0, 7) < viewMonth);
  const hasNext = dailyReturns.some((d) => d.date.slice(0, 7) > viewMonth) || dayjs().format('YYYY-MM') > viewMonth;

  if (dailyReturns.length === 0) {
    return (
      <Card title="收益日历" style={{ marginBottom: 16 }}>
        <Empty description="暂无快照数据，每天打开页面会自动记录" />
      </Card>
    );
  }

  return (
    <Card title="收益日历" style={{ marginBottom: 16 }}>
      <Space style={{ marginBottom: 12 }}>
        <Button
          size="small"
          icon={<LeftOutlined />}
          disabled={!hasPrev}
          onClick={() => setViewMonth(dayjs(`${viewMonth}-01`).subtract(1, 'month').format('YYYY-MM'))}
        />
        <span style={{ minWidth: 80, textAlign: 'center', fontWeight: 500 }}>{viewMonth}</span>
        <Button
          size="small"
          icon={<RightOutlined />}
          disabled={!hasNext}
          onClick={() => setViewMonth(dayjs(`${viewMonth}-01`).add(1, 'month').format('YYYY-MM'))}
        />
      </Space>

      {/* 周几表头 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
        {WEEKDAY_LABELS.map((d, i) => (
          <div
            key={i}
            style={{
              textAlign: 'center',
              fontSize: 12,
              color: '#999',
              padding: 4,
              background: i === 0 || i === 6 ? '#fafafa' : 'transparent',
            }}
          >
            {d}
          </div>
        ))}
      </div>

      {/* 日期格子 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {cells.map((cell) => {
          const { date, dayNum, inMonth, data } = cell;
          const isWeekend = dayjs(date).day() === 0 || dayjs(date).day() === 6;
          let bg = isWeekend ? '#fafafa' : '#fff';
          let fg = '#333';
          if (data) {
            const intensity = maxAbsReturn > 0 ? Math.min(Math.abs(data.totalReturn) / maxAbsReturn, 1) : 0;
            const opacity = 0.15 + intensity * 0.7;
            if (data.totalReturn > 0) bg = `rgba(82, 196, 26, ${opacity})`;
            else if (data.totalReturn < 0) bg = `rgba(255, 77, 79, ${opacity})`;
            else bg = '#f0f0f0';
            fg = Math.abs(data.totalReturn) > 0 ? '#000' : '#999';
          }
          const isSelected = selectedDate === date;
          const isToday = date === dayjs().format('YYYY-MM-DD');
          return (
            <Tooltip key={date} title={data ? `${date}：${formatMoney(data.totalReturn)}` : date}>
              <div
                onClick={() => setSelectedDate(isSelected ? null : date)}
                style={{
                  minHeight: 56,
                  padding: 4,
                  background: bg,
                  border: isSelected ? '2px solid #1677ff' : isToday ? '1px solid #1677ff' : '1px solid #f0f0f0',
                  borderRadius: 4,
                  cursor: 'pointer',
                  opacity: inMonth ? 1 : 0.35,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ fontSize: 11, color: inMonth ? '#666' : '#bbb' }}>{dayNum}</div>
                {data && (
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: fg,
                      textAlign: 'right',
                      lineHeight: 1.2,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {formatMoney(data.totalReturn)}
                  </div>
                )}
              </div>
            </Tooltip>
          );
        })}
      </div>

      {/* 颜色图例 */}
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#666' }}>
        <span>少</span>
        {['rgba(82, 196, 26, 0.15)', 'rgba(82, 196, 26, 0.5)', 'rgba(82, 196, 26, 0.85)'].map((c, i) => (
          <div key={i} style={{ width: 14, height: 14, background: c, borderRadius: 2 }} />
        ))}
        <span>多</span>
        <span style={{ marginLeft: 8 }}>|</span>
        {['rgba(255, 77, 79, 0.5)'].map((c, i) => (
          <div key={i} style={{ width: 14, height: 14, background: c, borderRadius: 2 }} />
        ))}
        <span>亏损</span>
      </div>

      {/* 选中日期的明细 */}
      {selected && (
        <div style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 8, fontWeight: 500 }}>
            {selected.date} 收益明细
            <Tag
              style={{ marginLeft: 8 }}
              color={selected.totalReturn > 0 ? 'green' : selected.totalReturn < 0 ? 'red' : 'default'}
            >
              合计 {formatMoney(selected.totalReturn)}
            </Tag>
          </div>
          <Table
            size="small"
            dataSource={selected.perFund}
            rowKey="fundId"
            pagination={false}
            columns={[
              { title: '基金', dataIndex: 'fundName', key: 'fundName' },
              {
                title: '收益',
                dataIndex: 'returnAmount',
                key: 'returnAmount',
                align: 'right' as const,
                render: (v: number) => <span style={{ color: pnlColor(v) }}>{formatMoney(v)}</span>,
              },
            ]}
          />
        </div>
      )}
    </Card>
  );
}
