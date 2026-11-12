-- Profile follower / following / streamer-follow counts.
-- Project: kpaiacaqylipffdilnci (eu-central-1)
--
-- Run this whole file once in the Supabase SQL editor. It does not change
-- existing rows. It adds a count-only function so a profile can show
--   * how many people follow that user (public.follows)
--   * how many people that user follows (public.follows)
--   * how many streamers that user follows (public.streamer_follows)
-- without letting clients read someone else's streamer_follows rows.
--
-- The site works before this is applied: your own profile can still count
-- your streamer follows directly. Other profiles only show that third number
-- after this function exists.

create or replace function public.profile_follow_counts(target uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'followers', (select count(*) from public.follows where following_id = target),
    'following', (select count(*) from public.follows where follower_id = target),
    'streamers', (select count(*) from public.streamer_follows where user_id = target)
  );
$$;

comment on function public.profile_follow_counts(uuid) is
  'Public counts for a profile: user followers, user following, and streamers followed. Returns numbers only.';

revoke all on function public.profile_follow_counts(uuid) from public;
grant execute on function public.profile_follow_counts(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
