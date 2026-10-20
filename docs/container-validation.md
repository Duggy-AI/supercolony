# 容器验证：colony worker on Linux

## 2026-10-19：npm 首次公开发布

- `supercolony@0.1.0` 已发布至 npm 官方仓库，`latest` 指向 `0.1.0`。包页面：https://www.npmjs.com/package/supercolony 。
- 包含等价命令 `supercolony`、`colony`，均指向 `dist/cli.mjs`；下载界面用词为 `Local LLM`。
- 从公开仓库实际下载 tarball，与本地验收包的 SHA-512 完整性一致。共 63 个文件、158898 字节压缩体积，仅含混淆后的 `dist/`、`package.json` 和 README，无源码目录或 source map。验证记录位于 `.local/npm-published-verification.json`、`.local/npm-published-pack.json`。
- 首次查询短暂读到了阶段占位版本的旧缓存；公开元数据及全新 npm 缓存均已确认正式版本和 latest，随后实际下载成功。没有重复发布或覆盖版本。

## 2026-10-19：本地模型分步准备与下载进度

- 下载界面统一显示 `Local LLM`，包含进度条、百分比、已下载/总 MB 和平均速度；下载、校验、加载分别显示步骤。显式 `model setup` 仅展示下载和校验两步。人工可读状态不再展示具体模型名、缓存文件名或技术字段；`model status --json` 保留完整元数据。
- CLI 与 TUI 共用进度格式。CLI TTY 原地刷新并结束动画，重定向时仅向 stderr 写纯文本里程碑；TUI 显示独立准备面板，支持 40×20 终端，并在成功或失败后清理进度状态。复用已校验缓存时不再访问网络；切换备用源时重置字节进度和速度，下载 100% 不会提前标记整个准备过程完成。
- 混淆产物 Windows 全量回归 314/314 通过（含真实模型、原生 PTY）；最后补充条宽调整及备用源重置测试后，相关测试 57/57 通过，无跳过。Linux 纯 Node 22 非 root 容器运行混淆后的进度/下载测试 17/17 通过；专用容器已清理。没有为本轮 UI 验收重新下载正式模型，HTTP 场景使用本地测试服务和校验夹具。
- 发布白名单检查通过，新包为 63 个文件、约 155 KiB，仅含 `dist/` 与 npm 元数据。日志：`.local/model-progress-dist-tests.log`、`.local/model-progress-final-tests.log`、`.local/model-progress-linux-tests.log`。

## 2026-10-19：混淆后的 npm 分发

- 在 esbuild 压缩后，本地使用固定版本 `javascript-obfuscator@5.9.0` 混淆全部 ESM 和 CommonJS 运行模块。启用内部标识符重命名及字符串数组，保留导入、导出和对象属性；关闭控制流平坦化、死代码注入、自保护和反调试。混淆器仅为开发依赖，不调用在线混淆服务。
- `npm pack` / `npm publish` 自动生成混淆产物，不生成 source map。固定种子，重复构建的全部运行模块 SHA-256 一致。实际 tarball 仍为 62 个文件，约 153 KiB；发布白名单检查通过。
- 新增 `npm run test:dist`：在独立临时目录把构建产物作为被测模块运行现有测试，结束后清理；平台 CI 已改为验证构建产物。源码测试 `npm test` 保留。
- Windows 混淆代码完整回归 **308/308** 通过，无跳过，包含真实 Qwen 模型、钱包、付款、恢复、Worker、原生 PTY 及终端注入测试。实际 tarball 独立安装成功，安装包的 ConPTY 仪表盘可打开并正常退出。
- Linux Node 22 非 root 容器从相同 tarball 安装成功；混淆代码回归 **261 通过、0 失败、1 跳过**（真实模型未复制）。本轮 Linux 未运行依赖开发包的 local-wallet、TUI 组件及 PTY 三个测试文件；同版本 CPU 预编译后端加载通过。专用容器已清理。
- Windows 冷启动抽测交替运行两种安装包各 5 次，`--version` 中位数为压缩版 548 ms、混淆版 531 ms；这是本机小样本，说明本轮没有观察到明显启动退化，不代表其他硬件或业务负载性能。
- 本轮未在 macOS 实机执行，未向 npm 发布，未真实扣款。日志位于 `.local/obfuscated-*.log`，启动样本在 `.local/obfuscated-startup.json`。

