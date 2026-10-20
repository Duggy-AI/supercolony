# IMD CLI（colony）调研

调查日期：2026-10-17。范围：真实 jobs 端点、发布任务的两签流程、官方 worker 包入口/服务命令、纯 CLI 配对与注册。
来源：官方文档 <https://imd.fun/docs/>（Markdown 版 `/docs/llms.txt`）、<https://api.imd.fun/openapi.json>、公开 API 实测、worker release 与 `dist`、x402 npm 包。公开下载物在 `.research/`。未读私钥/全局凭证，未执行付费请求、链上交易、全局安装或服务部署。

## 1. 浏览任务：真实端点

### 1.1 列表

`GET https://api.imd.fun/jobs`

查询参数（服务端实际支持的就这些）：

| 参数 | 语义 |
| --- | --- |
| `limit` | 默认 100，服务端 clamp 到 1–500；`limit=0` 实测返回 1 条 |
| `before` | 排他的创建时间游标；传上一页最老的 `createdAt`，ISO 8601；实测有效 |
| `q` | 搜 objective 或 job id 前缀，最长 200 |
| `since` | 返回该时间后“有变动”的任务；实测按 `updatedAt` |
| `exclude=oracle` | 排除 oracle panel 任务 |

没有 `state`/`template`/`wallet` 过滤。实测 `state=completed` 被忽略，仍返回 executing。按状态/模板筛选只能在客户端做。

响应：

```json
{
  "count": 2,
  "jobs": [{
    "id": "uuid",
    "state": "executing|completed|blocked|cancelled|...",
    "template": "shape:dag|skill:research-report|audit|research|...",
    "objective": "...",
    "blockedReason": null,
    "delivery": null,
    "createdAt": "2026-10-17T15:00:04.874Z",
    "updatedAt": "2026-10-17T15:00:10.018Z",
    "project": {"id": "uuid", "version": 3, "of": 3}
  }]
}
```

`count` 是本次页大小，不是总数；`project` 可为 null。2026-10-18 补充验证：`GET /swarm` 的 `counts.jobs` 提供全站真实任务总数，任务广场使用它显示总数；关键词搜索仍没有匹配总数。实测还多出 `originalRequest`、`launchKind`、`via`，实现应按“可有额外字段”解析。抽样 500 条看到的状态：`completed` 470、`blocked` 23、`executing` 6、`cancelled` 1；未在文档中看到完整 state 枚举，按开放字符串处理。

分页：`GET /jobs?limit=100&before=<最老 createdAt>`；当 `count < limit` 停止。`since` 可能重复返回同一条，需按 id 去重。

任务广场每 30 秒用 `since` 增量刷新，更新游标取成功读取的最大 `updatedAt`，每次重叠 30 秒覆盖列表缓存窗口；增量超过单页限制时继续按 `before` 读完，完成后再推进更新游标。合并时按 id 去重、按创建时间降序排列，保留历史页游标与当前选中任务；发生在尚未加载的旧任务上的变更不插入当前历史窗口。

### 1.2 详情与产物

| 端点 | 关键字段 |
| --- | --- |
| `GET /jobs/:id` | `state, template, objective, blockedReason, paidBy, parentJobId, project, delivery, nodes[], reviews[], workflow, planning, site, launch, oracleRequestId, media` |
| `GET /jobs/:id/submissions` | `jobId, repoUrl, baseCommit, count, submissions[]`；每条含 `hash, nodeKey, role, attempt, deviceKey, seat, outcome, accepted, failureReason, failureClass, usage, bundleHash, artifacts[], changedPaths, verificationErrors, summary` |
| `GET /jobs/:id/result` | `jobId, projectId, state, complete, launch, source[], files[], delivery` |
| `GET /jobs/:id/report.md` | 仅 audit；`404 unknown_audit`，未就绪 `409 report_not_ready` |

详情里的 `nodes[]` 实际字段：`key, role, state, attempt, revisions, judgeRevisions, dependsOn, allowedPaths, failureReason, dispatchNote, verdict, seat, live`。`verdict` 含 `status, profile, evaluation, rejectionCode, detail, verifierVersion, verifiedTreeHash, at, failedChecks`。

`GET /jobs/:id/result` 在任务运行中也可读，但：

```json
{
  "state": "executing",
  "complete": false,
  "source": [],
  "files": [],
  "delivery": {"requested": false, "mode": "repository", "repoUrl": null, "commit": null, "deliveredAt": null, "failure": null}
}
```

完成后：

