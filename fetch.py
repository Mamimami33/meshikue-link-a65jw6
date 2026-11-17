#!/usr/bin/env python3
"""DiscordスレッドからレシピURLを取得し、表示用 data.json を作る。

- 環境変数 DISCORD_BOT_TOKEN（ボットのトークン）と THREAD_LINK（スレッドのURL）を使う。
- 出力する data.json には Discord のアカウント名・投稿文を含めない。
  含めるのは URL / タイトル / サムネイル / チャンネル名 / 投稿日時 / タグ だけ。
- 既存の data.json があれば読み、付いているタグは保持する。
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error
from urllib.parse import urlparse, parse_qs, urlencode

API = "https://discord.com/api/v10"
UA = {"User-Agent": "recipe-fetch (GitHub Actions)"}


def http_json(url, headers=None):
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def http_text(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode("utf-8", errors="replace")


def channel_id_from(link):
    nums = re.findall(r"\d{15,}", link or "")
    if not nums:
        sys.exit("THREAD_LINK からチャンネルIDが読み取れませんでした。スレッドのリンクを設定してください。")
    return nums[-1]


def fetch_messages(channel_id, token):
    msgs = []
    before = None
    while True:
        url = f"{API}/channels/{channel_id}/messages?limit=100"
        if before:
            url += f"&before={before}"
        try:
            batch = http_json(url, {"Authorization": f"Bot {token}"})
        except urllib.error.HTTPError as e:
            if e.code == 401:
                sys.exit("Discord認証に失敗しました（401）。DISCORD_BOT_TOKEN が正しいか確認してください。")
            if e.code == 403:
                sys.exit("権限がありません（403）。ボットがサーバーに入っているか、チャンネルを見られるか確認してください。")
            if e.code == 404:
                sys.exit("チャンネルが見つかりません（404）。THREAD_LINK が正しいか確認してください。")
            raise
        if not batch:
            break
        msgs.extend(batch)
        before = batch[-1]["id"]
        if len(batch) < 100:
            break
    return msgs


def canonicalize(url):
    p = urlparse(url)
    host = p.netloc.lower()
    if "youtube.com" in host and "/shorts/" in p.path:
        vid = p.path.split("/shorts/")[1].split("/")[0]
        return f"https://www.youtube.com/shorts/{vid}"
    if host == "youtu.be":
        vid = p.path.strip("/").split("/")[0]
        return f"https://www.youtube.com/watch?v={vid}"
    if "youtube.com" in host and p.path == "/watch":
        v = parse_qs(p.query).get("v", [""])[0]
        return f"https://www.youtube.com/watch?v={v}"
    q = {k: v for k, v in parse_qs(p.query).items()
         if not k.startswith("utm_") and k not in ("si", "feature")}
    base = f"{p.scheme}://{p.netloc}{p.path}"
    return base + ("?" + urlencode(q, doseq=True) if q else "")


def youtube_id(url):
    p = urlparse(url)
    if "/shorts/" in p.path:
        return p.path.split("/shorts/")[1].split("/")[0]
    v = parse_qs(p.query).get("v", [None])[0]
    return v


def enrich(url):
    """URLからタイトル・サムネイル・チャンネル名を取る。"""
    vid = youtube_id(url) if "youtu" in url else None
    if vid:
        try:
            oe = http_json("https://www.youtube.com/oembed?format=json&url="
                           + urllib.request.quote(url, safe=""))
            return {
                "title": oe.get("title", url),
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                "channel": oe.get("author_name", ""),
            }
        except Exception:
            return {"title": url,
                    "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                    "channel": ""}
    try:
        html = http_text(url)
        t = re.search(r'property="og:title"\s+content="([^"]+)"', html)
        i = re.search(r'property="og:image"\s+content="([^"]+)"', html)
        s = re.search(r'property="og:site_name"\s+content="([^"]+)"', html)
        return {
            "title": (t.group(1) if t else url),
            "thumbnail": (i.group(1) if i else ""),
            "channel": (s.group(1) if s else urlparse(url).netloc),
        }
    except Exception:
        return {"title": url, "thumbnail": "", "channel": urlparse(url).netloc}


def main():
    token = os.environ.get("DISCORD_BOT_TOKEN", "")
    link = os.environ.get("THREAD_LINK", "")
    if not token:
        sys.exit("DISCORD_BOT_TOKEN が設定されていません。")
    channel_id = channel_id_from(link)

    existing = {}
    if os.path.exists("data.json"):
        try:
            for item in json.loads(open("data.json", encoding="utf-8").read()):
                existing[item["url"]] = item
        except Exception:
            existing = {}

    msgs = fetch_messages(channel_id, token)
    url_re = re.compile(r"https?://[^\s<>\]]+")
    found = {}  # canonical url -> posted_at（最初の投稿日時）
    for m in msgs:
        urls = url_re.findall(m.get("content") or "")
        for e in m.get("embeds") or []:
            if e.get("url"):
                urls.append(e["url"])
        for u in urls:
            cu = canonicalize(u.rstrip(").,"))
            if cu not in found:
                found[cu] = m["timestamp"]

    items = []
    for url, posted_at in found.items():
        if url in existing:
            item = existing[url]
            item["posted_at"] = posted_at
        else:
            info = enrich(url)
            item = {"url": url, **info, "posted_at": posted_at, "tags": []}
        items.append(item)
    items.sort(key=lambda x: x["posted_at"], reverse=True)

    with open("data.json", "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    print(f"data.json を更新しました: {len(items)}件（うち新規 {len([i for i in items if i['url'] not in existing])}件）")


if __name__ == "__main__":
    main()