## 2026-10-19：仅构建产物的 npm 分发

- esbuild 将运行模块压缩到 `dist/`，保留 ESM/CommonJS 扩展名与相对路径；TUI 子进程入口、动态导入和 Worker 远程脚本都包含在产物中。构建不会捆绑原生依赖，也不生成 source map。
- `npm pack` / `npm publish` 自动运行构建。`npm run check:package` 验证发布白名单、必要入口、CLI 帮助/版本、本地钱包列表、模型缓存状态及远程 CommonJS 配置查询脚本；CI 平台矩阵已加入此检查。
- 实际 tarball 共 62 个文件，只有 `dist/`、`package.json`、README，约 93 KiB（未计依赖和首次下载的模型）。没有 `src/`、测试、内部文档、研发脚本或模型权重。
- Windows 在独立 prefix 从 tarball 安装成功；命令 shim、CLI 帮助/版本、空钱包列表、CPU 原生后端加载通过。安装包的真实 ConPTY 仪表盘能打开并正常退出，使用临时 home 和本地模拟 API。
- Linux Node 22 独立容器以 uid 10001 从相同 tarball 安装成功；命令、空钱包列表和 CPU 预编译后端加载通过。初次后端检查用了 `--input-type=module`，参数被内部 fork 继承，导致检测失败并误触发源码构建；改用正常 Node 启动参数后加载预编译后端通过，不需要改程序或安装编译器。专用容器已删除。
- macOS 本轮未实机运行；已加入现有 macOS Intel/ARM CI。没有向 npm 发布，没有真实付款。

## 2026-10-19：完全删除预算参数

- `--budget`、`assertBudgetOption` 及其透传和界面字段已删除；不提供兼容 alias 或迁移。任务创建与续作只展示官方报价，确认实际价格、最高扣款和网络费上限后付款。
- 本次删除预算时保留了 0.5% 输入滑点；随后已改为自动滑点（Ethereum 0.75%–5%，Robinhood 0.75%，见 `uniswap-path-validation.md`）。最高输入和网络费上限继续保留，授权仅覆盖本次最高兑换金额。
- 下文 2026-10-18“取消预算必填”及更早记录描述的是当时行为；其中提到的显式 `--budget` 现已删除。
- 验证：Windows 全量 304/304 通过（含真实本地模型及原生终端）；Linux Node 22 容器以非 root 用户执行支付、换币、签名与恢复相关 70/70 通过。Linux 首次复用旧镜像缺少当前依赖，按当前 lockfile 安装后复测通过。没有真实扣款；临时容器已清理。日志位于 `.research/remove-budget/`。

## 2026-10-19：Linux 补充验收

- Docker 引擎恢复后，使用独立临时容器 `colony-worker-audit-20261019`，以 uid 10001 执行安装和测试。无宿主目录挂载、无端口、无 Docker socket、非 privileged；复制测试文件时仅给准备阶段的 root CHOWN 能力。
- 真实安装并更新官方 `worker-v0.1.2-5921f9e9573c`。两次归档 SHA-256 均为 `21a551f810558cff7689d2acb0319413742135774543a40137960370ccf8841b`。安装目录为 `/home/colony/.super-colony/worker/prefix`。
- 15 项真实命令检查符合预期：工具添加、MCP 探测、列表、移除成功；未配对的身份/技能/RPC、未安装服务的状态/安装/启停/重启均返回明确失败。普通容器缺少 journalctl，日志查询也正确透传失败，不能作为正常服务日志读取成功。
- Linux 全量 287 项：286 通过、1 项可选真实模型测试跳过。包括原生 PTY 交互、Worker 交接、SSH identity 持久化、注册 pending 防重发及退出码回归。首次运行因测试准备遗漏 examples 夹具失败，补齐目录后全量重跑通过。
- 容器重启后安装文件和状态保留，确认没有安装后台服务。已导出本轮日志并删除专用测试容器，其他容器和原有测试 volume 未改动。
- 修正 `container/scripts/validate.sh` 中两处过时断言：未安装服务时 `worker status` 现在应退出 1，完整 JSON 报告继续保留。
- 本轮未配置 Claude/Codex 登录、NFT/钱包或 systemd 用户会话，未做真实配对、链上注册、后台接单或解除绑定。这些限制与命令/界面回归结果分开记录。

