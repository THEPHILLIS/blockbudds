-- BlockBudds initial schema
-- Project: kpaiacaqylipffdilnci (eu-central-1)
-- Apply once against a fresh database.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Profiles
-- id matches auth.users and is created by a trigger on sign-up.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  display_name text,
  avatar_url text,
  bio text,
  created_at timestamptz not null default now(),
  constraint profiles_username_length check (char_length(username) between 3 and 20),
  constraint profiles_username_format check (username ~ '^[A-Za-z0-9_]+$'),
  constraint profiles_username_unique unique (username)
);

create unique index profiles_username_lower_idx on public.profiles (lower(username));

comment on table public.profiles is 'Public user profiles. One row per auth.users record, created on sign-up.';

-- Create a profile when a new auth user is inserted.
-- Username comes from raw_user_meta_data->>'username' when it is valid and free;
-- otherwise a unique fallback of the form user_<hex> is used.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  desired text;
  candidate text;
  suffix text;
  n int := 0;
begin
  desired := nullif(btrim(coalesce(new.raw_user_meta_data->>'username', '')), '');

  if desired is not null
     and desired ~ '^[A-Za-z0-9_]{3,20}$'
     and not exists (
       select 1 from public.profiles p where lower(p.username) = lower(desired)
     )
  then
    candidate := desired;
  else
    suffix := substr(replace(new.id::text, '-', ''), 1, 8);
    candidate := 'user_' || suffix;

    while exists (
      select 1 from public.profiles p where lower(p.username) = lower(candidate)
    ) loop
      n := n + 1;
      candidate := 'user_' || substr(suffix, 1, 6) || lpad(n::text, 2, '0');
    end loop;
  end if;

  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    candidate,
    coalesce(
      nullif(btrim(coalesce(new.raw_user_meta_data->>'display_name', '')), ''),
      candidate
    ),
    nullif(btrim(coalesce(new.raw_user_meta_data->>'avatar_url', '')), '')
  );

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep id and created_at immutable for ordinary users.
create or replace function public.protect_profile_immutable_columns()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger profiles_protect_immutable
  before update on public.profiles
  for each row execute function public.protect_profile_immutable_columns();

alter table public.profiles enable row level security;

create policy "Public can read profiles"
  on public.profiles
  for select
  to anon, authenticated
  using (true);

create policy "Users can update their own profile"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Inserts are performed by the security-definer sign-up trigger, not by clients.

-- ---------------------------------------------------------------------------
-- Builds
-- ---------------------------------------------------------------------------
create table public.builds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  description text,
  tags text[] not null default '{}'::text[],
  mc_version text,
  image_urls text[] not null default '{}'::text[],
  like_count integer not null default 0,
  created_at timestamptz not null default now(),
  constraint builds_title_not_empty check (char_length(btrim(title)) > 0),
  constraint builds_image_urls_max_3 check (cardinality(image_urls) <= 3),
  constraint builds_like_count_nonneg check (like_count >= 0)
);

create index builds_user_id_idx on public.builds (user_id);
create index builds_created_at_idx on public.builds (created_at desc);
create index builds_like_count_created_at_idx on public.builds (like_count desc, created_at desc);

comment on table public.builds is 'Minecraft builds posted by users. like_count is maintained by a trigger on public.likes.';

-- Owners must not be able to change id, user_id, or created_at.
-- like_count is protected by column-level grants (authenticated cannot
-- update it) so the likes sync trigger can still maintain the counter.
create or replace function public.protect_build_immutable_columns()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger builds_protect_immutable
  before update on public.builds
  for each row execute function public.protect_build_immutable_columns();

alter table public.builds enable row level security;

create policy "Public can read builds"
  on public.builds
  for select
  to anon, authenticated
  using (true);

create policy "Signed-in users with a profile can insert builds"
  on public.builds
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid())
  );

create policy "Owners can update their own builds"
  on public.builds
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Owners can delete their own builds"
  on public.builds
  for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Likes
-- ---------------------------------------------------------------------------
create table public.likes (
  user_id uuid not null references public.profiles (id) on delete cascade,
  build_id uuid not null references public.builds (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, build_id)
);

create index likes_build_id_idx on public.likes (build_id);

