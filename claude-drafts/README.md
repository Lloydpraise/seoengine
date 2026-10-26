# Claude drafts

SEO drafts written by Claude for products that had no SEO yet (or had copy that did not match the photo).
Each file is a JSON array in the engine's draft shape plus `id` (Supabase id), `name`, `slug`,
`photo_check`, `competitor_check`, `sources`, `owner_questions` and `drafted_at`.

In the engine, click **Import Claude drafts**. Drafts land in **To review** under the
**Claude drafts to review** chip. Approve and publish them one by one as usual.
Publishing changes the slug to `slug` and records the old one in `old_slugs`
(run `supabase-old-slugs.sql` once first), so old links redirect.