本地日志：`.research/worker-audit/linux-deploy.json`、`linux-update.json`、`linux-smoke-results.json`、`linux-tests-final.log`、`linux-restart.json`。

## 2026-10-19：Workers 菜单逐项复核

- Windows 使用独立 Colony home、安装 prefix 和 `IDENTITYMD_HOME`，真实下载并校验安装官方 `worker-v0.1.2-5921f9e9573c`，随后通过 `worker update` 更新同一 prefix；未操作用户的 Worker 配置。
- 真实验证 tools 的添加、MCP 探测、列表和移除，以及 logs、status、doctor 查询。未配对时 whoami、skills、rpc 明确返回未配置/未配对，属于前置条件限制。
- 修复非零退出的诊断报告在 TUI 被当成异常 JSON 展示的问题；保留可读 stdout/stderr 并显示失败退出码。`worker status` 正确透传官方服务退出码，TUI 仍可读取其完整报告。
- 修复自定义 SSH identity 路径在部署后未持久化的问题；部署记录、命令上下文和 TUI 管理目标现在共用保存的路径，并允许显式覆盖。只保存路径，不复制私钥。
- `/agents/bind` 返回 `pending:true` 时，不再继续准备新注册交易；显式 `--tx-hash` 保持恢复流程。回归覆盖 pending 不签名、不发送、不写新登记，以及已有交易恢复。
- 配对签名、注册发送/恢复、服务安装/启停/重启、unlink、技能/RPC/凭证管理的参数与状态处理通过隔离测试；本轮未使用用户钱包、未发真实链上交易、未启停用户服务或解除绑定。
- 本机实际诊断发现 Claude 未登录、Forge 缺失，以及 Windows 读沙箱限制。Docker Desktop 启动后引擎查询仍超时，本轮未新增 Linux 容器验收；macOS 和远程 SSH 服务未实机验证。先前容器记录保留其原始日期与范围，不能视为本轮验证。

本页记录一次真实 Linux 容器部署验证，用于证明 colony 能安装并运行**官方 worker release**，同时明确没有钱包/runtime/systemd 时不能声称完成接单能力验收。

## 2026-10-18 任务流程与日常运维补充验收

- 本机完整测试：119/119 通过；同一源码在 Linux 容器中：119/119 通过，未跳过测试。
- Linux 镜像重新构建。测试时向 `/opt/colony` 拷入 `test/` 和 `examples/`；首次遗漏示例文件导致 8 项 ENOENT，补齐后全量通过。
- 真实公共 API：`task create --preset report --dry-run` 在本机与 Linux 均返回零 blocker；`task continue <id> ... --dry-run` 返回零 blocker 和项目 owner；均未创建付费订单。
- `task mine --address ... --limit 3` 实际读取公开钱包的 83 条任务订单，展示 3 个 completed 任务；空钱包和 `--local` 也通过。
- 容器内真实官方 worker：`tools list --json` 成功；`whoami`、`skills list`、`rpc list` 正确返回未配置/未配对错误，CLI 退出码与官方子进程一致。
- `tools key` / `rpc add` 在非交互 JSON 调用下先报错，不执行隐藏输入操作；TTY/SSH 参数由自动化 stub 测试覆盖，未验证真实远程交互。
- 新 tarball 经独立目录安装，确认 `task create` 与 `worker rpc` 命令存在。
- 本轮未执行真实付款、配对、注册、解除配对或后台服务运维；容器验收结束后停止，保留专用 volume。

