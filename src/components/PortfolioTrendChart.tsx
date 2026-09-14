import { useMemo, useState } from 'react';
import { Card, Radio, Empty } from 'antd';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { TooltipComponent, GridComponent, LegendComponent, DataZoomComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import dayjs from 'dayjs';
import { useStore } from '../stores';
import { getPortfolioValueHistory } from '../utils/calculator';
import { formatMoney, pnlColor } from '../utils/formatter';

echarts.use([LineChart, TooltipComponent, GridComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

type Range = '1m' | '3m' | '6m' | '1y' | 'all';

/**
 * 组合走势图：总市值 vs 累计投入。
 *
 * - 总市值（实线 + 浅色填充）：直观看到"账户里现在有多少钱"
 * - 累计投入（虚线）：作为本金基线；与总市值之间的"gap"就是累计盈亏
 * - 区间选择：1m / 3m / 6m / 1y / all
 * - dataZoom：内置 + slider 双轨，方便在大跨度数据下缩放查看
 *
 * 数据源：getPortfolioValueHistory，O(D·F) 预计算份额时间线 → 内层二分定位"截至 date 的累计份额"。
 * 周末/节假日不剔除：lookupNavForDate 回退到最近已发布 NAV，连成自然线段。
 */
export default function PortfolioTrendChart() {
  const { funds, transactions } = useStore();
  const [range, setRange] = useState<Range>('3m');

  const series = useMemo(() => {
    const full = getPortfolioValueHistory(funds, transactions);
    if (full.length === 0) return null;

    const today = dayjs();
    let cutoff = '';
    switch (range) {
      case '1m': cutoff = today.subtract(1, 'month').format('YYYY-MM-DD'); break;
      case '3m': cutoff = today.subtract(3, 'month').format('YYYY-MM-DD'); break;
      case '6m': cutoff = today.subtract(6, 'month').format('YYYY-MM-DD'); break;
      case '1y': cutoff = today.subtract(1, 'year').format('YYYY-MM-DD'); break;
      case 'all': cutoff = ''; break;
    }
    const data = cutoff ? full.filter((d) => d.date >= cutoff) : full;
    if (data.length === 0) return null;

    return {
      dates: data.map((d) => d.date),
      values: data.map((d) => Math.round(d.value * 100) / 100),
      costs: data.map((d) => Math.round(d.cost * 100) / 100),
    };
  }, [funds, transactions, range]);

  const lastValue = series?.values[series.values.length - 1] ?? 0;
  const lastCost = series?.costs[series.costs.length - 1] ?? 0;
  const cumReturn = lastValue - lastCost;
  const cumReturnRate = lastCost > 0 ? (cumReturn / lastCost) * 100 : 0;

  const option = useMemo(() => {
    if (!series) return null;
    return {
      tooltip: {
        trigger: 'axis' as const,
        formatter: (params: Array<{ axisValue: string; value: number; seriesName: string; color: string }>) => {
          if (!params || params.length === 0) return '';
          const date = params[0]!.axisValue;
          const lines = params.map((p) => {
            const val = formatMoney(p.value);
            return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px;"></span>${p.seriesName}：<b>¥${val}</b>`;
          });
          return `<div style="font-weight:600;margin-bottom:4px;">${date}</div>${lines.join('<br/>')}`;
        },
      },
      legend: {
        bottom: 0,
        data: ['组合总市值', '累计投入'],
        textStyle: { fontSize: 12 },
      },
      grid: { left: 60, right: 20, top: 20, bottom: 50 },
      xAxis: {
        type: 'category' as const,
        data: series.dates,
        axisLabel: { fontSize: 11 },
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: {
          fontSize: 11,
          formatter: (v: number) => {
            if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
            return v.toFixed(0);
          },
        },
        splitLine: { lineStyle: { type: 'dashed' as const, color: '#e8e8e8' } },
      },
      dataZoom: [
        { type: 'inside' as const, start: 0, end: 100 },
        { type: 'slider' as const, height: 18, bottom: 28 },
      ],
      series: [
        {
          name: '组合总市值',
          type: 'line' as const,
          smooth: true,
          symbol: 'none',
          data: series.values,
          lineStyle: { width: 2.5, color: '#1677ff' },
          areaStyle: { color: 'rgba(22,119,255,0.10)' },
        },
        {
          name: '累计投入',
          type: 'line' as const,
          smooth: true,
          symbol: 'none',
          data: series.costs,
          lineStyle: { width: 1.5, type: 'dashed' as const, color: '#999' },
        },
      ],
    };
  }, [series]);

  return (
    <Card
      title="组合走势"
      style={{ marginTop: 16 }}
      extra={
        <Radio.Group
          value={range}
          onChange={(e) => setRange(e.target.value as Range)}
          size="small"
          optionType="button"
          buttonStyle="solid"
        >
          <Radio.Button value="1m">近1月</Radio.Button>
          <Radio.Button value="3m">近3月</Radio.Button>
          <Radio.Button value="6m">近6月</Radio.Button>
          <Radio.Button value="1y">近1年</Radio.Button>
          <Radio.Button value="all">全部</Radio.Button>
        </Radio.Group>
      }
    >
      {series && option ? (
        <>
          <div style={{ marginBottom: 8, fontSize: 13, color: '#666' }}>
            累计盈亏
            <span style={{ marginLeft: 12, color: pnlColor(cumReturn), fontWeight: 600 }}>
              {cumReturn >= 0 ? '+' : ''}¥{formatMoney(cumReturn)}
            </span>
            <span style={{ marginLeft: 8, color: pnlColor(cumReturnRate) }}>
              ({cumReturn >= 0 ? '+' : ''}{cumReturnRate.toFixed(2)}%)
            </span>
          </div>
          <ReactEChartsCore echarts={echarts} option={option} style={{ height: 320 }} notMerge />
        </>
      ) : (
        <Empty description="添加交易后即可查看组合走势" style={{ padding: '40px 0' }} />
      )}
    </Card>
  );
}
