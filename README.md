# Hero Cycles IT Project Tracker

A public, read-only project dashboard (`index.html`) with a protected **Publish** workflow: an authorised person imports an
Excel workbook, previews it, and publishes it. Every viewer then sees the new data without a redeploy.

## About `index.html` (generated application)

`index.html` is a **generated, self-contained bundle**. Its own comments refer to `scripts/build-html-snapshot.ts` and
`src/lib/...`, but that source project and build script are **not available in this repository or any repository this
work could reach**, so they were not recreated. The Excel parser/rules (the bundled `ENGINE`) and the built-in data
(`EMBEDDED`) are left **byte-for-byte unchanged**; the changes are limited to data loading, the import dialog, the
footer/status text and a few CSS rules. If the dashboard is ever regenerated from its original source, these changes must
be re-applied (or made in that source).

## How it works

```
Browser ── GET /api/data ──────────────▶ reads private Blob with the server token ─▶ published JSON (public, read-only)
Browser ── POST /api/auth  (passphrase) ▶ signed HttpOnly session cookie + CSRF token
Browser ── POST /api/publish (cookie + CSRF + same origin) ▶ validate ▶ history entry ▶ current.json (ETag-conditional)
```

* The Excel file is parsed **in the browser by the existing parser**; only the parsed JSON (`source`) is published.
* The Blob store is **private**. The browser never talks to Blob; only the functions in `api/` do, with
  `process.env.IT_TRACKER_READ_WRITE_TOKEN` passed **explicitly** on every SDK call. `BLOB_READ_WRITE_TOKEN` is never used.
* The page shows: a newer unpublished local preview, else the published data, else the built-in data (offline fallback).

### Environment isolation

The server decides the data path from `VERCEL_ENV` only (never from the request):

| Deployment  | Current                              | History                              |
|-------------|--------------------------------------|--------------------------------------|
| Production  | `it-tracker/production/current.json` | `it-tracker/production/history/`     |
| Preview     | `it-tracker/preview/current.json`    | `it-tracker/preview/history/`        |

Local `vercel dev` is treated as Preview. An unknown environment fails closed. Every storage path is checked to be inside the
current environment's prefix, and session cookies are bound to their environment.

## Environment variables (server-only; set for Preview **and** Production)

| Variable | Purpose |
|---|---|
| `IT_TRACKER_READ_WRITE_TOKEN` | Blob read-write token (passed explicitly to the SDK). |
| `IT_TRACKER_STORE_ID` | Expected store id; must match the id inside the token or the API refuses to run. |
| `IT_TRACKER_PUBLISH_SECRET` | Shared publishing passphrase (min. 12 characters). |
| `IT_TRACKER_SESSION_SECRET` | Signs session cookies and CSRF tokens (min. 32 random characters; must differ from the passphrase). |
| `IT_TRACKER_WEBHOOK_PUBLIC_KEY` | Not used by this feature. |

Generate the session secret with `openssl rand -base64 48`.

## Security model

* Viewing is public. Publishing needs the passphrase → a 30-minute `HttpOnly; Secure; SameSite=Strict` cookie.
* Writes require **same-origin** (`Origin` check, `Sec-Fetch-Site`), `application/json`, a valid session **and** a per-session
  CSRF token header.
* Login failures are throttled **persistently** (per hashed client address and globally) using ETag-conditional counters in
  the same private Blob store, not in memory; if a counter cannot be updated safely the attempt is denied.
* Published payloads are validated (size ≤ 2 MB, ≤ 500 projects, exact field set, enums, real calendar dates, text limits).
* Responses and logs never contain tokens, passphrases or secrets.

## History and rollback

Each publish writes an immutable history entry, then replaces `current.json` with an ETag-conditional write (concurrent
publishers get a 409, never a silent overwrite). **Publisher tools** (footer link) lists recent versions; **Restore**
re-publishes one as a *new* version, so a rollback can itself be undone. History is never pruned automatically.

## Caching

`/api/data` is revalidated by browsers on every load (ETag → 304) and cached at Vercel's edge for at most 10 seconds.
Open tabs re-check when they become visible again (at most once a minute).

## Tests

```bash
npm install
npm test
```

API/engine tests run anywhere with Node ≥ 20 against a strict in-memory fake of `@vercel/blob`. Browser tests use Playwright
if it is installed (they are skipped otherwise). Set `UI_SHOTS_DIR` to save screenshots.