本地验收记录：`.local/cli-final-tests.log`、`.local/cli-linux-tests.log`、`.local/cli-linux-acceptance.json`。

## 结论

- 通过：镜像构建、隔离启动、`colony worker deploy`、SHA-256 校验、官方 `imd` 安装、`imd help`、`colony worker status`、预期前置失败、`colony worker update`、容器重启后安装保留。
- 通过：Linux 容器内 `task-result` 的 17 项测试（路径/符号链接/哈希落盘）。
- 阻塞：未配对、未注册、没有 Claude Code/Codex 登录、没有 Foundry/forge；因此没有验证真实接单、`imd doctor` 全绿或后台服务。
- 容器内没有 systemd user session；`imd service install/start` 未验证。Docker `restart`/restart policy 只是容器生命周期，**不等价于**官方 systemd service 的启动/重启语义。

## 实测环境

- Docker Desktop Linux containers，Docker Server 29.4.2。
- 镜像 `colony-worker-test:local`，基础镜像 `node:22-bookworm-slim`（`sha256:c3de60bf...`）。
- 容器内：Node v22.23.3、npm 10.9.9、git 2.39.5、curl 7.88.1。
- 非 root 用户 `colony`，uid 10001。
- 只使用独立项目/容器/volume：
  - project/container `colony-worker-test`
  - volume `colony-worker-test-home -> /home/colony`
  - 无 host bind、无端口、无 Docker socket、无 `--privileged`，启用 `no-new-privileges`。

## 实际安装版本

| 项目 | 值 |
| --- | --- |
| release tag | `worker-v0.1.2-c3fba9eb12cc` |
| npm package version | `0.1.2` |
| daemon version | `0.1.2+c3fba9eb` |
| archive SHA-256 | `29f25dbc62284be449c2083544cffc2ab29eea4a06b2f8556d10acfdff1d495b` |
| release metadata digest | 同 SHA-256 |
| install prefix | `/home/colony/.super-colony/worker/prefix` |
| imd | `/home/colony/.super-colony/worker/prefix/bin/imd` |

## 复现

从仓库根目录、Git Bash：

```sh
# 保留已有测试 volume
bash container/scripts/validate.sh 2>&1 | tee .local/container-validation.log

# 仅当需要全新测试时：只删除 colony-worker-test-home
bash container/scripts/validate.sh --reset 2>&1 | tee .local/container-validation.log
```

脚本结束会 `docker compose stop`，保留镜像和 volume。恢复：

```sh
docker compose -f container/compose.yml --project-name colony-worker-test start
```

只清理本测试项目时：

```sh
docker compose -f container/compose.yml --project-name colony-worker-test down -v
```

`.dockerignore` 排除了 `node_modules`、`.research`、`.local`、`.env*`、`*.tgz` 等，构建上下文只发送 colony 源码依赖所需内容。

## 关键命令与结果

Docker 命令在 Git Bash 中带 `MSYS_NO_PATHCONV=1`，避免 `/home/...` 等路径被改写。

```sh
docker exec colony-worker-test colony worker deploy --dry-run --json
# exit 0；固定 tag worker-v0.1.2-c3fba9eb12cc、digest 29f25d...

docker exec colony-worker-test colony worker deploy --version worker-v0.1.2-c3fba9eb12cc --json
# exit 0；先校验 SHA-256 再 npm install；返回 ok=true

docker exec colony-worker-test sh -c '"$COLONY_HOME/worker/prefix/bin/imd" help | head -1'
# exit 0；IdentityMD contributor daemon (v0.1.2+c3fba9eb)

docker exec colony-worker-test colony worker status --json
# exit 0；service.exitCode=1（服务未安装）
# standingError="not configured — run: imd pair --server <url>"

docker exec colony-worker-test colony worker doctor --json
# exit 1（预期）；git ok、isolation ok；runtime/forge/config 未满足

docker exec colony-worker-test colony worker update --version worker-v0.1.2-c3fba9eb12cc --json
# exit 0；同一 tag、同一 SHA-256

docker exec colony-worker-test colony worker deploy --version no-such-worker-release --dry-run --json
# exit 1；no worker release matches version/tag

docker exec colony-worker-test colony worker service install --json
# exit 1；Pair this machine first: imd pair ...
```

