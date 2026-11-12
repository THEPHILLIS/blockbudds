-- Optional TikTok handle on a streamer listing.
-- Project: kpaiacaqylipffdilnci (eu-central-1)
--
-- Run this whole file once in the Supabase SQL editor. It does not change
-- existing rows. TikTok is link-only: there is no public live API, so this
-- column is not read by check-live and it does not make a streamer live.
--
-- The site keeps working before this is applied. It only writes the column
-- when the database accepts it.

alter table public.streamers
  add column if not exists tiktok_handle text;

alter table public.streamers
  drop constraint if exists streamers_tiktok_handle_format;

alter table public.streamers
  add constraint streamers_tiktok_handle_format
  check (
    tiktok_handle is null
    or tiktok_handle ~ '^[A-Za-z0-9._]{1,24}$'
  );

comment on column public.streamers.tiktok_handle is
  'Optional TikTok username without @. Shown as a link to https://www.tiktok.com/@handle. Not used for live status.';

grant insert (tiktok_handle) on table public.streamers to authenticated;
grant update (tiktok_handle) on table public.streamers to authenticated;

notify pgrst, 'reload schema';
