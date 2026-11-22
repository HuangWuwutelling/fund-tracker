import type { Fund } from '../types';

/**
 * 基金类型分类——**纯领域规则**，不属于传输层。
 *
 * 此前这段启发式住在 `api/fundApi.ts`（script 注入的传输模块）里，于是：
 * - `stores/index.ts` 为了用 `getFundTypeFromName` 这个纯函数，
 *   让**状态层依赖了网络层**（分层倒挂）；
 * - 同一套名称关键词表被写了两遍：`getFundTypeFromSearch` 的名称分支
 *   和 `getFundTypeFromName` 各自抄了一份，改一处忘一处就是分类漂移。
 *
 * 现在只有一个地方定义关键词表，两个入口都从这里取。
 */

/** 仅当名称不携带类型线索时，退回用 search 接口的 type 字段判断 */
function mapRawType(rawType: string): Fund['type'] {
  if (rawType.includes('QDII') || rawType.includes('qdi')) return 'qdii';
  if (rawType.includes('债券')) return 'bond';
  if (rawType.includes('指数')) return 'index';
  return 'mixed';
}

/**
 * 仅按**名称**分类；名称无线索时返回 null。
 *
 * 返回 null 而不是 'mixed'，是为了不覆盖用户手动设置的类型——
 * "按名称重新分类"场景下，名称看不出类型的基金保持原样。
 *
 * 顺序：QDII → 债券 → 指数；关键词表与 CLAUDE.md 记录的一致
 * （QDII 指数基金在 search 里常被标成"指数型"，但名称带 "(QDII)"）。
 */
export function classifyFundTypeByName(name: string): Fund['type'] | null {
  if (name.includes('(QDII)') || name.includes('QDII')) return 'qdii';
  if (name.includes('债券') || name.includes('中债') || name.includes('国债')) return 'bond';
  if (name.includes('ETF') || name.includes('指数') || name.includes('联接') || name.includes('LOF')) return 'index';
  return null;
}

/**
 * 分类：名称优先（比 search 接口的 type 字段可靠），名称无线索时退回 rawType。
 */
export function classifyFundTypeBySearch(rawType: string, name?: string): Fund['type'] {
  return classifyFundTypeByName(name ?? '') ?? mapRawType(rawType);
}
