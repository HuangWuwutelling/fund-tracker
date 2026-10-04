import { useEffect, useMemo, useState } from 'react';
import { Modal, Radio, Spin, Empty } from 'antd';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { TooltipComponent, GridComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useStore } from '../stores';
import { INDEX_LIST, fetchIndexHistory } from '../api/indexApi';
import { pnlColor } from '../utils/formatter';

echarts.use([LineChart, TooltipComponent, GridComponent, CanvasRenderer]);

type Range = '1m' | '6m' | '1y' | 'all';

/** 7 天 = 一周。历史点位拉一次就能用很久，超过 7 天没新条目就后台静默刷新一次。 */
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

const RANGE_DAYS: Record<Range, number | null> = {
  '1m': 30,
  '6m': 180,
  '1y': 365,
  'all': null,
};

const RANGE_LABEL: Record<Range, string> = {
  '1m': '近1月',
  '6m': '近6月',
  '1y': '近1年',
  'all': '全部',
};

interface Props {
  /** INDEX_LIST 里的 code；null = 关闭 */
  code: string | null;
  onClose: () => void;
}

/**
 * 指数历史走势 Modal。
 *
 * 设计：
 *   - 懒加载：首次打开才去拉，写到 localStorage 后下次即时显示；
 *   - 7 天静默刷新：cache 里最后一条日期 > 7 天前的，后台静默拉一次，不阻塞 UI；
 *   - 时间范围切换：客户端 filter（已拉到的全量 ~8 年），不重新发请求；
 *   - 数据源：腾讯 web.ifzq.gtimg.cn/appstock/app/fqkline/get（见 indexApi.ts）。
 *
 * 异常：fetchIndexHistory 失败统一返回 []，这里直接进 empty 态，不抛。
 */
