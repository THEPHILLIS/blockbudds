# BlockBudds

BlockBudds is a Minecraft social site. Share a build, like the day's most-loved post, find streamers, and keep a profile. Accounts, posts, likes, follows, and the streamer directory are stored in Supabase. The page is still a single static `index.html`.

## Open it locally

Open `index.html` in a browser, or use the Live Server extension in VS Code.

## Hosting

This is a static site for GitHub Pages, Cloudflare Pages, or Netlify at [blockbudds.com](https://blockbudds.com). `index.html` at the repo root is served at `/`. The Supabase URL and anon key are public and live in that page. `supabase/migrations` is the schema already applied to the project.

## Live status

A scheduled Edge Function (`supabase/functions/check-live`) checks Twitch every 2 minutes and YouTube every 6 minutes, then writes `is_live`, `live_url`, and the other live columns on `streamers`. Kick is not checked yet. Twitch, YouTube, and cron credentials live in Supabase function secrets and in Vault (`check_live_cron_secret`), not in this repo.

Searching a name with at least two characters also asks `search-streamers` for Twitch and YouTube channels that are not already listed. Those results appear under the BlockBudds directory. The function caches Twitch for 10 minutes and YouTube for 24 hours, and it caps fresh YouTube searches at 60 per day.