```json
{
  "complete": true,
  "source": [{"node": "...", "submissionHash": "...", "hash": "...", "url": "https://api.imd.fun/bundles/<hash>"}],
  "files": [{
    "name": "report", "path": "artifacts/report.md", "mediaType": "text/markdown",
    "hash": "5ca4...", "bytes": 4886, "submissionHash": "615f...",
    "url": "https://api.imd.fun/artifacts/5ca4..."
  }],
  "delivery": {"requested": true, "mode": "repository", "repoUrl": "https://github.com/...", "commit": "...", "deliveredAt": "...", "failure": null}
}
```

`files[].url` / `source[].url` 是公开原始字节，按 hash 寻址；下载后应校验 SHA-256。列表里的 `delivery` 可能是对象，也可能只有 `{failure: "..."}`，CLI 展示需容错。

### 1.3 “我的任务”恢复

`GET /jobs` 不能按钱包过滤。可用：

`GET https://api.imd.fun/requests/paid-by/:address`

- 返回该钱包付过或尝试付过的订单，最新在前，最多 100 条；无分页。
- 字段：`payer, count, orders:[{orderId, action, status, createdAt, paidAt, payment, result}]`。
- `result` 里有 `{kind, jobId, launch, statusUrl, resultUrl}`，可直接跳到任务。
- 不含 input、签名或请求 token；超过 100 条的历史无法从此端点取回。

实测某钱包 70 条，第一条 `status: "admitted"`、`result.jobId` 可用。CLI 的 `task list --mine` 可先取此端点再按 jobId 拉 `/jobs/:id`，否则只能依赖本地订单记录。

### 1.4 读取限制

- 公共读按 IP 限 120 次/分钟；`429 too_many_reads`，带 `Retry-After`。
- 付费路由 300 请求/分钟、30 quote/分钟，按 IP 和 token 计。
- 列表缓存 30 秒；详情可能更大。CLI 必须处理 429，不要并发轰炸。

## 2. 发布任务

统一入口是 paid request。价格与资产必须实时读，不能硬编码。

`GET https://api.imd.fun/requests/capabilities` 实测（2026-10-17）：

- `job.open` / `job.continue` / `launch.open` / `workflow.open` / `oracle.request`：0.5 IMD。
- `payment`: `network=eip155:1`，`asset=0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7`，`amount=500000000000000000`，`payTo=0x4e0fa57bde726079356537e2f34d671e9f41adbc`，`decimals=18`。
- `quoteTtlSeconds=600`。
- `authentication={scheme:"Bearer", tokenBytes:32, encoding:"hex", creator:"client"}`。
- `payment` 顶层还声明 `x402Version:2, scheme:"exact", assetTransferMethod:"permit2", quoteApproval:"EIP-712"`。

### 2.1 流程

1. **本地生成 request token**：32 字节随机数的 64 位小写 hex。服务端不注册、不发放；它就是订单的 Bearer token。必须持久化，丢失后只能用 `paid-by` 找回订单号，拿不回 input。
2. **`POST /requests/check`（免费、无 token）**：`{action, input}`。可先看 `blockers`、`plan`、`facts`、`judged`；有 blocker 不应付款。实测 `job.open` 只给 objective 会返回 `missing_plan`。
3. **`POST /requests/quote`（Bearer）**：`{requestKey: UUID, action: "job.open", input: <job body>}`。
   - 新订单 `201 {created:true, order}`；同 key 同 input 重试 `200`；同 key 不同 input `409 request_key_conflict`。
   - `422 invalid_input` 带 `problems`，不收费。
   - quote 有效期 600 秒；`410 quote_expired` 后必须换新 `requestKey`。
   - 服务端可能“重建/准备” input；签名前要检查 `order.quote.input`（或 challenge 的 `input`），不能假设等于提交内容。
4. **`POST /requests/:id/submit`（Bearer，空 body）**：返回 `402`。响应 header `PAYMENT-REQUIRED` 是 base64 的 x402 v2 challenge；JSON 也含：
   - `x402Version:2`
   - `resource`
   - `accepts[0]`：`scheme=exact, network, asset, amount, payTo, maxTimeoutSeconds, extra.assetTransferMethod=permit2`
   - `quote`（含 `id, action, inputHash, issuedAt, expiresAt, payment, quoteHash`）
   - `requesterScopeHash`, `resourceUrl`, `input`
5. **钱包签两次**（同一钱包）：
   - Permit2 支付授权，由 x402 client 生成；得到 `payment` 对象。
   - IMD 额外的 EIP-712 `QuoteApproval`，绑定 challenge 上下文和“最终将发送的 payment 字节”。
