// BlockBudds search-streamers Edge Function
// Public GET ?q=... — searches Twitch and YouTube for channels not already
// listed in public.streamers. Called from the browser with the anon key.
// An empty q, or minecraft / live, returns popular live Minecraft streams.
// Any other keyword (hardcore, skyblock, modded, …) searches Twitch channels
// and currently-live Minecraft streams (a few Helix pages), matching the
// keyword against stream titles and tags. Live matches come first, by viewers.
// YouTube still uses one search.list per fresh query, inside the daily cap.
// Deploy with verify_jwt = false.
//
// Cache: Twitch 10 minutes, YouTube 24 hours.
// YouTube fresh searches are capped at 60 per UTC day (search.list is 100 units).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://blockbudds.com",
  "https://www.blockbudds.com",
  "https://thephillis.github.io",
]);

const MIN_Q = 2;
const MAX_Q = 50;
const TWITCH_FIRST = 10;
const TWITCH_KEYWORD_FIRST = 20;
// Helix game id for Minecraft. Streams are ordered by viewer count.
const MINECRAFT_GAME_ID = "27471";
const STREAM_PAGE_SIZE = 100;
const STREAM_PAGES = 3;
const MAX_LIVE_MATCHES = 40;
const BROWSE_QUERIES = new Set(["", "minecraft", "mc", "live"]);
const STOP_WORDS = new Set(["only", "the", "a", "an", "and", "just", "of"]);
const YOUTUBE_MAX = 5;
const YOUTUBE_DAILY_BUDGET = 60;
const TWITCH_TTL_MS = 10 * 60 * 1000;
const YOUTUBE_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;

const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const TWITCH_SEARCH_URL = "https://api.twitch.tv/helix/search/channels";
const TWITCH_STREAMS_URL = "https://api.twitch.tv/helix/streams";
const YT_API = "https://www.googleapis.com/youtube/v3";

type SearchItem = {
  platform: "twitch" | "youtube";
  name: string;
  handle: string;
  login?: string;
  channel_url: string;
  avatar_url: string | null;
  is_live: boolean;
  live_title: string | null;
  game: string | null;
  minecraft?: boolean;
  subscribers?: number;
  viewers?: number;
};

type TwitchChannel = {
  broadcaster_login: string;
  display_name: string;
  game_name: string;
  is_live: boolean;
  thumbnail_url: string;
  title: string;
};

type YtSearchItem = {
  id?: { channelId?: string };
  snippet?: {
    channelId?: string;
    title?: string;
    thumbnails?: Record<string, { url?: string }>;
  };
};

type YtChannel = {
  id: string;
  snippet?: {
    title?: string;
    customUrl?: string;
    thumbnails?: Record<string, { url?: string }>;
  };
  statistics?: {
    subscriberCount?: string;
    hiddenSubscriberCount?: boolean;
  };
};

