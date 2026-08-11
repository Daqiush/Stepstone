# Stepstone — 网页端桥牌教学程序

## 项目概述

局域网 / 远程多人合定约桥牌（Contract Bridge）对局平台，支持经典模式（标准定约桥牌）、大招模式（角色技能·变化手牌）与做题模式（单人定约练习·AI防守·判题系统）。

## 技术栈

- **后端**：Node.js + Express + Socket.IO 4.7.4
- **前端**：Vanilla JS + HTML5 + CSS3（无框架）
- **DDS**：`dds/Build/bin/x64/Release/dds_calc.exe`（全手）+ `dds_solve.exe`（逐局面），`dds-wrapper.js` 包装

## 启动

```bash
npm install && node server.js   # 默认 3000 端口
```

## 关键文件

```
server.js          # Express + Socket.IO + 完整游戏引擎（三模式）
dds-wrapper.js     # calcDDTable(hands) + solveBoard({trump,trickLeader,trickPlayed,hands})
skills/characters.json          # 大招模式 10 个角色 DSL
public/js/bridge-rules.js       # BR 命名空间，叫牌规则
public/js/{lobby,game,ult-game,problem-game}.js
public/css/{main,game,ult,problem}.css
public/problems/*.{json,spdsl}  # 做题题目 + SPDSL 源文件
public/problems/spdsl-compile.js
```

## 架构要点

### 状态机

- **经典**：`LOBBY → BIDDING → PLAYING → SCORING`
- **大招**：`LOBBY → ULT_CHAR_SELECT → ULT_BID_PREP → BIDDING → ULT_BID_END → PLAYING`
- **做题**：`LOBBY → PROB_SELECT → PROB_PLAYING → PROB_SCORING`
- `room.mode = 'classic' | 'ult' | 'problem'`，`ownerStartGame` 根据 mode 路由

### DDS

- **全手**：`calcDDTable(hands)` → `dds_calc.exe`；bitmask：`1 << rank`（rank 2=0x0004…A=0x4000）
- **逐局面**：`solveBoard(...)` 返回 `{ score, cards }`；`score` = **当前出牌方**可保证的剩余墩数（含当前这一墩），由 `trickLeader + trickLen mod 4` 确定出牌方
- **明手不能声称**：server 侧检查 `seat === room.dummy`

### 叫牌规则（重要）

- **Double (X)**：只能对对方定约加倍，且定约未被加倍
- **Redouble (XX)**：只能在己方定约被对方 X 后再加倍（`!cc.redoubled`）
- 校验在 `server.js:validateBid` 和 `bridge-rules.js:getValidBids` **两处**需同步维护

## 大招模式引擎

### 牌张格式

- 手牌：`{ suit, rank: integer(2~14) }`，`dealUltIntHands()` 发标准 52 张
- 技能牌堆：`{ suit, rank: float }`，rank ≡ `14 - χ²(4)`，由 `generateUltDeck()` 生成，6 位小数
- PASS 牌：`{ type: 'PASS' }`
- `clampRank(r)` = `parseFloat(Math.min(14, Math.max(2, r)).toFixed(6))`
- `ultTrickWinner(trick)` — 无将色，rank-only，PASS=-∞，同 rank 先出者赢

### 技能系统

- CD：`room.skillCooldowns[seat][skillId] = boardsLeft`，每副牌开始 `tickCooldowns` 递减
- **技能队列**（叫牌准备/结束阶段）：`startSkillPhase` → `emitSkillTurnOrFinish` → `advanceSkillQueue`；队列从发牌人顺时针，仅含可用技能座位
- **出牌技能**：`getAvailableSkills(room, seat, 'play_time')`（雄乱/克己/酒池）
- **被动技能**：`triggerUltSkills(room, trigger, ctx, seats)` 墩结束后触发（奸雄/戚乱）

### 出牌流程

- `advanceUltPlayer(room, startSeat)` — 空手或被强制的座位自动出 PASS，找第一个需手动出牌的座位广播 `bcastUltPlay`
- `completeRemainingUltTricks(room)` — 全员空手时快速结算剩余墩

### 角色表

