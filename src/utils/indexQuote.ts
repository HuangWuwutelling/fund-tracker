import type { IndexQuote, IndexHistoryRecord } from '../types';

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

/**
 * 决定 modal 打开 / quote 前进时是否该静默拉一次历史 K 线。
 *
 * 主路径：cache 最后一条日期 < 实时行情日期 → 必须刷新。
 *   这是 2026-10-07 用户报的 bug 复现：cache 截止 2026-10-05，quote 已到 2026-10-07，
 *   旧逻辑按 7 天阈值判断不刷新，modal 显示陈旧曲线；quote 在 refreshAll 30 分钟节奏
 *  下能立即前进，history 必须跟上，否则 quote 和曲线对不上账。
 *
 * 兜底：quote 不可用（未拉到 / fetch 失败）时，按"cache 多大"判断。
 *   阈值沿用旧逻辑的 7 天——历史数据本身不太变，太短的阈值会徒增 API 配额消耗。
 *
 * 严格大于：与旧逻辑一致，避免正好 7 天的边界抖动触发刷新。
 *
 * @param cached 当前 cache 的历史记录（按日期升序，APPEND 时无过滤）；空 / undefined 视为首次
 * @param quoteDate 实时行情的最新交易日（来自 indices[code].date）。空串 / undefined 视为"无 quote"
 * @param now 当前时间戳 ms（默认 Date.now()），与上限逻辑一致——方便测试注入
 */
export function shouldRefreshIndexHistory(
  cached: IndexHistoryRecord[] | undefined,
  quoteDate: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!cached || cached.length === 0) return true;
  // 数据残缺兜底：cache 条数过少视为 API 截断 / 坏数据，主动重拉。
  // 这条专门兜住 2026-10-07 NDX 旧 cache：旧 `usNDX` K 线只回 1 条，导致 cache 只有 1
  // 条、cache.last.date 与 quote.date 同一天不刷新、用户卡死 1 天的状态。
  // 30 ≈ 1.5 个月，K 线接口实测 2000（8 年），远大于这个值；少数 N 日内不会触发。
  if (cached.length < MIN_REASONABLE_HISTORY) return true;
  const lastDate = cached[cached.length - 1]!.date;
  // 主路径：quote 可用时只看日期比较——cache 与 quote 已对齐或 cache 更近都不该拉，
  // 只有 quote 更新了才必须拉。这是 2026-10-07 之后漏修的对称：旧逻辑 stale fallback
  // 没有被 quoteDate 守卫，cache 距今 > 7 天时哪怕 quote === lastDate 也会误判 true。
  // 单 `>` 也挡掉了"quote === lastDate 已对齐"的不必要刷新。
  if (quoteDate) return quoteDate > lastDate;
  // 兜底：quote 不可用时（quote 没拉到 / fetch 失败 / 空串）按 cache 时长判断，
  // 7 天阈值沿用旧 IndexHistoryModal 的常量。
  const lastDateMs = new Date(lastDate).getTime();
  return now - lastDateMs > STALE_THRESHOLD_MS;
}

/** 兜底阈值：history 7 天没新条目就静默拉一次。沿用旧 IndexHistoryModal 的常量。 */
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** cache 条数合理下限。远低于 K 线接口 2000 上限，足以发现 API 截断的残缺数据。 */
const MIN_REASONABLE_HISTORY = 30;

/**
 * 判断某个 ET 日期是否在美国夏令时区间内。
 *
 * 美国 DST 规则:3 月第二个周日 02:00 ET → 11 月第一个周日 02:00 ET。
 * 区间内 ET = UTC-4(EDT),区间外 ET = UTC-5(EST)。
 *
 * 实现说明:用 Date.UTC 算"3 月第 2 个周日"和"11 月第 1 个周日"的具体日期,
 * 然后只比较 YYYYMMDD 整数——这样判断**不依赖**运行时的浏览器 TZ,
 * 在任何时区下都一致。
 */
function isETDST(yyyy: number, mm: number, dd: number): boolean {
  const dstStart = nthSundayOfMonthUTC(yyyy, 2, 2); // 3 月第 2 个周日
  const dstEnd = nthSundayOfMonthUTC(yyyy, 10, 1); // 11 月第 1 个周日

  const dateNum = yyyy * 10000 + mm * 100 + dd;
  const startNum =
    dstStart.getUTCFullYear() * 10000 +
    (dstStart.getUTCMonth() + 1) * 100 +
    dstStart.getUTCDate();
  const endNum =
    dstEnd.getUTCFullYear() * 10000 +
    (dstEnd.getUTCMonth() + 1) * 100 +
    dstEnd.getUTCDate();

  return dateNum >= startNum && dateNum < endNum;
}

function nthSundayOfMonthUTC(year: number, month: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  // getUTCDay: 0 = 周日
  const dayOfWeek = first.getUTCDay();
  const firstSundayDay = 1 + (7 - dayOfWeek) % 7;
  return new Date(Date.UTC(year, month, firstSundayDay + (n - 1) * 7));
}

/**
 * 把 ET(美东)日期 + 时间转成对应的北京时间(UTC+8)。
 *
 * 转换关系:
 *   - DST 期间(EDT,UTC-4):北京 = ET + 12 小时
 *   - 标准时期间(EST,UTC-5):北京 = ET + 13 小时
 *
 * 实现要点:把 ET(date, time) 当作"假 UTC"喂给 Date.UTC(),加上偏移后
 * 再用 UTC 方法读回,这样**完全不依赖运行时 TZ**,在任何地区跑结果都一样。
 *
 * 例如:`2026-10-02 17:15`(DST,EDT)→ 北京 `2026-10-03 05:15`。
 *
 * 失败时(空 / 解析不出来)返回 `{date: '', time: ''}`,由 UI 决定是否显示。
 */
export function etToBeijing(
  etDate: string,
  etTime: string,
): { date: string; time: string } {
  if (!etDate || !etTime) return { date: '', time: '' };

  const dateParts = etDate.split('-').map(Number);
  const timeParts = etTime.split(':').map(Number);
  if (
    dateParts.length !== 3 ||
    dateParts.some((n) => !Number.isFinite(n)) ||
    timeParts.length < 2 ||
    timeParts.some((n) => !Number.isFinite(n))
  ) {
    return { date: '', time: '' };
  }

  const yyyy = dateParts[0]!;
  const mm = dateParts[1]!;
  const dd = dateParts[2]!;
  const hh = timeParts[0]!;
  const mi = timeParts[1]!;

  const offsetHours = isETDST(yyyy, mm, dd) ? 12 : 13;
  const fakeEtAsUtcMs = Date.UTC(yyyy, mm - 1, dd, hh, mi);
  const fakeBjtAsUtcMs = fakeEtAsUtcMs + offsetHours * 3600 * 1000;
  const bj = new Date(fakeBjtAsUtcMs);

  const date = `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`;
  const time = `${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`;
  return { date, time };
}