6. **再次 `POST /requests/:id/submit`**：
   - Header：`Authorization: Bearer <token>`、`Content-Type: application/json`、`PAYMENT-SIGNATURE: <base64>`。
   - Body：`{"quoteSignature":"0x...130 hex"}`。
   - 返回 `202 pending` 或 `200 outcome`。
7. **轮询 `GET /requests/:id`（Bearer）**：`{status, order, payment, admission}`。`status`：
   `quoted | payment_pending | admission_pending | admitted | payment_failed | expired`。
   `admitted` 后 `admission.result`：
   - `job.open`: `{kind:"job", jobId, launch:false, statusUrl:"/jobs/<id>", resultUrl:"/jobs/<id>/result"}`
   - 其它 action 各有 `workflowId` / `requestId` / `scheduleId`。

幂等/重试：同一订单重发同样的 payment 字节不会二次扣款；响应丢失可重发。不要换 order、不要重新签一次不同字节的 payment。

### 2.2 QuoteApproval（EIP-712）

来源：OpenAPI `x-imd-quote-approval` 与文档示例。

```js
domain = {
  name: "IdentityMD Paid Action",
  version: "1",
  chainId: Number(quote.payment.network.slice(7))
}
primaryType = "QuoteApproval"
types = { QuoteApproval: [
  {name:"resource", type:"string"},
  {name:"requesterScopeHash", type:"bytes32"},
  {name:"quoteId", type:"string"},
  {name:"quoteHash", type:"bytes32"},
  {name:"paymentHash", type:"bytes32"},
  {name:"action", type:"string"},
  {name:"asset", type:"address"},
  {name:"amount", type:"uint256"},
  {name:"payTo", type:"address"},
  {name:"expiresAt", type:"uint256"}
]}
message = {
  resource: challenge.resourceUrl,
  requesterScopeHash: "0x" + challenge.requesterScopeHash,
  quoteId: quote.id,
  quoteHash: "0x" + quote.quoteHash,
  paymentHash: sha256(stringToBytes(canonicalJson(payment))),
  action: quote.action,
  asset: quote.payment.asset,
  amount: BigInt(quote.payment.amount),
  payTo: quote.payment.payTo,
  expiresAt: BigInt(quote.expiresAt)
}
```

`canonicalJson`：对象键排序、无空白、整数保持整数、无 `undefined`。`paymentHash` 必须是“最终放进 `PAYMENT-SIGNATURE` 的同一对象”的规范 JSON 的 SHA-256；差一个字节就是 `invalid_quote_approval`。

### 2.3 x402 payment payload

文档给出的可复用代码使用：

```js
import { x402Client } from '@x402/core/client';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
```

- npm 上 `@x402/core`、`@x402/evm` 当前均 2.28.0；文档称 plane 固定 2.28.0。
- `payment` 形状：`x402Version, resource, accepted, payload.signature, payload.permit2Authorization{from, permitted{token,amount}, spender, nonce, deadline, witness{to,validAfter}}`；`extensions` 可为空对象，但任何非空/未知键都会被严格解析拒绝（`invalid_payment_shape`）。
- 必须丢掉 SDK 自动附带的 `extensions`；`accepted` 必须等于 challenge 的 `accepts[0]`；`resource.url` 必须等于 `resourceUrl`；permit 的 `deadline` 必须早于 `quote.expiresAt`。
- 不要自己拼 header：用 `encodePaymentSignatureHeader(payment)`。

### 2.4 钱包前置与限制

- x402 路径只收 Ethereum mainnet 的 IMD：`0xd34a...63b7`，0.5 IMD。
- 钱包必须有 IMD 余额，并已给 Permit2 授权 IMD。Permit2 地址来自 `@x402/evm@2.28.0`：`0x000000000022D473030F116dDEE9F6B43aC78BA3`。
- 该包导出 `createPermit2ApprovalTx(tokenAddress)`，返回 `{to: IMD, data: approve(PERMIT2, MaxUint256)}`；`getPermit2AllowanceReadParams` 可查 allowance。授权交易要钱包付 gas，应作为单独显式命令，不要混进 publish 自动执行。
- 钱包必须是普通 EOA 或 EIP-7702 账户；Safe 等合约钱包暂不支持。
- x402 支付本身由服务端钱包付 gas；但授权和注册需要主网 ETH。
- 文档建议的 `ClientEvmSigner` 只要求 `{address, signTypedData}`；本地加密钱包解锁后转换为 viem account 签名。环境变量私钥只保留给未配置本地钱包的脚本用法。
- 价格、asset、payTo 都可能变；每次从 capabilities/quote 读。

