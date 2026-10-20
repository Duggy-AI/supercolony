# Security bug review — 2026-10-19

Scope: Colony code bugs in payment signing, wallet selection, terminal output,
worker command execution and installation, and task artifact downloads. Codex
reviewed payment/wallet/output paths; Pi Web DeepSeek reviewed worker/file paths.
All attack fixtures used fake keys, local mock servers and disposable directories.
No real payment, pairing, registration or production worker operation was performed.

## Confirmed and fixed

### 1. Untrusted text could control the terminal

Public task objectives and API errors reached CLI stdout/stderr with raw escape
sequences. Worker status and logs had the same problem, including streaming logs.
Captured-output tests reproduced OSC 52 and screen-erasing CSI bytes. Depending
on the terminal, these can change the clipboard or falsify the visible output.
This review did not demonstrate arbitrary shell command execution.

`src/lib/terminal-text.mjs` now owns the text boundary used by CLI output,
diagnostics, confirmation prompts, planner questions and the TUI. Worker commands
that produce data stream through a stateful filter: it handles escape sequences
split across chunks, emits once per chunk, and honors stream backpressure without
accumulating the log. JSON output escapes C1 controls while preserving parsed data.
Actual interactive credential/tool wizards retain the official program's TTY;
they are explicit terminal handoffs, not sanitized task/log views.

### 2. QuoteApproval could sign terms different from the reviewed quote

The payment challenge contains both Permit2 requirements and a separate quote
used for QuoteApproval. Only the former's payment fields were compared with the
saved quote. Local mock responses changed the latter's amount, recipient, asset
or chain while preserving the quote hash; the old code signed and submitted them.
Both sets of terms are now checked against the saved quote before funding or
signing. Tests assert no RPC, funding state or signature on a mismatch.
The Permit2 amount was independently bounded; this test does not establish that
the mismatched QuoteApproval alone could withdraw extra tokens on the real network.

### 3. Omitting a budget skipped token/decimals validation

> Historical note: the budget parameter and `src/lib/budget.mjs` were later removed. Quote payment fields are now validated through `assertQuotePayment(payment)` in `src/lib/payments.mjs`.

`assertBudget` returned immediately when no explicit budget existed. A mock quote
with 21 decimals was accepted for IMD, whose supported configuration uses 18.
This made the quote-price display 0.0005 IMD for a 0.5 IMD signature. Other payment
summary lines could still show the correct amount, so the issue is inconsistent,
misleading price display, not proof that every review field hid the debit.
The supported token and decimals are now checked even without a budget; the
optional numeric cap remains optional. The regression stops before challenge/RPC.

### 4. Two late wallet-switch paths could still sign with the old account

Ethereum continuation cached the owner's account before confirmation. Robinhood
retained its account while waiting for final transaction preparation. Switching
the active wallet during those waits did not always stop the old account signing.
Both paths now recheck the intended wallet immediately before signing. Local RPC
fixtures reproduce each timing window and assert no payment signature/broadcast.

## Validation

Regression fixtures were run against the old behavior first: terminal injection,
all four QuoteApproval mutations, decimals spoofing and both wallet-switch cases
failed their rejection assertions. The fixes pass their focused tests.

- Windows, Node 24.15.0: **310 passed, 0 failed, 0 skipped**, including the real
  cached local model and native terminal tests (`windows-final.log`).
- Linux container, Node 22: **309 passed, 0 failed, 1 skipped**. The real-model
  test is conditional on a model-cache path and was skipped in this container
  (`linux-final.log`).
- A terminal test initially timed out because its sequential matcher waited for
  a header above an already consumed row in the same screen render. It now waits
  for the network error below that row; both platforms' final full runs passed.
- `npm pack --dry-run`: 68 files, including the new terminal module; no test
  directories, audit artifacts, GGUF files or private-key files included.

Logs and pre-fix reproductions are in the ignored `.research/security-audit/`
directory. The disposable Linux audit container was removed after verification.

## Review limits

No additional reproducible command/SSH injection, artifact path traversal,
symlink overwrite, or archive extraction flaw was confirmed in the reviewed paths.
That is a scoped review result, not a guarantee of absence.

The three previously reported dependency alerts in the node-llama-cpp/simple-git
dependency chain remain unresolved; see `docs/final-review.md`. They are not
counted as newly discovered Colony bugs. macOS and real paid onchain flows were
not exercised in this review.
