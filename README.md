# postdesk — 統一出 post 台

One dashboard for the 3 clip IG accounts — see every review queue,
approve one by one, schedule publishing, no app-jumping.

| Tab | Account | Source |
|---|---|---|
| 霍利中文 | @snhawleytranslatorhkunofficial | `review_queue.json` (zh) |
| 特朗普中文 | @trumptranslatorhkunofficial | `review_queue_trump_zh.json` (zh, when poller produces it) |
| Global News Shorts | @globalnewsshorts | `review_queue_{hawley,trump}_en.json` |

## Why not auto-post?

Meta's Accounts Center hard-limits one Meta account per link — the 3
accounts can't be linked to the connector, so direct IG publishing is
blocked. The publish step stays manual in the IG app; this dashboard
owns queue → approve → schedule → post pack (caption copy + media
download) → mark posted.

## Layout

- `src/index.js` — Cloudflare Worker: password-gated dashboard UI +
  JSON API. Bindings: `POSTDESK_KV` (KV), `MEDIA` (R2).
  Secrets: `DASH_PASSWORD`, `SYNC_SECRET`.
- `scripts/sync.py` — VM poller side: reads the review_queue JSONs,
  uploads media to R2 via the Worker, upserts items to KV.
- `wrangler.toml` — reference config (deploy is via dashboard paste,
  same as hawley-translator).

## Deploy (dashboard, because CF API is 401 from the VM)

1. Workers & Pages → Create → Worker `postdesk`, paste `src/index.js`, deploy.
2. KV → create namespace `postdesk`, Workers → postdesk → Settings →
   Bindings → add KV `POSTDESK_KV`.
3. R2 → create bucket `postdesk-media`, add R2 binding `MEDIA`.
4. Settings → Variables → add secrets `DASH_PASSWORD`, `SYNC_SECRET`.
5. Custom domain: `post.hectorchan.com`.

## Sync (on VM)

```sh
POSTDESK_URL=https://post.hectorchan.com \
POSTDESK_SYNC_SECRET=xxx \
python3 scripts/sync.py
```

State (uploaded media keys) lives in
`~/workspace/goals/hawley-ig-auto-translate-bot/hidden_files/postdesk_sync.json`.
Run after each poller run (or cron it).
