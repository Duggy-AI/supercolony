# colony

Interactive payments offer two choices: **official fee + 10% optional support** (highlighted first), or **Original price**. The message is “Help us make Colony better.” Final payment confirmation still defaults to Cancel. For a 0.5 IMD task, the support option totals 0.55 IMD before network fees. The payment card shows the official fee, the coin and network it pays with, the payment amount and, separately, the gas (network fee) cap paid in ETH. Swap slippage is calculated automatically: 0.75%–5% on Ethereum and 0.75% on Robinhood. Authorization covers only the reviewed maximum; slippage is never increased after confirmation.

Support goes to the public address in `src/lib/support-recipient.mjs` on the selected payment network. The private key is never distributed with Colony. Support is a separate IMD transfer sent before task payment; it is not refunded if task admission fails. The review shows the support amount, total and recipient. Signed transfers are saved before broadcast and reused on recovery. Non-interactive commands and `--yes` use the original price without adding support.

面向 IMD 使用者的 CLI：创建任务、查看自己的任务、获取结果并继续修改，也能直接部署和管理自己的 worker。

- Node.js **22+**，ESM JavaScript；开发使用 `src/`，npm 发布压缩并混淆后的 `dist/`。
- `supercolony` 和 `colony` 是等价命令，所有子命令和参数相同，避免与官方 worker 的 `imd` 冲突。
- 读取任务不需要钱包；发布任务支持 Ethereum 的 x402 签名付款及 Robinhood Chain 的链上报价付款。Wallet 页面支持创建和导入钱包，私钥以密码加密后保存在本机。
- worker 命令复用官方 `imd`，详见 [docs/plan.md](docs/plan.md) 和 [docs/research.md](docs/research.md)。

## Quick start (English)

### Interactive dashboard

After local installation, run `colony` with no arguments, or `colony ui`, to open the terminal workspace. From this repository, use `node src/cli.mjs`. The dashboard uses real task, order and worker data; no demo data is included.

```sh
colony
colony ui
colony --ascii
```

If this computer has no wallet yet, launching the dashboard first offers **1. Create a new wallet** (the default; you set a local password and confirm it) or **2. Not now** (browse without a wallet; Esc does the same). The new wallet is empty; press `b` to back it up and `d` to add funds. The offer appears on each launch until a wallet exists.

The dashboard has **My tasks**, **Explore**, **Workers** and **Wallets** at the top. Terminals at least 80 columns wide show a list and details side by side; below 80 columns, Enter opens details and Esc returns to the list. Use an interactive terminal at least 40 columns by 20 rows. `--ascii` uses ordinary ASCII borders. Special fonts, WSL and a browser are not required.

Panel actions stay visible along the bottom of their frame. Task lists contain New task, Search and Refresh; My tasks also has Filter. The Workers list contains Add target, Search and Refresh, while the selected worker's actions stay in its details pane. Wallet actions and Refresh belong to the selected wallet; New, Import, Manage and Receive funds remain in Wallet management. Selection and Enter/Tab hints stay in the list; return, scrolling and detail-tab hints stay in the details pane. Shortcuts wrap as whole entries on narrow terminals. The screen footer contains only global Help and Quit; during input, confirmation or an operation, it shows Ctrl+C to exit.

| Key | Action |
| --- | --- |
| `1`–`4` | Switch workspace |
| `n` | Describe a task, then review its official fee |
| Up / Down, Enter, Esc | Select, open, return |
| `/`, `f`, `r` | Search, cycle My tasks filters, refresh |
| Tab, `[` / `]`, Page Up / Down | Focus list/details, switch detail tab, scroll |
| `d`, `s`, `c` | Fetch result files, save verified files, request project changes |
| `v` in My tasks / Explore | Show the official IMD task link |
| `o` | Inspect/resume a saved local order |
| `x`, `m` in My tasks | Cancel an unsigned request; open available task actions |
| `a`, `m`, `l`, `g` in Workers | Add an SSH target, actions, logs, diagnostics |
| `n`, `i`, `m` in Wallets | Create wallet, import a private key or backup, selected wallet actions |
| `u`, `g` in Wallets | Use the selected wallet, manage all wallets |
| `d`, `b` in Wallets | Receive funds / QR code, back up encrypted wallet |
| Down at the end of Explore, `l` | Automatically load older tasks; `l` also loads/retries manually |
| `e`, `?`, `q` | Full error, keyboard help, quit |

Form fields use Enter to advance/submit and Tab to switch fields. A new task asks only for your request, then uses the local planner and the existing IMD payment/order workflow. You never pick a network up front. Colony checks Ethereum and Robinhood Chain together and picks a coin and network with enough balance (IMD first, then stablecoins, then ETH; the lower-gas network wins ties). The payment card shows the official admission fee, "Pay with <coin> on <network>", the payment amount and the gas (network fee) cap separately; confirmation defaults to **Cancel**. **Change payment** lists the other funded options with their amounts. If no option has enough funds, the card lists both networks side by side, for example "0.5 IMD or ≈ 2.01 USDC or ≈ 0.0006 ETH" plus gas, and suggests the smallest top-up. **Add funds** first asks which network you will send on, then shows that network's address, QR code and amounts. Tab selects the payment action, Enter confirms, and Esc returns to editing without signing. `--yes` never bypasses this dashboard confirmation. `i` reveals the payment network, asset, recipient and server-prepared input. Task admission does not guarantee completion. Wallet authorization transactions can incur separate gas fees.

