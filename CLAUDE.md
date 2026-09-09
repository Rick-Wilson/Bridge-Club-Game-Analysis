# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

Club Game Analysis — a tool for bridge players to understand their game results
board-by-board, categorizing each result by cause (good play, lucky, auction
error, play error, defense error, unlucky). Web app, two input paths:

1. **Upload BWS + PBN files** (the original flow, for ACBLscore/ACBLlive club
   games — drag and drop on the home page).
2. **Browser-extension push** (for ACBL Live tournament data — the
   [bridge-data-extension](../acbl-live-fetch) scrapes the results page and
   hands a normalized JSON document off to the `/analyze` route).

### Architecture: Rust = file translation, JS = analysis

```
┌──────────── server (Rust container) ────────────┐    ┌── browser ──┐
                                                  │    │             │
BWS + PBN  ──► data/adapters/pbn_bws.rs ──┐       │    │  index.html │
                                          ├──► normalized JSON ──► JS analyzer
JSON push ───► data/schema.rs (validate) ─┘   ↑   │    │  (matchpoints,
                                              │   │    │   DVF, cause
                          enrich_tricks  ─────┤   │    │   analysis,
                          enrich_handviewer ──┘   │    │   rendering)
                                                  │    │             │
                                  data.json on disk    │             │
└──────────────────────────────────────────────────┘    └─────────────┘
```

The Rust server's job is the **BWS/PBN → JSON translation**, two schema-walk
enrichment passes (derive missing trick counts from score; replace adapter-
emitted handviewer URLs with canonical BBO LIN URLs that include a
constructed auction), and persistence. Everything else — matchpoint
calculation, declarer-vs-field, cause analysis, all the rendering — runs
client-side in the SPA's inlined JS.

The boundary is the **normalized JSON schema** documented in
[`acbl-live-fetch/docs/normalized-schema.md`](../acbl-live-fetch/docs/normalized-schema.md).
To add a third source (BBO LIN, hand-typed data, ...) write a new adapter
that emits the schema.

### Workspace Crates

| Crate | Binary | Purpose |
|-------|--------|---------|
| `parse-files/` | (library) | Schema types in `data/schema.rs`, BWS+PBN→JSON adapter in `data/adapters/pbn_bws.rs`, schema-walk enrich passes in `data/builder.rs`. |
| `web/` | `bridge-analysis-web` | Axum web server: file upload, JSON ingest, name-overrides, BBA proxy, admin dashboard, static SPA serving. Walks the schema directly via `web/src/upload_helpers.rs` to shape upload responses. |

### Key Dependencies

- `bridge-parsers` (git) — BWS/PBN file parsing (used by the pbn_bws adapter only)
- `bridge-types` (git, via bridge-parsers) — Direction, Strain, Deal, Vulnerability types
- `axum 0.7` — Web framework (web crate)
- `reqwest` — HTTP client for BBA proxy (web crate)
- `serde_json`, `chrono` — JSON ingest + emit (analysis crate)

## Build & Test Commands

```bash
cargo build                              # Build all crates (debug)
cargo build --release                    # Build all crates (release)
cargo build -p bridge-analysis-web       # Build web server only
cargo test                               # Run all tests
cargo clippy --all-targets -- -D warnings # Lint (treat warnings as errors)
cargo fmt --all                          # Format all code
```

### Local Testing

```bash
# Run web server locally (serves at http://localhost:3001/)
cargo run -p bridge-analysis-web
# or:
just dev
```

The web server reads `BASE_PATH` env var to nest under a path prefix (default: empty = root).
For local dev, just run it and access `http://localhost:3001/`.

**Important:** The web crate embeds static files (HTML/JS/CSS) at compile time via `include_str!`/`include_bytes!`. A `build.rs` watches the `static/` directory, but if static changes aren't picked up, `touch web/src/api.rs` forces a recompile.

## Pre-commit Requirements

Before committing, always run and fix:
1. `cargo fmt --all` - Format all code
2. `cargo clippy --all-targets -- -D warnings` - Fix all clippy warnings
3. `cargo test` - Ensure all tests pass

## Code Standards

- No `unwrap()` or `expect()` outside test code - use proper error handling
- No `println!()` in library code (CLI and web binaries are OK)
- All public functions must have doc comments (`///`)
- All `unsafe` blocks must have a comment explaining why they're safe
- Prefer editing existing files over creating new ones

## Production Deployment

The **frontend is a static single-page `index.html`, served by GitHub Pages** —
this repo is the whole client. The old droplet path (a native systemd binary,
then a `bridge-analysis` container in the bridge-craftwork-platform compose
stack at `club-game-analysis.bridge-classroom.com`) was **RETIRED 2026-06-29**:
analysis moved into this frontend JS, and file parsing moved to the separate
`bridge-event-parser-service`. There is no longer any droplet container, image,
`just deploy`, or `ssh bridge-droplet` step for this app — ignore any older
notes that say otherwise.

### Architecture

