# Stepstone — 网页端桥牌教学对局平台

Stepstone 是一个运行在局域网 / 远程的多人定约桥牌（Contract Bridge）对局平台，面向桥牌教学与练习场景。无需安装客户端，浏览器即可参与。

## 快速开始

**前置要求**：本机需安装 [Node.js](https://nodejs.org/)（建议 18 及以上 LTS 版本，安装时保持默认"Add to PATH"选项）。若命令行提示 `'npm' 不是内部或外部命令`（或 `command not found`），说明 Node 未安装或未加入 PATH——Windows 安装后需重开终端使 PATH 生效。

未安装时可任选一种方式安装（装完重开终端）：

```powershell
# Windows（任选其一）
winget install OpenJS.NodeJS.LTS        # 推荐，Win10/11 自带 winget
choco install nodejs-lts                # 需已安装 Chocolatey
scoop install nodejs-lts                # 需已安装 Scoop
```

```bash
# macOS / Linux
brew install node        # macOS（Homebrew）
sudo apt install nodejs npm    # Debian / Ubuntu
```

```bash
npm install
npm start            # 默认监听 3000 端口
```

启动后访问 `http://<主机IP>:3000` 即可打开大厅。

### macOS 与 DDS

默认自动构建 DDS 时，Intel Mac 和 Apple Silicon Mac 都需要 Xcode Command Line Tools：

```bash
xcode-select --install
```

如果安装工具链失败，或 macOS 升级后工具链失效，可再次运行该命令进行恢复。若同时提供有效的 `DDS_CALC_PATH` 与 `DDS_SOLVE_PATH`，则不会读取源码或调用编译器。克隆项目时推荐使用 `git clone --recurse-submodules <仓库地址>`。普通克隆也可以；若 `dds/` 源码尚未出现，macOS 上的安装脚本会初始化仓库固定的官方 DDS 版本，也可预先手动执行：

```bash
git submodule update --init --recursive -- dds
npm install
node server.js
```

源码压缩包不含 `.git` 元数据；使用默认自动构建时，发布包必须包含 `dds/` 源码，因为安装脚本无法从子模块记录补回缺失内容。`npm install` 会把主仓库 `native/dds-cli/` 中的 Stepstone 适配器与官方 DDS 源码一起按当前 Node 架构编译；已有且匹配的构建会直接复用。生成文件由 `dds/.gitignore` 忽略，不应提交到版本控制。

如需使用自定义 DDS 程序，可设置 `DDS_CALC_PATH` 和/或 `DDS_SOLVE_PATH`。路径可以是绝对路径，也可以是相对于 Stepstone 项目根目录的路径；若默认程序未构建，启动服务时必须继续保留相应变量。空值、无效路径或不可执行文件会直接报错，而不会静默回退。

可在真实 Apple Silicon 与 Intel Mac 上分别运行以下命令检查架构与服务；`arm64` 应对应 `darwin-arm64`，`x86_64` / Node 的 `x64` 应对应 `darwin-x64`：

```bash
uname -m
node -p "process.arch"
npm run test:dds:smoke
npm run test:server:smoke
```

若有界安装等待后报告某个 `.publish-lock`，先确认没有其他 Stepstone DDS 安装或构建进程正在运行，再只删除错误信息明确报告的那个锁目录，然后重新运行 `npm install`；不要清理整个 DDS 构建目录或其他锁。

Windows 继续使用本机已有的 `dds/Build/bin/x64/Release/*.exe`，也可以通过上述两个环境变量指定自行构建的程序；当前 `postinstall` 不负责为全新 Windows 克隆生成 DDS。`.exe`、`.lib`、`.obj` 等本机构建产物不进入版本控制。

## 三种对局模式

### 经典模式

标准四人定约桥牌。完整流程：大厅 → 叫牌 → 出牌 → 结算。

- 叫牌支持叫品、加倍（X）、再加倍（XX），规则与正式桥牌一致；
- 庄家、明手、首攻人均按标准规则确定，支持旁观。

### 大招模式

带角色技能的变化玩法。每位玩家在开局选择一名角色，技能会在发牌、叫牌结束、出牌、赢墩 / 输墩等时机触发，手牌也会被技能改变。

- 技能有冷却（以"副"为单位），牌堆中存在点数为小数的特殊牌张；
- 出牌比大小只看点数，无将色（PASS 牌最小）。

可选角色：刘备、诸葛亮、曹操、张辽、孙权、吕蒙、董卓、张绣、刘协、何太后（详见游戏内说明）。

### 做题模式（推荐单人练习使用）

单人定约练习：你执南家（含明手北家）完成定约，东西两家由 AI 防守。

基本流程：

1. 房主在选题区挑选一道题目（如 A1 ~ A9）；
2. 按题目给定定约打牌，目标是在时限内拿到足够墩数；
3. 一道题可包含多个**测试点**：通过当前测试点后自动进入下一个，防守方手牌或叫牌可能变化；
4. 中途判负（WA）后可以**只重试当前测试点**，不必从头再来。

判题标准：

| 结果 | 条件 |
|------|------|
| AC（通过） | 拿够所需墩数，且用时、记忆消耗均未超限 |
| WA（答错） | 防守方先拿到足够击宕的墩数，或庄家放弃 |
| TLE（超时） | 成功完成但用时超限 |
| MLE（记忆超限） | 成功完成但查看记忆次数超限 |

- 时间限制：每测试点 400 秒（多测试点按数量等比放宽；计时器变黄 / 变红的阈值同步放宽）；
- 记忆消耗：查看已完成的墩（每墩计一次）+ 记牌器（每墩每类型计一次），上限 3 次。

其他能力：

- **旁观**：其他人可凭房间号进入房间，全程只读观看，可查看四家手牌，不影响做题者的计时与记忆次数；
- 每道题附有主题诗句与背景故事，全部为原创设计。

## 房间与联机

- 所有模式共用 3 位房间号：房主创建房间后把号码告诉同伴即可；
- 断线重连：中途刷新页面或掉线后重新加入同一房间可恢复对局状态；
- 旁观者在任何阶段都可以加入（做题模式中途加入会自动同步当前局面）。

## 目录结构一览

```
server.js                     # Express + Socket.IO 服务端与三模式游戏引擎
public/                       # 前端页面与静态资源
  js/lobby.js                 # 大厅（创建/加入房间）
  js/game.js                  # 经典模式前端
  js/ult-game.js              # 大招模式前端
  js/problem-game.js          # 做题模式前端
  js/bridge-rules.js          # 叫牌规则（与前端共用）
  problems/                    # 做题模式题目（JSON）
dds/                          # DDS 双明手求解引擎（calc / solve）
dds-wrapper.js                # Node 侧 DDS 调用封装
```

## 常见问题

**打不开页面 / 其他人连不上？**
确认服务端已启动、双方在同一局域网（或已建立远程通道），并使用主机的实际 IP 而非 `localhost` 访问。

**做题模式里防守方出牌"不合理"？**
防守 AI 按预设剧本行动，剧本结束后按双明手最优解防守；部分题目有特殊的防守触发机制（如换牌、强制跟牌），属于题目设计的一部分。

**想自己出题？**
`public/problems/` 下按现有题目的 JSON 格式新增文件即可，服务端会自动识别；高级用法（剧本 DSL）可参考同目录下的 `.spdsl` 文件与项目内的 `spdsl-compile.js`。