After a task is published, Colony displays its official page at `https://explorer.imd.fun/jobs/<jobId>`. The dashboard shows the link in a full-width panel; Enter or Esc returns to the workspace, and `v` shows it again from My tasks or Explore. CLI creation, continuation, saved-order submission and `task show` also print the link. JSON publication output and order summaries expose it as `taskUrl`. Drafts and unpaid orders have no task link until IMD creates a job.

Explore shows the server's actual task total and refreshes in the background every 30 seconds. New tasks appear at the top, changed states update in place, and the selected task, loaded history and detail scroll position are preserved. Refreshing pauses during forms, payment confirmation and worker operations. Read errors are visible and the next scheduled refresh retries. Reaching the end of the loaded list automatically appends older tasks. Loading, errors and the end of history are visible; search results show the loaded count until all matches have been fetched because the API does not provide a search total. `r` reloads the latest list and resets loaded history.

The selected active task refreshes every five seconds while its workspace is idle. Only real server states are shown; the UI does not invent progress percentages or completion times. Completed tasks expose delivery files and a paid continuation flow. My tasks keeps local orders that have not produced a job, including recoverable interrupted payments.

Select an unpaid request and press `x`, or `m` → **Cancel request**. Confirmation defaults to **Keep request**. Cancellation is local and prevents Colony from signing or resuming that request; no wallet or network is needed. The record remains visible as **Cancelled**, with a separate filter. Use `m` → **Delete local record** to remove it permanently. Signed payments and published jobs cannot be cancelled through IMD's public API, and their recovery records are retained. The footer only shows actions available for the selected item.

Worker deployment, pairing, registration, service installation and hidden credential prompts temporarily take over the terminal and return to the dashboard after Enter. They use the existing official-worker commands and their confirmations. SSH targets are read from the existing worker state; a new target is remembered for the current session and recorded by the existing deployment flow. Wallet supports creating or importing a password-encrypted local wallet.

Workers lists your **Mine** management targets first, followed by the public **Network** directory from IMD. Public workers are sorted by Available → Busy → Paused → Connection unconfirmed, then by free concurrency slots (descending), then device ID for stable ties. This is an availability order, not a quality ranking. Press `/` to search by worker ID, runtime or skill, and `r` to refresh while keeping the selected worker. Public entries show capacity, runtime/model, skills, platform and heartbeat; management actions apply only to your saved targets. If the public directory fails, its error remains visible and your management targets stay accessible.

Read queries automatically retry temporary network failures, rate limits and server errors, with at most **three total attempts**. API and Worker release queries default to 3 seconds between attempts; RPC queries use the SDK's 3-second then 6-second backoff. Queries honor the server's Retry-After when provided. Cancelling interrupts the wait when the caller supplies an abort signal. Missing resources and permission errors are reported immediately. Task validation is a read-only query; order creation, payment submissions and Worker mutations are not automatically repeated by this policy. Model/artifact downloads retain their separate download handling.

Ordinary commands and `--json` keep their existing behavior. When stdin/stdout are redirected, the bare `colony` command prints help; `colony ui` requires a TTY and rejects `--json`. Windows native ConPTY and Linux PTY validation are covered by `test/tui-pty.test.mjs`; macOS is in the platform CI matrix and still requires a real Mac run before claiming hardware acceptance.

```sh
git clone <repository>
cd super_colony
npm install
node src/cli.mjs --help
node src/cli.mjs task create "Build a landing page for my bakery" --dry-run
```

Natural-language planning uses Qwen3.5-0.8B Q4_K_M (about 533 MB) locally: CPU on Windows, Linux and Intel Macs, and Metal on Apple Silicon. Windows and Linux have passed actual model and CLI checks; macOS still needs execution on a Mac. See [validation details](docs/local-planner-validation.md).

