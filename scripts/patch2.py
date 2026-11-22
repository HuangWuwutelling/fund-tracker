import io


def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for a, b in pairs:
        if a not in s:
            raise SystemExit("NOT FOUND in %s: %r" % (path, a[:90]))
        s = s.replace(a, b)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print("patched", path)


# --- fundApi：删掉分类启发式（搬去 utils/fundType） ---
old_classifiers = """/**
 * 判断基金类型，名称优先（比 search 接口的 type 字段可靠）：
 * - QDII 指数基金（纳指/标普）在 search 里常被标成"指数型"，但名称带 "(QDII)"
 * - 债券指数基金（中债7-10年国开）同理，名称带"债券"
 * 顺序：QDII → 债券 → 指数 → 混合；名称无线索时退回 rawType。
 */
export function getFundTypeFromSearch(rawType: string, name?: string): Fund['type'] {
  const n = name ?? '';
  if (n.includes('(QDII)') || n.includes('QDII')) return 'qdii';
  if (n.includes('债券') || n.includes('中债') || n.includes('国债')) return 'bond';
  if (n.includes('ETF') || n.includes('指数') || n.includes('联接') || n.includes('LOF')) return 'index';
  return mapRawType(rawType);
}

/**
 * 仅按名称分类，无名称线索返回 null（用于"按名称重新分类"场景，避免把手动设置的
 * 类型覆盖成 'mixed'）。语义与 getFundTypeFromSearch 的名称分支一致。
 */
export function getFundTypeFromName(name: string): Fund['type'] | null {
  if (name.includes('(QDII)') || name.includes('QDII')) return 'qdii';
  if (name.includes('债券') || n.includes('中债') || n.includes('国债')) return 'bond';
  if (name.includes('ETF') || name.includes('指数') || name.includes('联接') || name.includes('LOF')) return 'index';
  return null;
}
"""
# 上面的 old_classifiers 里有一处笔误（n vs name），用真实文本重建
old_classifiers = """/**
 * 判断基金类型，名称优先（比 search 接口的 type 字段可靠）：
 * - QDII 指数基金（纳指/标普）在 search 里常被标成"指数型"，但名称带 "(QDII)"
 * - 债券指数基金（中债7-10年国开）同理，名称带"债券"
 * 顺序：QDII → 债券 → 指数 → 混合；名称无线索时退回 rawType。
 */
export function getFundTypeFromSearch(rawType: string, name?: string): Fund['type'] {
  const n = name ?? '';
  if (n.includes('(QDII)') || n.includes('QDII')) return 'qdii';
  if (n.includes('债券') || n.includes('中债') || n.includes('国债')) return 'bond';
  if (n.includes('ETF') || n.includes('指数') || n.includes('联接') || n.includes('LOF')) return 'index';
  return mapRawType(rawType);
}

/**
 * 仅按名称分类，无名称线索返回 null（用于"按名称重新分类"场景，避免把手动设置的
 * 类型覆盖成 'mixed'）。语义与 getFundTypeFromSearch 的名称分支一致。
 */
export function getFundTypeFromName(name: string): Fund['type'] | null {
  if (name.includes('(QDII)') || name.includes('QDII')) return 'qdii';
  if (name.includes('债券') || name.includes('中债') || name.includes('国债')) return 'bond';
  if (name.includes('ETF') || name.includes('指数') || name.includes('联接') || name.includes('LOF')) return 'index';
  return null;
}

"""

old_mapraw = """/** 仅当名称不携带类型线索时，退回用 search 接口的 type 字段判断 */
function mapRawType(rawType: string): Fund['type'] {
  if (rawType.includes('QDII') || rawType.includes('qdi')) return 'qdii';
  if (rawType.includes('债券')) return 'bond';
  if (rawType.includes('指数')) return 'index';
  return 'mixed';
}

"""

patch('src/api/fundApi.ts', [
    (old_mapraw, ""),
    (old_classifiers, ""),
])

# --- store：改成从 utils/fundType 取（去掉对 api 层的依赖） ---
patch('src/stores/index.ts', [
    ("import { getFundTypeFromName } from '../api/fundApi';",
     "import { classifyFundTypeByName } from '../utils/fundType';"),
    ("      const t = getFundTypeFromName(f.name);",
     "      const t = classifyFundTypeByName(f.name);"),
])

# --- FundList：getFundTypeFromSearch 改从 utils 取 ---
patch('src/pages/FundList.tsx', [
    ("import { fetchFundWithHistory, loadFundSearchList, searchFunds, getFundTypeFromSearch } from '../api/fundApi';",
     "import { fetchFundWithHistory, loadFundSearchList, searchFunds } from '../api/fundApi';\nimport { classifyFundTypeBySearch } from '../utils/fundType';"),
])
s = io.open('src/pages/FundList.tsx', encoding='utf-8').read()
s = s.replace("getFundTypeFromSearch(", "classifyFundTypeBySearch(")
io.open('src/pages/FundList.tsx', 'w', encoding='utf-8', newline='').write(s)
print("patched src/pages/FundList.tsx (call sites)")

# --- navHistoryMerge：统一用 hasRealAcc ---
patch('src/utils/navHistoryMerge.ts', [
    ("import type { NavRecord } from '../types';",
     "import type { NavRecord } from '../types';\nimport { hasRealAcc } from './navSeries';"),
    ("  if (!remote.some((r) => r.accNav !== r.nav)) return local;",
     "  if (!hasRealAcc(remote)) return local;"),
    ("""  const remoteHasRealAcc = remote.some((r) => r.accNav !== r.nav);
  const localHasRealAcc = local.some((r) => r.accNav !== r.nav);""",
     """  const remoteHasRealAcc = hasRealAcc(remote);
  const localHasRealAcc = hasRealAcc(local);"""),
])
