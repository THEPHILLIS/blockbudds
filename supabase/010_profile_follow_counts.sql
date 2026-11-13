-- Count followers and following, including streamer follows.
-- Project: kpaiacaqylipffdilnci (eu-central-1)
--
-- Already applied on the live database. Safe to run again.
-- followers: people who follow this profile, plus users who follow
--   this profile's streamer listing, each person once.
-- following: people this profile follows, plus streamers they follow.
-- people_following and streamers are those two parts of following.

create or replace function public.profile_follow_counts(target uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with s as (
    select * from public.streamers where profile_id = target
  ),
  sf as (
    select distinct f.user_id
    from public.streamer_follows f
    where f.user_id <> target
      and (
        f.streamer_id in (select id from s)
        or exists (
          select 1 from s
          where (f.platform = 'twitch' and lower(f.channel_key) = lower(s.twitch_handle))
            or (f.platform = 'youtube' and (lower(f.channel_key) = lower(s.youtube_handle) or f.channel_key = s.youtube_channel_id))
            or (f.platform = 'kick' and lower(f.channel_key) = lower(s.kick_handle))
            or (f.platform = 'tiktok' and lower(f.channel_key) = lower(s.tiktok_handle))
        )
      )
  ),
  pf as (
    select follower_id as user_id
    from public.follows
    where following_id = target
  )
  select jsonb_build_object(
    'followers', (select count(*) from (select user_id from pf union select user_id from sf) u),
    'following', (select count(*) from public.follows where follower_id = target)
      + (select count(*) from public.streamer_follows where user_id = target),
    'people_following', (select count(*) from public.follows where follower_id = target),
    'streamers', (select count(*) from public.streamer_follows where user_id = target)
  );
$$;

comment on function public.profile_follow_counts(uuid) is
  'Public counts for a profile. followers includes people and streamer-listing followers. following is people plus streamers followed.';

revoke all on function public.profile_follow_counts(uuid) from public;
grant execute on function public.profile_follow_counts(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
