# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`tesla-nav` is a PWA navigation app for the Tesla Model 3/Y center screen (MCU2 Intel Atom, MCU3 AMD Ryzen) for driving in Georgia, where Tesla's own navigation has no local routing, speed limits or Georgian language. It runs in the car's Chromium browser, whose viewport is **773x601 CSS px at dpr 1.53** (measured in the car, 2026-10-20); its user agent is plain desktop Chrome on `X11; Linux x86_64`, with no "Tesla" in it. Every screen must fit 773x601. It is deployed at `https://apev.onrender.com` (Render, free tier) and locally at port 3000. The owner is Samvel. Project docs and most notes are written in Georgian. Reply in Georgian when the user writes in Georgian.

**`PROJECT_DOCS.md` is the current, complete project description (Georgian): read it first.** Other docs in this folder: `README.md` (older feature overview, v3.10.29), `TEAM_NOTES.md` (**the source of truth for file ownership, priorities and the changelog**), `docs/archive/` (AGENT_HANDOVER_GUIDE.md, MASTER_HISTORY_AND_ARCHITECTURE.md: old v3.8–v3.9 history, out of date), `../TODO_FOR_AGENT.md` (things to check in the real car). `FULL_CONVERSATION_TRANSCRIPT.md` (4 MB) and `conversation-logs/` are git-ignored archives. Don't read them unless the user asks.

## Commands

No build step and no npm dependencies. It's plain Node (>=18) and browser JS.

```bash
node server.js                 # or: npm start   (PORT default 3000)
npm test                       # all unit test files, run one after another; stops at the first failure
npm run check                  # version consistency + script whitelist (tests/check_version.js)
npm run smoke                  # starts the real server on a random port, security/regression checks
node tests/test_map_gl.js      # run a single test file
for f in *.js tests/*.js; do node --check "$f" || exit 1; done   # syntax check, same as CI
```

CI (`.github/workflows/ci.yml`, Node 20) runs the syntax check, `npm test`, `npm run check` and `npm run smoke`. All four must pass before you commit. A new test file must also be added to the `test` script chain in `package.json`, or it never runs.