comment on table public.likes is 'One like per user per build. Keeps builds.like_count in sync.';

create or replace function public.sync_build_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.builds
    set like_count = like_count + 1
    where id = new.build_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.builds
    set like_count = greatest(like_count - 1, 0)
    where id = old.build_id;
    return old;
  end if;
  return null;
end;
$$;

create trigger likes_sync_build_like_count
  after insert or delete on public.likes
  for each row execute function public.sync_build_like_count();

alter table public.likes enable row level security;

create policy "Public can read likes"
  on public.likes
  for select
  to anon, authenticated
  using (true);

create policy "Users can like as themselves"
  on public.likes
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid())
  );

create policy "Users can unlike as themselves"
  on public.likes
  for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Follows
-- ---------------------------------------------------------------------------
create table public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint follows_no_self_follow check (follower_id <> following_id)
);

create index follows_following_id_idx on public.follows (following_id);

comment on table public.follows is 'User-to-user follows. Self-follows are not allowed.';

alter table public.follows enable row level security;

create policy "Public can read follows"
  on public.follows
  for select
  to anon, authenticated
  using (true);

create policy "Users can follow as themselves"
  on public.follows
  for insert
  to authenticated
  with check (
    follower_id = auth.uid()
    and follower_id <> following_id
    and exists (select 1 from public.profiles p where p.id = auth.uid())
  );

create policy "Users can unfollow as themselves"
  on public.follows
  for delete
  to authenticated
  using (follower_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Streamers
-- ---------------------------------------------------------------------------
create table public.streamers (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique references public.profiles (id) on delete set null,
  display_name text not null,
  platform text not null,
  channel_handle text not null,
  channel_url text not null,
  avatar_url text,
  bio text,
  days text[] not null default '{}'::text[],
  time_of_day text,
  mc_types text[] not null default '{}'::text[],
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  constraint streamers_platform_check
    check (platform in ('twitch', 'youtube', 'kick', 'tiktok')),
  constraint streamers_time_of_day_check
    check (time_of_day is null or time_of_day in ('morning', 'afternoon', 'evening', 'late night')),
  constraint streamers_days_check
    check (days <@ array['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']::text[]),
  constraint streamers_display_name_not_empty
    check (char_length(btrim(display_name)) > 0),
  constraint streamers_channel_handle_not_empty
    check (char_length(btrim(channel_handle)) > 0)
);

create unique index streamers_platform_handle_lower_idx
  on public.streamers (platform, lower(channel_handle));

comment on table public.streamers is 'Featured or self-linked streamer directory. verified is not client-writable.';

-- Ordinary users cannot set or change the verified flag, reassign profile_id
-- on update, or alter id / created_at.
create or replace function public.protect_streamer_privileged_columns()
returns trigger
language plpgsql
as $$
begin
  if auth.role() in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.verified := false;
    elsif tg_op = 'UPDATE' then
      new.verified := old.verified;
      new.profile_id := old.profile_id;
      new.id := old.id;
      new.created_at := old.created_at;
    end if;
  end if;
  return new;
end;
$$;

create trigger streamers_protect_privileged
  before insert or update on public.streamers
  for each row execute function public.protect_streamer_privileged_columns();

alter table public.streamers enable row level security;

create policy "Public can read streamers"
  on public.streamers
  for select
  to anon, authenticated
  using (true);

create policy "Users can insert a streamer linked to their own profile"
  on public.streamers
  for insert
  to authenticated
  with check (
    profile_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid())
  );

create policy "Users can update their own linked streamer"
  on public.streamers
  for update
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy "Users can delete their own linked streamer"
  on public.streamers
  for delete
  to authenticated
  using (profile_id = auth.uid());

-- Seed: Phil / ThePhillis only. Bio fetched from his public Twitch about text
-- as mirrored on moddex.tv/user/thephillis on 2026-11-11.
insert into public.streamers (
  display_name,
  platform,
  channel_handle,
  channel_url,
  avatar_url,
  bio,
  days,
  time_of_day,
  mc_types,
  verified
) values (
  'ThePhillis',
  'twitch',
  'thephillis',
  'https://twitch.tv/thephillis',
  'https://static-cdn.jtvnw.net/jtv_user_pictures/f1fa9d85-288d-40d9-9ce9-a8646fe7a57f-profile_image-300x300.png',
  'On 17 March 2024 I started my first ever Hardcore Minecraft world. Over 2 years later, it''s still alive. Join me for huge projects, close calls and community chaos. Earn Emeralds, unlock redeems and help shape the adventure. One mistake ends it all.',
  array['Mon', 'Tue', 'Thu', 'Fri', 'Sun']::text[],
  'evening',
  array['hardcore', 'smp']::text[],
  true
);

