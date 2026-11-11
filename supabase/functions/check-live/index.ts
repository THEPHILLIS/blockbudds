// BlockBudds check-live Edge Function
// Refreshes public.streamers live-status from Twitch Helix and YouTube Data API v3.
// Kick is not wired up yet (see TODO at the bottom).
//
// Auth: require header x-cron-secret == CRON_SECRET, or a Bearer token
// that matches CRON_SECRET or SUPABASE_SERVICE_ROLE_KEY.
// Deploy with verify_jwt = false so the cron shared secret can be used.
//
// YouTube is throttled to every 6th UTC minute (cron is every 2 minutes)
// to stay well inside the 10,000 unit/day quota. Pass ?youtube=1 or
// { "force_youtube": true } to run YouTube immediately.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

type StreamerRow = {
  id: string;
  platform: string;
  channel_handle: string;
  youtube_channel_id: string | null;
};

type LiveFields = {
  is_live: boolean;
  live_title: string | null;
  live_game: string | null;
  live_viewers: number | null;
  live_started_at: string | null;
  live_thumbnail_url: string | null;
  live_url: string | null;
  live_checked_at: string;
};

type TwitchStream = {
  user_login: string;
  title: string;
  game_name: string;
  viewer_count: number;
  started_at: string;
  thumbnail_url: string;
};

type YtThumbnail = { url?: string };
type YtThumbnails = {
  maxres?: YtThumbnail;
  standard?: YtThumbnail;
  high?: YtThumbnail;
  medium?: YtThumbnail;
  default?: YtThumbnail;
};

const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const TWITCH_STREAMS_URL = "https://api.twitch.tv/helix/streams";
const HELIX_BATCH_SIZE = 100;
const YT_API = "https://www.googleapis.com/youtube/v3";
const YT_PLAYLIST_ITEMS = 5;
const YT_VIDEOS_BATCH = 50;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return json({ ok: true }, 200);
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  if (!isAuthorized(req)) {
    return json({ error: "unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "missing supabase env" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: streamers, error: selectError } = await supabase
    .from("streamers")
    .select("id, platform, channel_handle, youtube_channel_id");

  if (selectError) {
    return json({ error: "failed to load streamers", detail: selectError.message }, 500);
  }

  const rows = (streamers ?? []) as StreamerRow[];
  const twitchRows = rows.filter((r) => r.platform === "twitch");
  const youtubeRows = rows.filter((r) => r.platform === "youtube");
  const kickRows = rows.filter((r) => r.platform === "kick");

  const forceYoutube = wantsForcedYoutube(req);
  const youtubeDue = forceYoutube || (new Date().getUTCMinutes() % 6 === 0);

  const results: Record<string, unknown> = {
    ok: true,
    checked_at: new Date().toISOString(),
    twitch: { checked: 0, live: 0 },
    youtube: { checked: 0, live: 0, skipped: 0, quota_units: 0 },
    // TODO: Kick live search is not implemented yet.
    kick: { checked: 0, skipped: kickRows.length, todo: true },
  };

  try {
    results.twitch = await refreshTwitch(supabase, twitchRows);
  } catch (err) {
    const message = err instanceof Error ? err.message : "twitch refresh failed";
    return json({ error: message, ...results }, 502);
  }

  if (!youtubeDue) {
    results.youtube = {
      checked: 0,
      live: 0,
      skipped: youtubeRows.length,
      quota_units: 0,
      throttled: true,
    };
  } else {
    try {
      results.youtube = await refreshYoutube(supabase, youtubeRows);
    } catch (err) {
      const message = err instanceof Error ? err.message : "youtube refresh failed";
      return json({ error: message, ...results }, 502);
    }
  }

  return json(results, 200);
});

function wantsForcedYoutube(req: Request): boolean {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("youtube") ?? url.searchParams.get("force_youtube");
    if (q === "1" || q === "true") return true;
  } catch {
    // ignore
  }
  const header = req.headers.get("x-force-youtube") ?? "";
  return header === "1" || header.toLowerCase() === "true";
}