Deno.serve(async (req) => {
  const cors = corsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== "GET") {
    return json({ error: "method not allowed" }, 405, cors);
  }

  const url = new URL(req.url);
  const raw = url.searchParams.get("q") ?? "";
  const trimmed = raw.trim();
  const browse = isBrowseQuery(trimmed);
  if (!browse && trimmed.length < MIN_Q) {
    return json({ error: "query must be at least 2 characters" }, 400, cors);
  }
  if (trimmed.length > MAX_Q) {
    return json({ error: "query must be at most 50 characters" }, 400, cors);
  }

  // Empty / minecraft / live share one popular-Minecraft cache entry.
  // Keywords keep their own cache and their own YouTube search text.
  const queryKey = browse ? "minecraft" : normalizeQueryKey(trimmed);
  const words = keywords(trimmed);
  const searchText = browse ? "minecraft" : (words.join(" ") || trimmed);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "missing supabase env" }, 500, cors);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ipHash = await clientIpHash(req);
  if (ipHash) {
    const allowed = await touchRateLimit(supabase, ipHash);
    if (!allowed) {
      return json({ error: "too many requests" }, 429, cors);
    }
  }

  let twitchItems: SearchItem[] = [];
  let youtubeItems: SearchItem[] = [];
  let youtubeLimited = false;
  let twitchCached = false;
  let youtubeCached = false;
  let twitchError: string | undefined;
  let youtubeError: string | undefined;

  const twitchCachedRows = await readCache(supabase, queryKey, "twitch", TWITCH_TTL_MS);
  if (twitchCachedRows) {
    twitchItems = twitchCachedRows;
    twitchCached = true;
  } else {
    try {
      twitchItems = browse ? await searchTwitchBrowse() : await searchTwitchKeyword(trimmed);
      await writeCache(supabase, queryKey, "twitch", twitchItems);
    } catch (err) {
      twitchError = err instanceof Error ? err.message : "twitch search failed";
    }
  }

  const youtubeCachedRows = await readCache(supabase, queryKey, "youtube", YOUTUBE_TTL_MS);
  if (youtubeCachedRows) {
    youtubeItems = youtubeCachedRows;
    youtubeCached = true;
  } else {
    const reserved = await reserveYoutubeSearch(supabase);
    if (!reserved) {
      youtubeLimited = true;
    } else {
      try {
        youtubeItems = await searchYoutube(searchText);
        await writeCache(supabase, queryKey, "youtube", youtubeItems);
      } catch (err) {
        youtubeError = err instanceof Error ? err.message : "youtube search failed";
        await refundYoutubeSearch(supabase);
      }
    }
  }

  const listed = await loadListedStreamers(supabase);
  twitchItems = sortSearchItems(excludeListed(twitchItems, listed));
  youtubeItems = excludeListed(youtubeItems, listed);

  const body: Record<string, unknown> = {
    twitch: twitchItems,
    youtube: youtubeItems,
  };
  if (youtubeLimited) body.youtube_limited = true;
  // cache flags are informational; the frontend can ignore them
  if (twitchCached) body.twitch_cached = true;
  if (youtubeCached) body.youtube_cached = true;
  if (twitchError) body.twitch_error = twitchError;
  if (youtubeError) body.youtube_error = youtubeError;

  return json(body, 200, cors);
});

function corsHeaders(req: Request): Headers {
  const headers = new Headers();
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  );
  headers.set("Access-Control-Max-Age", "3600");
  const origin = req.headers.get("origin") ?? "";
  if (ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function json(body: unknown, status: number, cors: Headers): Response {
  const headers = new Headers(cors);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function normalizeQueryKey(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function isBrowseQuery(q: string): boolean {
  return BROWSE_QUERIES.has(q.trim().toLowerCase());
}

function isMinecraft(game: string | null | undefined): boolean {
  if (!game) return false;
  const g = game.trim().toLowerCase();
  return g === "minecraft" || g.startsWith("minecraft:") || g.startsWith("minecraft ");
}

function keywords(q: string): string[] {
  return q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word));
}

function sortSearchItems(items: SearchItem[]): SearchItem[] {
  return [...items].sort((a, b) => {
    const live = Number(!!b.is_live) - Number(!!a.is_live);
    if (live) return live;
    const viewers = (b.viewers ?? 0) - (a.viewers ?? 0);
    if (viewers) return viewers;
    return Number(!!b.minecraft) - Number(!!a.minecraft);
  });
}

type Listed = { twitchLogins: Set<string>; youtubeIds: Set<string>; youtubeHandles: Set<string> };

function excludeListed(items: SearchItem[], listed: Listed): SearchItem[] {
  return items.filter((item) => {
    if (item.platform === "twitch") {
      const login = (item.login || item.handle || "").trim().replace(/^@/, "").toLowerCase();
      return !listed.twitchLogins.has(login);
    }
    const id = (item as SearchItem & { channel_id?: string }).channel_id
      ?? extractYoutubeChannelId(item.channel_url);
    if (id && listed.youtubeIds.has(id.toLowerCase())) return false;
    const handle = (item.handle || "").trim().replace(/^@/, "").toLowerCase();
    if (handle && listed.youtubeHandles.has(handle)) return false;
    return true;
  });
}

function extractYoutubeChannelId(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/youtube\.com\/channel\/(UC[\w-]{22})/i);
  return m ? m[1] : null;
}

