#!/usr/bin/env python3
"""Sync review queues -> postdesk dashboard (Worker KV + R2).

Reads the translator pipeline's review_queue JSONs on this VM, uploads
media files to the dashboard's R2 via the Worker, and upserts item
records into KV via /api/sync.

Usage:
  POSTDESK_URL=https://post.hectorchan.com \
  POSTDESK_SYNC_SECRET=xxx \
  python3 scripts/sync.py [--state-dir DIR] [--dry-run]

Queue -> account mapping:
  review_queue.json            (zh, source hawley) -> hawley_zh
  review_queue_trump_zh.json   (zh, source trump)  -> trump_zh   (when it exists)
  review_queue_hawley_en.json  (en)                -> gns
  review_queue_trump_en.json   (en)                -> gns
"""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error

QUEUE_MAP = [
    ("review_queue.json", "hawley_zh"),
    ("review_queue_trump_zh.json", "trump_zh"),
    ("review_queue_hawley_en.json", "gns"),
    ("review_queue_trump_en.json", "gns"),
]

STATE_FILE = "postdesk_sync.json"
MAX_UPLOAD_BYTES = 100 * 1024 * 1024


def upload_media(base, secret, key, local_path):
    """Upload one file via curl (urllib's TLS stack gets killed by the
    egress proxy on larger bodies; curl is reliable here)."""
    import subprocess
    import time
    last = None
    for attempt in range(3):
        p = subprocess.run(
            ["curl", "-s", "-w", "\n%{http_code}", "--max-time", "600",
             "-X", "POST", base + "/api/media",
             "-H", "x-sync-secret: " + secret,
             "-F", "key=" + key,
             "-F", "file=@" + local_path + ";type=" + guess_ct(local_path)],
            capture_output=True, text=True)
        out = p.stdout.strip().rsplit("\n", 1)
        code = out[-1] if out else ""
        body = out[0] if len(out) > 1 else ""
        if code == "200":
            try:
                r = json.loads(body)
                if r.get("ok"):
                    return r
                last = RuntimeError("upload rejected: %s" % body[:200])
            except Exception as e:
                last = e
        else:
            last = RuntimeError("curl upload %s -> HTTP %s: %s" % (local_path, code, (p.stderr or body)[:200]))
        print("upload attempt %d/3 failed: %s" % (attempt + 1, last))
        time.sleep(2 * (attempt + 1))
    raise last


def encode_multipart(fields, files):
    boundary = "----postdesk%d" % os.getpid()
    body = b""
    for k, v in fields.items():
        body += b"--" + boundary.encode() + b"\r\n"
        body += ('Content-Disposition: form-data; name="%s"\r\n\r\n' % k).encode()
        body += str(v).encode() + b"\r\n"
    for k, (fname, ctype, data) in files.items():
        body += b"--" + boundary.encode() + b"\r\n"
        body += ('Content-Disposition: form-data; name="%s"; filename="%s"\r\n' % (k, fname)).encode()
        body += ("Content-Type: %s\r\n\r\n" % ctype).encode()
        body += data + b"\r\n"
    body += b"--" + boundary.encode() + b"--\r\n"
    return body, "multipart/form-data; boundary=" + boundary


def api(url, secret, method="GET", data=None, headers=None, retries=4):
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("x-sync-secret", secret)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            print("HTTP %d on %s: %s" % (e.code, url, e.read()[:300]), file=sys.stderr)
            raise
        except Exception as e:
            last = e
            print("attempt %d/%d failed (%s): %s" % (attempt + 1, retries, url, e))
            import time
            time.sleep(2 * (attempt + 1))
    raise last


def guess_ct(name):
    n = name.lower()
    if n.endswith(".mp4"):
        return "video/mp4"
    if n.endswith(".png"):
        return "image/png"
    if n.endswith(".webp"):
        return "image/webp"
    return "image/jpeg"


def collect_media(item, state_dir):
    """Return list of (kind, local_abs_path). Prefer final/watermarked files."""
    out = []
    seen = set()
    vid = item.get("video_local_path")
    if vid:
        p = os.path.join(state_dir, vid)
        if os.path.isfile(p) and p not in seen:
            out.append(("video", p)); seen.add(p)
    for img in item.get("image_local_paths") or []:
        p = os.path.join(state_dir, img)
        if os.path.isfile(p) and p not in seen:
            out.append(("image", p)); seen.add(p)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-dir", default=os.path.expanduser(
        "~/workspace/goals/hawley-ig-auto-translate-bot/hidden_files"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    base = os.environ.get("POSTDESK_URL", "").rstrip("/")
    secret = os.environ.get("POSTDESK_SYNC_SECRET", "")
    if not base or not secret:
        print("need POSTDESK_URL and POSTDESK_SYNC_SECRET env", file=sys.stderr)
        sys.exit(2)

    state_path = os.path.join(args.state_dir, STATE_FILE)
    state = {}
    if os.path.isfile(state_path):
        state = json.load(open(state_path))
    uploaded = state.get("uploaded", {})  # local_abs_path -> r2 key

    items = []
    up_count = 0
    for fname, account in QUEUE_MAP:
        qpath = os.path.join(args.state_dir, fname)
        if not os.path.isfile(qpath):
            continue
        queue = json.load(open(qpath))
        for it in queue:
            post_id = str(it.get("post_id") or it.get("shortcode") or "")
            source = it.get("source", "")
            target = it.get("target", "")
            iid = "%s:%s:%s" % (source, target, post_id)
            media = []
            for kind, lp in collect_media(it, args.state_dir):
                key = uploaded.get(lp)
                if not key:
                    key = "media/%s/%s/%s" % (account, post_id, os.path.basename(lp))
                    if not args.dry_run:
                        size = os.path.getsize(lp)
                        if size > MAX_UPLOAD_BYTES:
                            print("skip too big: %s (%d)" % (lp, size))
                            continue
                        print("upload %s (%d KB) -> %s" % (lp, size // 1024, key))
                        r = upload_media(base, secret, key, lp)
                        up_count += 1
                        if up_count % 10 == 0:
                            state["uploaded"] = uploaded
                            json.dump(state, open(state_path, "w"), indent=1)
                            print("checkpoint: %d uploaded" % up_count)
                    uploaded[lp] = key
                media.append({"kind": kind, "key": uploaded[lp]})
            items.append({
                "id": iid,
                "account": account,
                "source": source,
                "target": target,
                "post_id": post_id,
                "shortcode": it.get("shortcode"),
                "url": it.get("url"),
                "media_type": it.get("media_type"),
                "created_at": it.get("created_at"),
                "caption_en": it.get("caption_en"),
                "caption_zh": it.get("caption_zh"),
                "suggested_post": it.get("suggested_post"),
                "seo_hook": it.get("seo_hook"),
                "seo_hashtags": it.get("seo_hashtags"),
                "media": media,
                "warnings": it.get("warnings") or [],
                "queued_at": it.get("queued_at"),
                "posted": bool(it.get("posted")),
                "posted_url": it.get("posted_url"),
                "posted_at": it.get("posted_at"),
            })

    print("items=%d media_uploaded=%d dry_run=%s" % (len(items), up_count, args.dry_run))
    if args.dry_run:
        return
    r = api(base + "/api/sync", secret, "POST",
            json.dumps({"items": items}).encode(),
            {"content-type": "application/json"})
    print("sync ->", r)
    state["uploaded"] = uploaded
    json.dump(state, open(state_path, "w"), indent=1)
    print("state saved:", state_path)


if __name__ == "__main__":
    main()
