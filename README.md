# BHA RSS

One service for everything BHA reads from outside: news and blog feeds, YouTube channels, LinkedIn profiles and web pages. It replaces Genie-RSS and ragingester (14 Nov 2026, Destiny).

- **Collects** every active source on its own interval (`rss_sources.every_hours`), a few at a time, and keeps every item it finds in `rss_items` (unique per source and item, so a re-read adds nothing).
- **Keeps raw items here only.** Nothing raw goes to BHARAG.
- **Once a day** (after `DIGEST_HOUR_UTC`, default 06:00) it compiles the UTC day before into one digest with sections for the Media Twin, Research Twin, North Star and Genie, every point carrying its item's link, and posts it to the BHA Engine Dashboard (`POST /api/engine/outside-digest`). The dashboard stores it, sends it to BHARAG once, and serves it to the agents with `read_outside_digest`.

## Tables (Supabase, ragingester project, public schema)

`rss_sources`, `rss_runs`, `rss_items`, `rss_digests`. Row level security is on with no policies: only the service role key reads or writes them.

## Settings

| Variable | What it is |
| --- | --- |
| `SUPABASE_URL` | The project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key of that project |
| `BHA_RSS_KEY` | Key for this service's own admin routes (`x-api-key`) |
| `APIFY_TOKEN` | Apify, for LinkedIn posts |
| `OPENROUTER_API_KEY` | For writing the digest |
| `DASHBOARD_INBOUND_KEY` | The dashboard's inbound key |
| `DIGEST_MODEL`, `DIGEST_HOUR_UTC`, `POLL_MS`, `CONCURRENCY`, `SCHEDULER` | Optional |

A missing setting is named on `/health`.

## Routes

- `GET /health` (open): `{ ok, missing }`.
- With `x-api-key: BHA_RSS_KEY`: `GET /status` (sources, runs in 24 hours, last digests), `POST /pass` (one collection pass now), `POST /run { source_id }` (one source now), `POST /digest { date? }` (make and deliver the digest for a day now).

## Test

`npm test` (no outside packages; Node 20 or later).
