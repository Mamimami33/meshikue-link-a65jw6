// レシピリンク集「更新ボタン」用 Cloudflare Worker
// ページの更新ボタンから呼ばれると、Discordスレッドを取得して
// GitHubリポジトリの data.json を更新する。
//
// 必要な設定（Workerの Settings → Variables and Secrets）:
//   DISCORD_BOT_TOKEN (Secret) : Discordボットのトークン
//   GITHUB_PAT        (Secret) : 対象リポジトリの Contents 読み書き用キー
//   THREAD_LINK       (Text)   : Discordスレッドのリンク
//   MUSIC_THREAD_LINK (Text)   : 音楽スレッドのリンク（/music 用）
//
// data.json にはアカウント名・投稿文を含めない（fetch.py と同じ整形）。

const API = "https://discord.com/api/v10";
const GH_API = "https://api.github.com";
const REPO = "Mamimami33/meshikue-link-a65jw6";
const EXCLUDE = ["muse.ai/s/", "mamimami33.github.io/meshikue-link-a65jw6"];
const UA = { "User-Agent": "recipe-updater (Cloudflare Worker)" };

function canonicalize(raw) {
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  if (host.includes("youtube.com") && u.pathname.includes("/shorts/")) {
    const vid = u.pathname.split("/shorts/")[1].split("/")[0];
    return `https://www.youtube.com/shorts/${vid}`;
  }
  if (host === "youtu.be") {
    const vid = u.pathname.replace(/\//g, "").split("/")[0];
    return `https://www.youtube.com/watch?v=${vid}`;
  }
  if (host.includes("youtube.com") && u.pathname === "/watch") {
    return `https://www.youtube.com/watch?v=${u.searchParams.get("v") || ""}`;
  }
  for (const k of [...u.searchParams.keys()]) {
    if (k.startsWith("utm_") || k === "si" || k === "feature") u.searchParams.delete(k);
  }
  return u.toString();
}

function youtubeId(url) {
  const u = new URL(url);
  if (u.pathname.includes("/shorts/")) return u.pathname.split("/shorts/")[1].split("/")[0];
  return u.searchParams.get("v");
}

async function enrich(url) {
  const vid = url.includes("youtu") ? youtubeId(url) : null;
  if (vid) {
    try {
      const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url), { headers: UA });
      const oe = await r.json();
      return { title: oe.title || url, thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, channel: oe.author_name || "" };
    } catch {
      return { title: url, thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, channel: "" };
    }
  }
  try {
    const r = await fetch(url, { headers: UA });
    const html = await r.text();
    const pick = (name) => {
      const m = html.match(new RegExp(`property="og:${name}"\\s+content="([^"]+)"`));
      return m ? m[1] : "";
    };
    return { title: pick("title") || url, thumbnail: pick("image"), channel: pick("site_name") || new URL(url).hostname };
  } catch {
    return { title: url, thumbnail: "", channel: new URL(url).hostname };
  }
}