-- ---------------------------------------------------------------------------
-- Daily pinned build: most-liked in the last 24 hours, else all-time most-liked.
-- Both a view (single row) and an RPC are provided for the front end.
-- ---------------------------------------------------------------------------
create or replace view public.daily_pinned_build
with (security_invoker = true) as
select *
from public.builds
order by
  (created_at >= now() - interval '24 hours') desc,
  like_count desc,
  created_at desc
limit 1;

comment on view public.daily_pinned_build is
  'The most-liked build created in the last 24 hours, falling back to the all-time most-liked build.';

create or replace function public.get_daily_pinned_build()
returns setof public.builds
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  return query
    select *
    from public.builds
    where created_at >= now() - interval '24 hours'
    order by like_count desc, created_at desc
    limit 1;

  if found then
    return;
  end if;

  return query
    select *
    from public.builds
    order by like_count desc, created_at desc
    limit 1;
end;
$$;

comment on function public.get_daily_pinned_build() is
  'Returns the most-liked build created in the last 24 hours, or the all-time most-liked build if none exist in that window.';

-- ---------------------------------------------------------------------------
-- Storage: public bucket build-images
-- Objects must live under a folder named after the uploader's user id.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'build-images',
  'build-images',
  true,
  5242880, -- 5 MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']::text[]
);

create policy "Public can view build images"
  on storage.objects
  for select
  to public
  using (bucket_id = 'build-images');

create policy "Users can upload build images to their own folder"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'build-images'
    and split_part(name, '/', 1) = auth.uid()::text
  );

create policy "Users can update build images in their own folder"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'build-images'
    and split_part(name, '/', 1) = auth.uid()::text
  )
  with check (
    bucket_id = 'build-images'
    and split_part(name, '/', 1) = auth.uid()::text
  );

create policy "Users can delete build images in their own folder"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'build-images'
    and split_part(name, '/', 1) = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- Privileges
-- Fresh Supabase projects grant ALL on new public tables to anon/authenticated
-- via default privileges. Revoke that, then re-grant only what the clients need.
-- Column-level grants keep like_count, verified, and ids client-safe.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.builds from anon, authenticated;
revoke all on table public.likes from anon, authenticated;
revoke all on table public.follows from anon, authenticated;
revoke all on table public.streamers from anon, authenticated;
revoke all on public.daily_pinned_build from anon, authenticated;

grant select on table public.profiles to anon, authenticated;
grant update (username, display_name, avatar_url, bio) on table public.profiles to authenticated;

grant select on table public.builds to anon, authenticated;
grant insert (id, user_id, title, description, tags, mc_version, image_urls) on table public.builds to authenticated;
grant update (title, description, tags, mc_version, image_urls) on table public.builds to authenticated;
grant delete on table public.builds to authenticated;

grant select on table public.likes to anon, authenticated;
grant insert (user_id, build_id) on table public.likes to authenticated;
grant delete on table public.likes to authenticated;

grant select on table public.follows to anon, authenticated;
grant insert (follower_id, following_id) on table public.follows to authenticated;
grant delete on table public.follows to authenticated;

grant select on table public.streamers to anon, authenticated;
grant insert (
  id, profile_id, display_name, platform, channel_handle, channel_url,
  avatar_url, bio, days, time_of_day, mc_types
) on table public.streamers to authenticated;
grant update (
  display_name, platform, channel_handle, channel_url,
  avatar_url, bio, days, time_of_day, mc_types
) on table public.streamers to authenticated;
grant delete on table public.streamers to authenticated;

grant select on public.daily_pinned_build to anon, authenticated;

revoke all on function public.get_daily_pinned_build() from public;
grant execute on function public.get_daily_pinned_build() to anon, authenticated;
