# predict.fun 足球赛前做市机器人

赛前（开赛前 24h–2h）在 predict.fun 的足球二元盘口上做**赔率联动的双边挂买单**：

1. 用 The Odds API 取 Pinnacle / Betfair Exchange / Matchbook 的 1X2 赔率，**每家分别去水**后按权重合并成合理概率；
2. 可选用 Polymarket 同一问题的实际盘口做交叉校验（偏差过大则暂停，否则小权重融合）；
3. 在合理价两侧各留 1–2 美分，同时挂 **买 YES** 和 **买 NO** 两个限价单（只用 U，成交后才产生仓位）；
4. 两边都成交后把等量 YES+NO **合并（merge）换回 U**，赚取 `1 − (买YES价 + 买NO价)` 的价差；
5. 成交后先管库存：重的一边降价/暂停并挂卖单，轻的一边略微收紧，但**永远不会穿过合理价追单**；
6. 限额：总占用资金、同时做的场次、单场未配对成本（含挂单）、单笔成本、当日停机线；
7. 到退出时间撤单、合并配对、按模式处理剩余单边仓位；断线超时撤单，且每张单都带签名有效期（TTL），程序挂掉后订单自动过期；
8. 逐笔记录成交、合并、盈亏，以及成交后 10s / 60s 的价格走向（markout）。

默认是 **dryRun（纸面模拟）**：用真实赔率和真实 predict.fun 盘口，但不发单，按盘口穿越规则模拟成交。先跑 20–30 场看报告，再改 `dryRun: false`。

---

## 1. 环境

- Node.js ≥ 20.10（推荐 22）
- 三把钥匙：
  - `PREDICT_API_KEY`：predict.fun API key（Discord 开 ticket 申请；testnet 不需要）
  - `PREDICT_PRIVATE_KEY`：签单私钥。用网页版账户（Predict Account / 智能钱包）时，填在 https://predict.fun/account/settings 导出的 **Privy 钱包私钥**，并同时填 `PREDICT_ACCOUNT`（账户/充值地址）。用普通 EOA 钱包时只填私钥。
  - `ODDS_API_KEY`：https://the-odds-api.com
- 合并、授权、链上撤单会发链上交易：签名钱包里要有少量 **BNB** 作 gas（Predict Account 模式下是 Privy 钱包）。

```bash
npm install
npm run build
cp .env.example .env          # 填 key
cp config.example.json config.json
```

## 2. 使用流程

```bash
node dist/index.js sports                                   # 查 The Odds API 的足球联赛 key（免费，不耗 credits）
node dist/index.js scan --category <predict.fun 分类 slug> --sport soccer_epl
node dist/index.js scan --ids 123,124 --sport soccer_epl,soccer_uefa_champs_league
node dist/index.js scan --search "arsenal" --max-pages 10 --sport soccer_epl
```

`scan` 会列出 predict.fun 盘口（标题、问题、结算规则摘要、YES/NO outcome、negRisk 等），按队名匹配赔率事件，给出
主/平/客三个合理概率、识别出的 outcome，并打印可直接粘贴到 `config.json → markets` 的条目。

**粘贴前必须人工确认：**

- `outcome`（home / draw / away）与盘口问题一致。“主胜 NO”包括平局和客胜，不等于“客胜 YES”。
- 结算范围：90 分钟还是含加时/点球、延期/腰斩如何结算。只拿同一结算范围的赔率来定价（The Odds API 的 h2h 是常规时间 1X2）。
- 同一天同名对阵（杯赛/联赛）会提示 `WARNING`，此时手动填 `oddsEventId` 或 `kickoff`。

Polymarket 校验（可选）：

```bash
node dist/index.js poly-find "arsenal chelsea"              # 找事件 slug 和其中的市场
```

把 slug 填进该盘口的 `polySlug`；多市场事件下程序按队名/Draw 自动选市场，也可以用 `polyMarketQuestion` 指定。

然后：

```bash
node dist/index.js fair        # 看每家赔率去水后的概率、权重、是否过期、Poly 盘口，顺带验证 key
node dist/index.js run         # dryRun=true：纸面模拟
node dist/index.js report      # 盈亏 / 成交 / markout 汇总
```

正式运行：`config.json` 里 `dryRun: false`，然后

