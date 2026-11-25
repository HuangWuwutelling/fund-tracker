# 开源投资 / 基金组合记录工具调研（2026-11-24）

> **调研目的**：回答「有没有其他开源好用的投资记录工具」，为 `fund-tracker`（纯前端中国公募基金记录器）提供「换用 / 借鉴 / 放弃」三条路的决策依据。
>
> **方法**：只用一手来源——GitHub / Gitee 仓库自身的 API 元数据（license、stars、最后推送）、README、源码、`docs/` 目录、项目官方文档站。星数与活跃度均为 **2026-11-24** 当天通过 GitHub REST API / Gitee API 实测值，不是搜索引擎快照。
>
> **标注约定**：
> - **[已验证]** = 结论直接来自一手来源，后附链接。
> - **[推断]** = 我基于已验证事实做的判断，来源里没有直接这么写。
> - **[未验证]** = 一手来源无法确认（如仓库无许可证、README 抓不到），如实说明而不是猜。

---

## TL;DR

1. **ZFundPilot**（[`Euzohn/ZFundPilot`](https://github.com/Euzohn/ZFundPilot)，MIT，34★）—— 唯一把「中国公募基金 + 多渠道成本 + 申购/赎回费率 + 分红再投资 + T+1 待确认」整套做全的自托管项目。它 2026-11 的**买入口径**与你 2026-11-20 修正后的 `resolveTxValues` **完全一致**（`shares=(amount−fee)/nav`，`amount` 为扣费前总付出）；**卖出的字段语义相反**（它的 `amount` 存净额，你存毛额）—— 见下方「⚠️ 一处必须纠正的对照」。除这一条外，它是最值得逐行对照的参照实现。
2. **real-time-fund / 基估宝**（[`hzm0321/real-time-fund`](https://github.com/hzm0321/real-time-fund)，AGPL-3.0，**1790★**）—— 中国区最热门的开源基金跟踪器，纯前端 Next.js + localStorage + 天天基金 JSONP，和你技术栈几乎同构；既可当「替代品」，也是最好的交互参考对象。
3. **Portfolio Performance**（[`portfolio-performance/portfolio`](https://github.com/portfolio-performance/portfolio)，EPL-1.0，4186★）—— 国际上做「基金 / ETF 组合记账」的事实标准。**没有**中国基金净值源，但它的三件事可直接抄：FIFO vs 移动加权成本的两套口径、TWR/MWR 双收益口径、以及「手续费从份额里扣 ⇒ 总额记 0 的 Outbound Delivery」这一招。
4. **asset-allocation-management**（[`tuzaizi8/asset-allocation-management`](https://github.com/tuzaizi8/asset-allocation-management)，MIT，1★）—— 2026-11-16 才建的项目，却是唯一把「**平台 YAML 对账单适配** + Excel/PDF/截图导入 + TWR/MWR/Modified Dietz + 每日快照 / 现金流」做成完整闭环的中国基金组合系统。**设计值得抄，代码太新不值得依赖**（创建 8 天、1★）。
5. **Ghostfolio**（[`ghostfolio/ghostfolio`](https://github.com/ghostfolio/ghostfolio)，AGPL-3.0，9773★）—— 自托管组合跟踪器的 UX 与国际化标杆，数据源只有 Yahoo 等通用行情，**拿不到中国基金净值**；可当 UI 参考，不可当工具。
6. **finance_tools**（Gitee [`itliuyan/finance_tools`](https://gitee.com/itliuyan/finance_tools)，0★，**无许可证**）—— 功能清单与你的需求几乎逐条对上（多平台分组、移动加权成本、现金分红 vs 红利再投资、15:00 截止、OCR 截图导入），但零星、无许可证，**只能读不能抄**。

> 一句话结论 **[推断]**：**这个细分是薄的不是厚的**。国际上没有一个工具拿得到中国基金 NAV，中国区的工具普遍小、年轻、许可证不清。可行的路不是「换一个工具」，而是**把 `fund-tracker` 继续做深**——但 ZFundPilot 已经把后端那一层的关键算法（费率、T+1、QDII）做完了，值得逐行抄。

---

## 对比表

> 许可列为 SPDX id（取自 GitHub/Gitee API 的 `license` 字段）。「活跃度」= 最后推送日期 + 未关闭 issue 数。

| 工具 | 许可 | 技术栈 / 部署 | 活跃度（2026-11-24） | 净值 / 价格数据源 | 中国基金 | 成本口径 | 导入 / 导出 |
|---|---|---|---|---|---|---|---|
| **ZFundPilot** | MIT | Python FastAPI + SQLite + Pandas；React 18 + Vite + TS + Tailwind + shadcn/ui；Docker / uvicorn | 推送 2026-11-22；v0.28.1（2026-11-20）；0 issue；CI(ruff→pytest→tsc→build) active；733 commits | 天天基金 `pingzhongdata`（同一上游！）、AkShare 兜底；费率页 `fundf10.eastmoney.com/jjfl_{code}.html`；天天基金分红页 | **是**（支付宝 / 理财通 / 天天基金分渠道） | 移动加权平均；赎回费按 **FIFO 批次 + 持有天数分档** | CSV 导入导出（中文表头，amount/shares/nav 填二补一）+ 全量备份 ZIP v2（带逐表校验） |
| **real-time-fund** | AGPL-3.0 | Next.js (App Router) 静态导出 + 全局 CSS；纯前端 | 推送 2026-11-23；**1790★** / 506 fork / 20 issue | 天天基金 JSONP（估值）+ 东方财富 HTML 解析（重仓）+ 腾讯财经 script 注入 | **是** | 持仓存 `share` + `cost`（单位成本价）；交易含 `feeRate/feeMode/feeValue` | JSON 配置导出 / 导入；可选 Supabase 云同步 |
| **Portfolio Performance** | EPL-1.0 | Java / Eclipse RCP **桌面应用** | 推送 2026-11-20；0.90.0（2026-11-01）；4186★ / 537 issue | Yahoo Finance（主力）、内置 PP 服务、Alpha Vantage、EODHD、JSON、CSV、AMFI/MFAPI（印度） | **否** | **FIFO 与 移动加权（ACB）双口径**，可切换 | CSV 导入向导（列名可自定义映射）+ PDF 导入（PDFBox）+ 导出 |
| **asset-allocation-management** | MIT | React 19 + Vite + router v7 + TanStack Query + shadcn/ui + Tailwind v4 + Recharts；FastAPI + SQLAlchemy 2.0 async + PostgreSQL + Redis | 推送 2026-11-18（**创建 2026-11-16**）；1★ | AkShare（基金/净值/指数）+ 同花顺档案三级缓存（Redis→DB→AkShare） | **是** | 每日快照 + 现金流预计算；**TWR / MWR / Modified Dietz** + QuantStats | Excel / PDF / 截图上传，**平台 YAML 适配**；Excel 导出可原样回导 |
| **Ghostfolio** | AGPL-3.0 | TypeScript / Nx；NestJS + PostgreSQL + Prisma + Redis；Angular + Material；Docker | 推送 2026-11-24；3.100.0（2026-11-15）；**9773★** / 362 issue | Yahoo Finance、Alpha Vantage、EODHD、Financial Modeling Prep、CoinGecko、Google Sheets、Manual、Rapid API | **否** | 活动类型 BUY/SELL/DIVIDEND/FEE/INTEREST/LIABILITY；ROAI（含分红总回报） | JSON / CSV 活动导入导出；PWA |
| **finance_tools** | **无（不可验证）** | Python + SQLite + 原生 Web 页面（`web_app.py --port 5001`） | 推送 2026-09-13；创建 2026-05-10；**0★** | 天天基金（同花顺分组） | **是** | **移动加权平均成本** | CSV / Excel 净值导入；CLI + Web；macOS Vision OCR 截图导入（可选 OpenAI/Google 复核） |
| **ChickenFarm** | AGPL-3.0 | Python 3.10+ + SQLite + uv/pytest；CLI 脚本 | 推送 2026-11-16；47★ / 13 fork / 1 issue | `xalpha`（场外基金累计净值）+ 新浪财经 / AkShare 兜底（ETF 前复权日线） | **是**（仅回测，无持仓账本） | — | CSV 导出（p 值 / 效应量 / CI / 稳健性结论） |
| **Qfunds** | **无** | Python + Streamlit + SQLite + Pandas + Plotly | 创建 = 最后推送 = 2026-01-15；**0★** | AkShare `fund_open_fund_info_em` + 东方财富 JSONP 实时估值 | **是** | **逐日回放**（事件驱动重算）；买入费计入累计亏损、赎回费扣自成交额 | SQLite；`st.navigation` 多页 |
| **moneyney** | MIT | React 18 + TS + Vite + Tailwind + Recharts + Lucide | 创建 = 最后推送 = 2026-02-02；4★ | 天天基金 + 新浪财经 | **是** | 加权平均成本 | JSON 导出 / 导入；**localStorage** |
| **xalpha**（数据源，非工具） | MIT | Python 库 | 推送 2026-11-14；**2755★** | 基金净值 / 持仓 / 回测引擎 | **是** | — | — |
| rotki | AGPL-3.0 | Python + Vue；Docker / 桌面二进制 | 推送 2026-11-24；4097★ / 335 issue | 加密资产行情 | 否（仅 crypto） | 链上交易解码式会计 | — |
| Firefly III | AGPL-3.0 | PHP / Laravel + Vue；Docker | 推送 2026-11-24；25333★ / 198 issue | 无（预算 / 记账） | 否 | 双式记账 | CSV / OFX / QIF |
| Actual Budget | MIT | TypeScript / NodeJS；本地桌面 or Docker | 推送 2026-11-23；30434★ / 194 issue | 无（预算） | 否 | 信封预算 | CSV |
| Beancount + Fava | GPL-2.0 + MIT | Python；纯文本账本 + Web UI | beancount 推送 2026-08-23（6202★）；fava 2026-11-23（2612★） | 无（需自写 price 指令或插件） | 否（可建模但无数据） | 双式记账 | `.beancount` 文本 |

---

## 逐工具详述

### 1. ZFundPilot —— 最接近的「同类产品」

**仓库**：[`Euzohn/ZFundPilot`](https://github.com/Euzohn/ZFundPilot) ｜ **许可**：MIT（README 末节 + GitHub API `license.spdx_id = MIT`）｜ **数据源合规声明**：[`NOTICE.md`](https://github.com/Euzohn/ZFundPilot/blob/main/NOTICE.md)

**[已验证]** 事实：

- **活跃度**：最后推送 2026-11-22；最新 release `v0.28.1`（2026-11-20）；0 个未关闭 issue；GitHub Actions `CI` workflow 处于 `active`（[`ci.yml`](https://github.com/Euzohn/ZFundPilot/blob/main/.github/workflows/ci.yml)，顺序为 ruff → pytest → tsc → build）；累计 733 commits。
- **栈**：后端 FastAPI + SQLite + Pandas；前端 React 18 + Vite + TypeScript + Tailwind + shadcn/ui；Docker Compose 部署（端口 8000），也可 `pip install -e .` + uvicorn 本地跑。[README「技术栈」「快速开始」](https://github.com/Euzohn/ZFundPilot/blob/main/README.md)
- **数据源**：README 明写「**AkShare + 天天基金**」；[README 截图说明](https://github.com/Euzohn/ZFundPilot/blob/main/README.md) 写「净值更新 — 天天基金优先、AkShare 兜底」。[源码](https://github.com/Euzohn/ZFundPilot/blob/main/src/zfundpilot/fetch_fund.py) 里出现的 URL 是 `https://fund.eastmoney.com/pingzhongdata/{fund_code}.js`、`https://fundf10.eastmoney.com/jjfl_{fund_code}.html`、`https://fundf10.eastmoney.com/FundArchivesDatas.aspx`——**`pingzhongdata` 和你用的是同一个上游**，而 `jjfl_` 费率页是你目前没有的。
- **交易口径（逐字核对，与你的实现一致）**：[`src/zfundpilot/models.py`](https://github.com/Euzohn/ZFundPilot/blob/main/src/zfundpilot/models.py) 的 `Transaction.normalize()` docstring 写：
  > 买入：`amount = shares × nav + fee`（用户付份额价值 + 手续费）
  > 卖出：`amount = shares × nav - fee`（用户收份额价值 - 手续费）
  > 分红/再投资：无手续费

  代码体：`buy` 分支 `self.shares = round((a - fee) / n, 2)`，`sell` 分支 `self.amount = round(s * n - fee, 2)`。

  > #### ⚠️ 一处必须纠正的对照（2026-11-24 复核，实测源码后修正）
  >
  > **买入口径：完全一致。** 双方都是 `shares = (amount − fee) / nav`，`amount` 为**扣费前**的总付出。
  >
  > **卖出口径：字段语义相反 —— 这条不能照抄。**
  >
  > | | 存储的 `amount` | 存储的 `fee` | 下游「实际到手」 |
  > |---|---|---|---|
  > | **ZFundPilot** | `shares × nav − fee` = **净额**（已扣费） | 单独存 | 直接取 `amount` |
  > | **`fund-tracker`（本项目）** | `shares × nav` = **毛额**（成交额） | 单独存 | `amount − fee` |
  >
  > 两者**经济学相同**（手续费从卖出所得里扣、份额不变），但 `amount` 字段的含义不同。
  > 本项目 CLAUDE.md 的不变式是「**`amount` 恒为扣费前金额**（卖出 = 成交额），`fee` 恒从中扣除」，
  > 且下游代码（`Transactions.tsx` 的统计 `sellAmount += tx.amount - tx.fee`）依赖毛额口径。
  >
  > **若照抄 ZFundPilot 的表示法，本项目会把手续费扣两次** —— 正是 CLAUDE.md 里记的
  > 「2026-11-20 卖出份额被侵蚀」那一类事故。**结论：本项目的毛额口径要保留，
  > ZFundPilot 的净额表示法只作对照，不要移植。**
  >
  > 复核方式：`curl raw.githubusercontent.com/Euzohn/ZFundPilot/main/src/zfundpilot/models.py`，
  > `Transaction.normalize()` 第 88–120 行（2026-11-24 实测）。[已验证]
- **手续费是它比你多出来的一块**：[`fetch_fund.py` 的 `calc_redemption_fee()`](https://github.com/Euzohn/ZFundPilot/blob/main/src/zfundpilot/fetch_fund.py) 做了**按日期回放流水重建买入批次 → FIFO 消耗批次 → 用持有天数匹配费率档**；`calc_purchase_fee()` 按金额分档匹配申购费。其 docstring 明确：持有期按流水日期算、同日买入按 0 天落惩罚档、边界模糊时**按高档计费（宁可高估费用、不静默少计成本）**。费率表从 `fundf10.eastmoney.com/jjfl_{code}.html` 抓。
- **T+1 待确认**：[`analysis.py`](https://github.com/Euzohn/ZFundPilot/blob/main/src/zfundpilot/analysis.py) 有 `_is_t1_transaction()` / `_t1_nav_date()`（= 交易日的次日）/ `recalculate_t1_transactions()` / `backfill_transaction_navs()`；`calc_redemption_fee()` 在净值未公布时返回 `code="pending_nav"` 而非瞎猜费率。**这是你 `autoConfirm.ts` 的同一思路。**
- **QDII 延迟**：`_qdii_nav_reference()`（analysis.py）——「QDII 净值通常 T+2 公布，且受美股休市影响，故容忍多一个交易日」，用 `us_calendar.is_us_trading_day()` 判断中美同时开市。仓库里还有独立的 `src/zfundpilot/us_calendar.py`（NYSE 交易日历）。[已验证]
- **多渠道成本**：`channel` 字段（支付宝/理财通/天天基金），README 明写「同一基金不同渠道分开计算成本」；`_position_key(fund_code, channel)` 是持仓聚合的键。
- **分红**：`action` 支持 `buy/sell/dividend/reinvest`；`fetch_dividend.py` 从天天基金检测分红事件，每天 09:30 扫描持仓并弹窗预填确认入账。
- **导入导出**：CSV 列 `fund_code / action / date / amount / shares / nav / fee / channel / note`，「填任意两列自动补全第三列，支持中文表头」；另有全量备份 ZIP（格式 v2，含净值历史与逐表校验，可预检后恢复）——**和你现在「导出 JSON 整包」是同一个需求，但它的版本化 + 逐表校验值得抄**。
- **测试规模**：[`CHANGELOG.md`](https://github.com/Euzohn/ZFundPilot/blob/main/CHANGELOG.md) 最近一条提到「后端全量 1768 例、前端全量 245 例」（README 里写的 1514 已过期）。

**[推断] 怎么用**：它不是「换掉你」的工具（Docker + 后端 + 认证，复杂度高出一截），而是**一份免费的中文基金记账规格书**。凡是「中国基金特有」的规则——申购/赎回费率分档、持有期惩罚档、分红再投资、T+1、QDII 交易日历——它都已经踩过一遍并写成了带 docstring 的代码。

**[已验证] 旁支**：`Choi-Peng/ZFundPilot` 是它的 fork（GitHub API `fork = true`，0★，MIT，README 把数据源优先级写成「AkShare 优先、天天基金兜底」——与上游相反）。**[推断]** 两个版本都活跃（fork 最后推送 2026-11-04），说明这块需求还在动。

---

### 2. real-time-fund / 基估宝 —— 中国区最热门，同构度最高

**仓库**：[`hzm0321/real-time-fund`](https://github.com/hzm0321/real-time-fund) ｜ **官网**：<https://jigubao.app/> ｜ **许可**：AGPL-3.0（GitHub API + README）

**[已验证]** 事实：

- **人气**：**1790★ / 506 fork / 20 open issue**，创建 2026-01-31，最后推送 2026-11-23。中文开源基金跟踪器里量级最大的一个。
- **栈**：Next.js (App Router) 静态导出 + 全局 CSS（玻璃拟态）；**纯前端**，GitHub Actions + GitHub Pages 部署；可选 Supabase 做云同步。README 明写「通过 JSONP 方案直连东方财富、腾讯财经等公开接口，彻底解决跨域问题，支持在 GitHub Pages 等静态环境直接部署」。
- **数据源**：基金估值 = **天天基金 JSONP**；重仓 = 东方财富（HTML 解析）；股票行情 = 腾讯财经（script 注入）。**和你「script-tag 注入 + JSONP」的技术决策完全同路。**
- **持久化**：[`doc/localStorage 数据结构.md`](https://github.com/hzm0321/real-time-fund/blob/main/doc/localStorage%20%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84.md) 里 `holdings` 存 `share` + `cost`（单位成本价）；`transactions` 存交易；`dcaPlans` 存定投计划。
- **待确认交易（和你的 autoConfirm 同构）**：同文档 `### 10. pendingTrades` 写「**净值未更新时暂存交易 / 净值更新后自动处理待处理交易**」，字段含 `share / amount / feeRate / feeMode / feeValue / isAfter3pm / isDca / groupId`。**它的 `pendingTrades` 就是你的「待确认」。**
- **手续费模式**：`feeMode` 字段说明手续费有多种模式（从份额扣 / 从金额扣之类）——**[推断]** 与你 2026-11-20 那次「买入公式误用到卖出」的坑是同一类问题，值得看看它 `feeMode` 的取值定义。
- **CLI**：`@jigubao/cli`，`jgb search / price / portfolio list --json`——**[推断]** 对你没什么用，但「同一份数据两个出口（网页 + CLI）」的产品形态不错。
- **无分红建模**：文档里的 `transactions` 字段只覆盖 `buy` / `sell`；**没有** 分红 / 红利再投资的记录类型。**[已验证（文档范围内）]**

**[推断] 怎么用**：这是「**换用**」选项里唯一一个技术栈和你重叠的（纯前端 + localStorage + 静态托管 + JSONP 天天基金）。缺点是 AGPL-3.0（商用要开源）、没有分红口径、没有成本明细到分批次、没有费率自动查。它的价值更多在**交互参考**：分屏多列（估值 / 重仓 / 收益三合一）、拖拽排序、自定义排序规则组、可配置刷新频率（5–300 秒）。

**衍生项目**：**透视宝 LazyTrader**（[`suvzzc/LazyTrader`](https://github.com/suvzzc/LazyTrader)，AGPL-3.0，主仓库在 Gitee `suv-vsu/lazy-trader`）是它的下游，README 明写「参考并衍生自 real-time-fund」，改成了「本地以 localStorage 为主；**可选**接入 Supabase 做配置同步」。**[推断]** 同架构的两个实现互相印证了这套形态的可行性。

---

### 3. Portfolio Performance —— 记账规则的教科书

**仓库**：[`portfolio-performance/portfolio`](https://github.com/portfolio-performance/portfolio) ｜ **官网**：<https://www.portfolio-performance.info> ｜ **文档**：[`portfolio-help` 仓库的 `docs/en/`](https://github.com/portfolio-performance/portfolio-help/tree/master/docs/en) ｜ **许可**：EPL-1.0（GitHub API `spdx_id = EPL-1.0`；README 指向 <https://www.eclipse.org/legal/epl-v10.html>）

**[已验证]** 事实：

- **形态**：**Java / Eclipse RCP 桌面应用**（不是网页），离线单机。Active：推送 2026-11-20；最新 release **0.90.0（2026-11-01）**；4186★ / 850 fork / **537 open issue**（老牌项目，issue 多是功能请求）。
- **覆盖的资产**：股票、ETF、**共同基金（Mutual funds）**、债券、加密货币、黄金、外汇。有专章 [Mutual funds](https://github.com/portfolio-performance/portfolio-help/blob/master/docs/en/how-to/downloading-historical-prices/index.md)。
- **数据源（关键结论）**：文档 [Downloading Historical Stock Prices](https://github.com/portfolio-performance/portfolio-help/blob/master/docs/en/how-to/downloading-historical-prices/index.md) 列出 Alpha Vantage、EODHD、Finnhub、Leeway、Twelve Data、Quandl、Yahoo Finance、内置 PP 服务、JSON、CSV、HTML 表格导入，并明说「**实际上只有内置 PP 服务与 Yahoo Finance 可以推荐**」；共同基金那一节直接说 Morningstar 最全。**没有任何中国基金源**（有印度专章 [AMFI / MFAPI](https://github.com/portfolio-performance/portfolio-help/blob/master/docs/en/how-to/downloading-historical-prices/indian.md)，说明它是按「国家插件」扩展的，但没有中国的）。
- **成本口径（最值得抄的一节）**：[`concepts/cost-methodology.md`](https://github.com/portfolio-performance/portfolio-help/blob/master/docs/en/concepts/cost-methodology.md) 明确两套并存的实现：
  > Portfolio Performance calculates gains using two methodologies: the **FIFO** principle and the **moving average** principle, also known as **Adjusted Cost Base (ACB)**.

  文档用两个完整例子把 realized / unrealized gain 都算了一遍。**[推断]** 你的「按比例结转成本」属于 moving average 一族；FIFO 那套是另一个可选口径，值得做成开关而不是硬编码。
- **「手续费从份额里扣」的正解**：[`how-to/fees-on-shares.md`](https://github.com/portfolio-performance/portfolio-help/blob/master/docs/en/how-to/fees-on-shares.md) —— 券商按年费卖掉你一小部分份额时，用一笔 **Outbound Delivery** 记：「shares are sold and the fees are applied to the sold value within the same transaction. This results in a **total outbound delivery amount of 0**」，并且强调「Sell transaction in Portfolio Performance can not have a final null value」。**[已验证]**
- **红利再投资（choice dividend）**：[`how-to/handling-choice-dividend.md`](https://github.com/portfolio-performance/portfolio-help/blob/master/docs/en/how-to/handling-choice-dividend.md) 把「现金分红 vs 股票分红」拆成**两笔交易**：先记 gross dividend（不加费不加税），再按参考价买入配股（bonus shares）；零碎份额单独记一笔。**[已验证]** 这和你现在「`tx.shares > 0 → 红利再投资`」的单笔判据是两种建模，取舍很清楚。
- **收益口径双轨**：[`concepts/performance/time-weighted.md`](https://github.com/portfolio-performance/portfolio-help/blob/master/docs/en/concepts/performance/time-weighted.md) 给 TWROR 的标准三步法与公式 `1 + r = MVE / (MVB + CF)`；[`money-weighted.md`](https://github.com/portfolio-performance/portfolio-help/blob/master/docs/en/concepts/performance/money-weighted.md) 说明 MWR = IRR，给出 `MVB×(1+IRR)^(RD/365) + Σ CF_t×(1+IRR)^(RD_t/365) = MVE` 的解析式。**[已验证]**
- **导入导出**：[CSV 导入](https://github.com/portfolio-performance/portfolio-help/blob/master/docs/en/reference/file/import/csv-import.md) 是三步向导，「列名可自由选择，但建议对齐 PP 的字段名以简化映射」；另有 PDF 导入（PDFBox）、导出。整个应用还有 XML 持久化格式。

**[推断] 怎么用**：**不能换用**（桌面应用 + 无中国净值），但它是**成本与收益口径的最佳教材**。三处直接可抄：(a) 手续费从份额扣时用「总额 0 的出账」表达；(b) 现金分红与红利再投资拆成两笔；(c) TWR 与 MWR 并列展示（你目前只有 XIRR）。

---

### 4. asset-allocation-management —— 设计最完整，但太新

**仓库**：[`tuzaizi8/asset-allocation-management`](https://github.com/tuzaizi8/asset-allocation-management) ｜ **许可**：MIT

**[已验证]** 事实：

- **活跃度**：**创建 2026-11-16，最后推送 2026-11-18，1★ / 0 fork / 0 issue**。CI badge 在 README 里（`.github/workflows/ci.yml`，前端 lint+类型+测试，后端 ruff+pytest）。**截至 2026-11-24 它存在 8 天。**
- **栈**：前端 React 19 + Vite + react-router v7 + TanStack Query v5 + shadcn/ui v4 + Tailwind v4 + Recharts + MSW + Vitest + Playwright；后端 Python 3.12+ / FastAPI / SQLAlchemy 2.0 async / PostgreSQL / Redis / AkShare / QuantStats。
- **数据源**：AkShare 拉基金字典与净值；同花顺档案走「Redis → DB → AkShare 三级缓存」；指数行情同步。
- **对账单导入（最像你 `platformImport.ts` 的东西）**：README 原文——
  > 上传券商导出的 Excel / PDF / 截图对账单后，系统自动解析为结构化交易记录并进入三步确认流程（选择文件 → 核对勾选 → 完成导入），**按来源文件逐行列出类型、金额、份额、单价与手续费**，人工确认后自动重建持仓与快照。

  并且提到「**平台 YAML 适配** + 分级校验」。
- **收益口径**：README 明确「TWR、MWR、Modified Dietz、QuantStats 风险指标」，且「全部指标基于真实净值与 TWR 计算，数据不采样、不估算，每一笔都能在净值历史里溯源」。
- **快照模型**：`历史持仓` 页按日期区间生成**每日快照与现金流**，持仓分析 / 占比历史都读快照（不生成则页面无数据）。
- **Excel 往返**：交易流水 Excel 导出「与导入模板同列形可回导」。

**[推断] 怎么用**：**读它的设计，不依赖它的代码**。三件事值得抄：(a) **平台 YAML 适配器**——把「支付宝 / 天天基金 / 同花顺」的对账单格式做成可插拔的声明式解析器（比你现在写死的 parser 更好扩展）；(b) **导入三步确认流**（选择文件 → 逐行核对勾选 → 提交），你现在的「预检报告」方向一致，但它的 UI 形态更完整；(c) **快照 + 现金流是分析的唯一数据源**，避免分析逻辑各自去读流水。

---

### 5. Ghostfolio —— UX 与国际化标杆，拿不到中国净值

**仓库**：[`ghostfolio/ghostfolio`](https://github.com/ghostfolio/ghostfolio) ｜ **官网**：<https://ghostfol.io> ｜ **许可**：AGPL-3.0

**[已验证]** 事实：

- **人气与活跃度**：**9773★ / 1434 fork / 362 open issue**；推送 2026-11-24；最新 release **3.100.0（2026-11-15）**；CHANGELOG 顶部还有 Unreleased 条目。**项目非常活跃。**
- **栈**：Nx workspace；后端 NestJS + PostgreSQL + Prisma + Redis；前端 Angular + Angular Material + Bootstrap；官方 Docker 镜像（linux/amd64、arm/v7、arm64）。
- **数据源（源码目录实测）**：`apps/api/src/services/data-provider/` 下的子目录为 `alpha-vantage/`、`coingecko/`、`eod-historical-data/`、`financial-modeling-prep/`、`ghostfolio/`（内置）、`google-sheets/`、`manual/`、`rapid-api/`、`yahoo-finance/`。**没有任何中国基金 / 天天基金源**；免费层实际可用的是 Yahoo Finance。
- **活动类型**：`apps/api/src/app/portfolio/portfolio.service.ts` 里有 BUY / SELL / DIVIDEND / Fee / INTEREST / ASSET / LIABILITY 等类型，README 强调 **ROAI（Return on Average Investment，含分红的总回报）**，并有 Today / WTD / MTD / YTD / 1Y / 5Y / Max 区间。
- **其他**：PWA + Zen Mode + Dark Mode；有官方 Premium 云服务（AGPL 的商业化路径参考）。

**[推断] 怎么用**：**不能换用**（数据源不兼容）。可参考的是产品层：ROAI（资金加权但含分红）与 TWR 并列的展示方式、区间快捷选择器（Today/WTD/MTD/YTD/1Y/5Y/Max）、多账户 + 多资产类别分类树、以及 Docker 化部署的文档组织。

---

### 6. finance_tools —— 功能清单几乎逐条对上你，但不能抄

**仓库**：Gitee [`itliuyan/finance_tools`](https://gitee.com/itliuyan/finance_tools)（README 由 Gitee API 读取）

**[已验证]** 事实：

- **元数据**（Gitee API）：创建 2026-05-10，最后推送 2026-09-13，**0★ / 0 fork / 0 issue**，`license` 字段为空 —— **仓库无许可证**（即默认保留一切权利，不能合法复用代码）。
- **README 原文功能清单**：
  - 「**多平台分组**：同一基金代码可以在 `tt`（天天基金）、`ths`（同花顺）等分组中分别建仓」
  - 「**交易记录**：买入、卖出、**15:00 截止判断**、**交易净值确认**、**移动加权平均成本**」
  - 「**分红管理**：现金分红和红利再投资；现金分红计入账户资产，红利再投资增加持有份额但不增加投入资金」
  - 「净值管理：手动录入、批量获取、CSV/Excel 导入」
  - 「账户指标：投入总资金、当前账户总资金、资产最高点、投资最高收益」
  - 「收益曲线：Web 页面按基金/分组查询近 30、90、180、365 天收益曲线」
  - 「告警规则：全局组合、单只基金、基金分组三种作用域；三级告警」
  - 「**OCR 图片导入**：macOS Vision 本地识别持仓截图；识别不理想时可重新上传并选择 OpenAI/Google 模型，**人工确认并修正后才入库**」，且明确「图片字节只在当前请求内存中处理，不保存原图、不保存图片 hash，**也不会自动推断买入、卖出或分红交易**」
  - 「高危操作：Web 页面输入 `CLEAR` 后清空业务数据，保留表结构和配置」
- **形态**：Python + SQLite + 原生 Web 页面（`python web_app.py --port 5001`）。

**[推断]**：这份清单里有 **4 条你还没做但迟早要做的**：15:00 截止判断、分红 vs 红利再投资的**入账语义**（现金分红计入资产、再投资增份额不增投入）、资产最高点 / 最高收益（回撤峰值口径）、以及 OCR 截图导入的「不自动推断交易、必须人工确认」纪律。**但 0★ + 无许可证，只能当需求清单读。**

---

### 7. 其他值得一提的

| 项目 | 一手来源与事实 | 定位 |
|---|---|---|
| **ChickenFarm**（养鸡场） | [`doongz/ChickenFarm`](https://github.com/doongz/ChickenFarm)，AGPL-3.0，47★ / 13 fork / 1 issue，推送 2026-11-16，创建 2021-08-08 | **现在已经是纯回测工具**（README 原文：「一个纯回测工具」）——不再记个人持仓。价值在回测方法学：场外基金固定金额买入 / ETF 固定手数，计滑点佣金申购费折扣；**Wilcoxon 符号秩检验 + Holm 多重比较校正 + bootstrap 95% CI + 分块稳健性判定**；数据源 `xalpha`（2755★，MIT）+ 新浪财经/AkShare 兜底，前复权含分红拆分合成。**[推断]** 它的「什么时候定投更划算」的严谨统计方法可以照搬到你的定投回测里。 |
| **Qfunds** | [`zhangfanglue0228/Qfunds`](https://github.com/zhangfanglue0228/Qfunds)，**无许可证**，0★，创建 = 最后推送 = 2026-01-15 | Streamlit + SQLite + AkShare + 东方财富 JSONP。**唯一亮点是算法**：「**逐日回放**」——按事件驱动逐日重放持仓，而不是「当前份额 × 当前净值」；买入手续费直接计入累计亏损，赎回费计入累计亏损；非交易日录入自动顺延到交易日；`pending → processed` 两态交易。**[已验证]**（README 第 3.1 节）**[推断]** 这个「回放」模型比快照式计算更抗陈旧净值——你的 `autoConfirm` / `navSeries` 已经在往这个方向走。**但仓库只有 39KB、0★、无许可证、半年没动。** |
| **moneyney** | [`z1the3/moneyney`](https://github.com/z1the3/moneyney)，MIT，4★ / 2 fork，创建 = 推送 = 2026-02-02 | React 18 + TS + Vite + Tailwind + Recharts，localStorage，**和你几乎同构**。天天基金 + 新浪财经净值同步；交易记录 + 加权平均成本 + 撤销；定投一键执行；JSON 导出导入。**README 里的 clone 命令还是模板占位符 `git clone https://github.com/your-username/moneyney.git`** → **[推断]** 是个没走完的模板项目，功能描述（尤其「定投一键批量申购」「操作撤销」）可以参考。 |
| **xalpha** | [`refraction-ray/xalpha`](https://github.com/refraction-ray/xalpha)，MIT，**2755★**，推送 2026-11-14 | 「基金投资管理回测引擎」Python 库。**[推断]** 如果你以后想扩到回测（定投策略、网格），它是现成的中国基金数据 + 回测底座，比自己从 `pingzhongdata` 拼要省事。 |
| **j-tide/fund-pulse** | [`j-tide/fund-pulse`](https://github.com/j-tide/fund-pulse)，GPL-3.0，11★，推送 2026-11-24，创建 2026-06-18 | Swift 原生 macOS 菜单栏；盘中估值 + 官方净值 + 收益分析 + 加减仓与**转换记录**；本地优先无账号。**[推断]** 「基金转换（转出→转入）作为一笔业务」值得看一眼 ZFundPilot 是怎么记的（见下）。 |
| **lingyired/fund01** | [`lingyired/fund01`](https://github.com/lingyired/fund01)，**无许可证**，23★，推送 2026-10-12，创建 2026-07-31 | Chrome 扩展 + macOS 菜单栏 + Windows 任务栏三端共用一套前端；持仓分组 + 盘中估值 + 收益盈亏。**[推断]** 三端同码的形态有意思，但对你单人纯前端场景价值不大。 |
| **yysgit/Fund** | [`yysgit/Fund`](https://github.com/yysgit/Fund)，**无许可证**，5★ / 1 fork / 0 issue，Java，推送 2026-06-07，创建 2023-01-08 | 仓库自述「基金开源网站-真实数据爬虫」；定位是**策略辅助**（据二手资料为网格 / 金字塔定投策略），不是记账器。**[推断]** 网格策略与你的定投计划模型正交，不构成「换用」选项。 |
| **olixu/Fund** | [`olixu/Fund`](https://github.com/olixu/Fund)，MIT，29★ / 7 fork / 1 issue，**最后推送 2021-04-08** | 仓库自述「基金推荐与投资记录系统」，Streamlit + SQLite + 天天基金。**[推断]** 定位与你接近，但**已停更 5 年半**。 |
| **kaidea/fishing-funds** | [`kaidea/fishing-funds`](https://github.com/kaidea/fishing-funds)，GPL-3.0，**是 fork**（上游另找），0★，最后推送 2021-11-24 | Electron 菜单栏，导入导出基金 JSON（code / 持有份额 / 成本价）。**[推断]** 停更、且只是 fork，不值得看。 |
| **akshare_fund_analyzer / fund-toolkit / Index Analyzer / VSTP / FundMasterPro / FVTracker** | [`nox-1354/fund-toolkit`](https://github.com/nox-1354/fund-toolkit) MIT 11★；[`samwancd/akshare_fund_analyzer`](https://github.com/samwancd/akshare_fund_analyzer)；Gitee [`watch4bmw/index_analyzer`](https://gitee.com/watch4bmw/index_analyzer) 0★；Gitee [`sword-chopper/VSTP`](https://gitee.com/sword-chopper/VSTP) GPL-2.0 1★；Gitee [`zxl7725103/FundMasterPro`](https://gitee.com/zxl7725103/FundMasterPro) 3★；Gitee [`HTLaoYang/FVTracker`](https://gitee.com/HTLaoYang/FVTracker) 12★（Gitee API 标 **MPL-2.0**，但其 README 的徽章写 **MIT**，**两者矛盾**） | 要么是数据/筛选工具而非记账器，要么是桌面 GUI 单机。`index_analyzer` 有 XIRR + 周度年化曲线；`VSTP` 是 PyQt5 估值监控 + 量化信号；`FVTracker` 是 Tkinter 加仓策略建议。**[推断]** 都不构成「换用」选项；FVTracker 的许可证标注矛盾本身就是不要碰的信号。 |

---

## 值得借鉴的技术（可以直接抄进 `fund-tracker`）

按「抄进你代码库的性价比」排序。每条都标了出处。

### A. 交易口径与费率（最高价值）

1. **费率分档表从天天基金抓** —— ZFundPilot 从 `https://fundf10.eastmoney.com/jjfl_{fund_code}.html` 解析申购/赎回费率档（`[已验证]` 源码 `fetch_fund.py` 的 URL 常量）。**你的 `platformImport` 目前完全依赖平台导出的真值，缺一条「系统自己查费率」的路。**
2. **赎回费按 FIFO 批次 + 持有天数分档** —— ZFundPilot `calc_redemption_fee()` 回放流水重建买入批次、FIFO 消耗、按持有天数匹配费率档。**[已验证]** 中国平台普遍有「持有 <7 天 1.5%」的惩罚档，**你的移动加权成本法算不出这个**（一次买入 1000 元、持有 3 天全卖，真实费用和持有 1 年的费用差一个量级）。
3. **边界模糊时按高档计费** —— ZFundPilot 的原话：「边界模糊时刻意按高档计费（**宁可高估费用，不静默少计**）」。**[已验证]** 这条和你 CLAUDE.md 里「宁可不给信号，也不要错误信号」（`accNav` 同源原则）是同一种纪律，可以直接写进 `resolveTxValues` 的 docstring 作为原则。
4. **买入口径与你完全一致** —— ZFundPilot `Transaction.normalize()`：买入 `shares=(amount−fee)/nav`，分红/再投资无手续费。**[已验证]** 两个独立实现算出同一个买入口径，说明你的口径是对的；可以作为「口径正确性」的外部佐证写进你的 spec。**但卖出的 `amount` 字段语义相反（它存净额、你存毛额），别照抄——见「⚠️ 一处必须纠正的对照」。**
5. **「手续费从份额里扣」用总额 0 表达** —— Portfolio Performance：Sell 交易不允许最终金额为 null，这类费用要用 **Outbound Delivery**（卖出份额、金额记 0、费用落在卖出额上）。**[已验证]** 你现在的「卖出费从成交额里扣、不减少份额」和这个是同一件事的不同表达——值得在数据模型里显式区分「费用扣自成交额」与「费用扣自份额」两种 fee 位置，而不是只有 `fee` 一个数字。

### B. 待确认 / 陈旧净值

6. **手续费也要等净值** —— ZFundPilot `calc_redemption_fee()` 在净值未公布时返回 `code="pending_nav"`，而不是先按 0 费率记。**[已验证]** 你现在只对**份额**做待确认，**费用没有一起进待确认队列** —— 净值公布后补的份额是对的，但费率是「取不到就用 0」还是「事后重算」需要定死。
7. **T+1 确认日期 = 交易日的次日** —— ZFundPilot `_t1_nav_date()` = `tx.date + 1 day`，并在 `_is_t1_transaction()` 里标记「15:00 后下单」。**[已验证]** 你的 `today()` 用本地时间、`autoConfirm` 判「当天净值」——如果允许 15:00 后下单，确认日应该是**次日**而不是当天。**这一条你目前没有。**
8. **QDII 的净值参考日要多退一个交易日** —— ZFundPilot `_qdii_nav_reference()`：QDII 净值通常 T+2 公布且受美股休市影响，用 `us_calendar.is_us_trading_day()` 找「中美同时开市」的交易日。**[已验证]** 你的 `docs/superpowers/plans/2026-09-14-latest-nav-pnl.md` 里提过「QDII 写死 T+2」这个坑，ZFundPilot 给的是**按美股日历动态推**的做法。
9. **逐日回放代替「当前份额 × 当前净值」** —— Qfunds 的核心算法：把持仓当成事件流，按日期逐日重放（mark-to-market + 交易处理 + 结算水位线），买入手续费直接计入累计亏损、赎回费计入累计亏损，非交易日录入自动顺延。**[已验证]** 你现在的 `snapshot.ts` 是每日快照式，**回放式**能自动处理「中途加减仓后费用归属」这类问题。

### C. 收益呈现

10. **TWR 与 MWR 并列** —— Portfolio Performance 给出两套完整公式；asset-allocation-management 明确实现 **TWR / MWR / Modified Dietz** 三件套。**[已验证]** 你现在对外只有 XIRR（= MWR 的一种）。**定投策略下 TWR 才能回答「这个策略本身赚不赚钱」，与「我投了多少钱」解耦**——这正是 ChickenFarm 回答「周几定投更划算」时用的口径。
11. **ROAI（含分红的总回报）** —— Ghostfolio 的核心指标定义。**[已验证]** 与你 `buildAdjustedSeries()` 的后复权序列思路接近，但 ROAI 是「相对投入资金的年化总回报」，比 IRR 更适合「我这个组合到底行不行」的直觉判断。

### D. 数据工程 / 备份 / 导入

12. **平台 YAML 适配器** —— asset-allocation-management 的「平台 YAML 适配 + 分级校验」把「支付宝 / 天天基金 / 同花顺」的对账单格式做成声明式解析器。**[已验证]** 你的 `platformImport.ts` 是硬编码 parser + 千分位还原，**换成声明式**后加一个平台就是加一个 YAML。
13. **备份的版本化 + 逐表校验 + 预检后恢复** —— ZFundPilot 的备份 ZIP 格式 v2「含净值历史与逐表校验，可预检后恢复」。**[已验证]** 你的导出是「一整包 JSON」，**没有 schema 版本、没有逐表校验、没有恢复前预检**——而你的 CLAUDE.md 正好记录过一次「14/34 处金融写入忽略返回值导致内存与磁盘分裂」的事故。备份的「写完能读回来」校验是同一条防线。
14. **导入三步确认流** —— asset-allocation-management：选择文件 → 逐行核对勾选 → 完成导入，**逐行列出类型 / 金额 / 份额 / 单价 / 手续费**。**[已验证]** 你的「平台流水对账」已有预检报告，缺的是**逐行勾选的交互层**。
15. **OCR 截图导入的纪律** —— finance_tools：「不会自动推断买入、卖出或分红交易」「人工确认并修正后才入库」「图片字节只在当前请求内存中处理，不保存原图、不保存图片 hash」。**[已验证]** 这三条边界（不自动推断交易类别 / 人工确认 / 不落原图）值得原样抄成规范。ZFundPilot 的「持仓对账模式按渠道对比已记录份额，一键生成差额调整交易」是另一个角度的同类功能。

### E. 输入 UX

16. **「填二补一」** —— ZFundPilot 的 CSV 列 `amount / shares / nav` 填任意两列自动补全第三列，且**买/卖方向自动决定用哪个公式**；CSV 支持中文表头。**[已验证]** 这正是你 `resolveTxValues()` 的输入形态，**你的表单已经做了，但 CSV 导入还值得照抄这个三列模型**。
17. **15:00 截止判断** —— finance_tools 的交易记录显式带「15:00 截止判断」。**[已验证]** 与 ZFundPilot 的 `isAfter3pm → is_t1` 是同一件事，两家独立实现都做了，说明它对 A 股基金是硬需求。

### F. 还没人做好的（留给你的差异化）

18. **中国平台的「同一基金不同渠道成本」** —— 只有 ZFundPilot（channel 字段）和 finance_tools（tt/ths 分组）做了；**其余工具都没有渠道维度**。**[已验证]** 你已经在做（平台是 `Platform` 一等公民），**这是你相对开源同类的护城河**。
19. **复权序列与主序列同源** —— 你的 `buildAdjustedSeries()` + `pairNavWithAcc()` 的「全有或全无」规则，我没在任何一个候选里看到对应实现。**[推断]** 这是你的技术优势，可以考虑贡献回 ZFundPilot（MIT 许可，接受 PR）。

---

## 差距 / 不值得

### 不值得换用的（理由）

| 工具 | 为什么出局 |
|---|---|
| **Ghostfolio** | 9773★ / AGPL-3.0 / UX 很好，但数据源里**没有中国基金**（源码目录实测：只有 Yahoo / Alpha Vantage / EODHD / FMP / CoinGecko / Google Sheets / Manual / Rapid API）。移植成本 = 自己写天天基金 provider。 |
| **Portfolio Performance** | 桌面应用（Java/Eclipse），无中国净值源。**是教材，不是工具。** |
| **rotki**（4097★） | 纯加密资产（Python + Vue + 链上交易解码）。[README 自述](https://github.com/rotki/rotki)「A privacy-focused portfolio manager, accounting, and analytics tool」——范围是 crypto，与公募基金无交集。 |
| **Firefly III**（25333★） | 双式记账 + 预算，**没有投资/股票跟踪**。仓库 issue 里三次请求（2017-09-14 「Add some basic stock portfolio management capabilities」、2019-06-17 「Investment, bonds, stock assets」、2019-10-19 「Can I manage my investment? Like stock. etf?」）**全部 closed**。[已验证，issue 追踪器] |
| **Actual Budget**（30434★） | 信封预算工具，README 与文档只讲 budgeting / envelope budgeting，**无净值、无持仓**。 |
| **Beancount + Fava**（6202★ / 2612★） | 纯文本双式记账，**没有行情抓取**（要自己写 `price` 指令或插件），没有 UI 成本口径。**[推断]** 适合「愿意用手写账本」的人，不适合「要天天记一笔」的人。 |
| **finance_tools** | 功能几乎完全对上，**但仓库无许可证**（Gitee API `license` 为空）→ 默认保留一切权利，**不能复用代码**；且 0★、2026-09 后无推送。 |
| **Qfunds** | 0★、**无许可证**、39KB、创建即最后提交（2026-01-15）——**半年没动过的一天项目**。README 写得很细很专业，但那是唯一的证据。 |
| **moneyney** | 4★，README 的 clone 命令仍是模板占位符 `your-username/moneyney`。 |
| **olixu/Fund / fishing-funds / FundMasterPro / FundCalculator** | 分别停更 5 年半、5 年、4 个月、6 年。 |
| **akshare_fund_analyzer / fund-toolkit / yysgit/Fund / fund01** | 是筛选器 / 数据包 / 网格策略 / 三端盯盘，**不是记录器**。 |

### 这个细分的真实形状 **[推断]**

- **国际侧**：工具很成熟（PP / Ghostfolio / Firefly III / Beancount 都有 4000–30000★ 级社区），但**成熟的都是「不含中国资产」**。PP 甚至专门做了印度 AMFI/MFAPI 的 provider 插件（见其 [indian.md](https://github.com/portfolio-performance/portfolio-help/blob/master/docs/en/how-to/downloading-historical-prices/indian.md)），**却没有中国的** —— 说明这个需求对上游作者来说不存在市场。
- **中国侧**：项目很多，但**普遍年轻、许可证不清、单人维护**。星数最高的是 real-time-fund（1790★，AGPL-3.0），功能最全的是 ZFundPilot（34★，MIT），设计最完整的是 asset-allocation-management（1★，MIT，8 天大）。**没有一个既成熟、又 MIT/宽松、又覆盖「多渠道 + 费率 + 分红再投资 + T+1」的。**
- **一句话**：**不存在一个「更好的 fund-tracker」让你换过去。** 有的是一个 MIT 的、把你已经踩过的坑都写成了 docstring 的参照实现（ZFundPilot），一个同构的、人气最高的国产同类（real-time-fund），和一本讲清楚了成本与收益口径的教科书（Portfolio Performance）。

---

## 独立复核（2026-11-24，调研 agent 之后由主会话补做）

调研 agent 的报告是**二手核验**（拉 API + raw 源码），主会话又独立抽验了三处最吃重的结论：

| 结论 | 复核方式 | 结果 |
|---|---|---|
| ZFundPilot 34★ / MIT / Python / pushed 2026-11-22 / created 2026-07-04 | `GET api.github.com/repos/Euzohn/ZFundPilot` | ✅ 一致 |
| real-time-fund 1790★ / AGPL-3.0 | `GET api.github.com/repos/hzm0321/real-time-fund` | ✅ 一致（pushed_at 实为 2026-11-24，比报告晚一天） |
| Portfolio Performance 4186★ / EPL-1.0 / Java | `GET api.github.com/repos/portfolio-performance/portfolio` | ✅ 一致 |
| **ZFundPilot 的买卖口径「与本项目逐字一致」** | `raw…/src/zfundpilot/models.py` 第 88–120 行 | ❌ **不成立** —— 买入口径一致，**卖出 `amount` 字段语义相反**（它存净额，本项目存毛额）。已在正文与「借鉴清单 #4」两处更正 |
| 赎回费率页 `fundf10.eastmoney.com/jjfl_{code}.html` 可用 | `curl` 实取 `jjfl_008163.html` → HTTP 200 / 46KB，含「赎回费率」「赎回费用＝赎回金额×赎回费率」 | ✅ **可用**，这是最可落地的一条 |
| FIFO 批次 + 持有天数分档的赎回费算法 | `raw…/src/zfundpilot/fetch_fund.py` 第 1190 行起 `calc_redemption_fee()` | ✅ 属实：docstring 明写 FIFO 回放、同日买入按 0 天落 <7 天惩罚档、「边界模糊时按高档计费——宁可高估费用、不静默少计成本」、净值未公布时返回 `code="pending_nav"` |

---

## 方法与注意事项

**做了什么**

1. **候选发现**：GitHub 搜索 API（`q=基金 投资记录` / `基金 组合 收益` / `基金 净值 持仓` / `investment tracker fund portfolio self-hosted` 等，按 stars 排序）+ Gitee 公开 API + 若干 Web 搜索（仅用于**找候选**）。
2. **一手核验**：对每个候选调用 `GET /repos/{owner}/{repo}`（Gitee 为 `GET /api/v5/repos/{owner}/{repo}`）取 `license.spdx_id`、`stargazers_count`、`forks_count`、`open_issues_count`、`language`、`archived`、`pushed_at`、`created_at`、`size`、`fork`；取 releases 列表确认最新版本与日期；用 `raw.githubusercontent.com` 拉 README 与关键源码；用 `raw.githubusercontent.com/portfolio-performance/portfolio-help/master/docs/en/**` 拉 Portfolio Performance 官方手册全文；用 `raw.githubusercontent.com/hzm0321/real-time-fund/main/doc/**` 拉其 localStorage 数据结构文档；用 Gitee `readme` API 拉 Gitee 项目 README。
3. **元数据抓取时间**：**2026-11-24**（当天）。星数、fork 数、issue 数、推送时间都是当时的值，会漂移。

**没有验证 / 没能验证的**

- **Firefly III 官方文档页**返回 403（`docs.firefly-iii.org` 拒绝脚本访问），其「不支持股票跟踪」这一结论我依据的是**仓库 issue 追踪器里三条 closed 请求**，而不是文档原文。**[未验证]**：Firefly III v6 之后是否已在别处加进投资功能。
- **Ghostfolio 官网**（ghostfol.io）是 Angular SPA，纯文本抓不到；其数据源清单我改用**源码目录 `apps/api/src/services/data-provider/`** 实测得出，比官网更可靠。**[未验证]**：Ghostfolio 的 Premium 层是否有中国基金 provider。
- **`itliuyan/finance_tools`** 的元数据已从 Gitee API 核到，但**仓库无 LICENSE 文件**，`license` 字段为空 —— 无法确认许可条款。
- **FVTracker 许可证标注自相矛盾**：Gitee API 返回 `MPL-2.0`，README 徽章写 `MIT`。**[未验证]** 实际是哪一份。
- **`Choi-Peng/ZFundPilot`** 的 README 与上游内容有出入（数据源优先级相反），我只读了它的 README，**没有逐文件比对它与上游的差异**。
- **ZFundPilot 的实际运行行为没有实机验证**（本次调研不安装、不运行任何外部项目），所有结论来自源码与文档。**它 README 写的「1514 个 pytest 用例」已被自己的 CHANGELOG（1768 例）超越** —— 说明 README 有滞后，读这类项目的文档时要注意版本漂移。
- **PP 的 537 open issue** 里有多少是功能请求、多少是 bug，我没有分类统计；只看数量容易误导（PP 是 2012 年开坑的老项目）。
- 我**没有**评估任何项目的安全审计状况、依赖漏洞或供应链风险。

**口径提醒**

- 「中国基金支持」一栏指的**是能否拿到中国公募基金的净值并能记录交易**，不是「能否处理人民币」。Ghostfolio / PP 都能处理 CNY 汇率，但拿不到中国基金的净值。
- 「活跃度」一栏是**最后一次推送**，不是「最后一次 release」——ZFundPilot 的 release（2026-11-20）和推送（2026-11-22）差两天，ChickenFarm 推送（2026-11-16）远新于它任何 release。
- 本文件所有 GitHub/Gitee 元数据均为 **2026-11-24** 实测，引用时请连同日期一起引用。
- 本次调研**只读**，未安装、未运行、未 fork 任何外部项目；本仓库除新增本文件外未做任何改动。