function isAuthorized(req: Request): boolean {
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  const headerSecret = req.headers.get("x-cron-secret") ?? "";
  const bearer = bearerToken(req);

  if (cronSecret && headerSecret && timingSafeEqual(headerSecret, cronSecret)) {
    return true;
  }
  if (cronSecret && bearer && timingSafeEqual(bearer, cronSecret)) {
    return true;
  }
  if (serviceRoleKey && bearer && timingSafeEqual(bearer, serviceRoleKey)) {
    return true;
  }
  return false;
}

function bearerToken(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let out = 0;
  for (let i = 0; i < aBytes.length; i++) out |= aBytes[i] ^ bBytes[i];
  return out === 0;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeTwitchLogin(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

function twitchThumbnailUrl(url: string | undefined): string | null {
  if (!url) return null;
  return url.replace("{width}x{height}", "440x248");
}

function offlineFields(checkedAt: string): LiveFields {
  return {
    is_live: false,
    live_title: null,
    live_game: null,
    live_viewers: null,
    live_started_at: null,
    live_thumbnail_url: null,
    live_url: null,
    live_checked_at: checkedAt,
  };
}

async function getTwitchAppToken(): Promise<string> {
  const clientId = Deno.env.get("TWITCH_CLIENT_ID");
  const clientSecret = Deno.env.get("TWITCH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("missing twitch credentials");
  }

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

  if (!res.ok) {
    throw new Error(`twitch token http ${res.status}`);
  }

  const data = await res.json() as { access_token?: string };
  if (!data.access_token) {
    throw new Error("twitch token missing");
  }
  return data.access_token;
}

async function fetchTwitchStreams(
  token: string,
  clientId: string,
  logins: string[],
): Promise<Map<string, TwitchStream>> {
  const live = new Map<string, TwitchStream>();

  for (let i = 0; i < logins.length; i += HELIX_BATCH_SIZE) {
    const batch = logins.slice(i, i + HELIX_BATCH_SIZE);
    const url = new URL(TWITCH_STREAMS_URL);
    for (const login of batch) url.searchParams.append("user_login", login);

    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Client-Id": clientId,
      },
    });

    if (!res.ok) {
      throw new Error(`twitch helix http ${res.status}`);
    }

    const data = await res.json() as { data?: TwitchStream[] };
    for (const stream of data.data ?? []) {
      live.set(stream.user_login.toLowerCase(), stream);
    }
  }

  return live;
}

async function refreshTwitch(
  supabase: SupabaseClient,
  rows: StreamerRow[],
): Promise<{ checked: number; live: number }> {
  if (rows.length === 0) {
    return { checked: 0, live: 0 };
  }

  const clientId = Deno.env.get("TWITCH_CLIENT_ID");
  if (!clientId) throw new Error("missing twitch credentials");

  const token = await getTwitchAppToken();
  const logins = [...new Set(rows.map((r) => normalizeTwitchLogin(r.channel_handle)).filter(Boolean))];
  const liveMap = await fetchTwitchStreams(token, clientId, logins);
  const checkedAt = new Date().toISOString();

  let liveCount = 0;
  for (const row of rows) {
    const login = normalizeTwitchLogin(row.channel_handle);
    const stream = liveMap.get(login);
    const fields: LiveFields = stream
      ? {
        is_live: true,
        live_title: stream.title ?? null,
        live_game: stream.game_name ?? null,
        live_viewers: typeof stream.viewer_count === "number" ? stream.viewer_count : null,
        live_started_at: stream.started_at ?? null,
        live_thumbnail_url: twitchThumbnailUrl(stream.thumbnail_url),
        live_url: `https://twitch.tv/${login}`,
        live_checked_at: checkedAt,
      }
      : offlineFields(checkedAt);

    if (fields.is_live) liveCount += 1;

    const { error } = await supabase.from("streamers").update(fields).eq("id", row.id);
    if (error) {
      throw new Error(`failed to update streamer: ${error.message}`);
    }
  }

  return { checked: rows.length, live: liveCount };
}

type YtRef = { channelId?: string; handle?: string; username?: string };

