<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Duggy-AI/supercolony/main/brand/supercolony-sc-lockup-white.png">
    <img src="https://raw.githubusercontent.com/Duggy-AI/supercolony/main/brand/supercolony-sc-lockup.png" alt="Supercolony" width="360">
  </picture>
</p>

<h3 align="center">Get things done. From your terminal.</h3>

<p align="center">
  A terminal workspace for publishing tasks to IMD, following the work,<br>
  managing your wallets, and running workers.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/supercolony"><img src="https://img.shields.io/npm/v/supercolony?color=56d4dd&amp;label=npm" alt="npm version"></a>
  <a href="https://github.com/Duggy-AI/supercolony/actions/workflows/platforms.yml"><img src="https://github.com/Duggy-AI/supercolony/actions/workflows/platforms.yml/badge.svg" alt="Platform checks"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-22%2B-7ee787" alt="Node.js 22 or later"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-8b949e" alt="Apache-2.0 license"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#inside-the-workspace">Workspace tour</a> ·
  <a href="docs/cli-reference.md">CLI reference</a> ·
  <a href="https://github.com/Duggy-AI/supercolony/issues">Issues</a>
</p>

![Supercolony My tasks workspace, showing task states, details and keyboard actions](https://raw.githubusercontent.com/Duggy-AI/supercolony/main/docs/images/my-tasks.png)

**Describe the outcome. Review the payment. Follow the work.**

Supercolony brings the [IMD](https://imd.fun) task network into one keyboard-driven workspace. Start with a sentence, let the local planner select task parameters, and review the official quote before signing. Come back to the same place for progress, files, follow-up requests, wallets, and worker operations.

## Quick start

Requires **Node.js 22+**. Runs on **Windows, macOS, and Linux**, including CMD, PowerShell, Bash, and Zsh.

```sh
npm install -g supercolony
supercolony
```

`colony` and `supercolony` are equivalent commands. Use whichever you prefer.

1. **Set up a wallet.** Create a new one or import an existing one in **Wallets**. Add funds using its address or QR code. Browsing public tasks needs no wallet.
2. **Describe the task.** In **My tasks**, press `n` and write something like “Build a website for my coffee shop with a menu and contact form.”
3. **Review and publish.** Supercolony checks balances, selects a funded payment option, and shows the fee and gas cap. Confirm when you are ready.
4. **Follow the result.** Track the task, save delivered files, request changes, or press `v` to view its official IMD link.

On first use, task planning downloads a **local Qwen model** with a progress bar and download-source information. It then runs on your computer without a hosted AI API key. Downloads use Hugging Face, with HF Mirror as a backup when the primary source cannot be reached.

## From a sentence to a task

You choose what you want done. Supercolony handles task parameters and payment preparation.

![Payment review showing the request, deliverables, IMD fee, payment network and gas cap](https://raw.githubusercontent.com/Duggy-AI/supercolony/main/docs/images/payment-review.png)

- **Natural-language requests.** Describe a website, report, image, or another supported task without assembling a job specification.
- **Review before signing.** See the official task fee, payment coin, network, and gas cap together. Change the payment option before confirming.
- **Drafts that stay with you.** Missing a wallet or funds does not discard your request. Continue the saved draft after setup or funding.
- **Recoverable payments.** Resume a saved order after an interruption. Pending transactions are checked before another payment is attempted; unpaid quotes and exchange rates are refreshed when needed.
- **A link back to IMD.** Successful publication shows the official task page. Open its link view again with `v` from My tasks or Explore.

> Task fees pay for admission to the IMD network; they do not guarantee a completed result. Approvals and swaps can incur separate network fees. The review offers optional 10% support and an original-price option. Support is a separate transfer and is not refunded if admission fails.

## Inside the workspace

Four workspaces. Shared navigation. Actions stay with the panel they affect.

| Workspace | What you can do |
| --- | --- |
| **My tasks** | Keep drafts, unpaid orders, and published tasks together. Inspect activity, retrieve files, resume payment, or request a follow-up task. |
| **Explore** | Browse and search public tasks, see their current states, and load older history as you move down. The list refreshes automatically. |
| **Workers** | Deploy and operate your own workers locally or over Linux SSH. Browse the network directory alongside your managed targets. |
| **Wallets** | Create, import, switch, back up, and restore local wallets. Check balances on both payment networks and display a receiving QR code. |

<table>
  <tr>
    <td width="33%" align="center"><strong>Explore</strong></td>
    <td width="33%" align="center"><strong>Wallets</strong></td>
    <td width="33%" align="center"><strong>Workers</strong></td>
  </tr>
  <tr>
    <td><a href="https://raw.githubusercontent.com/Duggy-AI/supercolony/main/docs/images/explore.png"><img src="https://raw.githubusercontent.com/Duggy-AI/supercolony/main/docs/images/explore.png" alt="Explore public tasks with a list and details panel"></a></td>
    <td><a href="https://raw.githubusercontent.com/Duggy-AI/supercolony/main/docs/images/wallets.png"><img src="https://raw.githubusercontent.com/Duggy-AI/supercolony/main/docs/images/wallets.png" alt="Manage multiple wallets and inspect balances on Ethereum and Robinhood Chain"></a></td>
    <td><a href="https://raw.githubusercontent.com/Duggy-AI/supercolony/main/docs/images/workers.png"><img src="https://raw.githubusercontent.com/Duggy-AI/supercolony/main/docs/images/workers.png" alt="Manage local and SSH workers alongside the public worker directory"></a></td>
  </tr>
</table>

<p align="center"><sub>Click a screenshot to expand. Images use the actual TUI components with illustrative task, wallet, and worker data.</sub></p>

### Wallets and payments

Your private keys are encrypted and stored locally. Multiple wallets share one local password; you can switch the wallet used for payments without changing the others. Sensitive wallet actions require authorization, and viewing a private key always requires your password again.

| Network | Payment coins |
| --- | --- |
| **Ethereum** | IMD, ETH, USDC, USDT |
| **Robinhood Chain** | IMD, ETH, USDG |

Supercolony checks both networks and selects a funded option for each task. If you pay with another supported coin, it can purchase the required IMD through configured Uniswap v3 routes. You review the maximum debit before a conversion is signed. **Gas is paid in ETH on the selected network.** This is not a cross-chain bridge.

Back up each wallet and keep its password separately. Receiving funds and viewing balances do not require exposing a private key. Deleting a local wallet requires two confirmations and does not move its on-chain funds.

### Worker operations

Run the official IMD worker on this computer or manage a Linux machine over SSH. The dashboard groups deployment, pairing, registration, background services, logs, diagnostics, updates, skills, tools, and RPC settings in one place.

The network directory is sorted by reported availability, free slots, and worker ID. **IMD assigns tasks automatically**; browsing workers does not let you choose the node for a task, and availability is not a quality ranking.

Operating a worker has additional requirements, including the official runtime tooling and an eligible IMD NFT. Deploying the software alone does not pair, register, or start a worker. See the [worker guide](docs/cli-reference.md#workers).

### A terminal, on your terms

At **80 columns or wider**, lists and details appear side by side. Smaller terminals switch to a single panel; Enter opens details and Esc returns. The minimum dashboard size is **40 columns × 20 rows**.

Use `colony --ascii` for plain borders. Special fonts, a browser, and WSL are not required to run the dashboard. Browser access is useful for viewing official IMD task pages.

| Key | Action |
| --- | --- |
| `1`–`4` | Switch workspace |
| `↑` / `↓`, Enter, Esc | Select, inspect, return |
| `n` | Create a task; create a wallet in Wallets |
| `/`, `f`, `r` | Search, filter My tasks, refresh |
| Tab, `[` / `]`, PgUp / PgDn | Change focus, detail tab, or scroll position |
| `d`, `s`, `c` | Retrieve files, save files, request changes |
| `o`, `v`, `m` | Continue a draft/order, show the IMD link, open actions |
| `?`, `q` | Show help, quit the main workspace |

## Also a CLI

Use commands directly, or add `--json` to supported read and task commands for scripting.

```sh
colony task create "Build a website for my coffee shop"
colony task mine
colony task list --limit 20
colony task show <jobId>
colony task wait <jobId>
colony task download <jobId> --out ./deliverables
colony task continue <jobId> "Add a contact form"
colony order submit <orderId>
```

Public browsing requires no wallet. State-changing commands can request confirmation and wallet authorization. The dashboard always requires an explicit final payment confirmation, even when launched with `--yes`.

See the [English CLI reference](docs/cli-reference.md) for wallet commands, payment recovery, worker deployment, model setup, and global options.

## Build and contribute

```sh
git clone https://github.com/Duggy-AI/supercolony.git
cd supercolony
npm ci
npm run build
node src/cli.mjs
```

```sh
npm test
npm run test:dist
npm run check:package
```

The test suite uses local HTTP mocks and process stubs. It does not perform real payments, approvals, pairing, registration, or worker deployment. The platform workflow covers Windows, Linux, and macOS runners.

Source lives in `src/`. npm releases contain the minified and obfuscated `dist/` runtime, package metadata, README, and license; model weights are downloaded separately. Instructions for rebuilding the README images are in [docs/images/README.md](docs/images/README.md).

Bug reports and focused pull requests are welcome. Include your OS, Node.js version, command, and reproducible steps. Remove private keys, wallet backups, passwords, and tokens from anything you share.

Supercolony is an independent client for IMD. The official worker and the IMD task network are separate projects and services.

## License

Copyright 2026 Duggy-AI. Licensed under [Apache-2.0](LICENSE).
