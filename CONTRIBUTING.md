# Contributing

Thanks for taking the time to contribute. This document covers the conventions that keep the project
maintainable — please read it before opening a pull request.

## Getting started

```bash
git clone https://github.com/Andyyao12/Bilibili-AI-Playlist-Agent.git
cd Bilibili-AI-Playlist-Agent

npm install
npm run typecheck     # must pass
npm run build         # must pass, and prints a dist/ inventory + manifest reference check
```

To try your changes in Chrome: run `npm run build`, then load `dist/` via
`chrome://extensions` → **Developer mode** → **Load unpacked**. After editing source files you must rebuild
and hit **Reload** on the extension card (`npm run dev` rebuilds on change, but Chrome still needs the reload).

## Before opening a pull request

1. `npm run typecheck` and `npm run build` both pass.
2. You have not committed `dist/`, `node_modules/`, `.env`, or any credential.
3. If you changed ranking, admission rules or prompts, describe **how you verified it** — and say explicitly
   whether the LLM responses involved were real model output or fixtures. Preset JSON responses must not be
   presented as real model behaviour.
4. If you changed Bilibili DOM selectors, say which page and date you validated them against.

## Project conventions

These are not style preferences; breaking them tends to break the extension in ways that are hard to debug.

### 1. All LLM traffic goes through `src/services/llm.ts`

Never call `fetch` directly from business code. `LlmClient` owns timeouts, bounded retry, failure classification
and log redaction. A bare `fetch` bypasses all of that and will leak into logs.

### 2. Every Bilibili selector lives in `src/content/bilibili.ts`

That file is the single DOM adapter on purpose: when Bilibili ships a redesign, exactly one file should need
updating. Do not inline selectors anywhere else, and do not use shared query helpers from other modules.

### 3. Never use `data-v-*` attributes as selectors

They are build-time scoped-CSS hashes and change on every Bilibili release. Prefer stable class names and
link-shape based selection (e.g. `a[href*="/video/BV"]`). Always provide multi-level fallbacks.

### 4. The model returns indices, never videos

Ranking responses may only reference candidate numbers. Video URLs always come from DOM extraction.
Any change that lets a model supply a URL or BV id is rejected — that is how fabricated videos get into a queue.

### 5. Mind the LLM call budget

Per user request: **one** intent-parsing call. Per discovery round: **one** batched ranking call for the whole
accumulated candidate pool — never one call per candidate. Search keywords come from the intent plan (or are
synthesised locally); they never cost an extra model call.

### 6. Keep secrets out of logs

`sanitize`-style helpers already exist. Logging an endpoint is fine (with the query string stripped);
logging an `Authorization` header, an API key, or a request body is not.

### 7. Don't widen the scope silently

Changes to the playback state machine, the message protocol, or the storage schema should be called out
explicitly in the PR description, with the reasoning. The queue must keep surviving service-worker
restarts and must keep going after a single item fails.

## Reporting bugs

A good bug report includes:

- what you asked the agent to play (the exact natural-language request),
- the side panel's **运行日志** excerpt — these logs are redacted, so they are safe to paste,
- your `media_type` / `mode` as shown in the log line `意图解析完成：mode=… media_type=…`,
- browser + extension version.

Ranking-quality reports are especially useful when they include the *actual* candidate titles the agent saw,
so the admission rules can be tuned against real data.

## Code style

- TypeScript in strict mode. No `any` unless it is genuinely unavoidable at a boundary, and then narrow it immediately.
- Comments explain **why**, not what. Non-obvious trade-offs (especially in ranking rules) should carry a short
  comment stating the reason, because these thresholds look arbitrary otherwise.
- Keep modules single-purpose. The agent state machine, the ranking rules, the DOM adapter and the LLM client
  are deliberately separate.
- Prefer a small explicit function over a clever abstraction. This project intentionally avoids frameworks.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