Env vars (`.env` / Render): `PORT`, `HOST`, `ACCESS_PIN` (comma list; the first PIN is the master, changed only here; the rest are guest PINs, which the owner can also change in the devices panel), `AUTH_SECRET` (signs cookies and panel guest PINs), `ADMIN_TOKEN` (`/api/chargers/sync`), `GOOGLE_MAPS_KEY` (Google mode, browser key), `GOOGLE_MAP_ID`, `ROUTES_DAILY_CAP` / `ROUTES_MONTHLY_CAP` (default 100 / 4000), `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (+ optional `UPSTASH_REDIS_KEY`: Google caps, signed-in devices `_auth`, speed cameras `_cameras`), `DATA_DIR` (local files when there is no Upstash), `OVERPASS_ENDPOINTS` (tests). `GOOGLE_ROUTES_KEY` is no longer used (v3.10.70).

## Architecture

**Server (`server.js`)**: a single-file `http` server with no framework. It serves only the files listed in `STATIC_WHITELIST`, so **a new browser `.js` file returns 404 in production until you add it there**. `check_version.js` enforces this for `index.html` scripts. It holds PIN auth with brute-force lockout, and API routes under `/api/*`:
- `search` / `suggest`: Nominatim (1 s throttle, 24 h cache) and Photon proxies. `search` and `maps-link` (Google Maps share link → coordinates) also accept the phone's active session code instead of a PIN.
- `chargers/live|sync`: charger data from the dachar.ge Firestore plus GeoCharge tariff medians (read daily, `geocharge-tariffs.js`), deduplicated. `chargers-cache.json` is the git snapshot; the live list goes to `chargers-live.json` (ignored).
- `cameras` (OSM speed cameras, daily, also in Upstash) and `overpass` (cached speed-limit / traffic-light tiles; only those two queries).
- `admin/*`: the owner's devices panel (master PIN only): devices, guest PINs (`auth-store.js`).
- `google-permit` / `route-permit` / `google-usage`: per-SKU free-tier caps (`route-quota.js`, Asia/Tbilisi day, counters in Upstash). The page calls Google Routes / Places itself after a permit.
- `gmaps-config`: the browser key for Google mode.
- `session/listen|send|status`: an SSE channel for the phone companion `remote.html`, which pairs by QR code. Allowed event types are only `destination` and `gps`.

**Client**: no bundler. `index.html` loads classic scripts in a fixed order, and `app.js` comes last as the coordinator (GPS, UI events, follow mode, debug HUD). Modules attach to `window` (`window.RoutingEngine`, ...) or use a UMD wrapper (`module.exports` when it exists), so the same file runs in the browser and under Node tests.
- `map-gl.js`: the MapLibre GL abstraction. FollowCamera does dead reckoning between 1 Hz GPS fixes and shortest-arc bearing smoothing. The LayerRegistry (`ensureCustomLayers()`) re-adds custom layers after a style switch, so add new map layers through it. It also has the LiteGovernor (auto-Lite / auto-flatten when fps is low, stored in `sessionStorage`) and the house-number speed governor.
- `tesla-style.js`: map looks. `mono` (flat, gray, pitch 0) is the default. `?style=classic` gives the colored 3D map, `?style=tesla` the Tesla palette. Day/night switching uses `diff()` + `setPaintProperty` and never a full `setStyle` (that froze the car browser).
- `routing.js`: OSRM with two servers (`router.project-osrm.org`, `routing.openstreetmap.de`). Alternatives appear only in preview. It keeps the old route when the network fails. `speech.js` reads Georgian TTS only (no English fallback) and plays Web Audio chimes.
- `speed-limit.js`: tier 0 is the OSM Overpass `maxspeed` on about 0.5 km tiles. It has three confidence levels: confirmed `60` (alarm allowed), estimate `~60` (dashed badge, **never** an alarm), unknown `—`.
- `gmap.js`: a separate "Google mode" overlay (`#gmap-layer`) with Google raster, Traffic, Places and Routes (called from the browser after a `/api/route-permit` / `/api/google-permit`), plus off-route rerouting. **Google data (Places/Traffic/Routes) must never be shown on the MapLibre map** (Google ToS); `tests/test_gmap.js` checks this.
- `sw.js`: the service worker. `CACHE_NAME` includes the version. It lets the page reload instantly after the car's browser reloads on shifting into R. The route state is restored from `localStorage`.

**Tests**: plain Node scripts with no framework. Most load a browser file with `vm.runInThisContext` against small `window`/map stubs and print `PASS`/`FAIL`, setting `process.exitCode = 1` on any failure. Some tests cut part of `server.js` out and run it in `vm`, so code order inside `server.js` can matter.

## Rules (from TEAM_NOTES.md and the handover guide)

- **Version bump touches all of these at once:** `package.json` `version`, every `?v=` in `index.html`, `APP_VERSION` in `app.js`, and `CACHE_NAME` + precache list in `sw.js`. Tesla Chromium caches aggressively, and a mismatch gives stale code in the car. `npm run check` verifies package/index/app.js.
- **File ownership:** several agents (Claude and Antigravity) work on the repo. Check the owner table in `TEAM_NOTES.md` before editing. `index.html`, `package.json` and `server.js` are shared: keep your diff minimal and record it. After finishing, add a changelog line to `TEAM_NOTES.md` (in Georgian, with the version, what changed and what was **not** verified in the car).
- **Keep the documentation current (owner's rule, 2026-10-20):** with every change also update `PROJECT_DOCS.md` when anything it describes changes (features, data sources, limits, files, API, rules) and bump its version/date line. The conversation history in `../history/` is exported automatically after every reply (Stop hook in `../.claude/settings.json` runs `../history/_export.js`); it stays outside git because it holds everything pasted into the chats.
- Re-read files (or `git pull`) before editing. Another agent may have changed or reverted them. Make one commit per topic.
- Don't change `DRIVING_LOCKOUT` (`app.js`, stays false) or work around Tesla's own in-motion video block. YouTube was removed on purpose (v3.10.28). Don't add it back unless asked.
- Never use `backdrop-filter: blur()`. It causes heavy GPU stutter on the MCU. Performance on MCU2 (fps 6–16 was measured) comes first. Don't add heavy layers or features without the owner's approval. Put new visual changes behind a URL flag first.
- Overlay controls must stop touch propagation (`e.stopPropagation()`, `button svg { pointer-events: none }`) so taps don't pan the map.
- Map gesture handlers must ignore programmatic camera events: `if (e && e.originalEvent && !e.followCamera)`. Without that, `jumpTo` fires `rotatestart`/`pitchstart` and turns off follow mode (the "arrow drives off the screen" bug).
- Be honest in the UI and in notes: battery arrival % is an estimate (no BMS access). Don't promise charger free/busy status (there's no data for it). PlugShare is excluded (license). TomTom traffic has no coverage in Georgia.
- The sandbox usually can't reach Overpass, OpenFreeMap, Google or YouTube. Say clearly what was tested only against mocks and needs checking in the real car.
- Never commit secrets. The repo is public.

URL debug flags: `?debug=1` (HUD; tapping the speed 5 times also opens it), `?lite=1|0`, `?pitch=N`, `?style=mono|classic|tesla`, `?dpr=`, `&labels=0`, `&markers=0`.

## Workspace outside the repo

The parent folder `D:\Projects\Tesla Model 3\` is not a git repo. It holds only `CLAUDE.md` and `TODO_FOR_AGENT.md`. The old backups (`tesla-nav-backup/`, the zip), `patch-osm-ci/` and the tmap.ge bundles went to the Recycle Bin on 2026-10-20 with the owner's approval.
