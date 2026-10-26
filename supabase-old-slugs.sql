-- Run once in Supabase > SQL Editor before publishing renamed links from the SEO engine.
-- old_slugs keeps every previous link of a product; the site redirects them (301) to the current link,
-- so pages Google already knows keep working when a slug is cleaned up.
alter table products add column if not exists old_slugs text[] not null default '{}';
create index if not exists products_old_slugs_idx on products using gin (old_slugs);