### 2.5 常见错误

| HTTP | code | 处理 |
| --- | --- | --- |
| 400 | `invalid_payment_shape` / `payment_terms_mismatch` / `invalid_quote_approval` / `invalid_payment_window` | 不改订单，修正签名/payment 后重发 |
| 401 | `request_token_required` | 带 Bearer |
| 402 | `payment_rejected`（如 `insufficient_funds`）或 challenge | 检查余额/授权；challenge 则去签名 |
| 403 | `payer_not_owner` / `origin_not_allowed` | continue 必须原付款钱包；服务端调用 |
| 409 | `request_key_conflict` / `quote_too_close_to_expiry` / `order_not_payable` / `payment_already_reserved` 等 | 按 code 处理；临近过期换新 quote |
| 410 | `quote_expired` | 新 `requestKey`，重新 quote |
| 422 | `invalid_input` + `problems` | 改 input，不付款 |
| 429 | `request_limit` | 退避；注意 quote/check/import 都计数 |
| 413 | `request_too_large` | body 上限 16 KiB；import 4 KiB |
| 503 | `paid_request_unavailable` | 订单保留，稍后重试 |

### 2.6 替代路径：链上 Intake

`Intakev2` 在 Ethereum / Robinhood Chain / Sepolia 同地址 `0xa43e6f75ee006411f79ac1c84120606c2330de82`。调用：

```solidity
request(bytes32 action, bytes calldata body, (address target, bytes4 selector) callback,
        address asset, uint256 amount) returns (bytes32 requestId)
```

`action` 是 `job.open@job-1` 右填充 bytes32；`body` 是 compact UTF-8 JSON；先给 Intake approve IMD。没有 request token、x402 或 QuoteApproval，但需要钱包付 gas，且 schedules 不走这条。colony 的产品主路径只走 x402；Intake 仅记录为外部可选事实，不实现备用路径。

## 3. 官方 worker 包与服务命令

### 3.1 包入口

GitHub：<https://github.com/Identity-md/worker>；release：`worker-v0.1.2-c3fba9eb12cc`（2026-10-17）。

`package.json`：

```json
{
  "name": "@identitymd/worker",
  "version": "0.1.2",
  "private": true,
  "type": "module",
  "bin": {"imd": "./dist/cli.js"},
  "exports": {
    ".": "./dist/cli.js",
    "./client": "./dist/client.js",
    "./config": "./dist/config.js"
  },
  "engines": {"node": ">=22"},
  "license": "UNLICENSED"
}
```

- **不在 npm registry**：`https://registry.npmjs.org/@identitymd%2Fworker` 返回 404；只能用 GitHub release 的 `identitymd-worker.tgz` 安装。
- 包内只有 `dist/`、`README.md`、`LICENSE`、`THIRD_PARTY_LICENSES.txt`、`build.json`；无后端源码。`dist/cli.js` 是约 1.18 MB 的 bundle。
- `./client` 导出 `DaemonClient`、`forPlane`、`PROFILE_REPROBE_MS`；`./config` 导出 `readConfig/writeConfig/ensureConfig/configPath` 等。但 `UNLICENSED`，不建议把内部模块当公共 API 依赖；CLI 包装应优先走 `imd` 进程。
- `imd help` 首行给出 `(v0.1.2+c3fba9eb)`；没有 `imd --version`（实测会打印 unknown command + help）。

安装（官方文档命令；`sha256sum` 用于 Linux/Git Bash，macOS 用 `shasum -a 256`）：

```sh
d="$(mktemp -d)"
(cd "$d" \
  && curl -fsSLO https://github.com/Identity-md/worker/releases/latest/download/identitymd-worker.tgz \
          -O https://github.com/Identity-md/worker/releases/latest/download/SHA256SUMS \
  && sha256sum -c SHA256SUMS)
npm install --global "$d/identitymd-worker.tgz"
imd help
```

本次校验：`identitymd-worker.tgz` 668,700 字节，SHA-256
`29f25dbc62284be449c2083544cffc2ab29eea4a06b2f8556d10acfdff1d495b`，与 release 的 `SHA256SUMS` 一致。`build.json`：`sourceCommit=c3fba9eb12cc...`，`daemonVersion=0.1.2+c3fba9eb`。

npm 权限失败时不要 sudo：设用户级 prefix（`npm config set prefix ~/.npm-global`，把 `~/.npm-global/bin` 加入 PATH）。安装不会启动 worker。

### 3.2 命令表

