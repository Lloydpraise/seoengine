# seoengine: cost changes

Unzip over the repo root, then `npm install` (adds the optional `sharp` for photo shrinking) and `npm test` (51 tests).

| File | Change |
|---|---|
| `lib/settings.js` | all four models default to `gpt-4.1-mini`; new `photoDetail` / `qaDetail` (default `low`); old saved `gpt-4o` / `gpt-4o-mini` values move to the new default, `ft:` and custom models are kept |
| `lib/ai.js` | records tokens + cached tokens per call (`onUsage`), sends `prompt_cache_key`, image detail defaults to `low`, retries without the key if the API rejects it |
| `lib/engine.js` | prompt reordered (shared first, product last, feedback at the very end); cache key per profile + category; expand and quality-fix retries are text-only; photo detail from settings; per-step/per-product usage totals; queue runs same profile + category back to back |
| `lib/vision.js` | photos shrunk to 768px JPEG before sending (optional `sharp`) |
| `lib/kenya.js` | "Kenya" added after every Google keyword the researcher searches (never doubled); empty `site:` searches retry once without it; site search boxes unchanged |
| `lib/profiles.js` | usage label for style learning |
| `engine-server.js` | `GET /api/usage`, `POST /api/usage/reset`; validates the detail settings |
| `ui/app.js` | Settings > AI: model fields for look and QA, detail selects; Token usage card |
| `package.json`, `package-lock.json` | `sharp` as an optional dependency |
| `tests/cost.test.js` | new: prompt prefix, Kenya keywords, text-only retries, detail settings, queue grouping, usage totals, cache-key fallback, settings migration, photo shrink |
| `ENGINE.md` | "Cost controls" section |
| `cost-changes.patch` | the same code changes as a `git apply` patch |
