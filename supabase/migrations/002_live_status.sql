-- BlockBudds live-status columns and privileged-column protection
-- Project: kpaiacaqylipffdilnci (eu-central-1)
-- Apply after 001_init.sql.

-- ---------------------------------------------------------------------------
-- Live-status columns on public.streamers
-- Written only by the check-live Edge Function (service_role).
-- ---------------------------------------------------------------------------
alter table public.streamers
  add column if not exists is_live boolean not null default false,
  add column if not exists live_title text,
  add column if not exists live_game text,
  add column if not exists live_viewers integer,
  add column if not exists live_started_at timestamptz,
  add column if not exists live_thumbnail_url text,
  add column if not exists live_checked_at timestamptz;

alter table public.streamers
  drop constraint if exists streamers_live_viewers_nonneg;

alter table public.streamers
  add constraint streamers_live_viewers_nonneg
  check (live_viewers is null or live_viewers >= 0);

create index if not exists streamers_is_live_idx
  on public.streamers (is_live)
  where is_live = true;

comment on column public.streamers.is_live is
  'Whether the channel is currently live. Maintained by the check-live function; not client-writable.';
comment on column public.streamers.live_title is
  'Current stream title when live; null when offline. Maintained by check-live.';
comment on column public.streamers.live_game is
  'Current game/category when live; null when offline. Maintained by check-live.';
comment on column public.streamers.live_viewers is
  'Current viewer count when live; null when offline. Maintained by check-live.';
comment on column public.streamers.live_started_at is
  'When the current stream started; null when offline. Maintained by check-live.';
comment on column public.streamers.live_thumbnail_url is
  'Live thumbnail URL (440x248) when live; null when offline. Maintained by check-live.';
comment on column public.streamers.live_checked_at is
  'When check-live last refreshed this row. Maintained by check-live.';

-- ---------------------------------------------------------------------------
-- Extend privileged-column protection so clients cannot set live status.
-- service_role / postgres are not in (authenticated, anon), so they can write.
-- ---------------------------------------------------------------------------
create or replace function public.protect_streamer_privileged_columns()
returns trigger
language plpgsql
as $$
begin
  if auth.role() in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.verified := false;
      new.is_live := false;
      new.live_title := null;
      new.live_game := null;
      new.live_viewers := null;
      new.live_started_at := null;
      new.live_thumbnail_url := null;
      new.live_checked_at := null;
    elsif tg_op = 'UPDATE' then
      new.verified := old.verified;
      new.profile_id := old.profile_id;
      new.id := old.id;
      new.created_at := old.created_at;
      new.is_live := old.is_live;
      new.live_title := old.live_title;
      new.live_game := old.live_game;
      new.live_viewers := old.live_viewers;
      new.live_started_at := old.live_started_at;
      new.live_thumbnail_url := old.live_thumbnail_url;
      new.live_checked_at := old.live_checked_at;
    end if;
  end if;
  return new;
end;
$$;

comment on function public.protect_streamer_privileged_columns() is
  'Prevents authenticated/anon clients from setting verified or live-status columns, or changing id, profile_id, and created_at.';

-- Table-level SELECT already granted in 001_init.sql covers new columns for anon
-- and authenticated. Do not grant INSERT/UPDATE on live columns to clients.