async function fetchMessages(channelId, token) {
  const msgs = [];
  let before = null;
  while (true) {
    let url = `${API}/channels/${channelId}/messages?limit=100`;
    if (before) url += `&before=${before}`;
    const r = await fetch(url, { headers: { ...UA, Authorization: `Bot ${token}` } });
    if (r.status === 401) throw new Error("Discord認証に失敗しました（401）。トークンを確認してください。");
    if (r.status === 403) throw new Error("権限がありません（403）。ボットの参加と権限を確認してください。");
    if (r.status === 404) throw new Error("チャンネルが見つかりません（404）。THREAD_LINKを確認してください。");
    if (!r.ok) throw new Error(`Discord API エラー: ${r.status}`);
    const batch = await r.json();
    if (!batch.length) break;
    msgs.push(...batch);
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return msgs;
}

function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function ghGet(pat) {
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/data.json`, {
    headers: { ...UA, Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json" },
  });
  if (r.status === 404) return { sha: null, text: null };
  if (!r.ok) throw new Error(`GitHub 読み取りエラー: ${r.status}`);
  const j = await r.json();
  return { sha: j.sha, text: b64decode(j.content) };
}

async function ghPut(pat, sha, text) {
  const body = { message: "データを更新（更新ボタン）", content: b64encode(text) };
  if (sha) body.sha = sha;
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/data.json`, {
    method: "PUT",
    headers: { ...UA, Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub 書き込みエラー: ${r.status}`);
}

// 閲覧数・お気に入り数のカウンター（Durable Object、SQLite保存）
export class Counter {
  constructor(state, env) {
    this.sql = state.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS counts (url TEXT PRIMARY KEY, views INTEGER NOT NULL DEFAULT 0, favs INTEGER NOT NULL DEFAULT 0)");
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/all") {
      const out = {};
      for (const r of this.sql.exec("SELECT url, views, favs FROM counts")) {
        out[r.url] = { views: r.views, favs: r.favs };
      }
      return Response.json(out);
    }
    if (url.pathname === "/inc" && request.method === "POST") {
      const body = await request.json();
      const itemUrl = body && body.url;
      const kind = body && body.kind;
      if (!itemUrl || (kind !== "view" && kind !== "fav")) {
        return Response.json({ ok: false, error: "bad request" }, { status: 400 });
      }
      const col = kind === "view" ? "views" : "favs";
      const d = kind === "view" ? 1 : (body.delta === -1 ? -1 : 1);
      this.sql.exec(
        `INSERT INTO counts (url, ${col}) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET ${col} = MAX(0, ${col} + ?)`,
        itemUrl, Math.max(0, d), d
      );
      const row = [...this.sql.exec("SELECT views, favs FROM counts WHERE url = ?", itemUrl)][0];
      return Response.json({ ok: true, views: row.views, favs: row.favs });
    }
    return new Response("not found", { status: 404 });
  }
}

// 音楽スレッドの YouTube URL から連続再生プレイリストへ直接飛ばす（最新順）
// パート指定は ?part=2 のように受ける（1パート50曲）
async function handleMusic(env, request) {
  const headers = { "Content-Type": "text/plain; charset=UTF-8" };
  const link = String(env.MUSIC_THREAD_LINK || "");
  const channelId = (link.match(/\d{15,}/g) || []).pop();
  if (!channelId) {
    return new Response("音楽スレッドが未設定です。", { headers });
  }
  const msgs = await fetchMessages(channelId, env.DISCORD_BOT_TOKEN);
  const urlRe = /https?:\/\/[^\s<>\]]+/g;
  const ids = []; // Discord API の返却順＝新しい投稿順
  const seen = new Set();
  for (const m of msgs) {
    const urls = (m.content || "").match(urlRe) || [];
    for (const e of m.embeds || []) if (e.url) urls.push(e.url);
    for (const raw of urls) {
      let vid = null;
      try { vid = youtubeId(canonicalize(raw.replace(/[).,]+$/, ""))); } catch { vid = null; }
      if (vid && /^[\w-]{11}$/.test(vid) && !seen.has(vid)) {
        seen.add(vid);
        ids.push(vid);
      }
    }
  }
  if (!ids.length) {
    return new Response("曲が見つかりませんでした。", { headers });
  }
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  let part = parseInt(new URL(request.url).searchParams.get("part") || "1", 10);
  if (isNaN(part) || part < 1) part = 1;
  if (part > chunks.length) part = chunks.length;
  const webUrl = `https://www.youtube.com/watch_videos?video_ids=${chunks[part - 1].join(",")}`;
  const ua = request.headers.get("User-Agent") || "";
  if (!/iPhone|iPad|iPod|Android/i.test(ua)) {
    return Response.redirect(webUrl, 302); // PCはそのままWebへ
  }
  // スマホ: 一時プレイリストを実IDに解決し、YouTubeアプリ用リンクで開く。
  // 解決できない場合は従来どおりWebへ飛ばす。
  let appUrl = null;
  try {
    const r = await fetch(webUrl, { redirect: "manual" });
    const loc = r.headers.get("Location") || "";
    const lu = new URL(loc, "https://www.youtube.com");
    const list = lu.searchParams.get("list");
    const v = lu.searchParams.get("v");
    if (list && v) {
      appUrl = /Android/i.test(ua)
        ? `intent://www.youtube.com/watch?v=${v}&list=${list}#Intent;package=com.google.android.youtube;scheme=https;S.browser_fallback_url=${encodeURIComponent(webUrl)};end`
        : `youtube://www.youtube.com/watch?v=${v}&list=${list}`;
    }
  } catch { appUrl = null; }
  if (!appUrl) return Response.redirect(webUrl, 302);
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>音楽プレイリスト</title></head><body><p>YouTubeアプリで開いています…</p><p><a href="${webUrl}">開かない場合はこちら（Web）</a></p><script>
var done = false;
function goWeb() { if (!done) { done = true; location.replace(${JSON.stringify(webUrl)}); } }
document.addEventListener("visibilitychange", function () { if (document.hidden) done = true; });
window.addEventListener("pagehide", function () { done = true; });
location.href = ${JSON.stringify(appUrl)};
setTimeout(goWeb, 2500);
</script></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
}

async function runUpdate(env) {
  const channelId = (String(env.THREAD_LINK || "").match(/\d{15,}/g) || []).pop();
  if (!channelId) throw new Error("THREAD_LINK からチャンネルIDが読み取れませんでした。");
  const { sha, text } = await ghGet(env.GITHUB_PAT);
  const existing = {};
  if (text) {
    try { for (const it of JSON.parse(text)) existing[it.url] = it; } catch { /* ignore */ }
  }
  const msgs = await fetchMessages(channelId, env.DISCORD_BOT_TOKEN);
  const urlRe = /https?:\/\/[^\s<>\]]+/g;
  const found = new Map();
  for (const m of msgs) {
    const urls = (m.content || "").match(urlRe) || [];
    for (const e of m.embeds || []) if (e.url) urls.push(e.url);
    for (const raw of urls) {
      const cu = canonicalize(raw.replace(/[).,]+$/, ""));
      if (EXCLUDE.some((x) => cu.includes(x))) continue;
      const vid = cu.includes("youtu") ? youtubeId(cu) : null;
      const key = vid ? `yt:${vid}` : cu;
      if (!found.has(key)) found.set(key, { url: cu, posted_at: m.timestamp });
      else if (cu.includes("/shorts/")) found.get(key).url = cu;
    }
  }
  const items = [];
  for (const { url, posted_at } of found.values()) {
    if (existing[url]) {
      const it = existing[url];
      it.posted_at = posted_at;
      items.push(it);
    } else {
      items.push({ url, ...(await enrich(url)), posted_at, tags: [] });
    }
  }
  items.sort((a, b) => b.posted_at.localeCompare(a.posted_at));
  const newText = JSON.stringify(items, null, 2);
  const changed = text === null || newText.trim() !== text.trim();
  if (changed) await ghPut(env.GITHUB_PAT, sha, newText);
  return { count: items.length, changed };
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    // 音楽プレイリスト
    if (url.pathname === "/music") {
      try { return await handleMusic(env, request); }
      catch (e) {
        return new Response(`取得に失敗しました：${String(e.message || e)}`,
          { status: 500, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
      }
    }
    // カウンター系
    if (url.pathname === "/counts" || url.pathname === "/view" || url.pathname === "/fav") {
      const stub = env.COUNTER.get(env.COUNTER.idFromName("global"));
      if (url.pathname === "/counts") {
        const r = await stub.fetch("https://counter/all");
        return new Response(await r.text(), { headers: cors });
      }
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ ok: false, error: "POST only" }), { status: 405, headers: cors });
      }
      const body = await request.json().catch(() => null);
      const r = await stub.fetch("https://counter/inc", {
        method: "POST",
        body: JSON.stringify({
          url: body && body.url,
          kind: url.pathname === "/view" ? "view" : "fav",
          delta: body && body.delta,
        }),
      });
      return new Response(await r.text(), { status: r.status, headers: cors });
    }
    if (url.pathname !== "/update") {
      return new Response(JSON.stringify({ ok: true, message: "recipe updater" }), { headers: cors });
    }
    try {
      const result = await runUpdate(env);
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }), { status: 500, headers: cors });
    }
  },
  // 定期実行（Workerの Triggers で Cron を設定すると呼ばれる）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runUpdate(env));
  },
};
