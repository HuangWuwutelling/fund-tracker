import type { IndexQuote } from '../types';

/**
 * 腾讯 qt.gtimg.cn 的时间戳格式两种：
 *   - CN: `20260930161412` (YYYYMMDDHHmmss 数字串,北京时间)
 *   - US: `2026-10-02 17:15:59` (带分隔符;具体 TZ 解释有歧义,我们只用日期+时分)
 *
 * 我们只关心"YYYY-MM-DD"和"HH:mm"两段,**不做时区换算**——理由:
 *   - CN 的时间戳本身是北京时间,直接剥就行;
 *   - US 的时间戳 TZ 解释在文档里没有定论(Beijing 还是 ET 都没强证据),
 *     既然显示里已经有"美东 MM-DD"前缀承担时区说明,这里就只取 HH:mm 给用户看;
 *     万一解析出来不可信,可以在 IndexQuote 里把 time 改成可选再放宽。
 *
 * 失败返回 `{date: '', time: ''}`,由 fetcher 决定是否算 null。
 */
export function parseIndexTimestamp(raw: string): { date: string; time: string } {
  if (!raw) return { date: '', time: '' };
  // 剥离所有非数字字符,得到 YYYYMMDDHHmmss 这种纯数字串
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) return { date: '', time: '' };
  const yyyy = digits.slice(0, 4);
  const mm = digits.slice(4, 6);
  const dd = digits.slice(6, 8);
  const date = `${yyyy}-${mm}-${dd}`;
  let time = '';
  if (digits.length >= 12) {
    const hh = digits.slice(8, 10);
    const mi = digits.slice(10, 12);
    time = `${hh}:${mi}`;
  }
  return { date, time };
}

/**
 * 决定 API 这次返回的数据要不要写进 cache。
 *
 * 规则就是字面的日期比较:`fetched.date > cached.date` 才写。理由(见设计文档 §3):
 * API 不会给我们"今天是交易日吗 / 该不该刷新"的判定——但**它返回的日期**就是权威——
 * 同一日重复拉说明市场没动(休市 / 周末 / 已收盘),cache 留旧值即可;
 * 日期前进了说明有新数据,写入。
 *
 * 无 cache 永远 true(首次观测,区别于"已知 cache 但 fetch 拿到旧日期")。
 * 这里**不**用 `fetchedAt` 参与判定——`fetchedAt` 只是 UI 显示用,不该影响 cache 内容。
 */
export function shouldUpdateIndexQuote(
  cached: IndexQuote | undefined,
  fetched: { date: string }
): boolean {
  if (!cached) return true;
  return fetched.date > cached.date;
}