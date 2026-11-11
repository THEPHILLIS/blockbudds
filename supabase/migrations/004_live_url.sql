-- Add a shared live_url and a cached YouTube channel id.
-- Project: kpaiacaqylipffdilnci (eu-central-1)
-- Apply after 002_live_status.sql.

alter table public.streamers
  add column if not exists live_url text,
  add column if not exists youtube_channel_id text;

comment on column public.streamers.live_url is
  'Watch URL for the current stream when live (Twitch channel or YouTube watch link); null when offline. Maintained by check-live; not client-writable.';
comment on column public.streamers.youtube_channel_id is
  'Cached YouTube channel ID (UC...) resolved from the handle or URL. Maintained by check-live; not client-writable.';

-- Keep live_url and youtube_channel_id privileged, same as the other live_* columns.
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
      new.live_url := null;
      new.youtube_channel_id := null;
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
      new.live_url := old.live_url;
      new.youtube_channel_id := old.youtube_channel_id;
    end if;
  end if;
  return new;
end;
$$;

comment on function public.protect_streamer_privileged_columns() is
  'Prevents authenticated/anon clients from setting verified, live-status, live_url, or youtube_channel_id, or changing id, profile_id, and created_at.';