| 命令 | 行为 |
| --- | --- |
| `imd start [--server URL] [--concurrency 1-4] [--runtime claude\|codex] [--auto-update]` | 前台运行；未配对会先引导配对；首次还要注册 ERC-8004 agent |
| `imd pair` | 只打印浏览器配对 URL 并轮询；不接收钱包私钥 |
| `imd status` | 配置、检测到的 runtime、eligibility；纯文本 |
| `imd doctor` | git、forge、tools、runtime 一行自检、控制面、为何未被派单；纯文本 |
| `imd whoami` | 打印本机 deviceKey（64 hex），无 JSON |
| `imd unlink` | 注销本机 enrollment，释放 NFT 可配对到别处 |
| `imd update` | 安装最新 GitHub release；或更新源码 checkout |
| `imd service install [--boot] [--auto-update] [--runtime ...] [--concurrency ...]` | 安装并启动后台服务；需要已配对（config.tokenId）且有可用 runtime |
| `imd service restart [--runtime claude\|codex]` | 只允许改 runtime，其它设置保留 |
| `imd service status` | 服务状态；平台相关文本 |
| `imd service logs [--follow\|-f]` | 默认最近 100 行；`-f` 持续跟随，Ctrl+C 只退出查看器 |
| `imd service start\|stop\|uninstall` | 启动/暂停/移除自启；uninstall 保留配对、日志、工作 |
| `imd skills` / `imd tools` / `imd rpc` / `imd site` / `imd launch` / `imd sandbox` | 额外能力；非本次核心 |

注意：没有顶层 `imd stop` / `imd logs` / `imd restart`，只有 `service` 子命令；`imd start` 是前台，Ctrl-C 停止。`--auto-update` 一旦 service install 时未加，之后不能只靠 restart 补，需重装服务。

服务细节（来自 `dist/cli.js`）：

- Linux：systemd **user** unit `identitymd-worker.service`；`--boot` 会 `loginctl enable-linger <uid>`，可能要求管理员授权；日志 `journalctl --user -u identitymd-worker.service`。
- macOS：launchd `md.identity.worker`；登录启动。
- Windows：Task Scheduler 任务 `IdentityMD Worker`；官方 CLI 内部用 PowerShell 包装循环，每 60 秒重启 `imd start`，日志写 `%USERPROFILE%\.identitymd\worker.log`；登录启动，必须保持登录且不休眠。
- `IDENTITYMD_HOME` 可分隔多个 worker profile；非默认路径会在服务名后加 config path 的 hash 后缀。配置默认 `~/.identitymd/config.json`（0600），含 deviceKey/devicePrivateKey/wallet/tokenId 等。
- `imd service install` 实测代码要求 `config.tokenId`，否则报 “Pair this machine first”；还要求 Claude/Codex 已安装并登录。

更新：`--auto-update` 在启动时及之后每 5 分钟检查最新 GitHub release；有更新时停止接新任务、等工作结束、校验 SHA-256、在临时目录试装、替换全局安装并重启。失败保留旧版，重试间隔 1–15 分钟。全局安装目录必须当前用户可写，更新器不会 sudo。

### 3.3 平台限制

- Node.js >=22（推荐 24），npm、git、curl；合约工作还需要 Foundry **v1.8.3**（验证器版本）。
- Windows 官方建议用 Git Bash；服务由 Task Scheduler + PowerShell 实现，机器必须保持登录/唤醒；`--boot` 仅 Linux。
- Windows 上 runtime 的 sandbox 无法对读取做 jail，官方代码明确返回：`${runtime}'s sandbox cannot jail reads on Windows; run the worker under WSL`；`imd sandbox` 在 Windows 输出 `nothing to do: not Linux`。因此 Windows 仅适合不要求 jail 的任务；要完整能力应使用 Linux/WSL/VPS。
- Linux Codex 的 bubblewrap 需要非特权 user namespace；Ubuntu 24.04 默认关闭，官方修复：`sudo imd sandbox` 或 `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`，并写入 `/etc/sysctl.d/60-userns.conf`。`imd doctor` 会检查。
- 无入站端口；worker 通过 WSS 连控制面。

### 3.4 远程 SSH 运维可行性

官方没有 remote 模式、没有 SSH 参数、没有 JSON 输出。可行路径是 colony 自己通过系统 `ssh` 执行远端 `imd`：