async function loadListedStreamers(supabase: SupabaseClient): Promise<Listed> {
  const listed: Listed = {
    twitchLogins: new Set(),
    youtubeIds: new Set(),
    youtubeHandles: new Set(),
  };
  const { data, error } = await supabase
    .from("streamers")
    .select("platform, channel_handle, youtube_channel_id, channel_url");
  if (error || !data) return listed;
  for (const row of data as Array<{
    platform: string;
    channel_handle: string | null;
    youtube_channel_id: string | null;
    channel_url: string | null;
  }>) {
    const handle = (row.channel_handle ?? "").trim().replace(/^@/, "").toLowerCase();
    if (row.platform === "twitch" && handle) listed.twitchLogins.add(handle);
    if (row.platform === "youtube" && handle) listed.youtubeHandles.add(handle);
    if (row.youtube_channel_id) listed.youtubeIds.add(row.youtube_channel_id.trim().toLowerCase());
    const fromUrl = extractYoutubeChannelId(row.channel_url ?? undefined);
    if (fromUrl) listed.youtubeIds.add(fromUrl.toLowerCase());
  }
  return listed;
}

async function readCache(
  supabase: SupabaseClient,
  queryKey: string,
  platform: "twitch" | "youtube",
  ttlMs: number,
): Promise<SearchItem[] | null> {
  const { data, error } = await supabase
    .from("streamer_search_cache")
    .select("results, fetched_at")
    .eq("query_key", queryKey)
    .eq("platform", platform)
    .maybeSingle();
  if (error || !data) return null;
  const fetched = Date.parse(data.fetched_at as string);
  if (!Number.isFinite(fetched) || Date.now() - fetched > ttlMs) return null;
  return Array.isArray(data.results) ? data.results as SearchItem[] : [];
}

async function writeCache(
  supabase: SupabaseClient,
  queryKey: string,
  platform: "twitch" | "youtube",
  results: SearchItem[],
): Promise<void> {
  await supabase.from("streamer_search_cache").upsert({
    query_key: queryKey,
    platform,
    results,
    fetched_at: new Date().toISOString(),
  });
}

async function reserveYoutubeSearch(supabase: SupabaseClient): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("streamer_search_quota")
    .select("youtube_fresh_searches")
    .eq("day", day)
    .maybeSingle();
  const current = data?.youtube_fresh_searches ?? 0;
  if (current >= YOUTUBE_DAILY_BUDGET) return false;
  if (!data) {
    const { error } = await supabase
      .from("streamer_search_quota")
      .insert({ day, youtube_fresh_searches: 1 });
    if (error) {
      // concurrent insert — try an increment instead
      const { data: again } = await supabase
        .from("streamer_search_quota")
        .select("youtube_fresh_searches")
        .eq("day", day)
        .maybeSingle();
      const n = again?.youtube_fresh_searches ?? 0;
      if (n >= YOUTUBE_DAILY_BUDGET) return false;
      await supabase
        .from("streamer_search_quota")
        .update({ youtube_fresh_searches: n + 1 })
        .eq("day", day)
        .lt("youtube_fresh_searches", YOUTUBE_DAILY_BUDGET);
    }
    return true;
  }
  const { data: updated, error } = await supabase
    .from("streamer_search_quota")
    .update({ youtube_fresh_searches: current + 1 })
    .eq("day", day)
    .eq("youtube_fresh_searches", current)
    .select("youtube_fresh_searches")
    .maybeSingle();
  if (error || !updated) {
    const { data: again } = await supabase
      .from("streamer_search_quota")
      .select("youtube_fresh_searches")
      .eq("day", day)
      .maybeSingle();
    return (again?.youtube_fresh_searches ?? YOUTUBE_DAILY_BUDGET) < YOUTUBE_DAILY_BUDGET;
  }
  return true;
}