export default function IndexHistoryModal({ code, onClose }: Props) {
  const [range, setRange] = useState<Range>('6m');
  const [loading, setLoading] = useState(false);

  const indexHistories = useStore((s) => s.indexHistories);
  const updateIndexHistory = useStore((s) => s.updateIndexHistory);
  const indices = useStore((s) => s.indices);

  const spec = code ? INDEX_LIST.find((s) => s.code === code) ?? null : null;
  const records = code ? indexHistories[code] ?? [] : [];
  const quote = code ? indices[code] : undefined;

  // 打开 / 切换指数时按需拉取
  useEffect(() => {
    if (!code || !spec) return;
    const cached = indexHistories[code] ?? [];
    const needsInitial = cached.length === 0;
    const lastDateMs = cached.length > 0
      ? new Date(cached[cached.length - 1]!.date).getTime()
      : 0;
    const stale = cached.length > 0 && Date.now() - lastDateMs > STALE_THRESHOLD_MS;

    if (needsInitial) {
      setLoading(true);
      fetchIndexHistory(spec)
        .then((rows) => {
          if (rows.length > 0) updateIndexHistory(code, rows);
        })
        .finally(() => setLoading(false));
    } else if (stale) {
      // 后台静默：不清 loading、不阻塞 UI；fetch 完直接覆盖 store
      fetchIndexHistory(spec).then((rows) => {
        if (rows.length > 0) updateIndexHistory(code, rows);
      });
    }
    // 故意只依赖 code：spec/records 变化会触发 re-render，但 fetch 的触发条件只看 code
  }, [code, spec]);

  // 按时间范围过滤（客户端切片，不发请求）
  const filtered = useMemo(() => {
    if (records.length === 0) return [];
    const days = RANGE_DAYS[range];
    if (days === null) return records;
    const last = records[records.length - 1]!;
    const cutoff = new Date(last.date);
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffMs = cutoff.getTime();
    return records.filter((r) => new Date(r.date).getTime() >= cutoffMs);
  }, [records, range]);

  // 区间涨跌幅（基于当前 range 过滤后的首末值）
  const first = filtered.length > 0 ? filtered[0]! : null;
  const last = filtered.length > 0 ? filtered[filtered.length - 1]! : null;
  const change = first && last ? last.value - first.value : 0;
  const pct = first && first.value > 0 ? (change / first.value) * 100 : 0;

  const chartOption = useMemo(() => {
    const dates = filtered.map((r) => r.date);
    const values = filtered.map((r) => r.value);
    return {
      tooltip: {
        trigger: 'axis' as const,
        formatter: (params: Array<{ axisValue: string; value: number; marker: string }>) => {
          if (!params || params.length === 0) return '';
          const p = params[0]!;
          const v = typeof p.value === 'number'
            ? p.value.toLocaleString('en-US', { maximumFractionDigits: 2 })
            : String(p.value);
          return `<div style="font-weight:600;margin-bottom:4px;">${p.axisValue}</div><div>${p.marker} 收盘 <b>${v}</b></div>`;
        },
      },
      grid: { left: 60, right: 20, top: 20, bottom: 40 },
      xAxis: {
        type: 'category' as const,
        data: dates,
        axisLabel: { fontSize: 11 },
      },
      yAxis: {
        type: 'value' as const,
        scale: true,
        axisLabel: {
          formatter: (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 }),
          fontSize: 11,
        },
        splitLine: { lineStyle: { type: 'dashed' as const, color: '#e8e8e8' } },
      },
      dataZoom: [
        { type: 'inside' as const, start: 0, end: 100 },
        { type: 'slider' as const, height: 18, bottom: 6 },
      ],
      series: [
        {
          type: 'line' as const,
          data: values,
          smooth: true,
          symbol: 'none',
          lineStyle: { width: 2, color: '#1677ff' },
          areaStyle: { color: 'rgba(22,119,255,0.06)' },
        },
      ],
    };
  }, [filtered]);

  return (
    <Modal
      title={
        spec ? (
          <span>
            <span style={{ marginRight: 8 }}>📊 {spec.name}</span>
            <span style={{ fontSize: 14, fontWeight: 'normal', color: '#666' }}>历史走势</span>
          </span>
        ) : '指数历史'
      }
      open={!!code}
      onCancel={onClose}
      footer={null}
      width={860}
      destroyOnClose
    >
      {spec && last && (
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: '#666' }}>最新</span>
          <span style={{ fontSize: 22, fontWeight: 700, color: '#333' }}>
            {last.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </span>
          <span style={{ fontSize: 13, color: '#999' }}>·</span>
          <span style={{ fontSize: 13, color: '#666' }}>{RANGE_LABEL[range]}涨跌</span>
          <span style={{ fontSize: 16, fontWeight: 600, color: pnlColor(change) }}>
            {change >= 0 ? '+' : ''}{change.toFixed(2)}
            <span style={{ fontSize: 12, marginLeft: 4 }}>
              ({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)
            </span>
          </span>
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <Radio.Group
          value={range}
          onChange={(e) => setRange(e.target.value as Range)}
          size="small"
          optionType="button"
          buttonStyle="solid"
        >
          <Radio.Button value="1m">近1月</Radio.Button>
          <Radio.Button value="6m">近6月</Radio.Button>
          <Radio.Button value="1y">近1年</Radio.Button>
          <Radio.Button value="all">全部</Radio.Button>
        </Radio.Group>
      </div>

      <Spin spinning={loading}>
        {records.length === 0 ? (
          loading ? (
            <div style={{ height: 400 }} />
          ) : (
            <Empty description="暂无历史数据" style={{ height: 400, display: 'flex', flexDirection: 'column', justifyContent: 'center' }} />
          )
        ) : (
          <ReactEChartsCore echarts={echarts} option={chartOption} style={{ height: 400 }} notMerge />
        )}
      </Spin>

      <div style={{ fontSize: 11, color: '#999', marginTop: 8, display: 'flex', justifyContent: 'space-between' }}>
        <span>
          数据源：腾讯历史K线 · 共 {records.length} 条记录
          {last && ` · 截止 ${last.date}`}
        </span>
        {quote && quote.value !== 0 && (
          <span>
            实时 {quote.value.toFixed(2)}
            {quote.time ? ` (${quote.date} ${quote.time})` : ` (${quote.date})`}
          </span>
        )}
      </div>
    </Modal>
  );
}
