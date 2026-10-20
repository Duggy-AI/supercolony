# Local planner validation

Validated on 2026-10-18. Natural-language requests use a local structured decision to select a supported deliverable. Application code builds the IMD input, preserves the request and clarifications, binds continuation parents, and enforces the IMD budget before signing payment.

> The `--budget` parameter and the separate budget limit described in this 2026-10-18 record have since been removed. Payment now proceeds from official quoted price, maximum debit and network fee cap shown for confirmation.

## Model

- Qwen3.5-0.8B, Q4_K_M, 532,517,120 bytes (about 533 MB).
- Repository: `unsloth/Qwen3.5-0.8B-GGUF`.
- Pinned revision: `6ab461498e2023f6e3c1baea90a8f0fe38ab64d0`.
- SHA-256: `bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517`.
- Runtime: `node-llama-cpp@3.22.2`, 4,096-token context, four CPU threads.
- Windows, Linux and Intel macOS select CPU; Apple Silicon selects Metal because its distributed native binary uses Metal.

## Executed checks

| Environment | Full CLI tests | Actual model cases | Model loading | Decision time |
| --- | --- | --- | --- | --- |
| Windows x64, Node 24.15.0 | 161 passed, 1 skipped | 27/27 | 2,225 ms | 164–292 ms |
| Linux x64 Docker, Node 22.23.3 | 161 passed, 1 skipped | 27/27 | 2,761 ms | 225–337 ms |

The skipped unit-suite case requires an explicitly configured model cache. The separate 27-case runs above loaded and executed the actual model. Cases cover English, Chinese, mixed-language requests, topic-versus-deliverable distinctions, unsupported actions, and continuation parents. These are regression cases, not a general accuracy benchmark.

macOS and Linux ARM64 are configured in `.github/workflows/platforms.yml`; they have not been executed on hardware in this workspace. Platform selection is unit tested. The CI workflow runs the same actual model evaluation on each target.

The Linux container also downloaded the full pinned model into an empty cache through `model setup`; the byte count and SHA-256 matched. Direct download on this Windows host failed with `ECONNRESET`; cached inference and setup passed. No host-specific IP or proxy routing was added to the application.

Model downloads now try the pinned Hugging Face URL first, then the equivalent `hf-mirror.com` URL after a network failure. Response headers and stalled network reads each have a 15-second deadline; there is no deadline for a complete download that continues making progress. Switching sources is reported on stderr, keeping JSON stdout clean. Both sources must match the same file size and SHA-256; verification and local filesystem failures are reported directly. Valid cached models need no connection.

Twelve download cases passed on both Windows and Linux using real loopback HTTP servers. They cover the primary source, HTTP errors, response-header timeout, stalled and interrupted bodies, dual-source failure, integrity checks, local filesystem errors, pinned revisions, and cached reuse. On this Windows host both real external sources returned `ECONNRESET`; automatic switching and the final two-source error were observed, but a successful real mirror download has not been confirmed here.

Actual CLI website and Chinese report requests passed the public IMD `/requests/check` endpoint with zero blockers. Assembled inputs for report, website, image, audio, video and contract code also passed that free endpoint. `npm pack --dry-run` excluded model weights, test data and the `.local` directory.

The earlier 338 MB UD-IQ2_XXS quantization selected correctly in only 3/17 comparison cases; Q4_K_M selected correctly in 16/17. It is retained only in ignored diagnostic data and is not a production alternative.

## Prompt experiments

The production prompt uses a short instruction and deliverable descriptions, without few-shot examples. Adding eight examples reduced the score from 63/65 to 57/65 on the same cases and increased mean decision latency from 180 ms to 274 ms. That version was not adopted.

A broader set of 77 scored cases, including 50 requests added after the original acceptance set, passed 72/77 with the production prompt. Known misses include some contract prototypes, direct NFT minting requests, and a Web3 mascot illustration. Four ambiguous requests were recorded separately and excluded from accuracy counts. The CLI presents its intended deliverable before payment; these results do not establish general intent accuracy.

Expanding the contract and unsupported-action descriptions also reduced the overall score (67/77), so those experimental changes were reverted. Raw comparisons are retained in `.local/fewshot-comparison.json` and `.local/criteria-refinement.log`.

## Reproduce

```sh
npm ci
npm test
node scripts/validate-planner.mjs
node src/cli.mjs --home .local/model-validation model status --json
node src/cli.mjs --home .local/model-validation task create "Build a website for my coffee shop" --dry-run
```

The model evaluation downloads the pinned file if its cache is empty. Subsequent inference uses the cached model. Its reports are written to `.local/planner-evaluation-<platform>-<arch>.json`. Neither the reports nor model weights are included in the npm package.

No real payment, wallet approval, worker registration or npm publication was performed for these checks.
