# colony 实现计划与验收

## 1. 产品范围

colony 面向 IMD 使用者，主流程是描述需求、确认发布、跟踪结果、继续修改；worker 管理也是日常功能：

- 任务浏览与产物：`task list/show/result/wait/download`
- 我的任务：`task mine`，合并本机订单与钱包远端任务，明确数据来源
- 创建与修改：`task create/continue/check/publish`，支持免费检查和保存输入
- 订单恢复：`order list/show/submit`
- 钱包：`wallet address/status/approve`
- worker：`worker deploy/update/pair/register/run/start/stop/restart/status/logs/doctor/service`
- worker 配置：`worker whoami/unlink/skills/tools/rpc`，直接复用官方管理命令
- 共享模块、入口、文档、示例、打包

不做：链上 Intake 备用发布路径、购买 NFT、自动安装系统包、钱包私钥托管、浏览器钱包连接。

## 2. 技术决定

- Node.js 22+，原生 ESM JavaScript；开发使用 `src/`，esbuild 压缩并经 javascript-obfuscator 混淆至 `dist/` 后发布。
- `commander`；`viem`；`@x402/core@2.28.0`、`@x402/evm@2.28.0`；`node:test`。
- 命令名 `supercolony` 和 `colony` 等价，发布 bin 均指向 `dist/cli.mjs`；源码入口仍为 `src/cli.mjs`。
- HTTP/API 端点来自官方文档与 OpenAPI；不猜测端点。
- 读取任务不需要钱包；发布只走 x402。
- 成功路径的 `--json` 只向 stdout 写一份 JSON；进度、确认、错误写 stderr；错误退出码非 0。
- npm 公共包名 `supercolony`，提供等价命令 `supercolony` 和 `colony`；固定发布至 npmjs.org，也支持本地 `npm pack` 安装。
- 钱包在 Wallet 创建或导入，以密码加密的标准 V3 keystore 保存在本机；付款时解锁。私钥不上传、不明文保存。未配置本地钱包时可选用 `--key-env` 供脚本使用。订单 token/签名保存为 0600。

## 3. 模块结构

```text
src/cli.mjs                 入口：import registerWorkerCommands，调用 program
src/program.mjs             全局 options、命令注册、错误出口；可注入 worker 注册器供测试
src/shared.mjs              request / getSigner / print / confirmAction / getRpcClients
src/commands/task.mjs       创建、续作、浏览、等待与产物命令
src/commands/my-tasks.mjs   task mine 的参数与输出
src/commands/order.mjs      order list/show/submit
src/commands/wallet.mjs     wallet address/status/approve
src/lib/publish.mjs         check/quote/challenge/双签/提交/轮询/恢复/refused 语义
src/lib/orders.mjs          订单文件（0600）、查找、摘要
src/lib/payments.mjs        从 capabilities 读取 action/payment/chainId
src/lib/task-result.mjs     有截止时间的任务等待、产物下载与大小/SHA-256 校验
src/lib/task-input.mjs      需求参数、预设和 JSON 文件输入
src/lib/my-tasks.mjs        本机与远端任务合并、归属和数据来源

src/worker/index.mjs        worker 命令注册；所有命令用 optsWithGlobals()
src/worker/context.mjs      本地/SSH 目标、PATH、IDENTITYMD_HOME、prefix
src/worker/preflight.mjs    Node/git/curl/forge/runtime/登录前置检查
src/worker/release.mjs      GitHub release 元数据、tag/版本解析
src/worker/install.mjs      tgz + SHA256SUMS 校验、npm --prefix 安装
src/worker/deploy.mjs       deploy/update 计划与执行
src/worker/pair.mjs         纯 CLI 配对流程
src/worker/pairing.mjs      WorkerAuthorization typed data 与 wire 格式
src/worker/config.mjs       本地 config 读写；补写 wallet/tokenId，保留 device key
src/worker/register.mjs     register-intent、显式交易、bind 轮询、txHash 恢复
src/worker/service.mjs      imd service/start/run/doctor/logs/status 映射
src/worker/process.mjs      子进程执行与输出
src/worker/ssh.mjs          系统 ssh、参数分隔、POSIX quoting
src/worker/remote/*.cjs     远程 config patch/summary/install 脚本
```

`src/shared.mjs` 契约（worker 依赖，不得改名）：

```js
request(apiUrl, path, { method, body, token, headers, allowStatuses }) -> { status, data, headers }
getSigner(options) -> viem account
print(value, options) -> stdout
confirmAction(message, options) -> Promise<void>
getRpcClients(options, chainId) -> { publicClient, walletClient, account }
```

`request` 只处理 JSON API：成功响应不是 JSON 时明确报错；非 2xx 且不在 `allowStatuses` 时抛错，非 JSON 错误保留原始摘要。`allowStatuses` 用于 402 challenge。