部署前空 `COLONY_HOME` 执行 `worker status`，exit 1 且提示 `imd not found ... run "colony worker deploy"`，确认不会把未安装当成成功。

容器重启后再次 `worker status` 仍能读到安装；named volume 保留 prefix 和 `worker-state.json`。

## 纯安装前置检查

`deploy` 只把 Node.js 22+ 和 npm 作为阻断条件。git/curl、Foundry/forge、Claude/Codex runtime 缺失会显示为 `warn`，不会阻止纯安装；运行能力由 `imd doctor`/`colony worker doctor` 单独检查。实测在该容器内 forge 与 runtime 都缺失，`deploy` 仍 exit 0，`doctor` exit 1，符合预期。

## 测试

- 容器内复制仓库 `test` 后运行：`node --test test/task-result.test.mjs`，17/17 通过。
- 宿主 worker 相关单测：`node --test test/worker-*.test.mjs`，39/39 通过。
- 完整日志与报告保存在 `.local/container-*`（已 gitignore）。

## 任务与付款补充验证

### 2026-10-18 任务管理补充验证

- Windows 完整测试：188 通过，1 项可选真实模型测试跳过。
- Linux Node 22 非 root 容器：订单生命周期、发布、预算、我的任务、TUI、自动刷新和原生 PTY 共 46 个相关用例验证通过；发布测试所需的 `examples` 已随测试复制。
- 新增验证包含：默认保留请求、明确确认后本地取消、取消后禁止付款/恢复、服务端状态刷新保留取消标记、再次确认后删除本地记录，以及签名/提交过的记录不可取消或删除。
- 原生终端通过键盘完成保留、取消、删除。验证只使用临时目录和本地模拟服务，没有对用户订单进行取消、付款或删除。
- 本次独立验证容器已清理。macOS 本次未实机验证。

### 2026-10-18 双链付款验证

- Ethereum 与 Robinhood Chain 已内置公共 RPC；用默认节点只读核对链 ID、官方 IMD 的 symbol/decimals 和 Intake 合约代码，均正常。不提供 Sepolia 付款选择。
- Windows 全量 204 项：203 通过，1 项可选真实模型测试跳过。Linux Node 22 非 root 容器全量结果相同。
- 后续新增的 `task publish`、`task create`、`task continue` 三条 CLI 付款集成测试，在 Windows 和 Linux 各 3/3 通过。
- 使用本地模拟 API/RPC 和公开测试私钥验证 Robinhood 真实交易编码与本地签名、预算超限、额度不足、默认拒绝付款、广播前保存签名交易、广播响应丢失后的原交易恢复、交易回滚、中断停止轮询。没有使用真实钱包资金。
- 原生 Windows ConPTY 和 Linux PTY 验证 Wallet 选择网络、重启后保留选择；40×20 终端付款卡能显示网络、ETH 手续费上限及确认按钮。
- `wallet network` 选择只影响新付款，恢复订单沿用原网络。默认选择 Ethereum；Robinhood 走官方报价的 Intake `pay`，任务仍通过原订单状态接口读取。
- 本次独立测试容器已清理。macOS 本次未实机验证。

### 2026-10-18 自动换币验证

