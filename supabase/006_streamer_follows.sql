-- User follows for listed and outside streamers.
-- Project: kpaiacaqylipffdilnci (eu-central-1)
-- Apply after 005_search_cache.sql.

create table if not exists public.streamer_follows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  platform text not null,
  channel_key text not null,
  streamer_id uuid null references public.streamers (id) on delete set null,
  display_name text not null,
  avatar_url text null,
  channel_url text null,
  created_at timestamptz not null default now(),
  constraint streamer_follows_platform_check
    check (platform in ('twitch', 'youtube', 'kick', 'tiktok')),
  constraint streamer_follows_channel_key_not_empty
    check (char_length(btrim(channel_key)) > 0),
  constraint streamer_follows_display_name_length
    check (char_length(display_name) <= 100),
  constraint streamer_follows_avatar_url_length
    check (avatar_url is null or char_length(avatar_url) <= 500),
  constraint streamer_follows_channel_url_https
    check (channel_url is null or channel_url ~ '^https://'),
  constraint streamer_follows_user_platform_channel_key_key
    unique (user_id, platform, channel_key)
);

create index if not exists streamer_follows_user_id_idx
  on public.streamer_follows (user_id);

comment on table public.streamer_follows is
  'Streamers a user follows, both BlockBudds-listed and outside Twitch/YouTube/Kick/TikTok results. Clients may only read, insert, and delete their own rows.';
comment on column public.streamer_follows.channel_key is
  'Stable identity for the followed channel: lowercase Twitch login (streamers.channel_handle) or YouTube channel id (streamers.youtube_channel_id). Normalised to lowercase on write.';
comment on column public.streamer_follows.streamer_id is
  'Optional link to public.streamers.id when the follow is a listed BlockBudds streamer. Set null if the streamer row is removed.';

-- Lowercase (and trim) channel_key on insert/update so the unique key is stable.
create or replace function public.normalize_streamer_follow_channel_key()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.channel_key := lower(btrim(new.channel_key));
  return new;
end;
$$;

create trigger streamer_follows_normalize_channel_key
  before insert or update on public.streamer_follows
  for each row execute function public.normalize_streamer_follow_channel_key();

-- Cap follows at 500 per user.
create or replace function public.enforce_streamer_follows_limit()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (
    select count(*) from public.streamer_follows
    where user_id = new.user_id
  ) >= 500 then
    raise exception 'A user can follow at most 500 streamers'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger streamer_follows_limit
  before insert on public.streamer_follows
  for each row execute function public.enforce_streamer_follows_limit();

alter table public.streamer_follows enable row level security;

create policy "Users can read their own streamer follows"
  on public.streamer_follows
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can insert their own streamer follows"
  on public.streamer_follows
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can delete their own streamer follows"
  on public.streamer_follows
  for delete
  to authenticated
  using (user_id = auth.uid());

-- No update policy: follows are inserted or deleted, not edited.

revoke all on table public.streamer_follows from anon, authenticated, public;
grant select, insert, delete on table public.streamer_follows to authenticated;