`getRpcClients` 的 `rpcUrls.default.http` 是数组；显式要求 `--rpc`/`COLONY_RPC_URL`，用 `getChainId` 校验链 id，链不匹配时不发交易。

## 4. 任务发布状态机

订单文件 `$COLONY_HOME/orders/<requestKey>.json`，权限 0600，包含：

```text
requestKey, requestToken, api, action, input, inputHash,
status, orderId, quote, challenge, payment, paymentHeader,
paymentHash, quoteSignature, admission, jobId, statusUrl, resultUrl, lastError
```

状态：

```text
created -> blocked | quoted -> challenged -> signed -> submitted -> admitted
                                                        \-> refused
                                                        \-> payment_failed / expired
```

不变量：

1. 本地 `requestKey`/`requestToken` 在第一次 quote 前生成并保存；普通重试复用。报价过期后生成 `serverRequestKey` 获取新报价，本地任务不变，旧报价进入 `quoteHistory`。
2. 同一 `requestKey` 只允许同一 input（本地 `inputHash` 校验）。
3. 普通网络错误复用原远端订单；只有失效的未付款报价允许更新远端订单号，且保留原输入和交易记录。
4. payment header 与 quoteSignature 在 submit 前写盘；仍有效的签名原字节重发。
5. 余额不足先显示所选网络和充值地址；继续任务时重新读取余额、兑换价和 gas，未签名的交易重新准备。已确认的兑换、授权和支持付款不重复执行。
6. 已签名订单先查询服务端。续期必须由 finalized 链状态证明旧支付已无法生效且未付款；旧签名进入 `paymentHistory`，新报价仍需确认。无法确定结果的签名保留恢复流程。
7. 金额/资产/收款方/网络来自真实 quote/challenge；challenge 与 quote 不一致立即停止。
8. 确认前展示服务端 prepared input（`challenge.input`）、network、金额、资产、收款方、过期时间。
9. Permit2 deadline 严格早于 `quote.expiresAt`：签名前把 SDK `maxTimeoutSeconds` 收紧到 `min(原值, 剩余-1)`，最终 `accepted` 保留原 challenge requirements；生成后再次校验 deadline。
10. 缓存 challenge 在签名前重新校验有效期；过期明确停止，不自动重新报价。
11. 所有创建订单后的错误都带 `requestKey`、`--home`、`--api` 恢复命令。
12. `admitted` 且 `admission.result.kind=refused` 是失败：状态 `refused`，保留 problems/付款状态/tx，命令非 0，不输出成功发布。

## 5. worker 生命周期

### 5.1 前置

目标机：Node.js 22+、npm、git、curl；Claude Code 或 Codex 已安装并登录；合约工作 Foundry v1.8.3；钱包持有 IMD NFT。远程只支持 Linux SSH；本机也支持 Windows/macOS，但受官方 worker 的 sandbox/服务限制。

`preflight` 只检查并报告缺失项，不自动安装系统包。`deploy` 不配对、不注册、不启动。

### 5.2 安装与更新

`deploy`：

1. 解析 release tag/版本，固定到该 tag 的 `identitymd-worker.tgz` 与 `SHA256SUMS`；
2. 下载并校验 SHA-256，失败不执行 npm；
3. `npm install --global --prefix <colony prefix>` 安装到 colony 管理的 prefix；
4. 校验生成的 `imd` 入口。

`update` 用同一 SHA-256 校验路径和同一 prefix 重新安装。`--auto-update` 是官方 worker 对**当前 cli 安装目录**的原地更新，不会切换 colony prefix；自定义 `--prefix` 时更新留在该 prefix。

### 5.3 配对与注册

- `worker pair`：读取目标机 deviceKey → `POST /pair/start` → 本地钱包签 EIP-712 `WorkerAuthorization` → `POST /pair/complete` → 把 wallet/tokenId 写回目标 config，保留 devicePrivateKey，文件 0600。钱包私钥不上远端。
- `worker register`：检查 `/agents/bind`；未注册则 `/agents/register-intent` 取 calldata；用 `--rpc` 校验链 id 后由本地钱包发**一笔**显式交易；保存 txHash，轮询 `/agents/bind`。已保存未确认的 txHash 不自动重发。
- 购买 NFT 和链上 gas 不由 CLI 代办。

### 5.4 服务与运维

| 命令 | 行为 |
| --- | --- |
| `worker run` | 前台 `imd start`；Ctrl+C 停止；支持 runtime/concurrency/auto-update/server |
| `worker start/stop/restart` | 官方 `imd service start/stop/restart` |
| `worker service install` | 官方 service install；需要已配对、已注册、runtime 可用；Linux `--boot` |
| `worker service status/logs/uninstall` | 官方 service 对应命令 |
| `worker logs [--follow]` | 官方日志；`--follow` 原始流，不使用 JSON |
| `worker status` | 官方 service 原始输出 + 控制面 `/workers/:deviceKey/standing` |
| `worker doctor` | 官方 `imd doctor`，退出码透传 |
| `worker update` | 同一 prefix 重新校验安装 |