| 角色 | 势力 | 触发 | 技能 |
|------|------|------|------|
| 刘备 | 蜀汉 | bid_end | 仁德：送至多2张给同伴，同伴各+1点 |
| 诸葛亮 | 蜀汉 | bid_start | 尽瘁：窥牌堆顶7张选放回；智哲：复制手中1张 |
| 曹操 | 魏国 | on_trick_lose | 奸雄CD:2：输墩后与赢墩者互换所打的牌 |
| 张辽 | 魏国 | bid_end | 突袭：从两名对手各随机夺1张 |
| 孙权 | 吴国 | bid_start | 制衡：弃至多4张摸等量牌 |
| 吕蒙 | 吴国 | play_time | 克己CD:1：有牌时可主动打出PASS保留手牌 |
| 董卓 | 群雄 | play_time | 酒池CD:1：打♠时可选择+π点数（上限A） |
| 张绣 | 群雄 | play_time | 雄乱CD:2：引出前令一名有牌角色本墩强制PASS |
| 刘协 | 汉朝 | bid_end | 密诏CD:2：将全手牌交给同伴 |
| 何太后 | 汉朝 | on_trick_win_set | 戚乱CD:1：击宕敌方定约的那墩摸3张牌 |

## 做题模式引擎

### 题目文件格式（`public/problems/*.json`）

```json
{
  "id": "A1", "name": "...", "flavorText": "...",
  "contract": { "level": 6, "suit": "S", "declarer": "S", "doubled": false, "redoubled": false },
  "vulnerability": "NONE", "tricksNeeded": 12,
  "hands": { "N": [{suit, rank},...], "S": [...] },
  "ewHands": { "E": [...], "W": [...] },
  "openingLeader": "W",
  "testCases": [
    { "script": [{"seat":"W","card":{"suit":"C","rank":13}}, ...] },
    { "ewHands": {...}, "branchTrick": 9, "script": [...] }
  ]
}
```

- `testCases[i].ewHands`（可选）：本测试点专属 EW 手牌；省略则继承顶级
- `testCases[i].branchTrick`（可选）：从第几墩（0-based）开始；省略或 0 = 从头
- `testCases[i].deviationBranches`（可选）：`[{ at: scriptPtr, script: [...] }]`；NS 在 at 处偏离时切换剧本而非设 scriptAbandoned

### SPDSL 编译器（`spdsl-compile.js`）

```bash
node spdsl-compile.js A1.spdsl                       # 输出 ewHands+testCases 片段
node spdsl-compile.js A1.spdsl A1_template.json > A1.json  # 合并模板
```

**语法**：

```
DIST <name> { E: <牌列表>  W: <牌列表> }
DIST <name> extends <parent> { E.<花色>: <点数列表> }   # 局部替换

SCRIPT <name> { <N/E/S/W>: <牌>  ... }
# 牌面：SA HQ DT C2；动态选择器：S_MAX S_MIN S_WIN；NS专用：ANY S_ANY H_LT_10

TESTCASES {
  TC [标签] dist=<name> [from=<墩>] script=<name>
  TC [标签] dist=<name> script=<name> {
    BRANCH at=<scriptPtr> script=<备用剧本>   # 可多个
  }
}
```

### 防守逻辑（`probAutoDefense`）

**`scriptPtr`** 跨 NS+EW 推进：
- NS 出牌：匹配则 `scriptPtr++`；不匹配且无 deviationBranch → `scriptAbandoned=true`
- EW 出牌：`!scriptAbandoned && script[ptr].seat===seat` → 按脚本出牌并 `scriptPtr++`

**动态选择器**：
- `MAX`/`MIN`：EW取本家该花色最大/最小；NS仅验花色
- `WIN`：EW取能赢当前墩的最小牌；NS验证同上
- `ANY`：NS专用，接受任意牌（`{suit:null,rank:'ANY'}` 不验证；`{suit:'S',rank:'ANY'}` 验花色）
- `LT_10`：NS专用，接受该花色 rank < 10 的牌

**EW 出牌优先级**：① midTrickTriggers → ② 脚本（含换牌）→ ③ 兑现击宕优先 → ④ DDS → ⑤ 启发式回退