async function refundYoutubeSearch(supabase: SupabaseClient): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("streamer_search_quota")
    .select("youtube_fresh_searches")
    .eq("day", day)
    .maybeSingle();
  const n = data?.youtube_fresh_searches ?? 0;
  if (n > 0) {
    await supabase
      .from("streamer_search_quota")
      .update({ youtube_fresh_searches: n - 1 })
      .eq("day", day);
  }
}

async function touchRateLimit(supabase: SupabaseClient, ipHash: string): Promise<boolean> {
  const { data } = await supabase
    .from("streamer_search_rate")
    .select("window_start, request_count")
    .eq("ip_hash", ipHash)
    .maybeSingle();
  const now = Date.now();
  const windowStart = data ? Date.parse(data.window_start as string) : NaN;
  const fresh = !data || !Number.isFinite(windowStart) || now - windowStart > RATE_WINDOW_MS;
  if (fresh) {
    const { error } = await supabase.from("streamer_search_rate").upsert({
      ip_hash: ipHash,
      window_start: new Date(now).toISOString(),
      request_count: 1,
    });
    return !error;
  }
  if ((data.request_count ?? 0) >= RATE_LIMIT) return false;
  const { error } = await supabase
    .from("streamer_search_rate")
    .update({ request_count: (data.request_count ?? 0) + 1 })
    .eq("ip_hash", ipHash);
  return !error;
}

async function clientIpHash(req: Request): Promise<string | null> {
  const raw = req.headers.get("cf-connecting-ip")
    || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "";
  if (!raw) return null;
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function getTwitchAppToken(): Promise<string> {
  const clientId = Deno.env.get("TWITCH_CLIENT_ID");
  const clientSecret = Deno.env.get("TWITCH_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("missing twitch credentials");
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });
  const res = await fetch(TWITCH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`twitch token http ${res.status}`);
  const data = await res.json() as { access_token?: string };
  if (!data.access_token) throw new Error("twitch token missing");
  return data.access_token;
}

function twitchHeaders(token: string, clientId: string): HeadersInit {
  return {
    "Authorization": `Bearer ${token}`,
    "Client-Id": clientId,
  };
}

function twitchChannelItem(ch: TwitchChannel, forceLive = false): SearchItem | null {
  const login = (ch.broadcaster_login || "").trim().toLowerCase();
  if (!login) return null;
  const live = forceLive || !!ch.is_live;
  const game = ch.game_name?.trim() || null;
  const item: SearchItem = {
    platform: "twitch",
    name: ch.display_name || login,
    handle: login,
    login,
    channel_url: `https://twitch.tv/${login}`,
    avatar_url: ch.thumbnail_url || null,
    is_live: live,
    live_title: live ? (ch.title?.trim() || null) : null,
    game,
  };
  if (forceLive || isMinecraft(game)) item.minecraft = true;
  return item;
}

async function searchTwitch(q: string): Promise<SearchItem[]> {
  const clientId = Deno.env.get("TWITCH_CLIENT_ID");
  if (!clientId) throw new Error("missing twitch credentials");
  const token = await getTwitchAppToken();
  return searchTwitchChannels(token, clientId, q);
}

async function searchTwitchChannels(
  token: string,
  clientId: string,
  q: string,
  first = TWITCH_FIRST,
): Promise<SearchItem[]> {
  const url = new URL(TWITCH_SEARCH_URL);
  url.searchParams.set("query", q);
  url.searchParams.set("first", String(first));
  url.searchParams.set("live_only", "false");
  const res = await fetch(url, { headers: twitchHeaders(token, clientId) });
  if (!res.ok) throw new Error(`twitch search http ${res.status}`);
  const data = await res.json() as { data?: TwitchChannel[] };
  const items: SearchItem[] = [];
  for (const ch of data.data ?? []) {
    const item = twitchChannelItem(ch);
    if (item) items.push(item);
  }
  items.sort((a, b) => Number(!!b.is_live) - Number(!!a.is_live));
  return items;
}