```
User → Cloudflare DNS (game-analysis.bridge-classroom.com) → GitHub Pages (this repo's index.html)
                              │
        client-side fetches → game-parser.bridge-craftwork.com  (bridge-event-parser-service — .bws/.pbn/.xml parsing)
                            → bba.harmonicsystems.com (BBA auctions)
        in-browser wasm     → static/solver/ (bridge-solver — double-dummy, no network)
```

- **Domain:** `game-analysis.bridge-classroom.com` (the committed `CNAME`; Cloudflare-proxied → GitHub Pages).
- **Deploy:** push to `main` → `.github/workflows/deploy.yml` (`actions/upload-pages-artifact` + `actions/deploy-pages`). The workflow copies `index.html` → `404.html` for SPA routing. No build step — the SPA is hand-authored `index.html` with inlined JS/CSS.
- **Parsing backend:** `const BASE = 'https://game-parser.bridge-craftwork.com'` in `index.html` points at `bridge-event-parser-service` (a separate repo/service) for `/api/upload` / `/api/normalized`. Deals otherwise live client-side in `sessionStorage['bc-game']`.
- **Double-dummy solver hand-off:** the board view's `solverUrl()` link opens
  `bridge-craftwork.com/bridge-solver/?lin=…` (`bcSolverBase()`) with the same
  LIN the embedded BBO viewer is rendering, lifted straight out of the row's
  `handviewer_url`. LIN, not PBN: the solver's play trace needs the auction and
  cards, which PBN would not carry. One fixed URL — the solver is a single
  deployment — so this one does *not* mirror the page TLD. It was
  `solver.bridge-classroom.org` until Sep 2026; that host was retired by the
  bridge-craftwork site consolidation and no longer resolves.
- **Bridge Classroom hand-off:** `bcViewerUrl()` builds `bridge-classroom.{com|org}/solo-practice-app/#/table?pbn=…` single-board replay links (`#/bidding-practice` was retired when that route merged into the unified table — a stale hash route does not error, it falls through to the lobby and drops the `?pbn=`); the "Send to Library" button POSTs a whole game to `api.bridge-classroom.{com|org}/api/deal-library` (`bcApiBase()`), keyed to the teacher by a `?bc_owner=<id>` launch handshake from their Bridge Classroom Deal Library tab.

### Other Services on the Same Droplet

| Service | URL | Port | Config |
|---------|-----|------|--------|
| BBA Server | `bba.harmonicsystems.com` | 5000 | `/opt/bba-server/` |
| LiveKit | `livekit.bridge-classroom.com` | 7880 | `/opt/livekit/` |

## Web Application Features

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET /` | Serve main SPA page (file-upload entry) |
| `GET /analyze` | Serve same SPA, but bootstrap reads JSON from `sessionStorage["pending-session"]` (extension entry) |
| `POST /api/upload` | Upload BWS+PBN files, runs the adapter + enrich passes, persists data.json. Response: session ID + session metadata + counts + per-pair ACBL map |
| `POST /api/upload-normalized` | Accept normalized JSON in body (extension's POST target). Validates `schema_version` (rejects unknown major versions with 422), enriches, persists |
| `GET /api/sessions?session=...` | List all sessions in an upload (BWS=1, JSON ingest may be many) |
| `GET /api/normalized?session=...` | Stream the persisted data.json. The browser fetches this once after upload and runs all analysis client-side over it |
| `POST /api/names?session=...` | Apply ACBL-number → name overrides; mutates data.json in place and re-runs the handviewer-URL enrichment |
| `POST /api/bba-proxy` | Proxy requests to BBA server (avoids CORS) |
| `GET /healthz` | Service-contract health (`{status, version, uptime_seconds}`); `/health` 308's here |
| `GET /metrics` | Prometheus text-format metrics |
| `GET /admin/dashboard?key=...` | Admin analytics dashboard |
| `GET /admin/api/stats?key=...` | Usage statistics JSON |

The previously-served `/api/players`, `/api/boards`, `/api/player`, `/api/board`
endpoints (server-side analysis) were removed in 2026-04 when the JS
analyzer became the only path; the SPA computes those lists and per-player /
per-board analysis directly from `cachedNormalized` (the result of one
`/api/normalized` fetch after upload).

`session_idx` defaults to `0` and is omitted from URLs when there's only one
session (the BWS+PBN case). Multi-session uploads (typical for tournament
data from the extension) get a session-selector dropdown in the UI.

### Extension handoff protocol (`/analyze`)

The browser extension at [acbl-live-fetch](../acbl-live-fetch) performs the
following sequence to hand off a freshly-scraped tournament:

1. Build the normalized JSON document in the extension.
2. Open a new tab to `https://club-game-analysis.bridge-classroom.com/analyze`.
3. Have a content script in that tab write the JSON to
   `window.sessionStorage["pending-session"]`. Because content-script timing
   is not guaranteed relative to page scripts, the SPA polls sessionStorage
   for ~2s and also listens for a `bridge-classroom-handoff` `window` event
   the extension can dispatch to short-circuit the wait.

The SPA's analyze bootstrap (`?analyze`, or a `/analyze` path on the old
origin-root deploy) has four explicit states:

