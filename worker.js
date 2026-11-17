// レシピリンク集「更新ボタン」用 Cloudflare Worker（再デプロイ用に更新）
// ページの更新ボタンから呼ばれると、Discordスレッドを取得して
// GitHubリポジトリの data.json を更新する。
//
// 必要な設定（Workerの Settings → Variables and Secrets）:
//   DISCORD_BOT_TOKEN (Secret) : Discordボットのトークン
//   GITHUB_PAT        (Secret) : 対象リポジトリの Contents 読み書き用キー
//   THREAD_LINK       (Text)   : Discordスレッドのリンク
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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
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
