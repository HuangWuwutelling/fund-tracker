import { useMemo, useState } from 'react';
import { Card, Tabs, Empty } from 'antd';
import dayjs from 'dayjs';
import type { Fund, Transaction } from '../types';
import {
  generateFundDailyReturns,
  generateMonthlyReturns,
  generateYearlyReturns,
} from '../utils/reportGenerator';
import { DayView, MonthView, YearView } from './ReturnCalendar';
import { useStore } from '../stores';

interface Props {
  fund: Fund;
  transactions: Transaction[];
}

/**
 * 单只基金的日/月/年收益日历。
 *
 * 算法：每条日格 = 当日累计收益 − 上一个有意义日累计收益
 *   cumulativeReturn(D) = shares × NAV(D) − totalBuy + totalSellNet + totalCashDiv
 *
 * 这与 Dashboard 收益日历（portfolio 级）共用 generateFundDailyReturns / generateMonthlyReturns /
 * generateYearlyReturns——单基金日历 = portfolio 日历里这只基金的子集，
 * 月/年格 = 当月/当年日格之和
 * 三种粒度构造上严格相等。
 */
export default function FundReturnCalendar({ fund, transactions }: Props) {
  type Granularity = 'day' | 'month' | 'year';
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [selected, setSelected] = useState<{ g: Granularity; key: string } | null>(null);
  const [viewYear, setViewYear] = useState<number>(() => dayjs().year());
  const { settings } = useStore();
  const usQdiiFilterMode = settings.usQdiiFilterMode;

  const dailyReturns = useMemo(
    () => generateFundDailyReturns(fund, transactions, undefined, usQdiiFilterMode),
    [fund, transactions, usQdiiFilterMode]
  );

  const firstTxDate = useMemo(() => {
    const confirmed = transactions.filter(
      (t) => t.fundId === fund.id && (!t.status || t.status === 'confirmed')
    );
    if (confirmed.length === 0) return null;
    return confirmed.map((t) => t.date).sort()[0]!;
  }, [fund.id, transactions]);

  // 复用 portfolio 月/年聚合（传入单只基金 + 单只基金日序列）——月/年格自动 = 日格之和
  const monthlyReturns = useMemo(
    () => generateMonthlyReturns([fund], transactions, dailyReturns, viewYear),
    [fund, transactions, dailyReturns, viewYear]
  );
  const yearlyReturns = useMemo(
    () => generateYearlyReturns([fund], transactions, dailyReturns),
    [fund, transactions, dailyReturns]
  );

  const minYear = useMemo(
    () =>
      yearlyReturns.length > 0
        ? Math.min(...yearlyReturns.map((r) => parseInt(r.year, 10)))
        : dayjs().year(),
    [yearlyReturns]
  );

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

  const isEmpty =
    dailyReturns.length === 0 &&
    monthlyReturns.every((m) => m.totalReturn === 0) &&
    yearlyReturns.every((y) => y.totalReturn === 0);

  if (isEmpty) {
    return (
      <Card title="收益日历" style={{ marginTop: 16 }}>
        <Empty description="暂无数据，添加交易或等首次刷新后即可查看" />
      </Card>
    );
  }

  return (
    <Card title="收益日历" style={{ marginTop: 16 }}>
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
                firstTxDate={firstTxDate}
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
                firstTxDate={firstTxDate}
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
      <div style={{ marginTop: 16, fontSize: 12, color: '#666' }}>
        累计收益口径与组合日历共用同一函数，三种粒度天然对账
      </div>
    </Card>
  );
}