function parseYouTubeInput(raw: string): YtRef {
  const s = raw.trim();
  if (!s) return {};

  const fromPath = (pathname: string): YtRef => {
    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] === "channel" && parts[1]) return { channelId: parts[1] };
    if (parts[0]?.startsWith("@")) return { handle: parts[0].replace(/^@/, "") };
    if (parts[0] === "c" && parts[1]) return { handle: parts[1].replace(/^@/, "") };
    if (parts[0] === "user" && parts[1]) return { username: parts[1] };
    if (parts[0] && /^UC[\w-]{22}$/.test(parts[0])) return { channelId: parts[0] };
    return {};
  };

  if (/^UC[\w-]{22}$/.test(s)) return { channelId: s };

  try {
    const withScheme = /^https?:\/\//i.test(s) ? s : (s.includes("youtube.com") || s.includes("youtu.be") ? `https://${s}` : "");
    if (withScheme) {
      const u = new URL(withScheme);
      const parsed = fromPath(u.pathname);
      if (parsed.channelId || parsed.handle || parsed.username) return parsed;
    }
  } catch {
    // fall through
  }

  if (s.startsWith("@")) return { handle: s.slice(1) };
  return { handle: s.replace(/^@/, "") };
}

function uploadsPlaylistId(channelId: string): string {
  if (channelId.startsWith("UC") && channelId.length >= 3) {
    return "UU" + channelId.slice(2);
  }
  return channelId;
}

function ytThumbUrl(thumbs: YtThumbnails | undefined): string | null {
  if (!thumbs) return null;
  return thumbs.maxres?.url || thumbs.standard?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null;
}

async function ytGet(path: string, params: Record<string, string>, apiKey: string): Promise<unknown> {
  const url = new URL(YT_API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", apiKey);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`youtube ${path} http ${res.status}`);
  }
  return await res.json();
}

async function resolveChannelId(
  apiKey: string,
  row: StreamerRow,
): Promise<{ channelId: string | null; units: number }> {
  if (row.youtube_channel_id && /^UC[\w-]{22}$/.test(row.youtube_channel_id)) {
    return { channelId: row.youtube_channel_id, units: 0 };
  }

  const ref = parseYouTubeInput(row.youtube_channel_id || row.channel_handle);
  if (ref.channelId && /^UC[\w-]{22}$/.test(ref.channelId)) {
    // Still confirm via cache write later; no API call needed if it's already a UC id.
    return { channelId: ref.channelId, units: 0 };
  }

  const params: Record<string, string> = { part: "id" };
  if (ref.channelId) params.id = ref.channelId;
  else if (ref.username) params.forUsername = ref.username;
  else if (ref.handle) params.forHandle = ref.handle.startsWith("@") ? ref.handle : `@${ref.handle}`;
  else return { channelId: null, units: 0 };

  const data = await ytGet("/channels", params, apiKey) as { items?: Array<{ id?: string }> };
  const id = data.items?.[0]?.id ?? null;
  return { channelId: id, units: 1 };
}

type YtVideo = {
  id: string;
  snippet?: {
    title?: string;
    categoryId?: string;
    liveBroadcastContent?: string;
    thumbnails?: YtThumbnails;
  };
  liveStreamingDetails?: {
    actualStartTime?: string;
    actualEndTime?: string;
    concurrentViewers?: string;
  };
};

function pickLiveVideo(videos: YtVideo[]): YtVideo | null {
  for (const v of videos) {
    const live = v.liveStreamingDetails;
    if (!live?.actualStartTime) continue;
    if (live.actualEndTime) continue;
    return v;
  }
  return null;
}