```bash
node dist/index.js approve     # 一次性链上授权（交易 + 合并）
node dist/index.js run
node dist/index.js status      # 余额 / 挂单 / 仓位
node dist/index.js cancel-all [--market 123] [--onchain]
node dist/index.js merge --market 123 [--pairs 20]
```

`Ctrl+C` 会先撤掉所有挂单再退出（`predict.cancelOnExit`）。

## 3. 配置说明（config.json）

| 组 | 字段 | 默认 | 含义 |
|---|---|---|---|
| 顶层 | `dryRun` | true | 纸面模拟；false 才真正发单、合并 |
| | `network` | mainnet | mainnet / testnet（testnet 自动用 api-testnet 域名） |
| | `loopIntervalSec` | 5 | 主循环间隔 |
| odds | `bookmakers` / `weights` | pinnacle 0.5, betfair_ex_eu 0.35, matchbook 0.15 | 数据源及合并权重 |
| | `refreshSec` | 120 | 赔率刷新间隔。每个联赛每次 1 credit（≤10 家）。120s 刷新 ≈ 720 credits/联赛/天，免费 500/月只够测试 |
| | `maxSourceAgeSec` | 900 | 某家 `last_update` 超过此时长则忽略 |
| | `maxFairAgeSec` | 420 | 合理价超过此时长没更新 → 撤单暂停 |
| | `devig` | multiplicative | 去水方法：multiplicative / power |
| | `maxExchangeSpread` | 0.05 | 交易所 back/lay 隐含概率差超过此值 → 该家权重减半（深度不足） |
| | `maxSourceDispersion` | 0.06 | 各家对该结果的概率极差超过此值 → 暂停该盘 |
| | `minSources` | 2 | 少于此数据源 → 暂停 |
| poly | `enabled` / `weight` / `maxDeviation` | true / 0.25 / 0.05 | Poly 中间价与赔率合理价偏差超过 maxDeviation 则暂停；否则按 weight 融合 |
| | `minDepthUsd` / `depthWindow` | 50 / 0.02 | 中间价 ±2 美分内两边各至少 50U 才采信 Poly |
| quote | `halfSpread` | 0.015 | 买单距合理价的基础距离（两边各 1.5 美分 → 一对毛价差 ≈ 3 美分） |
| | `minEdge` | 0.005 | 倾斜后最小距离，买单永远不会比 `合理价 − minEdge` 更高 |
| | `skewMax` | 0.02 | 库存倾斜上限：重的一边最多再远 2 美分，轻的一边最多近 2 美分（按未配对成本占上限的比例线性生效） |
| | `orderCostUsd` / `minOrderShares` | 15 / 5 | 每笔新增单边成本目标 & 最低份数 |
| | `orderTtlSec` | 900 | 订单签名有效期；临近到期自动换单。程序挂掉订单也会自行过期 |
| | `requoteTicks` / `requoteSizeRatio` | 1 / 0.3 | 目标价变动 ≥1 tick 或剩余量偏差 >30% 才撤单重挂（保留排队位置） |
| | `sellInventory` | true | 重的一边以 `合理价 + halfSpread` 挂卖单（maker） |
| | `postOnly` | true | 不穿越对手盘，避免成为吃单 |
| | `tickSize` | 0.01 | 报价精度（predict.fun 签名价格最多 3 位有效数字） |
| risk | `maxCapitalUsd` | 300 | 挂单占用 + 库存成本 上限 |
| | `maxMarkets` | 3 | 同时做的场次（按开赛时间先后取） |
| | `maxUnpairedCostPerMarketUsd` | 30 | 单场未配对仓位成本上限，**把重的一边的未成交买单也算进去** |
| | `maxOrderCostUsd` | 20 | 单笔成本硬上限 |
| | `dailyStopLossUsd` | 10 | 当日已实现 + 剩余仓位按可退出价计亏 ≤ −10U → 撤单停机（仓位保留，次日 UTC 重置） |
| schedule | `quoteStartHoursBeforeKickoff` / `quoteEndHoursBeforeKickoff` | 24 / 2 | 做市时段 |
| | `exitMode` | merge_and_sell | 退出时合并配对；单边仓位 `merge_and_sell`：若最优买价在 `合理价 − exitMaxSlippage` 以内就吃掉，否则在该价位挂卖；`merge_and_hold`：只合并，单边持有 |
| merge | `minShares` / `cooldownSec` | 10 / 120 | 配对 ≥10 份才发合并交易（省 gas） |
| markets[] | `predictMarketId`, `outcome`, `oddsSport`, `oddsEventId`, `teams`, `kickoff`, `polySlug`, `polyMarketQuestion`, `disabled` | | 见 scan 输出 |
| aliases | | | 队名别名（predict.fun 与赔率源写法不同时补充，内置了常见英超/西甲/意甲/德甲缩写） |

