# Direct Uniswap path validation

Update (2026-10-19): the user-supplied budget parameter and its checks have been removed. Historical budget and fixed 0.5% slippage tests below describe the earlier implementation. Current Ethereum swaps use gas/trade-value auto slippage with 25% headroom, bounded to 0.75%–5%; Robinhood uses 0.75%. The confirmed maximum input and displayed network fee cap remain fixed after confirmation.

Auto-slippage verification (2026-10-19): `node --test test/swaps.test.mjs test/funding.test.mjs` passed 45/45 on Windows. Coverage includes lower/upper bounds, basis-point and atomic-unit rounding, large integer amounts, equivalent token-decimal scales, exclusion of approval/task gas from the heuristic, both Robinhood source coins, gas-aware route ranking, and all five coin/network combinations through review, exact approval, signed swap calldata and recovery. These use an isolated mock RPC; no real funds were sent. The heuristic reuses existing route/gas quotes and adds no RPC calls or dependencies. Its parameters are an execution-tolerance policy, not a measured fill-rate guarantee or MEV protection.

Validated on 2026-10-18. The production CLI now calls Uniswap directly; this document records both initial feasibility checks and integration verification.

## Result

All five supported source-coin/network combinations can buy IMD using Uniswap v3 alone. No aggregator, API key, custom deployed contract, or v4 hook integration is required for these tested paths.

| Network | Source | Validated path | Pool fees | Input for 0.5 IMD at the recorded block, excluding gas |
| --- | --- | --- | --- | --- |
| Ethereum | ETH | ETH → WETH → USDT → IMD | 0.01%, 0.3% | 0.001160708829955736 ETH |
| Ethereum | USDC | USDC → IMD | 0.3% | 2.795159 USDC |
| Ethereum | USDT | USDT → IMD | 0.3% | 2.797021 USDT |
| Robinhood | ETH | ETH → WETH → IMD | 0.3% | 0.001138369113195251 ETH |
| Robinhood | USDG | USDG → WETH → IMD | 0.01%, 0.3% | 2.740071 USDG |

Wrapping ETH is handled inside the router call. These are executable paths, not a guarantee of the globally cheapest route. Prices and liquidity change; quote onchain again before payment. Direct IMD payment needs no swap.

Ethereum block: 26218092. Robinhood block: 91610595.

## Contracts and pools

Addresses were read from the [official Uniswap deployment feed](https://developers.uniswap.org/deployments.json). Pool existence was checked against the deployed v3 factory, and current liquidity was read onchain.

Ethereum:

- Factory: `0x1F98431c8aD98523631AE4a59f267346ea31F984`
- QuoterV2: `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`
- SwapRouter02: `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`
- WETH/USDT, 100: `0xc7bBeC68d12a0d1830360F8Ec58fA599bA1b0e9b`
- USDC/IMD, 3000: `0x894D4e6d3d2Abc64Fc0de0e4e2Ea63A93BC9c520`
- USDT/IMD, 3000: `0xF0262866f9E0588f67d1a7936726Fab0a75bB1a6`

Robinhood:

- Factory: `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`
- QuoterV2: `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`
- SwapRouter02: `0xCaf681a66D020601342297493863E78C959E5cb2`
- WETH/IMD, 3000: `0xfF0c11690648048C6E939C0A049B3Fbd21141575`
- USDG/WETH, 100: `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca`

The discovered Robinhood USDG/IMD 10000 pool had zero active liquidity. USDG/WETH pools at 100, 500, 3000 and 10000 all returned executable quotes; the 100 pool gave the lowest input among those candidates for 0.5 IMD.

## Read-only simulation

1. Enumerated v3 pools among the supported tokens and WETH at fees 100, 500, 3000, 10000.
2. Queried `QuoterV2.quoteExactOutput` for direct and two-hop candidates.
3. Simulated ERC20 approval followed by `SwapRouter02.multicall(deadline, [exactOutput, refundETH when needed])` using `eth_simulateV1`.
4. Read recipient IMD balance after execution and verified the exact output increment.

Each of the five paths passed for outputs of 0.5, 5 and 50 IMD: **15/15** successful simulations. Five additional simulations supplied ample funds/allowance but set `amountInMaximum` one base unit below the quote: **5/5** reverted with `Too much requested` and zero IMD balance change.

These were unsigned RPC simulations with validation disabled and virtual ETH balances. ERC20 tests simulated approvals from existing funded pool addresses outside the swap path. They validate contract execution, not possession of any account key. Nothing was broadcast, and no user wallet or saved order was accessed. They do not validate the future CLI integration, actual wallet authorization, network fee accounting, or transaction recovery.

Reproduction scripts and raw results (local research files, excluded from npm package):

- `.research/uniswap-paths.mjs`
- `.research/uniswap-simulate.mjs` (add `--reject-budget` for maximum-input rejection)
- `.research/uniswap-path-results.json`
- `.research/uniswap-simulation-results.json`
- `.research/uniswap-budget-rejection-results.json`

## Implementation direction

Use the small explicit route set above, onchain exact-output quotes, and SwapRouter02. Buy precisely the order's required IMD instead of iteratively sizing an exact-input aggregator quote. Stablecoins approve the router directly; Permit2 is unnecessary for this conversion step. ETH wrapping, swap and excess ETH refund are atomic in the router multicall. The existing Ethereum IMD admission-payment authorization is a separate flow.

The implementation preserves source-budget and gas limits, confirmation, local calldata construction, deadline enforcement, exact approval, and durable signed-transaction recovery. Removing KyberSwap does not remove the need for an RPC. This study establishes feasibility; it does not promise unlimited liquidity or lowest prices across every venue.

## Production module verification

`src/lib/swaps.mjs` now compares an explicit set of direct and two-hop v3 paths at one block. Ranking adds conservative gas costs (including necessary approvals) to the quoted input. Gas is valued in the source token using onchain source/WETH quotes; users still pay that gas in ETH. The source allowance influences whether approval/reset fees apply. The input movement allowance is at most 0.5%, clipped to the budget. There is no independent price-impact veto.

The production quote and transaction builders passed five additional unsigned `eth_simulateV1` checks, one for every source coin, at Ethereum block 26218190 and Robinhood block 91622153. All delivered exactly 0.5 IMD within the configured swap gas cap. Evidence: `.research/uniswap-production-check.mjs` and `.research/uniswap-production-results.json`.

Acceptance: Windows (serialized test files) and Linux Node 22.23.3 (non-root container) each passed 236 tests, with one optional live-model test skipped. The tests cover gas-adjusted route selection, existing allowances, exact-output/refund calldata, budget clipping, unavailable liquidity, absence of a price-impact veto, and interrupted transaction recovery. No real-money transaction was sent. macOS was not run locally.