- **DATA**: pending-session present, valid, accepted → normal player/board UI.
- **RESTORED**: no pending-session, but `sessionStorage["bc-game"]` still holds
  the game → the analysis is re-rendered from it. This is the refresh case.
- **EMPTY**: no pending-session and nothing cached → friendly card with a link
  to `./?upload`.
- **ERROR**: malformed JSON, unsupported `schema_version`, or server reject →
  error card with the specific message and a link to `./?upload`.

The fragment `#sid={uuid}` is for extension-side bookkeeping only; the SPA
ignores it. Reads of `pending-session` are one-shot — consumed via
`removeItem` immediately so a refresh cannot re-apply stale data.

### URL routing

The route params name *entries*, not screens, so the SPA consumes them:

- `?analyze` is a one-shot import. Once it has been handled (accepted, batch
  started, or found already-consumed), `clearAnalyzeRoute()` `replaceState`s it
  away — along with any `#sid=` — leaving the plain page URL. A refresh then
  goes down the normal load path.
- The normal load path restores `sessionStorage["bc-game"]` when it is there, so
  a refresh shows the game rather than the upload card. "New File" clears that
  cache (`resetSessionState`), so a dismissed game does not come back.
- `?upload` forces the file-upload card and is *not* stripped, so it stays put
  across a refresh. It exists because "go to the file-upload page" must land on
  the upload card even for a browser with saved history, which otherwise opens
  on the History view.

### Analytics

- IP addresses anonymized via SHA-256 → friendly "FirstName_Surname" pseudonyms
- CSV audit logs in `LOG_DIR` with monthly rotation
- Tracks: action, browser, device type, duration
- Admin dashboard shows daily usage, browser/device breakdown, top visitors

### External API Integrations

- **BBA** (`bba.harmonicsystems.com`): Sample auction generation (proxied through server to avoid CORS)

Double-dummy is **not** an external call. It was BSOL (`dds.bridgewebs.com`)
until August 2026; it is now our own `bridge-solver` wasm, vendored under
`static/solver/` and run in a worker — see that directory's `README.md`. Only
BBO captures ever solve, because the ACBL adapters put double-dummy in the
normalized payload. Tables are cached in `localStorage` under `bc-dd-cache`,
since one costs 190–1200 ms on a fast laptop and re-reviewing a session must not
pay twice. Deliberately no network fallback: the privacy policy states that a
deal never leaves the browser.

## Git Configuration

Use SSH for all GitHub operations:
- Clone/push/pull: `git@github.com:bridge-craftwork/repo.git` (not `https://`)
- Remote URLs should use SSH format

## Related Projects

All located at `/Users/rick/Development/GitHub/`:

| Project | Description | Relationship |
|---------|-------------|--------------|
| [bridge-types](../bridge-types) | Core bridge types | upstream dependency |
| [Bridge-Parsers](../Bridge-Parsers) | PBN/LIN/BWS file parsing | upstream dependency (used only by pbn_bws adapter) |
| [bridge-solver](../bridge-solver) | Double-dummy solver | upstream dependency |
| [acbl-live-fetch](../acbl-live-fetch) | Browser extension that scrapes ACBL Live tournament results and hands off normalized JSON to `/analyze` | **input source** (the JSON ingest path) — owns `docs/normalized-schema.md`, the contract between adapters and the analyzer |
| [bridge-wrangler](../bridge-wrangler) | CLI tool | sibling |
| [bridge-classroom](../bridge-classroom) | Main website | parent site (footer, landing page) |
| [BBA-CLI](../BBA-CLI) | BBA auction engine | BBA proxy target, deployment model reference |

### Schema co-evolution

The normalized JSON schema is owned by [`acbl-live-fetch/docs/normalized-schema.md`](../acbl-live-fetch/docs/normalized-schema.md).
When the schema changes, both repos must move together:

- server: update `parse-files/src/data/schema.rs` (serde types). Bump
  `SUPPORTED_MAJOR` only on a breaking change.
- server: if the change affects fields `parse-files/src/data/builder.rs`'s
  enrich passes (`enrich_tricks`, `enrich_handviewer_urls`) read or
  write, update those.
- server's BWS adapter (`parse-files/src/data/adapters/pbn_bws.rs`)
  emits the same schema; update it too if the change affects fields
  the adapter writes.
- web's upload helpers (`web/src/upload_helpers.rs`) walk the schema
  for the upload response shape; update if a relevant field changes.
- SPA: the JS analyzer in `web/static/index.html` reads the schema
  directly. Update its derive functions and renderers to match.
- extension: update its emitter and the doc's worked example.

Validate end-to-end with `cargo test --all` (server) + `npm test`
(extension). The server enforces `schema_version` major-version
compatibility — unknown major versions return 422 from
`/api/upload-normalized`.

## Notifications

Send Pushover notifications when work is blocked or completed:

```bash
pushover "message" "title"    # title defaults to "Claude Code"
```

**When to notify:**
- Waiting for user input or permission
- Task completed after extended work
- Build/test failures that need attention
- Any situation where work is paused and user may not notice
