import { useState, useMemo } from 'react';
import { Card, Tooltip, Table, Tag, Empty, Button, Space } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
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
 * - 每格突出显示当日收益金额（数字大、加粗）
 * - 颜色：绿涨红跌，灰色 = 无数据
 * - 支持月份切换（左/右箭头）
 * - 点击格子展开当天每只基金明细
 */
export default function ReturnCalendar({ dailyReturns }: Props) {
  const navigate = useNavigate();
  // 视图月份：YYYY-MM
  const [viewMonth, setViewMonth] = useState<string>(() => {
    if (dailyReturns.length > 0) {
      return dailyReturns[dailyReturns.length - 1]!.date.slice(0, 7);
    }
    return dayjs().format('YYYY-MM');
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const { cells, maxAbsReturn } = useMemo(() => {
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
      <Space style={{ marginBottom: 12 }} size="middle">
        <Button
          size="small"
          icon={<LeftOutlined />}
          disabled={!hasPrev}
          onClick={() => setViewMonth(dayjs(`${viewMonth}-01`).subtract(1, 'month').format('YYYY-MM'))}
        />
        <span style={{ minWidth: 100, textAlign: 'center', fontWeight: 500, fontSize: 16 }}>{viewMonth}</span>
        <Button
          size="small"
          icon={<RightOutlined />}
          disabled={!hasNext}
          onClick={() => setViewMonth(dayjs(`${viewMonth}-01`).add(1, 'month').format('YYYY-MM'))}
        />
      </Space>

      {/* 周几表头 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, marginBottom: 6 }}>
        {WEEKDAY_LABELS.map((d, i) => (
          <div
            key={i}
            style={{
              textAlign: 'center',
              fontSize: 13,
              color: '#999',
              padding: 6,
              fontWeight: 500,
            }}
          >
            {d}
          </div>
        ))}
      </div>

      {/* 日期格子 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
        {cells.map((cell) => {
          const { date, dayNum, inMonth, data } = cell;
          let bg = '#fafafa';
          if (data) {
            const intensity = maxAbsReturn > 0 ? Math.min(Math.abs(data.totalReturn) / maxAbsReturn, 1) : 0;
            const opacity = 0.12 + intensity * 0.55;
            // 中国惯例：红涨绿跌
            if (data.totalReturn > 0) bg = `rgba(255, 77, 79, ${opacity})`;
            else if (data.totalReturn < 0) bg = `rgba(82, 196, 26, ${opacity})`;
            else bg = '#f0f0f0';
          }
          const isSelected = selectedDate === date;
          const isToday = date === dayjs().format('YYYY-MM-DD');
          return (
            <Tooltip key={date} title={data ? `${date}：${formatMoney(data.totalReturn)}` : date}>
              <div
                onClick={() => setSelectedDate(isSelected ? null : date)}
                style={{
                  minHeight: 84,
                  padding: 8,
                  background: bg,
                  border: isSelected ? '2px solid #1677ff' : isToday ? '1.5px solid #1677ff' : '1px solid #e8e8e8',
                  borderRadius: 6,
                  cursor: 'pointer',
                  opacity: inMonth ? 1 : 0.3,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'transform 0.1s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.03)')}
                onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
              >
                <div style={{ fontSize: 13, color: inMonth ? '#666' : '#bbb', alignSelf: 'flex-start' }}>{dayNum}</div>
                {data ? (
                  <div
                    style={{
                      fontSize: 16,
                      fontWeight: 600,
                      color: data.totalReturn > 0 ? '#a8071a' : data.totalReturn < 0 ? '#237804' : '#666',
                      lineHeight: 1.2,
                      marginTop: 4,
                    }}
                  >
                    {data.totalReturn > 0 ? '+' : ''}
                    {data.totalReturn.toFixed(0)}
                  </div>
                ) : (
                  <div style={{ fontSize: 14, color: '#ccc', marginTop: 4 }}>—</div>
                )}
              </div>
            </Tooltip>
          );
        })}
      </div>

      {/* 颜色图例 */}
      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#666' }}>
        <span>盈利</span>
        {['rgba(255, 77, 79, 0.15)', 'rgba(255, 77, 79, 0.5)', 'rgba(255, 77, 79, 0.85)'].map((c, i) => (
          <div key={i} style={{ width: 16, height: 16, background: c, borderRadius: 3 }} />
        ))}
        <span style={{ marginLeft: 8 }}>亏损</span>
        {['rgba(82, 196, 26, 0.15)', 'rgba(82, 196, 26, 0.5)', 'rgba(82, 196, 26, 0.85)'].map((c, i) => (
          <div key={i} style={{ width: 16, height: 16, background: c, borderRadius: 3 }} />
        ))}
        <span>多</span>
      </div>

      {/* 选中日期的明细 */}
      {selected && (
        <div style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 8, fontWeight: 500, fontSize: 14 }}>
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
              {
                title: '基金',
                dataIndex: 'fundName',
                key: 'fundName',
                render: (name: string, r: { fundId: string }) => (
                  <a onClick={() => navigate(`/funds/${r.fundId}`)}>{name}</a>
                ),
              },
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
