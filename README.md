# CodeBuddy Agent

[![CI](https://github.com/BOHAOYUAN/CodeBuddy/actions/workflows/ci.yml/badge.svg)](https://github.com/BOHAOYUAN/CodeBuddy/actions/workflows/ci.yml)

An autonomous **ReAct code-repair agent** for TypeScript/JavaScript workspaces, packaged both as a
VSCode extension and a CLI, with a reproducible evaluation harness.

The agent plans, calls tools through real LLM function calling, repairs failing unit tests, verifies
its own work with an independent test run, and writes what it learned into long-term memory.

> Every line of telemetry the CLI and the extension display is produced by an actual model response or
> an actual tool execution. Nothing is scripted **in the agent itself** — see the note on the web
> preview below, which is a separate, clearly-labelled UI mock.

> **Accuracy note about the web preview.** `docs/mockup.html` is a **static UI mock**: it calls no
> model and runs no tests — clicking *Auto-Repair* just replays a fixed sequence so the interface can
> be seen without an API key. It is labelled as such on the page. The real, non-scripted runs happen
> through the CLI (`npm start`) and the VS Code extension, and their reports are written to
> `.codebuddy/` by the evaluation harness.

**Install** — grab the `.vsix` from
[Releases](https://github.com/BOHAOYUAN/CodeBuddy/releases/latest)
(`code --install-extension codebuddy-agent-2.0.0.vsix`), or run it from source with `npm install && npm test`.

**Site** — [codebuddy-hyhm.vercel.app](https://codebuddy-hyhm.vercel.app)

---

## Why this is not another agent demo

Most "agent" side projects replay a hardcoded transcript. This one is measured.

| Concern | How it is handled |
|---|---|
| Model actually drives the loop | Real OpenAI-compatible function calling; the model chooses every tool call |
| Runaway cost | Iteration cap, loop guard, `max_tokens` budget, **client-side tokens-per-minute pacer** |
| Infinite loops | Byte-normalized repeat detection + two-call cycle detection with no-progress tracking |
| Bad tool arguments | JSON-Schema validation layer before any handler executes |
| Patch applied to the wrong place | Exact match, then whitespace-tolerant window match, and **refusal on ambiguity** |
| Escaping the workspace | Every path is resolved and confined to the workspace root |
| Trusting the model's own claim | Verification is a separate test run performed by the harness, not by the model |
| No idea whether it works | `npm run eval` runs a fixed benchmark and emits success rate, rounds, tokens, cost and latency |

---

## Architecture

```
Goal + target file + verification command
                 │
                 ▼
        ┌──────────────────────────┐
        │  Phase 1 · Planning      │  structured JSON plan (hypothesis + steps)
        └──────────┬───────────────┘
                   ▼
        ┌──────────────────────────┐
        │  Phase 2 · ReAct loop    │◄──────────────┐
        │  model → tool → observe  │               │
        └──────────┬───────────────┘               │
                   │  guarded by:                  │
                   │   • iteration cap             │
                   │   • loop guard                │
                   │   • token-budget pacer        │
                   │   • schema validation         │
                   │   • optional patch review     │
                   ▼                               │
        ┌──────────────────────────┐               │
        │  Phase 3 · Verification  │  independent  │
        │  run the real test suite │  test run     │
        └──────────┬───────────────┘               │
                   ▼                               │
        ┌──────────────────────────┐               │
        │  Phase 4 · Reflection    │  root cause + lesson
        │  → long-term memory      │───────────────┘
        └──────────────────────────┘   feeds the next task
```

### Layers

```
src/
  config.ts                  env loading, tuning knobs, TPM/pricing settings
  llm/client.ts              OpenAI-compatible client: retry, backoff, pacing, usage accounting
  tools/
    astAnalyzer.ts           Babel AST → structural skeleton
    codeTools.ts             file reads, tolerant patching, command execution
    registry.ts              tool schemas, JSON-Schema validation, path confinement, dispatch
  agent/
    reactAgent.ts            planning → ReAct loop → verification → reflection
    loopGuard.ts             repeat + thrash detection
    memory.ts                bounded short-term window, persistent long-term lessons
    trace.ts                 typed trace events + run summary
    vscodeAgentBridge.ts     VSCode integration
  benchmark/
    tasks.ts                 task registry + reproducible baselines
    fixtures/*.buggy.txt     the buggy baseline for each task (single source of truth)
    targets/*.ts             working files the agent repairs
  eval/run.ts                benchmark harness → JSON + markdown report
  cli/renderer.ts            terminal trace rendering
  index.ts                   CLI entry point
```

---

## Measured behaviour

> **Read this before quoting any number below.**
>
> The measurements in this section come from `openai/gpt-oss-120b` (Groq free
> tier, 2026-09-19). The project now targets DeepSeek and **these figures have not
> yet been re-measured on it** — treat them as historical until they are.
>
> Two caveats, both worth knowing before you quote anything:
>
> 1. Success rate is **model-bound**. A result on one provider does not transfer
>    to another. A benchmark without a model name is not a benchmark.
> 2. The 2026-09-19 pass counted runs that crashed before completing a first
>    iteration as "not solved". The harness now separates *crashed* from
>    *attempted and failed*, so old and new reports are not directly comparable.
>
> A 2026-09-26 attempt to re-measure was invalid: the environment it ran in could
> not spawn a shell, so no test ever executed and every run scored zero for a
> reason that had nothing to do with the agent. `executeTestSuite` now reports
> that condition explicitly instead of disguising it as a failing test. Re-run
> the benchmark from a normal terminal before trusting any current number.

Numbers below are the historical Groq runs, kept because they document what the
harness measured at the time — not what it measures today.

### AST-driven context pruning

Before reading a file, the agent requests its structural skeleton. On the benchmark targets this
reduces the file context by **~70 %** (measured: `tokenReductionPct` in every run summary), because
signatures and line ranges are enough to plan a surgical patch.

### Benchmark results — 2026-09-19, `openai/gpt-oss-120b`, cold long-term memory

| Task | Bug class | Solved | Iterations | Tool calls | Tokens | Wall clock |
|---|---|---|---|---|---|---|
| `tieredDiscount` | boundary + float truncation | **yes** | 11 | 10 | 30,234 | 369 s |
| `pagination` | off-by-one + rounding | **yes** | 10 | 9 | 28,192 | 259 s |
| `dedupe` | wrong-wins + input mutation | **yes** | 8 | 7 | 22,575 | 202 s |
| `retry` | linear vs exponential backoff | no | 11 | 10 | 35,673 | 333 s |

**3 of 4 solved (75 %), 116,674 tokens total, ~20 minutes wall clock.**

The `retry` failure is a genuine capability ceiling, not an infrastructure fault: the model spent its
budget and then declared success with a plausible but wrong diagnosis, without noticing that the
function's JSDoc already stated the exact contract. Two changes came out of that run — the agent is
now told that a doc comment *is* the specification, and to treat an unused parameter as a marker of
the dropped behaviour.

The second (warm-memory) pass could not complete; see the quota note below.

`npm run eval:history` rebuilds a full history from the persisted traces without re-spending a single
token, and separates genuine failures from quota aborts — see `.codebuddy/run-history.md`. Across
every completed run on this account it reports **5/7 solved**; the 3 aborted runs are excluded rather
than counted as failures, because a quota abort measures the account, not the agent.

### Provider token budget (measured on this account)

| Model | Limit |
|---|---|
| `openai/gpt-oss-120b` | 8,000 tokens / minute **and 200,000 tokens / day** |
| `openai/gpt-oss-20b` | 8,000 tokens / minute |
| `qwen/qwen3.8-27b` | 7,000 input tokens / minute |

Two different failure modes, handled differently:

- **Per minute (429)** — recovers in seconds. The agent estimates `input + max_tokens` before every
  call and waits for the rolling 60-second window to drain, and parses the provider's own
  `"try again in 1.4925s"` hint when it still gets a 429.
- **Per day (429, `TPD`)** — does *not* recover by waiting. Retrying is pure waste, so it is detected
  and raised as non-retryable, and the evaluation harness aborts the pass instead of burning the
  retry budget on every remaining task.

A single request larger than the per-minute ceiling returns HTTP 413, which cannot be retried either —
only shrinking the request helps.

### Choosing a provider

The client speaks plain OpenAI-compatible chat completions, so the provider is four env vars. The
trade-off is not price — it is **throughput**.

| | Groq free tier | DeepSeek `deepseek-flash` |
|---|---|---|
| Cost | $0 | $0.15 / 1M input, $0.60 / 1M output (off-peak) |
| Ceiling | 8,000 tokens/min, **200,000 tokens/day** | no daily cap; 2,500 concurrent requests |
| Context | 128K | 1M |
| 96 repair tasks (~2.9M tokens) | **~14 days** | one sitting, **≈ ¥3.7** |
| Wall clock per task | 200–390 s, of which **~60–85 % is rate-limit pacing** | tens of seconds |

The pacing number is the whole argument. A representative Groq run reported `pacing wait: 358.0s` out
of `wall clock: 423.0s` — the model was idle for 85 % of the run waiting for the token budget to
drain. DeepSeek has no equivalent ceiling, so the same run is an order of magnitude faster, and for a
workload of this size it costs less than a coffee.

DeepSeek bills peak and off-peak (peak = 09:00–12:00 and 14:00–18:00 Beijing time, weekdays only;
**weekends are entirely off-peak**), so schedule batch runs for the evening or the weekend to halve
the bill again. Identical system prompts hit the prompt cache and cost 50× less than a cache miss.

To switch, edit the four `PROVIDER_*` lines in `.env` — see the comments in that file for the current
rate card. Note that `deepseek-chat` and `deepseek-reasoner` have been retired; the current names are
`deepseek-flash` and `deepseek-v4-pro`.

### Error handling that actually recovers

In a representative run the model produced a patch whose indentation did not match the file. The
patcher refused it, returned the surrounding source as a hint, and the agent re-read the region and
succeeded on the next attempt — without a human in the loop.

---

## Quickstart

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
# then set PROVIDER_API_KEY=sk-... (or the legacy GROQ_API_KEY)
```

`.env` is gitignored. Any OpenAI-compatible endpoint works — point `PROVIDER_BASE_URL` at DeepSeek,
Together, vLLM or a local server and everything else stays the same.

### 3. Run a single repair

```bash
npm start                              # repairs the default task
npx tsx src/index.ts --list            # list available tasks
npx tsx src/index.ts --task=pagination
npx tsx src/index.ts --cross-validation
npx tsx src/index.ts --help
```

The CLI prints a live trace, then a run summary:

```
  result          : RUN VERIFIED (verified: tests passing)
  iterations      : 10
  tool calls      : 9 (1 errors)
  tokens          : 30660 prompt + 1869 completion = 32529
  pacing wait     : 358.0s (rate-limit budget)
  prompt context  : 79054 chars sent
  AST pruning     : 69.7% smaller than reading the raw file
```

### 4. Run the benchmark

```bash
npm run eval                                   # all tasks, one pass
npm run eval -- --passes=2 --reset-memory      # cold pass then warm pass
npm run eval -- --tasks=dedupe,retry
```

Outputs `.codebuddy/eval-report.json` and `.codebuddy/eval-report.md`, including a
**cold-vs-warm comparison** that shows what long-term memory is worth in iterations, tool calls and
tokens.

> **Budget note.** A full four-task pass costs roughly 115,000 tokens, which is more than half of
> Groq's 200,000-token daily allowance. Run one pass per day on the free tier, or narrow it with
> `--tasks=`. The harness aborts the pass and says so if the daily quota runs out, rather than
> reporting the remaining tasks as failures.

### 5. VSCode extension

```bash
npm run vscode:build     # bundle to dist/extension.js
```

Then press **F5** (the `Run Extension` launch configuration builds first), or package it with
`npm run vscode:package`. The sidebar streams the real trace, shows the raw test output, and lets you
switch between benchmark tasks.

The API key is read from `codebuddy.providerApiKey` (Settings) or from the workspace `.env`.

> **Scope note.** Inside the extension the agent's workspace root is the *extension's own directory*,
> not the folder you have open. The benchmark targets, their tests, traces and memory all live there,
> so a repair run cannot write into your project. Pointing the same agent at a real user workspace is
> a deliberately separate step.

---

## The benchmark

Each task ships as a pair: a buggy baseline in `fixtures/` and a test file in `targets/`. The harness
restores the baseline before every run, so results are reproducible rather than one-shot.

| Task | Bug class | Difficulty |
|---|---|---|
| `tieredDiscount` | boundary condition + floating point truncation | easy |
| `pagination` | off-by-one slice bounds + integer rounding | medium |
| `dedupe` | wrong-wins on duplicates + caller-visible mutation | medium |
| `retry` | missing exponential growth + incorrect jitter model | medium |

Two suites, deliberately separated:

```bash
npm test                 # framework unit tests — deterministic, no network, always green
npm run test:benchmark   # the repair targets — red until the agent fixes them
npm run eval             # the agent fixes them, then the benchmark goes green
```

`npm test` covers the parts that must never break: loop detection, schema validation, path
confinement, the memory window, and the patching fallbacks. `npm run test:benchmark` is the ground
truth the agent is scored against, so it is *supposed* to start red — the bugs are the point.

---

## Design decisions

**Raw `fetch` instead of a vendor SDK.** The whole OpenAI wire protocol is a single POST with a
`tools` array. Implementing it directly means provider-agnostic behaviour, no SDK version drift, and a
retry path that can inspect the provider's own error text (for example, parsing
`"Please try again in 1.4925s"` out of an HTTP 429 and honouring it, instead of guessing).

**Hand-rolled JSON-Schema validator.** Roughly 80 lines, zero dependencies, and the validation rules
are visible at the call site rather than buried in a library. It rejects unknown arguments, wrong
types, and out-of-range values before a handler can touch the filesystem.

**Whitespace-tolerant patching with an ambiguity refusal.** Re-indented snippets are the single most
common cause of failed patches. Matching line-normalized rescues that, but the matcher refuses when
more than one region matches, because silently patching the wrong place is far worse than failing.

**A separate verification pass.** The model's summary is never treated as evidence. After the loop
ends, the harness runs the verification command itself and reports the real exit status.

**Bounded memory with an explicit eviction notice.** Short-term memory evicts old observations under a
character budget and tells the model *that it happened*, so the model can re-run a tool instead of
reasoning on silently truncated history. Long-term memory persists lessons across runs and is exposed
to the model as a callable tool (`recall_memory`).

---

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `PROVIDER_API_KEY` | — | required (legacy alias `GROQ_API_KEY` still read) |
| `PROVIDER_BASE_URL` | `https://api.deepseek.com` | any OpenAI-compatible endpoint |
| `PROVIDER_MODEL` | `deepseek-flash` | main loop model |
| `PROVIDER_VALIDATOR_MODEL` | `deepseek-flash` | patch review model |
| `AGENT_MAX_ITERATIONS` | 12 | hard iteration cap |
| `AGENT_MAX_RETRIES` | 5 | HTTP retry budget |
| `AGENT_TPM_LIMIT` | 0 | token-budget pacer ceiling; 0 disables |
| `AGENT_MAX_TOKENS` | 700 | completion budget per call (plan/tool/reflect) |
| `AGENT_MAX_OBSERVATION_CHARS` | 1800 | tool output truncation; raise or failures become undiagnosable |
| `AGENT_NO_PATCH_NUDGE_AT` | 3 | iteration at which a "you have not edited anything" reminder is injected; 0 disables |
| `AGENT_PRICE_IN_PER_MTOK` | 0 | input price, for the cost figure in reports |
| `AGENT_PRICE_OUT_PER_MTOK` | 0 | output price, for the cost figure in reports |
| `AGENT_CONTEXT_CHARS` | 9000 | short-term memory budget |
| `AGENT_MAX_OBSERVATION_CHARS` | 1800 | tool output clipping |
| `AGENT_CROSS_VALIDATION` | false | second-model gate before writing a patch |
| `AGENT_PRICE_IN_PER_MTOK` / `_OUT_` | 0 | used for the reported cost metric |

---

## Known limitations

Stated plainly, because knowing where a system breaks is part of the system.

**The reflection written to long-term memory is model-generated and can be wrong even when the repair
succeeded.** Observed directly: the `dedupe` task was verified as solved, but the lesson stored for it
described an ordering defect that was never the actual bug (the real defect was "keeps the last
duplicate and mutates the caller's array"). A later run recalling that record could be nudged in the
wrong direction. Recall is advisory — the agent still has to observe a real failure before patching —
but the honest fix is a stricter write gate, for example only storing a lesson the model can tie
explicitly to the diff it produced. Not implemented.

**The benchmark is single-file and small.** Every task is one function plus one test file. Nothing here
has been exercised against a multi-file change, a build step, or a codebase where the failure is not
localized by a test name.

**One model family has been tested.** All figures come from `openai/gpt-oss-120b` on Groq. Behaviour
on other models is unmeasured, and the prompts were tuned against this one.

**The free tier makes a full pass a once-a-day operation.** Four tasks cost ~115,000 of a
200,000-token daily allowance.

**The extension is confined to its own directory** and does not yet repair a user's project. That is a
deliberate scope boundary, not a finished feature.

**Cost accounting is zero on the free tier.** Token counts are real; the dollar figure is only
meaningful once `AGENT_PRICE_IN_PER_MTOK` / `_OUT_` are set for a paid endpoint.

---

## What this project demonstrates

Useful framing if you are reading this as a work sample:

- **Agent fundamentals, implemented rather than imported** — planning, tool use, bounded memory,
  reflection, and an explicit verification step, all in readable TypeScript.
- **Production instincts** — retries with provider-aware backoff, rate-limit pacing, schema
  validation, path confinement, loop detection, and refusal-on-ambiguity instead of best-effort writes.
- **Measurement** — a reproducible benchmark with cost, token and latency accounting, plus a
  cold-vs-warm experiment that quantifies what memory actually buys.

---

## License

MIT