## 4. 运行逻辑细节

**合理价**：每家先把 1X2 赔率去水（交易所有 back/lay 时取两者隐含概率中点），再按权重加权平均并归一化；过期、缺平局、赔率 ≤1 的数据源直接剔除。各家分歧过大、来源不足、数据过旧、Poly 偏差过大，都会让该盘 `paused` 并撤单。

**报价**：`买YES = floor(fairYES − edgeYES)`，`买NO = floor(fairNO − edgeNO)`，tick 取整；post-only 不穿越对手卖价；超出 `[minPrice, maxPrice]` 不报。predict.fun 的盘口以 YES 价格表示：买 NO 用 NO 的 token 下单，在盘口里显示为 `1 − 价格` 的 YES 卖单，程序已做换算。

**库存**：重的一边（YES 或 NO 多出的部分）按“未配对成本 / 上限”的比例加大 edge，达到上限就不再加仓；轻的一边 edge 收紧但最多到 `minEdge`；同时把多出的部分以 `合理价 + halfSpread` 挂卖。是否“补另一边”完全由最新合理价决定——买单永远在合理价之下，不为了凑对追价。

**成交/盈亏**：按平均成本核算；合并一对记 `1 − avgYES − avgNO`；卖出记 `卖价 − 平均成本`。真实模式下用 `GET /v1/orders` 的 `amountFilled` 变化识别成交，钱包 WebSocket 事件只用来触发立即同步；每分钟核对链上仓位，不一致时以链上为准。dryRun 下订单在盘口穿越到挂单价时视为全部成交。

**markout**：每笔成交记录成交时、10s、60s 后的 predict.fun 中间价和合理价，`report` 输出均值（正数 = 成交后价格朝有利方向走）。先看扣掉退出成本后的总盈亏和 markout 是否持续为负。

**数据文件**：`data/journal.jsonl`（订单、撤单、成交、合并、模式切换、停机、markout、PnL 快照）、`data/state.json`（库存、跟踪中的订单、当日盈亏；重启后自动恢复并与交易所对账）。

## 5. 已知前提 / 需要在 testnet 核对的点

程序按 predict.fun 公开 SDK 与文档实现，以下字段无法离线验证，首次真实运行前请先在 testnet（`network: "testnet"`，无需 API key）或极小资金核对：

- `GET /v1/orders` 的 `amount` / `amountFilled` 以比例折算成份额；`first` / `after` 分页参数；`POST /v1/orders/remove` 的 `{ data: { ids } }` 请求体。
- 盘口最低下单量和 tick：由 `quote.minOrderShares` / `quote.tickSize` 控制，若被拒单请调大。
- 盘口 outcome 命名：程序把名为 `Yes` 的 outcome 当 YES，否则取 `indexSet = 1` 的那个；`scan` 会打印 outcomes，请核对。
- negRisk（多结果）盘口的合并走 NegRiskAdapter，`approve` 会一并授权。
- 积分奖励不计入估值；手续费按盘口 `feeRateBps` 写进签名订单。
- Polymarket `/public-search` 若不可用，`poly-find` 会退回到扫描活跃事件列表按标题匹配。
- 机器人把配置里每个盘口上的**所有**挂单（包括手动挂的）视为自己的目标状态：不符合当前报价的会被撤掉，请不要在同一盘口手动挂单。

## 6. 安全

- 单独准备一个只放测试资金的钱包；`.env`、`config.json`、`data/` 已在 `.gitignore`。
- 私钥只用于本地签名与链上交易，不会发到 predict.fun 以外的任何服务；The Odds API 与 Polymarket 请求只带各自的 key / 公开参数。

## 7. 开发

```bash
npm run typecheck
npm test          # 去水/合并、报价与倾斜、库存核算、队名匹配 的单元测试
```