1. 预检远端：node/npm/git/curl/forge、Claude 或 Codex 已安装并登录、`imd help`。缺失时明确失败并给安装指引，不要静默装系统包。
2. 下载 release、校验 SHA256、`npm install -g`（用户 prefix）。
3. 配对/注册（见下）。钱包私钥留在本地，不放到远端；远端只需要 deviceKey 和最终 config.wallet/tokenId。
4. `imd doctor` 通过后 `imd service install --boot --auto-update --concurrency N`。
5. 状态优先查控制面 `GET /workers/:deviceKey/standing`（JSON：enrollment/presence/standing/queue），本地服务状态用 `systemctl --user is-active identitymd-worker.service`、`journalctl --user -u ... -n 100`；不要依赖 `imd status` 文本解析。
6. `imd service logs -f` 是流式的，SSH 管理要单独处理流；一次性取日志用 `imd service logs`。

SSH 本身（host key、认证、跳板）由 colony 负责，建议直接调用系统 `ssh`，避免再引入库。远端 `--boot` 的 linger 可能触发管理员授权，非交互 SSH 可能失败；需要预配置 linger 或接受显式失败。远程 runtime 登录/OAuth、Foundry 安装不在 `imd` 内，必须人工或另设步骤。

## 4. 纯 CLI 配对与注册

### 4.1 官方 CLI 不是纯 CLI

`imd pair` 的行为（从 `dist/cli.js`）：

1. `POST /pair/start {deviceKey}`；
2. 打印 `https://api.imd.fun/pair?code=<code>`；
3. 每 3 秒 `GET /pair/:code`，直到 `enrolled`；
4. 成功后把 `wallet`、`tokenId` 写进本机 config。

它不接受钱包私钥，也不提供 `--signature` 输入。浏览器页面用 `window.ethereum` 签 EIP-712 并 `POST /pair/complete`。所以“纯 CLI”只能由 colony 复刻协议，不能靠 `imd pair`。

### 4.2 配对协议（可从 CLI 完成）

设备侧先取 deviceKey：`imd whoami`（64 hex）。钱包私钥不需要在 worker 机器上。

`POST https://api.imd.fun/pair/start`

```json
{"deviceKey":"<64 lowercase hex>"}
```

实测响应：

```json
{
  "code": "2QQRNHJP",
  "nonce": "<64 hex>",
  "expiresAt": "2026-10-17T15:10:21.503Z",
  "relayOrigin": "https://api.imd.fun",
  "chainId": 1,
  "nftContract": "0x0000ec93127baa929e58e97dd0095a2bfb38ec1d"
}
```

`GET /pair/:code` 追加 `deviceKey, consumed, enrolled, wallet, tokenId, agentId`；实测未配对时为 null/false。配对码 5 分钟、一次性，`/pair/start` 限 30 次/分钟/IP。

钱包签名（EIP-712，官方页面内联代码的精确形状）：

```js
domain = {
  name: "IdentityMD Worker",
  version: "2",
  chainId: pairing.chainId,                 // 实测 1
  verifyingContract: pairing.nftContract    // 实测 0x0000ec93...
}
types = { WorkerAuthorization: [
  {name:"deviceKey", type:"bytes32"},
  {name:"wallet", type:"address"},
  {name:"tokenId", type:"uint256"},
  {name:"nonce", type:"bytes32"},
  {name:"expiresAt", type:"uint64"},
  {name:"relayOrigin", type:"string"}
]}
message = {
  deviceKey: "0x" + pairing.deviceKey,      // EIP-712 需要 0x
  wallet,
  tokenId,                                  // 十进制字符串
  nonce: "0x" + pairing.nonce,
  expiresAt: Math.floor(Date.now()/1000) + 900,  // 官方页面写法
  relayOrigin: pairing.relayOrigin
}
signature = signTypedData(domain, types, message)
```

注意：

- 官方页面把 `expiresAt` 设为“当前时间 + 900 秒”，而文档说它是 `/pair/start` 的 `expiresAt` 的 Unix 秒；服务端具体校验未知。照官方页面写最稳，但必须在配对码 5 分钟有效期内完成。
- 线格式要求严格：`POST /pair/complete` 的 `message.deviceKey` 和 `message.nonce` 必须是**不带 `0x` 的 64 hex**；`0x` 只用于 EIP-712 的 `bytes32`。官方页面专门注释了这一点。
- `message.tokenId` 是十进制字符串；`message.wallet` 小写 `0x` 地址。

`POST /pair/complete`

```json
{
  "code": "2QQRNHJP",
  "signature": "0x...",
  "message": {
    "deviceKey": "<64 hex，无 0x>",
    "wallet": "0x...",
    "tokenId": "42",
    "nonce": "<64 hex，无 0x>",
    "expiresAt": 1790089500,
    "relayOrigin": "https://api.imd.fun"
  }
}
```