远程目标选项：`--ssh <host>`、`--identity <path>`、`--port <port>`、`--worker-home <dir>`、`--prefix <dir>`。SSH 用系统 `ssh`，参数分隔/quoting 防注入；无入站端口。

### 5.5 推荐完整顺序（远程 Linux）

```text
deploy -> pair -> register --rpc -> service install --boot -> status/logs
```

本机 Windows 去掉 `--ssh` 和 `--boot`；服务随登录启动，机器需保持登录/唤醒。

## 6. 验收与测试

`npm test` 运行 `test/*.test.mjs`，全部离线：

主 CLI：

- `shared.test.mjs`：JSON 成功、成功非 JSON 报错、HTTP 非 JSON 错误摘要、allowStatuses 402、私钥 env 缺失/地址派生。
- `task.test.mjs`：分页/过滤参数、匿名读取、show/result 端点、非法 limit、HTTP 错误到 stderr + 非 0。
- `publish.test.mjs`：check/quote/402/双签/submit admitted；QuoteApproval 与 paymentHash 恢复验证；deadline 早于 expiry；prepared input+network；blocker 不 quote；响应丢失同字节恢复；quote 丢失同 key/token 恢复；缓存 challenge 过期停止。
- `recovery.test.mjs`：已签名 410 先刷新原订单；pending 时不建议新付款；admitted+refused 非 0 并保留问题/付款；`order show` 默认本地、`--refresh` 才查询。
- `cli.test.mjs`：真实入口注册 task/order/wallet/worker；worker deploy/pair/register/service 帮助；全局参数位置。

worker：

- release 元数据固定到 tag，不使用 `latest/download`；checksum 失败不调用 npm；校验通过只调用一次 npm。
- 远程安装脚本在 hash 不匹配时拒绝；npm 输出不污染 `--json` stdout。
- `WorkerAuthorization` typed data 可由本地 signer 恢复；wire 字段去 `0x`；`expiresAt` 按 `/pair/start` Unix 秒。
- config patch 保留 devicePrivateKey、写入 wallet/tokenId、权限 0600；远程脚本只返回安全摘要。
- 未 enrolled 不写 config；多 token 必须显式 `--token-id`。
- register：bind 轮询不虚构成功；只发一笔交易；保存/恢复 txHash；不自动重发。
- service：官方命令映射、退出码透传、status 组合 standing、standing 404 不虚构；deviceKey 解析唯一。
- SSH：host 校验、argv 分隔、POSIX quoting、元字符不执行；进程 runner 不用 shell。
- state：缺失为空，malformed 不静默替换。

CLI 集成：`--help`/`worker --help`、`worker deploy --dry-run --json`、service argv 映射/退出码、`task list` 公开读取。

任务结果验收：`task wait` 完成、blocked/cancelled、未知状态超时、429/Retry-After；`task download` 二进制和嵌套路径、大小/哈希错误、拒绝覆盖（包括下载期间新建目标）、路径越界与符号链接、失败保留已验证产物。顶层 `--version` 和 worker release `--version <tag>` 独立解析，全局选项仍支持前后放置。

Linux 实测使用独立非特权 Docker 容器，记录官方 worker 下载、校验、安装、更新及状态保留的实际结果；无钱包/runtime 时不将部署验证当作真实接单验收。见 [container-validation.md](container-validation.md)。

测试不发送真实 quote、支付、配对、部署或链上交易。

## 7. 打包与安装

- `files`：`src`、`examples`、`docs/plan.md`、`docs/research.md`、`README.md`。
- `.npmignore`/`.gitignore` 排除 `.research`、`node_modules`、`$COLONY_HOME`、tarball。
- 验收：`npm pack` 后在临时前缀 `npm install --prefix <tmp> ./supercolony-0.1.0.tgz`，运行 `<tmp>/node_modules/.bin/colony --help`。
- 不提交 git。

## 8. 限制

- `GET /jobs` 无 state/template/wallet 过滤；`paid-by` 最多 100 条且无 input。
- x402 发布只在主网 IMD，需要余额 + Permit2 allowance + 少量 ETH gas；Safe 不支持。
- 官方 `imd` 没有 JSON 输出；`worker status/logs` 的文本/流式输出需按原样处理，`status` 额外提供控制面 standing。
- Windows 本机受官方 worker sandbox 限制；远程仅 Linux SSH。
- `wallet approve` / `worker register` 是真实交易命令，自动化测试不执行。
- 订单 token/签名是敏感本地状态；备份/迁移保持 0600。