- Windows 全量：230 项中 229 通过、1 项可选真实模型测试跳过；后续显示调整的 48 项相关测试通过。Linux Node 22 非 root 容器同步核对源文件 SHA-256 后，全量同为 229 通过、1 项跳过。
- 覆盖 Ethereum 的 ETH、USDT、USDC 和 Robinhood Chain 的 ETH、USDG 换 IMD；本地模拟 API/RPC 使用公开测试私钥执行真实交易编码与签名。检查预算币种精度、包含 gas 的 ETH 上限、USDT 授权清零、精确授权、广播前持久化、广播响应丢失、未被节点接受时重发原字节、回滚不重买、中断恢复及错误收款地址/最低输出拦截。
- `task publish/create/continue` 的完整 CLI 路径验证 USDG 预算与换币参数；Windows ConPTY 和 Linux PTY 验证表单方向键切换币种，40×20 确认页测试核对最高扣款、gas 上限、取消与付款按钮均可见，默认取消。
- 真实公共 KyberSwap 接口验证五条路径的报价、交易构建与本地 calldata 校验。Ethereum 和 Robinhood 的 ETH → IMD 使用虚拟余额 `eth_call` 模拟通过；USDG 链上 decimals 为 6。未签名或广播真实交易。接口测试期间出现过 HTTP 503、旧报价无法执行；应用会停止，不自动换服务、加价或新建订单。

### 2026-10-18：Uniswap 直连替换

- 新订单兑换已移除 KyberSwap 依赖，由本地代码构造 Uniswap v3 SwapRouter02 exact-output 交易。比较内置候选路径的兑换额及保守 Gas 成本，包含已有授权和 USDT 重置授权情况。预算限制最高输入，未增加价格影响门槛。
- Windows 全套测试：237 项，236 通过，1 项可选真实模型测试跳过。使用 `--test-concurrency=1`；首次并发跑出现 Node 子进程异常退出，串行完整复核通过。
- Linux Node 22.23.3 容器普通用户全套测试：237 项，236 通过，1 项跳过。容器补齐 examples 和开发测试依赖后完成验收。
- 正式 quote/build 模块的五条主网路径都通过只读模拟，精确收到 0.5 IMD，Gas 使用量低于上限；没有签名、授权或广播真实交易。详细证据见 `docs/uniswap-path-validation.md`。
- npm 打包检查通过，包含新版兑换模块，不包含 `.research` 文件。此轮未在 macOS 实机运行。
- Linux 验证容器验证后清理。macOS 本次没有实机验证，继续使用既有平台 CI 矩阵。

### 2026-10-18：统一本地钱包

- Wallet 页面支持生成新钱包、隐藏输入导入私钥、密码解锁、手动锁定、加密备份与恢复，以及充值地址和二维码。采用标准 V3 JSON keystore；密码和明文私钥不写入订单或会话交接文件。
- Linux Node 22 非 root 容器全量 244 项：243 通过，1 项可选真实模型测试跳过；快捷键帮助更新后界面测试 23/23 通过。
- Windows 串行完整复核同为 244 项：243 通过，1 项跳过。首次运行一项任务预览子进程输出为空；该文件单独复测 10/10 通过，随后完整复核通过。
- 使用独立二维码解码器验证终端实际渲染的二维码能还原正确地址；小窗口明确提示调整大小或保存 SVG，不裁剪二维码。
- 临时测试钱包覆盖错误密码、签名地址恢复、备份恢复、拒绝覆盖、只读余额无需解锁，以及本地模拟 API/RPC 的完整付款流程。Windows 原生 ConPTY 和 Linux PTY 覆盖隐藏输入导入，确认私钥和密码不出现在输出中，结束后终端和进程正常退出。
- 合并 CLI/TUI 钱包余额查询和交易回执轮询，删除过期 KyberSwap 研究脚本。npm 打包检查包含新钱包模块，不包含 `.research`。
- 未使用用户真实钱包，未进行真实授权、兑换或付款。macOS 本轮未实机测试。

### 2026-10-18：整体流程审查