错误：`409` consumed code / enrolled token / `device_serves_another_seat`；`503` ownership unreadable。**成功响应精确 schema 未在文档中给出**；官方页面读取 `body.agentId`、`body.tokenId`，并据此判断是否还要注册。实现应按“有 agentId 即已注册，否则需注册”处理，并对缺失字段报错。

选择 tokenId：`GET /pair/wallet/:address` 返回该钱包持有的 seat：

```json
{"wallet":"0x...","chainId":1,"collection":"0x0000ec93...",
 "tokens":[{"tokenId":"1368","agentId":"52587",
            "device":{"key":"fb1af3f11ddf6470","online":true,"pairedAt":"..."}}]}
```

也可用 `GET /seats/:tokenId` 查 `owner/agentId/status`。

### 4.3 本地 config 同步（关键阻塞）

即使 `POST /pair/complete` 成功，worker 本机的 `~/.identitymd/config.json` 仍没有 `wallet/tokenId`。官方 `imd pair` 会替你做这一步；colony 自己配对则不会。

已确认：

- `imd service install` 在代码里直接检查 `config.tokenId`，没有就拒绝安装服务。
- `imd start` 的任务 receipt 使用 `config.wallet ?? 0x000...` 和 `config.tokenId ?? "0"`；不补写可能产生错误的 receipt 元数据。
- config 还含 `devicePrivateKey`（Ed25519），是 worker 身份，不是钱包私钥；补写时必须保留。

因此纯 CLI 配对要完整可用，colony 会在 worker 机器上对 config 做 read-modify-write，只写 `wallet`、`tokenId`，保留 `deviceKey/devicePrivateKey/server/maxConcurrency/skillsOptOut/inference` 等。钱包私钥不写入该文件；device private key 属于 worker 身份，不输出、不日志。

### 4.4 注册 ERC-8004 agent（链上）

配对只绑定设备与 NFT；未注册的 token 在连接时会被 `agent_unregistered` 拒绝。官方浏览器流程：

1. `POST /agents/bind {tokenId}` 先查已有注册；实测 token 42 返回 `{"tokenId":"42","agentId":"51495"}`。未注册时文档说返回 `agentId:null`。
2. `GET /agents/register-intent?tokenId=<id>` 取 calldata。实测 token 42：

```json
{
  "to": "0xde152afb7db5373f34876e1499fbd893a82dd336",
  "data": "0xb68ca002...",
  "chainId": 1,
  "agentURI": "https://api.imd.fun/agents/by-token/42.json"
}
```

3. 由 NFT owner 钱包发交易：`{from: wallet, to, data}`，`value=0`；链上 adapter 会铸造/绑定 ERC-8004 agent。页面用 `eth_sendTransaction`，然后每 4 秒、最多 30 次 `POST /agents/bind {tokenId, txHash}`，直到返回 `agentId`。
4. 若交易已确认但页面关闭，重新 `POST /agents/bind {tokenId}` 可由 adapter 日志找回，不要重复发交易。

colony 可用环境变量私钥在本地签这笔交易（viem wallet client + RPC），再把 txHash 交给 `/agents/bind` 轮询；钱包私钥不需要上远端。发交易前应确认钱包确实持有 token（`GET /pair/wallet/:address` 或 `GET /seats/:tokenId` 的 owner），否则交易会 revert。注册需要主网 ETH gas；购买 NFT 本身不在 CLI 范围内。

注册与配对是两条独立的链上/链下步骤：先配对（签名，无 gas），再注册（交易，有 gas）。顺序不能反：注册 intent 需要 tokenId，但不要求已配对；官方流程是配对后立即注册。`POST /agents/bind` 是公开的，不需要钱包签名，它只读链。

## 5. 推荐 colony 命令面（仅依据以上事实）

```text
colony task list [--q TEXT] [--before ISO] [--limit N] [--since ISO] [--exclude-oracle] [--json]
colony task show <jobId> [--json]
colony task result <jobId> [--json] [--download DIR]
colony task check -f job.json [--json]
colony task publish -f job.json [--request-key UUID] [--json]
colony orders list|show <orderId> [--json]
colony wallet approve-permit2 [--json]          # 显式链上授权
colony worker deploy --ssh HOST [--runtime claude|codex] [--concurrency N]
colony worker pair --ssh HOST|--local
colony worker register --ssh HOST|--local [--token-id ID]
colony worker start|stop|restart|status|logs|doctor|update --ssh HOST|--local
```