// Popular live Minecraft streams (Helix already sorts by viewers), then
// other Minecraft channel matches that are not already in that list.
async function searchTwitchBrowse(): Promise<SearchItem[]> {
  const clientId = Deno.env.get("TWITCH_CLIENT_ID");
  if (!clientId) throw new Error("missing twitch credentials");
  const token = await getTwitchAppToken();
  const liveUrl = new URL(TWITCH_STREAMS_URL);
  liveUrl.searchParams.set("game_id", MINECRAFT_GAME_ID);
  liveUrl.searchParams.set("first", String(TWITCH_FIRST));
  const res = await fetch(liveUrl, { headers: twitchHeaders(token, clientId) });
  if (!res.ok) throw new Error(`twitch streams http ${res.status}`);
  const data = await res.json() as {
    data?: Array<{
      user_login?: string;
      user_name?: string;
      game_name?: string;
      title?: string;
      thumbnail_url?: string;
    }>;
  };
  const live: SearchItem[] = [];
  const seen = new Set<string>();
  for (const stream of data.data ?? []) {
    const item = twitchChannelItem({
      broadcaster_login: stream.user_login || "",
      display_name: stream.user_name || stream.user_login || "",
      game_name: stream.game_name || "Minecraft",
      is_live: true,
      thumbnail_url: (stream.thumbnail_url || "").replaceAll("{width}", "320").replaceAll("{height}", "320"),
      title: stream.title || "",
    }, true);
    if (!item || !item.login || seen.has(item.login)) continue;
    seen.add(item.login);
    live.push(item);
  }
  const extra = await searchTwitchChannels(token, clientId, "minecraft");
  for (const item of extra) {
    if (!item.login || seen.has(item.login)) continue;
    seen.add(item.login);
    live.push(item);
  }
  return live;
}

type HelixStream = {
  user_login?: string;
  user_name?: string;
  game_name?: string;
  title?: string;
  tags?: string[];
  viewer_count?: number;
  thumbnail_url?: string;
};

function streamHaystack(stream: HelixStream): string {
  const tags = (stream.tags ?? []).join(" ");
  return `${stream.title ?? ""} ${tags}`.toLowerCase();
}

function streamMatchesKeyword(stream: HelixStream, words: string[]): boolean {
  if (!words.length) return false;
  const hay = streamHaystack(stream);
  return words.every((word) => hay.includes(word));
}

function streamToItem(stream: HelixStream): SearchItem | null {
  const item = twitchChannelItem({
    broadcaster_login: stream.user_login || "",
    display_name: stream.user_name || stream.user_login || "",
    game_name: stream.game_name || "Minecraft",
    is_live: true,
    thumbnail_url: (stream.thumbnail_url || "").replaceAll("{width}", "320").replaceAll("{height}", "320"),
    title: stream.title || "",
  }, true);
  if (!item) return null;
  const viewers = Number(stream.viewer_count);
  if (Number.isFinite(viewers) && viewers >= 0) item.viewers = viewers;
  return item;
}

async function fetchMinecraftStreams(token: string, clientId: string): Promise<HelixStream[]> {
  const all: HelixStream[] = [];
  let cursor = "";
  for (let page = 0; page < STREAM_PAGES; page++) {
    const url = new URL(TWITCH_STREAMS_URL);
    url.searchParams.set("game_id", MINECRAFT_GAME_ID);
    url.searchParams.set("first", String(STREAM_PAGE_SIZE));
    if (cursor) url.searchParams.set("after", cursor);
    const res = await fetch(url, { headers: twitchHeaders(token, clientId) });
    if (!res.ok) throw new Error(`twitch streams http ${res.status}`);
    const data = await res.json() as { data?: HelixStream[]; pagination?: { cursor?: string } };
    const batch = data.data ?? [];
    all.push(...batch);
    cursor = data.pagination?.cursor || "";
    if (!cursor || batch.length === 0) break;
  }
  return all;
}