**兑现击宕原则**：若在当前真实手牌下，EW 能通过合力兑现若干墩直接达到 `14 - tricksNeeded` 的宕约标准，则防守方必须优先这么做；但 `midTrickTriggers` 或脚本若正指挥防家进行其他行为，则剧本优先。有将定约下，将牌大牌也可作为兑现来源；DDS 等分候选牌按"从该候选牌开始的安全兑现长度"排序，允许非连续大牌在打落 NS 短套拦张后继续兑现，同时避免把对方可将吃的旁门花色误当成兑现。

**换牌原则**：仅脚本可触发换牌（脚本牌在同伴手中时自动转移），DDS 对当前手牌直接求解不修改分布。

**midTrickTrigger 结构**（题目顶级 `midTrickTriggers` 数组）：
```json
{
  "id": "唯一id", "triggerSeat": "E|W", "repeatable": true,
  "condition": {
    "ledBy": "N", "ledSuit": "H", "ledRankLt": 10,
    "ruffedBy": { "seat":"S", "ruffSuit":"S", "excludeRanks":[14,12] },
    "playedNotCard": { "seat":"S", "suit":"H", "rank":13 },
    "playedRankLt":  { "seat":"S", "suit":"H", "rank":10 },
    "completedSuitTricksLt": {"suit":"S","count":3},
    "completedSuitTricksGt": {"suit":"S","count":3}
  },
  "swap": { "from":{"seat":"E","suit":"H"}, "to":{"seat":"W","suit":"H"} },
  "forcedPlay": {"suit":"H","rank":"MIN"}
}
```

**重要时序**：
- EW 赢墩后 `probFinishTrick` **不**自动推进，等前端 `probTrickCollect` ack 后再 `setTimeout(probAutoDefense, 300)`
- EW 出牌后若下家为 NS，**立即** emit `probPlayUpdate`（不启 350ms 定时器），防止定时器竞态串墩

### 多测试点流程

NS 过点 → 服务端发 `probTCPassed` → 前端确认 `probTCAdvance` → `startNextTestCase`（回滚至 branchTrick，重建双方手牌）→ 发 `probTCStart`

WA 后点击重试只重启当前测试点：`probRetry` → `restartCurrentTestCase` → 按当前 `testCaseIdx` 回滚至该测试点的 `branchTrick`，重建当前测试点双方手牌并重置本次尝试的计时/记忆次数，不从整道题第 1 测试点重开。

### 房间与旁观

- 做题模式使用普通 3 位房间号；房主创建后直接进入 `problem.html`，页面选题区与牌桌顶栏均显示/可复制房间号。
- 旁观者通过大厅输入房间号加入；若在选题阶段加入，等待房主选题并随 `probStart` 进入只读牌桌；若中途加入，服务端通过 `buildProblemSnapshot` 发送当前完整状态并恢复到牌桌。旁观者可直接查看 N/E/S/W 四手牌；房主仍保持做题视角，只显示 NS 明牌与 EW 牌背。
- 服务端通过 `probSpectatorHands` 私发 EW 手牌给非房主 socket，避免 `probStart` 广播把防家明牌发给房主。
- 旁观者只能观看，不可出牌、收牌、选题、放弃、重试或返回选题；`probViewTrick` / `probOpenCounter` 仅房主可触发，避免旁观者消耗房主记忆次数。
- 房主收牌后服务端广播 `probTrickCollected`，旁观端同步清除收牌遮罩并更新已完成墩。

### 判题

| 结果 | 条件 |
|------|------|
| **AC** | `nsTricks >= tricksNeeded` 且 `elapsed ≤ 400s` 且 `memoryUses ≤ 3` |
| **WA** | EW 先达到 `14-tricksNeeded` 墩，或庄家放弃 |
| **TLE** | 成功但用时 > 400s |
| **MLE** | 成功但记忆消耗 > 3 次 |

记忆消耗：`probViewTrick`（同一墩只计一次）+ `probOpenCounter`（同一墩同类型只计一次）

## 同步更新策略

三模式共用 `sockRoom/sockSeat/rooms` 和 `roomState()`；前端各自独立文件。改通用房间字段改 `roomState()` 一处；改重连逻辑确认 `sendReconnectState` 两模式均已覆盖。