- `--json` 只对 colony 自己组装的 API 输出有意义；官方 `imd` 所有命令都没有 `--json`。
- `task list --mine` 若实现，走 `paid-by` + 本地订单，无法纯服务端分页。
- 订单状态建议保存：`requestKey, requestToken, orderId, status, createdAt, updatedAt, jobId, statusUrl, resultUrl`；requestToken 是 bearer secret，文件权限 0600，不进日志/仓库。colony 保存在 `$COLONY_HOME/orders/`。
- `publish` 必须依次：check 无 blocker → quote → 检查 prepared input → 402 → 两次签名 → submit → 轮询；任何一步失败都保留订单与 token，支持恢复。

## 6. 明确限制与未知

### 已确认限制

1. `/jobs` 无 state/template/wallet 过滤；`count` 是页大小；`limit` 最大 500；全站总数读 `/swarm.counts.jobs`，关键词搜索没有匹配总数。
2. `paid-by` 最多 100 条，无分页，不含 input；丢失 requestToken 后无法完整恢复订单内容。
3. 公共读 120/min/IP；付费 quote 30/min；必须处理 429/Retry-After。
4. x402 仅主网 IMD、0.5 IMD、600 秒 quote；钱包需 IMD 余额 + Permit2 allowance + ETH gas；Safe 不支持。
5. `QuoteApproval` 的 `paymentHash` 对字节极敏感；x402 payload 不允许未知键/非空 extensions。
6. 官方 worker 不在 npm；只有 GitHub tgz；`UNLICENSED`；只有 dist，无源码；Node >=22。
7. 官方 worker 无 `--json`；`status/doctor/service status` 是平台相关文本。远程机器可读状态应走 `GET /workers/:deviceKey/standing` 或 OS 命令。
8. `imd service install` 要求本地 config.tokenId 和已登录 runtime；`--boot` 仅 Linux；Windows 服务依赖 PowerShell/Task Scheduler、登录会话和常亮。
9. Windows 无法对 runtime 读取做 jail；完整 worker 能力应 Linux/WSL/VPS。
10. 纯 CLI 配对在协议层可行，但官方 CLI 不提供；本地 config 的 wallet/tokenId 同步是必须补的缺口。
11. 注册是链上交易，需要 NFT owner 钱包和主网 gas；购买 NFT 不在 CLI 范围。

### 未知/待验证

- `POST /pair/complete` 的成功响应精确字段/错误 detail；只从官方页面确认会读 `agentId/tokenId`。
- `WorkerAuthorization.expiresAt` 服务端是否要求等于 `/pair/start` 的 expiresAt，官方页面用 now+900；未做真实签名验证。
- 纯 CLI 补写 config 后，服务端是否完全接受（尤其 receipt 的 wallet/tokenId）；未实测。
- `imd service status` 输出是否稳定、退出码是否可用于脚本；未在真实服务上验证。
- `--boot` 的 linger 在非交互 SSH 下是否会被 polkit 拒绝；未在 VPS 验证。
- x402 真实 402 challenge 样例与 `PAYMENT-REQUIRED` 解码；未创建/支付订单，避免副作用。
- `POST /requests/check` 对非法 action/超大 body 的具体状态码；只验证了合法 action + blocker 场景。
- Windows 上哪些 skill 会因 jail 不可用而被拒绝；只确认了代码中的 jail 读取限制。
- 官方 release 的 `latest` 会随自动更新变化；colony 若需要可复现部署，应固定 tag + SHA256，而不是只用 `latest`。

## 7. 主要来源

- 文档：<https://imd.fun/docs/>；Markdown：<https://imd.fun/docs/llms.txt>
- OpenAPI：<https://api.imd.fun/openapi.json>
- 能力/价格：<https://api.imd.fun/requests/capabilities>
- jobs：<https://api.imd.fun/jobs>、`/jobs/:id`、`/jobs/:id/result`、`/jobs/:id/submissions`
- paid-by：<https://api.imd.fun/requests/paid-by/:address>
- 配对页（含 WorkerAuthorization 与注册流程内联代码）：<https://api.imd.fun/pair>
- worker：<https://github.com/Identity-md/worker>；release `worker-v0.1.2-c3fba9eb12cc`
- x402：`@x402/core@2.28.0`、`@x402/evm@2.28.0`（npm）
- 本地证据：`.research/docs_llms.txt`、`openapi.json`、`capabilities.json`、`jobs*.json`、`job_detail.json`、`job_result.json`、`job_subs.json`、`paid_by.json`、`pair_start.json`、`pair_state.json`、`pair_wallet2.json`、`register_intent.json`、`bind42.json`、`worker/`、`x402evm/`。`.research/` 仅为公开下载物，不参与构建。