Model downloads try Hugging Face first and automatically switch to [HF-Mirror](https://hf-mirror.com/) if the network request fails. Both sources use the same pinned model and SHA-256 verification. After setup, inference runs from the local cache.

First-time preparation names **Qwen** (about 533 MB) and explains its purpose: understanding your request locally and selecting task settings. IMD workers execute the task. The model downloads once, is reused locally, and needs no external AI API key. Download, verification and loading have separate steps; the download bar shows percentage, transferred MB, speed and the current source website (`huggingface.co` or `hf-mirror.com`). Switching to the backup source updates the website and resets the bar. A verified cache skips downloading. Redirected output uses plain milestones on stderr, and `--json` keeps stdout as one JSON document.

Before a paid task loads the local LLM or requests an order, Colony checks the selected wallet, payment coin and ETH network fee allowance using the current IMD price and live exchange quotes. If funds are insufficient, the dashboard shows the receiving address and network with **Check balance & continue**. The entered task is kept. This read-only check needs no wallet password; the final review includes the exact quote and any optional support. `--dry-run` remains available without a wallet. Startup tips explain natural-language tasks, automatic task settings, local inference and payment review.

The dashboard saves your request as a local **Draft** before checking the wallet or downloading the LLM. If no wallet exists, choose **Open Wallets** to create/import one, or return to My tasks. Drafts survive restarts; select one and press `o` to continue editing and publishing. Task actions also let you delete an unwanted draft. Once an order is saved, it takes over the same local request ID and replaces the draft in My tasks.

When the balance is insufficient, choose **Add funds** to open the receiving QR code for that payment's wallet and network. Press Esc to return to the same balance prompt, then **Check balance & continue** after depositing. Saving the QR with `s` is also available. Your request and completed payment steps are kept; balances, exchange rates and fees are checked again before the payment review.

## 安装

需要 Node.js 22+，Windows、Linux 和 macOS 使用相同安装命令。npm 包名为 `supercolony`：

```sh
npm install -g supercolony
```

安装后 `supercolony` 和 `colony` 都能启动程序，以下示例使用 `colony`，均可替换为 `supercolony`。

从源码或本地打包安装：

```sh
npm install
npm pack
npm install --prefix /path/to/prefix ./supercolony-0.1.0.tgz
/path/to/prefix/node_modules/.bin/colony --help
```

也可以直接在仓库里运行：

```sh
node src/cli.mjs --help
```

依赖会安装到项目本地。不要把钱包私钥写进 `.env`、脚本参数或仓库。

### 发布到 npm

在项目目录执行（CMD、PowerShell、Bash 都可）：

```sh
npm ci
npm run check:package
npm run test:dist
npm login --registry=https://registry.npmjs.org
npm publish
```

`npm pack` 和 `npm publish` 都会自动构建并混淆。发布包只包含混淆后的 `dist/`、`package.json` 和 README；不包含 `src/`、测试、研发脚本、内部文档、模型权重或 source map。混淆在本地通过 [javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator) 完成，重命名内部标识符并提取字符串；保留模块接口和属性名，不启用控制流平坦化、死代码注入或反调试。固定种子使同一份源码和依赖生成相同产物。混淆只能提高阅读成本，不能彻底隐藏代码，也不能用于保护内置密钥。原生依赖由 npm 根据用户平台安装，模型首次使用时另行下载；混淆器仅是开发依赖。

发布成功后，用户使用 `npm install -g supercolony` 安装，再运行 `supercolony` 或 `colony`。两个命令指向同一个程序入口，所有子命令和参数相同。后续发布前需要提高 `package.json` 的版本号；已发布的同名版本不能覆盖。

## 全局参数

```text
--api <url>        IMD API，默认 COLONY_API_URL 或 https://api.imd.fun
--home <dir>       本地状态目录，默认 COLONY_HOME 或 ~/.super-colony
--rpc <url>        可选自定义 RPC，也可用 COLONY_RPC_URL；两条付款链已内置默认节点
--payment-chain <network>  可选，只在 ethereum 或 robinhood 上付款；默认按余额自动选择
--pay-with <coin>  可选，只用 IMD / ETH / USDT / USDC / USDG 付款；默认按余额自动选择
--key-env <name>   可选脚本用私钥环境变量；没有本地钱包时使用，默认 COLONY_PRIVATE_KEY
--json             只向 stdout 输出一份 JSON；提示/日志走 stderr
--yes              跳过交互确认（脚本用）
```

全局参数可以放在子命令前或后。成功退出码为 0；HTTP、确认、校验错误为非 0。

## 浏览任务

```sh
colony task list --limit 20
colony task list --q report --before 2026-10-17T10:00:00Z --exclude-oracle --json
colony task show <jobId>
colony task result <jobId>
```

`task list` 直接透传服务端 `GET /jobs`，没有本地状态。服务端只支持 `q/before/limit/since/exclude=oracle`，没有 state/template/wallet 过滤；`count` 是页大小，不是总数。`task result` 会打印产物 hash 和公开下载 URL。

### 等待完成与下载产物

```sh
colony task wait <jobId> --timeout 600 --interval 5
colony task download <jobId> --out ./output
```

`task wait` 默认每 5 秒查询一次，最多等待 600 秒；完成后输出结果。任务 blocked/cancelled 或等待超时退出码为非 0，Ctrl+C 停止等待。等待本身不改变服务端任务，也不创建订单。`--json` 的结果写入 stdout，查询进度写入 stderr。

`task download` 下载已完成任务的 `files`，保留产物的相对目录，逐文件校验字节数和 SHA-256 后保存。它不覆盖已有文件、不解压 source bundle；下载失败保留已经校验保存的文件并清理临时文件。输出目录应由这次下载独占，避免其他程序同时修改其目录结构。

### 我的任务

```sh
colony task mine                       # 合并本机记录和当前钱包的远端任务
colony task mine --address 0x...        # 查看指定钱包，无需私钥
colony task mine --local               # 只看本机记录，不联网
colony task mine --limit 10 --json
```

列表区分任务执行状态、订单状态和付款状态，保留尚未产生任务的本机订单。没有配置钱包时只显示本机记录，并说明数据来源。服务端 `GET /requests/paid-by/:address` 仅提供最近最多 100 条订单；完整恢复依赖 `--home` 下的订单文件。`order list/show/submit` 用于检查和恢复支付订单。

## 创建任务

直接用一句话描述需求即可，不需要选择 skill、template 或 preset：

```sh
colony task create "Build a landing page for my bakery"
colony task create "比较三种 EVM 测试方案，给出来源" --dry-run
```

自然语言路径先用本机模型做一次有限结构化决策：模型只从 runnable route criteria 中选一个最终交付物（报告、网站、图片、音频、视频、新合约项目等），再由代码组装固定的输出路径和 IMD job body；模型不生成自由文本计划，也不决定付款、parent 或落地参数。默认模型为 Qwen3.5-0.8B **Q4_K_M**，约 533 MB，首次使用下载到 `$COLONY_HOME/models/`，之后在本地运行，不调用付费推理服务：Windows、Linux 和 Intel Mac 使用 CPU，Apple Silicon 使用 Metal。目标原文保持不变，计划完成后展示简要 summary 和 deliverables。

Windows 和 Linux 容器均已执行真实模型及 CLI 验证；macOS 已配置对应后端和 CI，尚未真机运行。实测范围和复现命令见 [本地模型验证记录](docs/local-planner-validation.md)。

首次下载优先使用 Hugging Face，网络访问失败时自动切换 [HF-Mirror](https://hf-mirror.com/)，无需用户设置镜像变量。两个下载源使用同一固定版本并校验文件大小及 SHA-256。已下载并校验通过的模型直接使用本地缓存。

`--dry-run` 只做免费检查，纯文本展示 summary、deliverables 和 check 阻塞原因；`--json` 模式才包含实际 input 和 check。dry-run 不创建订单、不需要钱包。正式发布和继续修改任务只获取官方报价，展示实际价格、最高扣款和网络费上限后确认付款。非交互付款仍需显式 `--yes`。`--save job.json` 可保存输入；保存不会覆盖已有文件。

模型当前只输出一个 route choice，不生成自由文本计划或 parent，也不承诺预计完成时间。真实链上部署、发币或交易不会伪装成普通 `job.open`。`--answer` 会把补充信息加入决策上下文，并以 `Clarifications:` 块追加到原始 objective 之后；原始 objective 保持为完整前缀，worker 会收到这些补充信息。

显式路径保持兼容，且不会加载本机模型：

```sh
colony task create "比较三种 EVM 测试方案，给出来源" --preset report --dry-run
colony task create "比较三种 EVM 测试方案，给出来源" --preset report
colony task create --file examples/research-job.json
```

可以用 `--skill <id>` 或 `--template <name>` 明确选择执行方式；复杂任务仍可使用 JSON 文件。显式 `--file`、`--preset`、`--skill`、`--template` 不使用模型。报告预设使用 `research-report`，输出 `artifacts/report.md`，默认不发布到 GitHub；需要时加 `--github`。

先检查，不产生订单、不付费：

```sh
colony task check --file examples/research-job.json
```

发布：

```sh
colony wallet create                         # 或 colony wallet import，私钥输入隐藏
colony task create --file examples/research-job.json
```

流程：

正式创建和续作任务时，Colony 会在任务描述末尾另起一行添加 `via supercolony`。原始输入用于本地编辑和恢复，提交内容在报价前固定保存；重试和报价续期不会重复添加署名，已保存的旧订单保持原提交内容。

1. 先以公开地址检查余额和 gas；自然语言输入随后由本地模型选择任务参数。`POST /requests/check` 有 blocker 立即停止；
2. 生成并保存 `requestToken` 和 `requestKey`，再 `POST /requests/quote`；
3. `POST /requests/:id/submit` 取得真实 402 challenge；
4. 在 stderr 展示 network、金额、资产、收款方、有效期，以及**服务端 prepared input**；确认后才签名；
5. 同一钱包签 Permit2 支付和 `QuoteApproval`；
6. 先保存 payment header 与 quoteSignature，再提交；轮询到 `admitted`。

`--yes` 供脚本跳过确认。没有 `--yes` 且不是 TTY 时，命令会失败而不是静默付款。

原来的 `task publish --file ...` 保留；与 `task create --file ...` 使用同一套支付和订单恢复流程，也接受 `--pay-with <coin>`。

### 在已有任务上继续修改

```sh
colony task continue <jobId> "补充性能对比和复现步骤" --dry-run
colony task continue <jobId> "补充性能对比和复现步骤"
colony task continue <jobId> --file changes.json
```

自然语言续作同样使用本机模型选择 `same` 或其他支持的路线，但 `parentJobId` 始终由代码绑定为真实 parent，模型不能修改；续作输入不会重新带 `repoUrl` 或 `baseCommit`。显式 `--file`、`--skill`、`--template` 路径不加载模型。指定 `--request-key` 恢复已保存订单时直接复用原输入，不重新生成。

续作产生项目的下一版任务，使用 `job.continue`，也需要支付。指定的任务必须是项目最新版本，满足服务端续作条件；CLI 不会自动换成另一个版本。付费前检查原项目所有者与当前钱包是否一致。旧版本、运行中或尚未交付等问题会在检查阶段给出原因。

金额、资产、收款方、网络只取自真实 quote/challenge；不会硬编码。Permit2 deadline 会被收紧到 quote 过期时间之前；未付款 quote 过期或接近过期时，继续原任务会获取新报价，付款前重新确认。

### 恢复订单

充值或网络错误后，继续已保存的任务：

```sh
colony order list
colony order show <orderId 或 requestKey>              # 只读本地
colony order show <orderId> --refresh                  # 显式查询服务端并更新本地
colony order submit <orderId>
colony order cancel <orderId 或 requestKey>            # 取消未签名、未提交的本地请求
colony order delete <orderId 或 requestKey>            # 永久删除已取消的未付款记录
```

`order show` 默认只显示本地保存的状态，不联网；`--refresh` 才会用已保存的 requestToken 调 `GET /requests/:id`，并更新本地状态。恢复前可以先 `--refresh`，已经 admitted 的订单不会再提交。

`order cancel` 和 `order delete` 都默认要求确认，脚本可显式传 `--yes`。取消不调用服务端取消接口，也不承诺退款；它仅适用于从未签名、提交的本地请求。已签名或已发布的订单保留恢复信息，不能用本地删除冒充停止执行。取消标记与服务端状态分开保存，刷新服务端状态不会使请求重新变为可付款。

`order submit` 可继续未付款任务并刷新报价、兑换价格和 gas；恢复时先核对已保存交易。新报价在同一个本地任务中保存历史，用户无需重新描述需求。已确认的兑换、授权和支持付款不会重复执行。如果 quote 响应丢失（本地还没有 orderId），也可用错误提示中的同一 `requestKey` 重试：

```sh
colony task publish --file examples/research-job.json --request-key <requestKey>
colony task create --request-key <requestKey>
colony task continue <jobId> --request-key <requestKey>
```

`create` / `continue` 只传 `--request-key` 时会使用已保存的输入，不需要重新填写需求；指定其他输入时仍核对其与原订单是否一致。

创建本地记录后的错误会给出已保存的 `requestKey`、`--home` 和 `--api` 恢复命令。已签名支付过期时先查原订单，再根据 finalized 链状态核对支付：Ethereum 检查 Permit2 deadline 和 nonce，Robinhood 检查合约到期和交易回执。只有确认旧支付未扣款且已无法再生效，才允许重新报价和确认；仍可能有效或已经扣款的支付只恢复原记录。

支付进度分别显示授权、换币、支持费转账、任务付款与 IMD 接收。等待链上确认超时会保留任务和交易哈希，显示待确认而不是付款失败。在 My tasks 继续原任务即可检查进度；需要提高 gas 时先展示新网络费，再以相同 nonce、收款方、金额和内容更新交易，原交易与更新交易只可能执行一个。所有候选交易在广播前保存；恢复会核对每个哈希，避免原交易先确认时重复执行。Ethereum gas 参考最近五个区块的成交优先费，并为基础费波动留出余量。更新 gas 的确认不代表链上成交保证。

如果服务端 `status=admitted` 但 `admission.result.kind=refused`，命令以非 0 退出，明确报告“已付费但任务被拒”，输出/保存拒绝原因和付款交易，不把它当作发布成功。用 `colony order show <id> --refresh` 查看。

订单文件在 `$COLONY_HOME/orders/`，权限 `0600`；包含 requestToken、payment header、签名，不应提交到 git 或贴到日志。

## 钱包

运行 `colony`，按 `4` 进入 Wallets。页面分为三个区块：左栏列出钱包并标记 Current，右上显示所选钱包的余额和操作，右下 Wallet management 管理所有钱包。`m` 打开所选钱包的操作；`g` 打开整体管理，`n` 新建、`i` 导入钱包（私钥或加密备份）、`p` 选择所有钱包共用的付款网络。上下键浏览不会切换付款钱包，按 `u` 设为当前钱包；Enter/Tab 切换列表与详情，窄屏 Esc 返回列表，整体管理区始终可见。新增或导入钱包后自动选中它，原钱包仍保留；切换选择会保存到本机，重启后继续使用。所有本地钱包共用首次设置的密码，解锁后新增钱包无需再设置密码。付款使用当前钱包；余额、收款和备份使用所选钱包，已付款任务按当前钱包地址查询。钱包页不再提供单独的授权操作；必要时使用 CLI 的 `wallet approve` 命令。

私钥和密码均隐藏输入，不必配置环境变量。钱包采用标准 Ethereum V3 JSON Keystore：首个钱包保存在 `$COLONY_HOME/wallet.json`，其他钱包保存在 `$COLONY_HOME/wallets/<address>.json`；已有首个钱包无需移动或改写，其密码就是本地统一密码。`wallet-selection.json` 仅记录当前公开地址。界面不显示锁定状态，也无需手动解锁。只有付款、授权、新增或导入等需要使用密码的操作才会询问；本次运行中已输入的密码可复用，付款仍需确认金额。浏览、查余额、收款和加密备份不需要密码。退出仪表盘清除当前进程内的密码和签名账户缓存，密码不以明文保存在磁盘。

在所选本地钱包的 `m` → **Delete wallet** 中可删除钱包。两次确认均显示完整地址并默认保留；完成两次确认后删除本机加密私钥。链上资金、已导出的备份和任务记录保留。删除当前钱包会选择另一个本地钱包，删除最后一个后可重新创建或导入；其他钱包仍使用原来的统一密码。

`d` 展示充值地址和二维码，`s` 可保存 SVG。请在发送方选择页面显示的 Ethereum 或 Robinhood Chain，并留一些 ETH 支付网络费。二维码只含公开地址、不包含私钥或密码，也不会替发送方自动选择网络。余额查询、充值和加密备份不需要解锁。终端太小时会提示扩大窗口或导出二维码，不显示被裁剪的二维码。

首次充值前按 `b` 备份所选钱包，并单独保管本地统一密码。每个钱包需要分别备份。恢复需要备份文件和它原来的密码；恢复到已有钱包库时，使用本地统一密码重新加密。恢复到空目录时，备份密码成为本地密码。Colony 无法找回丢失的密码。创建、导入和恢复会添加钱包，不覆盖已有钱包；重复地址提示切换到已保存的钱包。备份和二维码导出也不会覆盖已有文件。

查看私钥：选中本地钱包，按 `m` → `View private key`。每次查看必须重新输入密码，即使本次运行已输入过密码；验证通过后在独立页面显示所选钱包的私钥，不切换当前付款钱包。按 Esc 隐藏并返回，退出时也清除展示状态。

```sh
colony wallet create
colony wallet import                          # 隐藏输入私钥，然后设置加密密码
colony wallet list                            # 列出本地钱包，* 表示当前钱包
colony wallet use <address>                    # 切换当前钱包
colony wallet receive
colony wallet receive --out colony-receive.svg
colony wallet backup --out colony-wallet-backup.json
colony wallet restore --file colony-wallet-backup.json  # 添加并选中恢复的钱包
colony wallet address
colony wallet status                           # 同时列出 Ethereum 和 Robinhood Chain 的余额
colony wallet approve --amount 0.5
colony task create "Build a website for my coffee shop"     # 自动选择网络和币种
colony task create "Write a research report" --payment-chain robinhood   # 只在 Robinhood Chain 付款
```

- 本地钱包优先使用，私钥只以加密形式写盘，不上传。`--key-env` 仅保留给没有本地钱包的脚本用法，普通用户无需使用它。密码不接受命令行参数，也不写入订单、日志或终端交接消息。
- `wallet approve` 是显式链上交易，只授权指定数量；Ethereum 授权 Permit2，Robinhood 授权真实报价对应的 Intake，**不会默认无限授权**。
- CLI 可用 `wallet approve --amount 0.5 --wallet <address>` 明确指定预期地址。确认时显示该地址，签名前若当前钱包已经改变则停止。任务付款也绑定本次流程开始时的钱包，避免另一终端切换钱包后从不同账户付款。
- 支持 Ethereum 与 Robinhood Chain 两条正式付款链，公共 RPC 均已内置。普通用户无需设置 RPC，也不需要切换网络：同一个地址在两条链上通用，余额分别计算。每次付款时 Colony 同时查询两条链，自动选一个余额足够的方案（优先直接用 IMD，其次稳定币，再次 ETH；同类中选 gas 更低的网络）。确认卡上的 `Change payment` 可改用其他余额足够的网络或币种。不提供 Sepolia 测试币付款。
- 付款金额和 gas（网络费）分开显示。gas 总是用同一网络上的 ETH 支付；用 ETH 付款时，付款和 gas 都从 ETH 余额扣。
- 余额不足时，提示页并排列出两条链各自的价格、每种可用币种的金额（例如 “0.5 IMD 或 ≈ 2.01 USDC 或 ≈ 0.0006 ETH”）、gas 估算和最省事的补足方式。选择 `Add funds` 后先选打算转入的网络，再显示该网络的收款地址、二维码和需要的金额。
- Ethereum 沿用 x402 签名付款；Robinhood 使用同一份 HTTP 订单返回的签名报价，通过 Intake `pay` 结算。任务和续作仍进入同一个“我的任务”列表。已经签名或广播过的订单恢复时固定使用原付款网络和币种。
- 直接用 IMD 支付时，两条链都会检查余额和授权额度；额度不足会在付款确认后自动授权本次所需数量，无需另外运行命令。原价、可选支持和自动换币使用同一付款准备流程。确认卡显示实际网络、价格、最高扣款及 ETH 手续费上限。
- Robinhood 的签名交易及其哈希在广播前保存。中断后 `order submit` 先查原订单和交易；需要重发时只广播原字节，不创建新订单、不重新签付款。签过的记录不能本地取消或删除。
- `wallet status` 从 capabilities 读取资产/价格，同时查询两条链的付款币种余额及 IMD 支付额度，并校验节点链 id。某条链暂时不可用时，只在该链下显示错误。
- `--rpc` / `COLONY_RPC_URL` 仅用于显式覆盖默认节点。自定义节点失败或链 id 不符时直接报错；不自动切换到其他节点。付款只支持这两条主网；其他网络的 worker 链上操作需要显式提供 RPC。
- 开发/CI 不应执行真实 approve 或 register 交易。

### 自动换币付款

Ethereum 支持 **IMD、ETH、USDT、USDC**；Robinhood Chain 支持 **IMD、ETH、USDG**。默认自动选择余额足够的币种和网络；CLI 可用 `--pay-with` / `--payment-chain` 限定，仪表盘在确认卡上用 `Change payment` 更换。尚未签名的订单恢复时也可以更换付款方式。

```sh
colony task create "Build a website for my coffee shop" --pay-with USDC
colony task create "Write a research report" --payment-chain robinhood --pay-with USDG
colony task continue <jobId> "Add a contact form" --pay-with ETH
```

默认直接展示报价计算出的实际价格、最高扣款和网络费上限，确认后才执行换币。付款边界来自报价本身：ETH 最高扣款包含本轮授权、换币及链上付款的网络费上限，稳定币最高扣款限制该币扣款，另需 ETH 支付确认页列出的有上限网络费。

Colony 直接调用 [Uniswap v3](https://developers.uniswap.org/deployments) 合约，通过已配置的 RPC 获取报价，无需聚合器或兑换 API Key。程序比较少量候选路径的兑换额和预计网络费，自动选择其中总成本最低的方案。网络费比较采用保守的 Gas 上限，并按链上报价换算为付款币；稳定币付款的 Gas 仍另用 ETH 支付。已有授权、USDT 必要的授权重置和任务付款费用也计入比较。

每次精确购买订单所需的 IMD，不兑换用户全部余额。确认页显示预计付款、最高扣款和网络费上限。Ethereum 自动滑点为「兑换 Gas 成本 ÷ 兑换报价金额 × 1.25」，范围 0.75%–5%；Robinhood 为 0.75%。算法参考 [Uniswap 历史自动滑点实现](https://github.com/Uniswap/interface/blob/682215a574d9b3164bc7ce0587f84de080edf8ed/src/hooks/useAutoSlippageTolerance.ts)，适度放宽成交容忍度。两项成本都用付款币种计价，以精确输出的输入报价代表兑换金额；Gas 成本采用兑换 Gas 额度乘当前每 Gas 费用上限，不含授权、任务付款或支持费用，无需新增网络查询。这是成本比例的经验算法，不是价格预测或防夹保护。最高输入向上取整到付款币的最小单位，确认后不会自动扩大。没有额外的价格影响门槛。授权仅覆盖本次最高兑换金额，不设无限额度。兑换交易由 Colony 本地构造，固定本人收款地址、到账 IMD、最高输入金额和截止时间，ETH 余款在同一笔交易内退回。没有可用路径、超过最高输入或报价无法执行时停止，不自动加价。这里比较的是内置候选路径，网络费是估算，不保证全市场最低价。

兑换、授权与任务付款是独立交易，不能整体回滚。若兑换完成但任务提交中断，IMD 留在本人钱包；多余 IMD 也保留在钱包。用 My tasks 的 `o` 或 `colony order submit <orderId>` 恢复同一订单。每笔已签交易在广播前保存，恢复只查询或重发原字节，不重复购买；`order show` 和 Activity 可查看兑换进度和交易哈希。已签过交易的恢复记录不能删除。服务限流、无有效路径或报价超过上限时会明确停止，不自动更换服务、提高最高输入或跨链兑换。

## worker

worker 命令复用官方 `imd`，本机默认，远程只支持 Linux SSH。目标机前置：Node.js 22+、npm、git、curl；Claude Code 或 Codex 已安装并完成登录；合约工作还需要 Foundry v1.8.3；钱包已持有 IMD NFT。`deploy` 只安装并校验官方 release，不配对、不启动；`service install` 要求已经配对、注册并有可用 runtime。

远程 Linux 的完整顺序：

```sh
# 1. 安装官方 worker release（校验 SHA-256，写入 colony 管理的 prefix）
colony worker deploy --ssh user@host

# 2. 在 Wallet 导入 NFT owner 钱包；私钥只在本地解密签名，不传到 worker
colony wallet import
colony worker pair --ssh user@host --token-id 42

# 3. 显式链上注册 ERC-8004 agent（需要 RPC 和 gas）
colony --rpc https://... worker register --ssh user@host --token-id 42 --yes

# 4. 安装并启动后台服务；远程 Linux 用 --boot 保持 SSH 退出/重启后运行
colony worker service install --ssh user@host --boot --auto-update --runtime claude --concurrency 2

# 5. 运维
colony worker status --ssh user@host
colony worker logs --ssh user@host --follow
colony worker doctor --ssh user@host
```

本机 Windows 去掉 `--ssh`，并且不要使用 `--boot`；Windows 服务随登录启动，机器需要保持登录和唤醒。Windows 上官方 runtime sandbox 不能对读取做 jail，完整任务能力应使用 Linux/WSL/VPS。

其它命令：

```sh
colony worker run [--runtime claude|codex]      # 前台 imd start，Ctrl+C 停止
colony worker start|stop|restart               # 官方 imd service 命令
colony worker service install|start|stop|restart|status|logs|uninstall
colony worker update [--version <tag>]         # 同一 prefix 重新校验安装
```

### 身份、技能、工具与 RPC

这些都是日常 worker 管理命令，同样支持本机和 `--ssh user@host`：

```sh
colony worker whoami
colony worker skills list
colony worker skills add <skillId>
colony worker skills remove <skillId>
colony worker tools list
colony worker tools add                       # 交互添加工具
colony worker tools key <name>                # 隐藏输入凭证
colony worker tools forget <name>
colony worker tools remove <toolId>
colony worker rpc list
colony worker rpc add <chainId>               # 隐藏输入 RPC URL
colony worker rpc remove <chainId>
colony worker unlink                         # 解除官方 worker 配对
```

`tools add <toolId>` 也支持官方 `--command`、重复的 `--arg` / `--env` / `--probe` / `--enable` 参数，详见 `colony worker tools add --help`。`--env` 指定环境变量名，凭证通过 `tools key` 输入。

需要隐藏输入的命令要求交互终端，不接受 `--json`；SSH 会为这些命令分配终端。非交互命令的 `--json` 包含官方输出和退出码。`worker rpc` 管理 worker 使用的链端点；全局 `--rpc` 用于钱包授权和注册交易。

远程目标还支持 `--identity <path>`、`--port <port>`、`--worker-home <dir>`、`--prefix <dir>`。`worker status` 返回官方 service 原始输出加控制面 standing；`logs --follow` 是原始流，`--json` 不适用。

`deploy`/`service install` 分开是刻意的：deploy 不启动；没有配对、注册和已登录 runtime 时，service install 会明确失败。`--auto-update` 是官方 worker 对其**当前 cli 安装目录**做原地更新，不会切换 colony 的 prefix；使用自定义 `--prefix` 时，更新仍留在该 prefix。

### Linux 容器验证

仓库提供独立 Docker Compose 测试环境，不挂载宿主钱包、runtime 登录信息或 Docker socket，也不开放端口：

```sh
docker compose -f container/compose.yml up -d --build
docker exec colony-worker-test colony worker deploy --json
docker exec colony-worker-test colony worker doctor --json
docker compose -f container/compose.yml stop
```

该测试容器默认保持空闲，供 `docker exec` 执行 CLI；它不会自动接单。容器中的安装与状态保存在专用 volume，停止容器后保留。普通容器没有 systemd，官方 `worker service` 和真实接单还需要单独验证；容器重启不能证明 worker 后台服务已运行。完整验收步骤与实际结果见 [docs/container-validation.md](docs/container-validation.md)。

## 测试

```sh
npm test
```

`npm test` 只运行 `test/*.test.mjs`，覆盖主 CLI 与 worker 模块。测试使用本地 HTTP mock/process stub，不发送真实 quote、支付、配对、部署或链上交易。

## 限制

- 发布只走 x402；没有链上 Intake 备用路径。
- 读取端点受公共限流影响，遇到 429 请按 `Retry-After` 退避。
- 服务端 `/jobs` 无状态过滤，`paid-by` 最多 100 条。
- 官方 `imd` 没有 JSON 输出；worker 状态需要控制面 API 或 OS 命令补齐。
- `wallet approve`/`register` 是真实交易命令，本仓库的自动化测试不执行它们。

## 相关文档

- [docs/plan.md](docs/plan.md)：设计、模块边界、状态机与验收
- [docs/research.md](docs/research.md)：端点、签名与 worker 事实来源

## License

Copyright 2026 Duggy-AI.

Licensed under the [Apache License, Version 2.0](LICENSE).