async function refreshYoutube(
  supabase: SupabaseClient,
  rows: StreamerRow[],
): Promise<{ checked: number; live: number; skipped: number; quota_units: number; errors?: number }> {
  if (rows.length === 0) {
    return { checked: 0, live: 0, skipped: 0, quota_units: 0 };
  }

  const apiKey = Deno.env.get("YOUTUBE_API_KEY");
  if (!apiKey) throw new Error("missing youtube api key");

  let units = 0;
  let errors = 0;
  const resolved: Array<{ row: StreamerRow; channelId: string }> = [];

  for (const row of rows) {
    try {
      const result = await resolveChannelId(apiKey, row);
      units += result.units;
      if (!result.channelId) {
        errors += 1;
        continue;
      }
      if (result.channelId !== row.youtube_channel_id) {
        const { error } = await supabase
          .from("streamers")
          .update({ youtube_channel_id: result.channelId })
          .eq("id", row.id);
        if (error) throw new Error(`failed to cache youtube_channel_id: ${error.message}`);
        row.youtube_channel_id = result.channelId;
      }
      resolved.push({ row, channelId: result.channelId });
    } catch {
      errors += 1;
    }
  }

  const videoIdsByChannel = new Map<string, string[]>();
  const allVideoIds: string[] = [];

  for (const { channelId } of resolved) {
    try {
      const playlistId = uploadsPlaylistId(channelId);
      const data = await ytGet("/playlistItems", {
        part: "contentDetails",
        playlistId,
        maxResults: String(YT_PLAYLIST_ITEMS),
      }, apiKey) as { items?: Array<{ contentDetails?: { videoId?: string } }> };
      units += 1;
      const ids = (data.items ?? [])
        .map((it) => it.contentDetails?.videoId)
        .filter((id): id is string => !!id);
      videoIdsByChannel.set(channelId, ids);
      for (const id of ids) {
        if (!allVideoIds.includes(id)) allVideoIds.push(id);
      }
    } catch {
      errors += 1;
      videoIdsByChannel.set(channelId, []);
    }
  }

  const videos = new Map<string, YtVideo>();
  for (let i = 0; i < allVideoIds.length; i += YT_VIDEOS_BATCH) {
    const batch = allVideoIds.slice(i, i + YT_VIDEOS_BATCH);
    const data = await ytGet("/videos", {
      part: "snippet,liveStreamingDetails,statistics",
      id: batch.join(","),
    }, apiKey) as { items?: YtVideo[] };
    units += 1;
    for (const item of data.items ?? []) {
      if (item.id) videos.set(item.id, item);
    }
  }

  const checkedAt = new Date().toISOString();
  let liveCount = 0;
  let checked = 0;

  for (const { row, channelId } of resolved) {
    const ids = videoIdsByChannel.get(channelId) ?? [];
    const channelVideos = ids.map((id) => videos.get(id)).filter((v): v is YtVideo => !!v);
    const live = pickLiveVideo(channelVideos);
    const fields: LiveFields = live
      ? {
        is_live: true,
        live_title: live.snippet?.title ?? null,
        live_game: null, // categoryId 20 is only "Gaming", not a game name
        live_viewers: live.liveStreamingDetails?.concurrentViewers
          ? Number.parseInt(live.liveStreamingDetails.concurrentViewers, 10) || null
          : null,
        live_started_at: live.liveStreamingDetails?.actualStartTime ?? null,
        live_thumbnail_url: ytThumbUrl(live.snippet?.thumbnails),
        live_url: `https://www.youtube.com/watch?v=${live.id}`,
        live_checked_at: checkedAt,
      }
      : offlineFields(checkedAt);

    if (fields.is_live) liveCount += 1;
    checked += 1;

    const { error } = await supabase.from("streamers").update(fields).eq("id", row.id);
    if (error) {
      throw new Error(`failed to update streamer: ${error.message}`);
    }
  }

  // Rows we could not resolve still get a checked timestamp so they don't look stale forever.
  const unresolved = rows.filter((r) => !resolved.some((x) => x.row.id === r.id));
  for (const row of unresolved) {
    const { error } = await supabase.from("streamers").update(offlineFields(checkedAt)).eq("id", row.id);
    if (error) {
      throw new Error(`failed to update streamer: ${error.message}`);
    }
    checked += 1;
  }

  const out: { checked: number; live: number; skipped: number; quota_units: number; errors?: number } = {
    checked,
    live: liveCount,
    skipped: 0,
    quota_units: units,
  };
  if (errors > 0) out.errors = errors;
  return out;
}

// TODO(kick): For platform === "kick", call Kick's public livestream API for
// each handle and write the same live_* columns. Needs Kick app credentials.
// Not implemented yet.