// Live Minecraft streams whose title or tags contain the keyword, most
// viewers first, then Twitch channel-search hits that are not already listed.
async function searchTwitchKeyword(q: string): Promise<SearchItem[]> {
  const clientId = Deno.env.get("TWITCH_CLIENT_ID");
  if (!clientId) throw new Error("missing twitch credentials");
  const token = await getTwitchAppToken();
  const words = keywords(q);
  const items: SearchItem[] = [];
  const seen = new Set<string>();

  try {
    const streams = await fetchMinecraftStreams(token, clientId);
    const matched = streams
      .filter((stream) => streamMatchesKeyword(stream, words))
      .sort((a, b) => (b.viewer_count ?? 0) - (a.viewer_count ?? 0));
    for (const stream of matched) {
      const item = streamToItem(stream);
      if (!item?.login || seen.has(item.login)) continue;
      seen.add(item.login);
      items.push(item);
      if (items.length >= MAX_LIVE_MATCHES) break;
    }
  } catch (_err) {
    // Channel search still runs if the streams pages fail.
  }

  const channelQuery = words.join(" ") || q;
  try {
    const channels = await searchTwitchChannels(token, clientId, channelQuery, TWITCH_KEYWORD_FIRST);
    for (const item of channels) {
      if (!item.login || seen.has(item.login)) continue;
      seen.add(item.login);
      items.push(item);
    }
  } catch (err) {
    if (!items.length) throw err;
  }
  return items;
}

function ytThumb(thumbs: Record<string, { url?: string }> | undefined): string | null {
  if (!thumbs) return null;
  return thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null;
}

async function ytGet(path: string, params: Record<string, string>, apiKey: string): Promise<unknown> {
  const url = new URL(YT_API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", apiKey);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`youtube ${path} http ${res.status}`);
  return await res.json();
}

async function searchYoutube(q: string): Promise<SearchItem[]> {
  const apiKey = Deno.env.get("YOUTUBE_API_KEY");
  if (!apiKey) throw new Error("missing youtube api key");

  const search = await ytGet("/search", {
    part: "snippet",
    type: "channel",
    q,
    maxResults: String(YOUTUBE_MAX),
    relevanceLanguage: "en",
  }, apiKey) as { items?: YtSearchItem[] };

  const ids = [...new Set(
    (search.items ?? [])
      .map((it) => it.id?.channelId || it.snippet?.channelId || "")
      .filter(Boolean),
  )];
  if (ids.length === 0) return [];

  const channels = await ytGet("/channels", {
    part: "snippet,statistics",
    id: ids.join(","),
  }, apiKey) as { items?: YtChannel[] };

  const byId = new Map((channels.items ?? []).map((c) => [c.id, c]));
  const items: SearchItem[] = [];
  for (const id of ids) {
    const ch = byId.get(id);
    const title = ch?.snippet?.title || "";
    let handle = (ch?.snippet?.customUrl || "").trim();
    if (handle && !handle.startsWith("@") && !handle.startsWith("UC")) {
      handle = "@" + handle.replace(/^@/, "");
    }
    if (!handle) handle = id;
    const url = handle.startsWith("@")
      ? `https://www.youtube.com/${handle}`
      : `https://www.youtube.com/channel/${id}`;
    const item: SearchItem = {
      platform: "youtube",
      name: title || handle,
      handle,
      channel_url: url,
      avatar_url: ytThumb(ch?.snippet?.thumbnails),
      is_live: false,
      live_title: null,
      game: null,
    };
    // stash channel id in the URL already; also keep handle. For exclusion we parse channel URLs / handles.
    // Attach channel_id in a way that is useful to the frontend and to excludeListed.
    (item as SearchItem & { channel_id: string }).channel_id = id;
    if (!ch?.statistics?.hiddenSubscriberCount && ch?.statistics?.subscriberCount) {
      const n = Number.parseInt(ch.statistics.subscriberCount, 10);
      if (Number.isFinite(n)) item.subscribers = n;
    }
    items.push(item);
  }
  return items;
}