- 修复 Ethereum IMD 付款在等待钱包密码期间被另一终端撤销后仍继续签名的问题；解锁返回后再次核对撤销状态。错误记录也保留另一终端已保存的撤销，覆盖密码正确和密码错误两种情况。
- 修复 My tasks 把已发布任务全部放在未付款请求前面的问题；两类记录现在共用最近更新时间排序。
- 两个新增回归用例均先复现失败，再验证修复通过。Linux 普通用户容器全量 246 项：245 通过，1 项可选真实模型测试跳过。
- Windows 串行全量同为 246 项：245 通过，1 项跳过。Linux 验证容器已清理；本轮未运行真实付款或 macOS 实机测试。
- 运行时依赖审计报告 3 个关联告警：`node-llama-cpp@3.22.2 → simple-git@3.36.0 → @simple-git/argv-parser@1.1.1`。这是尚未消除的上游依赖问题。当前最新版 node-llama-cpp 仍声明 simple-git 3.x；未更换模型运行库或跨主版本强制替换其内部依赖。
- Colony 本地推理明确设置 `build: 'never'`，不从推理入口调用 Git 源码构建。此限制不等于整个安装依赖链不存在风险。上游公告：[Git 配置 include](https://github.com/advisories/GHSA-g4wm-2vf7-vfgr)、[编辑器环境变量](https://github.com/advisories/GHSA-v5rq-49vh-5v5c)、[trailer 配置](https://github.com/advisories/GHSA-x6jw-m9v5-85vh)。

### 2026-10-18：全网 Worker 浏览

- 只读验证官方 `/workers`，当时返回 1,024 条公开 Worker。界面管理目标置顶，公开节点按 Available、Busy、Paused、Connection unconfirmed 分组排序，再按空闲并发名额降序、设备 ID 升序；不以此冒充历史质量评分。
- 验证技能/运行时/ID 搜索、手动刷新保留选中节点、公开节点不能进入运维动作，以及公共接口失败时保留本地管理目标并显示错误。详情使用目录快照，不为每个节点单独发状态请求。
- Windows 相关单元和界面回归 32/32 通过；原生 ConPTY Worker 运维交接单独复核通过。本轮没有新增真实部署、付款或 macOS 实机验证。

### 2026-10-18：统一查询重试

- API GET、只读任务校验及 GitHub Worker 版本查询在临时网络错误、408、429、5xx 时最多尝试三次（包括首次）；默认等待三秒，尊重 Retry-After。RPC SDK 配置两次重试，默认三秒、六秒退避。权限错误和资源不存在不重试。
- 任务等待原有独立限流重试已合并到统一入口，避免两层重试叠加。取消信号可中断重试等待；订单创建、提交付款及 Worker 写操作未加入查询重试。实际 RPC 测试验证广播调用仅一次。
- 验证分页连续三次失败才报告错误，保留已加载内容和选择，之后可手动恢复。下载流程保持独立，不把部分文件重写混入查询重试。
- Linux 非 root 容器全量 255 项：254 通过，1 项可选真实模型测试跳过。测试容器已清理。本轮未使用真实钱包资金。
- Windows 串行完整复核同为 255 项：254 通过，1 项跳过；包括真实 ConPTY 的 Worker 交接和自动刷新。macOS 本轮未实机测试。

### 2026-10-18：按官方费用确认，取消预算必填

- 新建与继续修改任务只询问需求，付款卡直接展示官方费用，不再显示 Limit。CLI 不再询问或强制要求预算；显式 `--budget` 仍为硬上限，已保存订单的限额保持生效。
- ETH、USDC、USDT、USDG 自动换币在省略预算时，以链上报价和原有 0.5% 容差生成有限的最高输入；确认前展示最高扣款和 Gas 上限。没有改成无限授权，也没有提前广播。
- Windows 相关测试共 104/104 通过（75 项核心与界面、29 项命令与原生终端）；最终去除旧订单 Limit 展示后界面 25/25 复核通过，CLI 可选预算换币 3/3 通过。
- Linux 非 root 容器相关 104/104 通过，最终界面和换币 49/49 复核通过。容器已清理；未使用真实资金，未在 macOS 实机验证。

### 2026-10-18：多钱包与恢复入口

- Wallet 菜单始终提供切换、新建、导入和恢复备份。新增或恢复的钱包自动选中，原钱包保留；重复地址拒绝覆盖。CLI 增加 `wallet list` 和 `wallet use <address>`。
- 原有 `wallet.json` 保持原位和原密文；后续钱包独立存储于 `wallets/<address>.json`，当前地址通过原子重命名保存到 `wallet-selection.json`。覆盖无选择文件的原有钱包场景，无需迁移。
- 验证独立密码、签名恢复地址、当前钱包备份、恢复为额外钱包、跨进程选择持久化，以及切换时清除本进程解锁缓存。等待密码期间当前地址变化会停止此次签名。
- Windows 串行全量与 Linux 非 root 容器全量均为 264 项：263 通过，1 项可选真实模型测试跳过。原有钱包无选择文件场景在两端追加复核通过。
- 未读取或修改用户真实钱包，未使用真实资金；macOS 本轮未实机验证。

### 2026-10-18：统一本地钱包密码

- 首个钱包的密码作为本地统一密码。新增或导入钱包复用已解锁的密码；锁定时只询问已有密码，首次创建才设置和确认密码。切换钱包保持解锁，退出或手动锁定清除本进程密码和签名账户缓存。
- 恢复外部 V3 备份时使用备份原密码解密，再以本地密码加密；空目录恢复沿用备份密码。未改写用户现有钱包文件。
- Windows、Linux 普通用户容器的相关回归均为 39/39 通过，覆盖共享解锁、不同本地目录密码隔离、外部备份重加密、切换账户期间停止旧账户签名、付款和取消，以及新增与导入界面不再显示设置密码字段。
- 两个平台的原生 PTY 测试各 1/1 通过，实际执行首次导入和第二次新建：第二次仅输入已有密码，私钥和密码不回显，无二次设置密码。专用容器已清理，未使用真实资金；macOS 本轮未实机验证。

### 2026-10-18：钱包全流程复核与地址绑定

- 备份、收款绑定界面选中的地址，可操作非当前付款钱包，不再在执行时重新读取可能已被另一终端切换的地址。验证备份密文确实属于所选钱包、二维码地址一致且不改变付款钱包。
- 任务付款绑定流程开始时的钱包地址；Ethereum 确认回调中切换到另一钱包时拒绝签名。单独授权从仪表盘传入预期钱包和网络，CLI 支持 `--wallet <address>`，确认卡显示钱包地址，签名前核对地址。
- 查看私钥每次重新校验密码，错误密码、取消、退出和展示清除均有回归；创建、导入、共享密码、不同密码外部备份恢复、重复导入、只读余额和充值、兑换/付款恢复沿用相关测试覆盖。
- 修复整体管理区未显示当前付款网络的问题，并更新原生终端删除记录测试以匹配一次取消确认后直接删除的流程。
- Windows 与 Linux 非 root 容器全量均为 269 项：268 通过，1 项可选真实模型测试跳过；包含原生 PTY 隐藏输入、多钱包创建、网络选择重启持久化、删除记录、Worker 交接及自动刷新。专项钱包/兑换/付款/界面测试 73/73 通过。
- 仅使用临时测试钱包和模拟支付服务，未读取用户私钥或发送真实交易。macOS 本轮未实机验证。专用 Linux 容器已清理。

## 真实服务边界

- 钱包私钥、配对、EIP-712 签名、ERC-8004 注册、付费/接单。
- Claude/Codex 登录、模型调用、真实任务执行与收益。
- Foundry/forge 合约能力。
- 容器内 systemd user service 的安装、`--boot`、开机自启。
- 远程 Linux SSH 部署路径（本轮未启用隔离 sshd；相关 argv/quoting 由单测覆盖）。

这些边界不能用容器启动或 `docker restart` 冒充通过。
