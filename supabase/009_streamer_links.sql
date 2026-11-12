-- Extra platform handles on a streamer's own row, and a reset of live
-- status when those handles change.
-- Project: kpaiacaqylipffdilnci (eu-central-1)
--
-- Run this whole file once in the Supabase SQL editor, after
-- 008_tiktok_handle.sql if you have not run that yet. This file adds
-- tiktok_handle itself when it is missing.
--
-- Owners can already update their own streamers row (RLS policy
-- "Users can update their own linked streamer"). Live columns stay
-- client-locked. The trigger below clears them when a handle changes,
-- so check-live can resolve the new channel.

alter table public.streamers
  add column if not exists twitch_handle text,
  add column if not exists youtube_handle text,
  add column if not exists kick_handle text,
  add column if not exists tiktok_handle text;

comment on column public.streamers.twitch_handle is
  'Optional Twitch login. Used by check-live when set. Not a live flag.';
comment on column public.streamers.youtube_handle is
  'Optional YouTube handle or UC channel id. Clearing or changing it drops youtube_channel_id so check-live resolves it again.';
comment on column public.streamers.kick_handle is
  'Optional Kick slug. Link only; Kick live checks are not wired up.';
comment on column public.streamers.tiktok_handle is
  'Optional TikTok username without @. Link only; not used for live status.';

-- Copy the original single handle into the matching column.
update public.streamers
set twitch_handle = lower(regexp_replace(btrim(channel_handle), '^@+', ''))
where platform = 'twitch'
  and twitch_handle is null
  and channel_handle is not null
  and btrim(channel_handle) <> '';

update public.streamers
set youtube_handle = regexp_replace(btrim(channel_handle), '^@+', '')
where platform = 'youtube'
  and youtube_handle is null
  and channel_handle is not null
  and btrim(channel_handle) <> '';

update public.streamers
set kick_handle = lower(regexp_replace(btrim(channel_handle), '^@+', ''))
where platform = 'kick'
  and kick_handle is null
  and channel_handle is not null
  and btrim(channel_handle) <> '';

update public.streamers
set tiktok_handle = regexp_replace(btrim(channel_handle), '^@+', '')
where platform = 'tiktok'
  and tiktok_handle is null
  and channel_handle is not null
  and regexp_replace(btrim(channel_handle), '^@+', '') ~ '^[A-Za-z0-9._]{1,24}$';

grant insert (twitch_handle, youtube_handle, kick_handle, tiktok_handle)
  on table public.streamers to authenticated;
grant update (twitch_handle, youtube_handle, kick_handle, tiktok_handle)
  on table public.streamers to authenticated;

-- Owners already have this policy. Recreate it so a fresh run is explicit.
drop policy if exists "Users can update their own linked streamer" on public.streamers;
create policy "Users can update their own linked streamer"
  on public.streamers
  for update
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- Runs after streamers_protect_privileged, which copies the old live
-- columns back onto client updates. This one then clears them when the
-- channel identity actually changed. service_role (check-live) is left alone.
create or replace function public.clear_streamer_live_on_handle_change()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  old_twitch text;
  new_twitch text;
  old_youtube text;
  new_youtube text;
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;
  if auth.role() is distinct from 'authenticated' and auth.role() is distinct from 'anon' then
    return new;
  end if;

  old_twitch := lower(regexp_replace(btrim(coalesce(
    old.twitch_handle,
    case when old.platform = 'twitch' then old.channel_handle else '' end
  )), '^@+', ''));
  new_twitch := lower(regexp_replace(btrim(coalesce(
    new.twitch_handle,
    case when new.platform = 'twitch' then new.channel_handle else '' end
  )), '^@+', ''));
  old_youtube := lower(regexp_replace(btrim(coalesce(
    old.youtube_handle,
    case when old.platform = 'youtube' then old.channel_handle else '' end
  )), '^@+', ''));
  new_youtube := lower(regexp_replace(btrim(coalesce(
    new.youtube_handle,
    case when new.platform = 'youtube' then new.channel_handle else '' end
  )), '^@+', ''));

  if old.platform is distinct from new.platform
     or lower(regexp_replace(btrim(coalesce(old.channel_handle, '')), '^@+', ''))
        is distinct from lower(regexp_replace(btrim(coalesce(new.channel_handle, '')), '^@+', ''))
     or old_twitch is distinct from new_twitch
     or old_youtube is distinct from new_youtube
     or lower(regexp_replace(btrim(coalesce(old.kick_handle, '')), '^@+', ''))
        is distinct from lower(regexp_replace(btrim(coalesce(new.kick_handle, '')), '^@+', ''))
  then
    new.is_live := false;
    new.live_title := null;
    new.live_game := null;
    new.live_viewers := null;
    new.live_started_at := null;
    new.live_thumbnail_url := null;
    new.live_checked_at := null;
    new.live_url := null;
  end if;

  if old_youtube is distinct from new_youtube then
    new.youtube_channel_id := null;
  end if;

  return new;
end;
$$;

drop trigger if exists streamers_z_clear_live_on_handle_change on public.streamers;
create trigger streamers_z_clear_live_on_handle_change
  before update on public.streamers
  for each row execute function public.clear_streamer_live_on_handle_change();

notify pgrst, 'reload schema';
