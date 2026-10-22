# seoengine: lean mode (calls, images, cost) + code checks + merged research

Unzip over the repo root, then `npm test` (62 tests). No new dependencies.

| File | Change |
|---|---|
| `lib/settings.js` | `imageMode` ('once' default | 'full'), `expandBelow`, `maxSpendUsd`, `prices` |
| `lib/ai.js` | bad JSON retried once (was 5x), cut-off answers not repeated, `maxTokens` cap (dropped if the API rejects it) |
| `lib/engine.js` | once-mode: competitor photos, writer photo and automatic photo QA off; append-only expansion; title/meta patch call; image-only fallback in the writer; cost per call, spend limit, projection in `usage()` |
| `lib/vision.js` | review merge understands a skipped photo QA (no noise row; flags only a name/photo conflict) |
| `engine-server.js` | validates `imageMode`, `maxSpendUsd` |
| `ui/app.js` | Picture use + spend limit settings; cost and projection on the Token usage card |
| `tests/cost.test.js`, `tests/vision.test.js` | lean-mode tests; two old tests run in 'full' mode |
| `ENGINE.md` | "Lean mode" section |
| `lib/qa.js` | `fixHead`: title/meta length and keyword fixed in code |
| `lib/vision.js` | `visibleCountIssues` (copy vs photo description, in code); merged research prompt |
| `lib/settings.js` / `engine-server.js` / `ui/app.js` | `researchMode` ('separate' default | 'merged'); research cache signature in `lib/engine.js` |
