-- Streamer search cache, YouTube daily budget, and per-IP rate limit.
-- Used only by the search-streamers Edge Function (service_role).
-- Project: kpaiacaqylipffdilnci (eu-central-1)

-- ---------------------------------------------------------------------------
-- Cache of Helix / YouTube search results.
-- TTL is enforced in the function: Twitch 10 minutes, YouTube 24 hours.
-- ---------------------------------------------------------------------------
create table if not exists public.streamer_search_cache (
  query_key text not null,
  platform text not null,
  results jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now(),
  primary key (query_key, platform),
  constraint streamer_search_cache_platform_check
    check (platform in ('twitch', 'youtube')),
  constraint streamer_search_cache_query_key_not_empty
    check (char_length(query_key) > 0)
);

comment on table public.streamer_search_cache is
  'Cached outside-directory streamer search results. Service role only; TTL enforced by the search-streamers function.';

-- ---------------------------------------------------------------------------
-- Daily YouTube fresh-search budget (UTC day). Cap is 60, enforced in the function.
-- ---------------------------------------------------------------------------
create table if not exists public.streamer_search_quota (
  day date primary key,
  youtube_fresh_searches integer not null default 0,
  constraint streamer_search_quota_nonneg check (youtube_fresh_searches >= 0)
);

comment on table public.streamer_search_quota is
  'UTC daily count of fresh YouTube search.list calls made by search-streamers. Cap is 60.';

-- ---------------------------------------------------------------------------
-- Per-IP rate limit windows (~30 requests / minute). IPs are stored hashed.
-- ---------------------------------------------------------------------------
create table if not exists public.streamer_search_rate (
  ip_hash text primary key,
  window_start timestamptz not null,
  request_count integer not null default 0,
  constraint streamer_search_rate_count_nonneg check (request_count >= 0)
);

comment on table public.streamer_search_rate is
  'Hashed client-IP request windows for search-streamers. Service role only.';

-- No public access. The Edge Function writes these with the service role key.
alter table public.streamer_search_cache enable row level security;
alter table public.streamer_search_quota enable row level security;
alter table public.streamer_search_rate enable row level security;

revoke all on table public.streamer_search_cache from anon, authenticated, public;
revoke all on table public.streamer_search_quota from anon, authenticated, public;
revoke all on table public.streamer_search_rate from anon, authenticated, public;
