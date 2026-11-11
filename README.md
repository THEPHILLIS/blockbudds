# BlockBudds

BlockBudds is a Minecraft social site. Share a build, like the day's most-loved post, find streamers, and keep a profile. Accounts, posts, likes, follows, and the streamer directory are stored in Supabase. The page is still a single static `index.html`.

## Open it locally

Open `index.html` in a browser, or use the Live Server extension in VS Code.

## Hosting

This is a static site for GitHub Pages, Cloudflare Pages, or Netlify at [blockbudds.com](https://blockbudds.com). `index.html` at the repo root is served at `/`. The Supabase URL and anon key are public and live in that page. `supabase/migrations/001_init.sql` is the schema already applied to the project.
