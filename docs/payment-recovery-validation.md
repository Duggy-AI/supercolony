# Payment recovery validation — 2026-10-19

Initially validated locally as 0.1.2. Published to npm as **0.1.3** on 2026-10-19, including the more generous gas policy. The public `latest` tag and downloaded tarball integrity were verified. The user's remote Linux installation has not been updated by this work.

## Behavior

- One local request survives quote renewal. Creation and `order submit` use the same payment state machine. A server `expired` result now enters reconciliation rather than ending at the generic status message.
- A live or possibly spent authorization cannot create another payment. Ethereum renewal requires a finalized, expired Permit2 authorization and an unused nonce. Robinhood checks all saved transaction candidates and finalized contract expiry. Confirmed payment information prevents renewal.
- Confirmed conversion, token authorization and support transfers survive renewal. An expired, unmined contract call can be replaced in its original nonce slot after finalized proof that it can no longer transfer funds.
- Ethereum fees use the maximum of the RPC tip suggestion and the median of five recent blocks' gas-weighted 75th-percentile tips, increased by 25%, with a 0.1 gwei minimum priority fee. The maximum fee includes three times the next-block base fee. Robinhood's native estimator gets 50% maximum-fee headroom and 25% priority-fee headroom. Fees are checked again before signing; exceeding the reviewed maximum requires a new review.
- A pending transaction has a durable hash, reason and explorer link. Continuing can offer a higher network fee with explicit confirmation. The replacement preserves nonce, recipient, value, gas limit and calldata. Both signed versions are saved before broadcast; either receipt can complete the step.
- Progress distinguishes authorization, conversion, support transfer, task payment and IMD admission. Refreshing an admitted order clears stale pending labels. Displayed confirmed hashes identify the transaction that actually mined.

## Verification

- Gas-policy follow-up: **72 source tests and 72 compiled tests passed**, including upper-quartile sampling, integer rounding, the Ethereum minimum tip, Robinhood-specific headroom and reviewed-cap enforcement. Logs: `.local/gas-policy-tests.log` and `.local/gas-policy-dist-tests.log`.
- Windows, final compiled payment suite: **87 passed, 0 failed**. Log: `.local/payment-windows-final.log`.
- Linux Node 22.23.3 container, final compiled payment suite: **87 passed, 0 failed**. Log: `.local/payment-linux-final.log`. Dependencies came from the current lockfile; optional GPU binaries and lifecycle scripts were omitted because the payment suite does not load the local model.
- UI recovery/progress and refresh tests: **10 passed**. The full compiled run also exercised the terminal UI and native PTY tests.
- Package check: **70 files, about 168 KiB**, only compiled runtime and npm metadata.
- Full Windows compiled suite: **353 tests, 350 passed, 2 failed, 1 skipped**. The two failures are a child and its parent reporting one Windows Node process exit `3221226505`; earlier runs showed the same exit in different CLI cases. The affected suite and the final 87-test payment suite passed when rerun. The native process-exit cause remains unresolved; no assertion was relaxed or failure treated as success. The skip is the optional actual-model inference test.

Read-only queries to the two public Ethereum RPCs reproduced a zero/near-zero default tip suggestion while recent included transactions yielded 0.1 gwei. The revised estimator agreed across both nodes. This verifies fee data handling, not future inclusion speed.

All signed transactions in tests use a public test key and isolated mock RPCs. No user's payment, replacement, cancellation or support transaction was signed or broadcast during this work. Tests do not guarantee IMD admission or chain confirmation under future network conditions.
