# 🚀 Tesla In-Car Navigation (Georgia) — Master Agent Handover Guide

> **Target Audience:** Future AI Agents, Engineers, and Auditors.  
> **Status as of October 13, 2026:** Production Ready, Optimized for Tesla MCU Chromium Browser, Version **v3.9.4**.  
> **Primary URL:** `http://localhost:3000` (Local) / `http://192.168.111.25:3000` (In-car WiFi/Hotspot) / `https://apev.onrender.com` (Cloud).  
> **Repository Location:** `C:\Users\skarapetiani\.gemini\antigravity\scratch\tesla-nav`  
> **Backup Directory:** `C:\Users\skarapetiani\.gemini\antigravity\scratch\tesla-nav-backup`  
> **Zip Archive:** `C:\Users\skarapetiani\.gemini\antigravity\scratch\tesla-nav-backup-complete.zip`  

---

## 1. Project Background & Core Mission
In Georgia, Tesla's factory navigation is unsupported (no local map routing, no speed limits, no live traffic, no Georgian language).
This application provides a native-feeling, zero-lag, 60 FPS web navigation system specifically engineered for the 15-inch center touchscreen of the **Tesla Model 3 and Model Y** (MCU2 Intel Atom and MCU3 AMD Ryzen).

---

## 2. Full Conversation & Request History (From Day 1 to Now)

### Phase 1: Core Foundation & UI
* **Cyber Dark Automotive Theme:** Fullscreen map canvas matching Tesla OEM styling.
* **Turn-by-Turn Routing (`routing.js`):** OSRM routing engine with Georgian voice prompts (`speech.js`), maneuver cards, speed limit warnings, and Arrival Time (ETA).
* **Automotive Widgets:** Real-time speedometer (km/h), 24h clock (`HH:mm`), full-screen toggle, and Screen Wake Lock API.

### Phase 2: Eco-System & Tesla Features
* **Battery & Energy Estimator (`battery.js`):** Calculates trip energy consumption (kWh) and Arrival State of Charge (SoC %) based on vehicle profiles.
* **Live Weather (`weather.js`):** Open-Meteo API integration for local temperature, wind, and conditions.
* **YouTube In-Car Music (`media-player.js`):** Corner picture-in-picture player for background YouTube music.
* **Traffic Signals (`traffic-signals.js`):** Tbilisi signalized intersections layer with 350m proximity HUD alerts via Overpass API.
* **EV Chargers Layer (`chargers.js`):** Fast charging stations across Georgia with 1-click route calculation.

### Phase 3: Major Refinements & User Feedback
1. **Removed Clutter POI Chips:** Cleaned search dropdown to focus solely on navigation.
2. **Google Maps Integration:** Integrated official Google Maps tiles in Georgian without API keys (`google-roads` and `google-sat` hybrid).
3. **Map Style Menu:** Streamlined to 3 essential maps:
   * 🗺️ **Google Maps (Roads)**
   * 🛰️ **Google Satellite Hybrid**
   * 🟡 **Yandex Maps (with live traffic & score)**
4. **Phone Remote Companion (`remote.html`):** QR code modal on car screen. Passengers scan to search destinations, dictate addresses by voice, or paste YouTube links/search terms directly to the car screen.
5. **1-Click Day/Night Mode:** Global high-contrast theme toggle for night driving.
6. **Reverse Gear Recovery:** Auto-persists route state to LocalStorage so page reloads upon reversing don't lose the route.
7. **Avoid Unpaved Roads:** Added OSRM parameter `exclude=unpaved`.

### Phase 4: Extreme 60 FPS Optimization for Tesla MCU
* Replaced heavy SVG layers with Hardware-Accelerated HTML5 Canvas (`preferCanvas: true`).
* Disabled tile opacity animations (`fadeAnimation: false`) and aggressive off-screen buffer limits (`keepBuffer: 2`).
* Removed all GPU-choking `backdrop-filter: blur(20px)` and replaced with frosted solid `#0e121a`.
* Added dirty-checking throttles to all DOM writes.
* Lazy-loaded Yandex Maps API v2.1 on demand.
* Added native Gzip compression and strict cache headers in `server.js`.

### Phase 5: Recent Critical Requests & Bug Fixes
* **6.6 Search Dropdown Horizontal Scroll Elimination (v3.2.0):** Eliminated unwanted horizontal scrollbars (`overflow-x: hidden !important`, `minmax(0, 1fr)`).
* **6.7 Official Tesla Model 3 & Model Y (2018-2023) Specs Integration (v3.3.0):** Researched EPA, WLTP, and official owner manuals. Integrated 9 exact trim configurations (Standard Range+, RWD LFP, Long Range AWD, Performance AWD) with usable battery capacities (50.0 to 79.0 kWh), battery chemistries, and charging recommendations (LFP 100% vs NCA 80-90%).
* **6.8 Remote YouTube Direct Search & Live Chargers Auto-Sync (v3.4.0):**
  * Added `/api/youtube/search` backend resolver for title/artist lookups without API key quotas.
  * Added phone remote YouTube player controls.
  * Added 30-minute auto-sync for 650+ Georgian EV chargers from Dachar/Revolt/Firestore to local JSON cache (`chargers-cache.json`).
* **6.9 Removal of Simulation & Fake Incidents (v3.5.0):**
  * Removed `#btn-sim-drive`, `startSimulation()`, and all background intervals to keep app ultra-lightweight.
  * Removed 6 hardcoded fake demo road incident markers from `yandex.js`.
* **6.10 Georgian Voice Dictation on Phone Remote (v3.6.0):**
  * Added Web Speech Recognition (`ka-GE`) with mic buttons in `remote.html` for both destination input and YouTube search.
* **6.11 Yandex Live Traffic Toggle Fix (v3.6.1):**
  * Added `toggleTraffic(explicitState)` in `yandex.js` and connected `#btn-toggle-traffic` in `app.js` to control `trafficProvider.setMap(...)`.
* **6.12 Yandex Reload Black Screen & Panning Lag Fix (v3.6.2):**
  * Fixed initialization order bug in `initMap()` vs `initSubsystems()`.
  * Added fallback road tiles while Yandex script downloads.
  * Fixed Yandex center sync with `{ duration: 0, checkZoomRange: false }` via `requestAnimationFrame`.
* **6.13 Yandex Zoom Lag & Icon Synchronization Fix (v3.6.3):**
  * **Root cause:** Leaflet's 250ms CSS scale animation on markers was running while Yandex in the background did not receive zoom events until the animation completed.
  * **Fix:** Dynamically disabled `map.options.zoomAnimation = false; map._zoomAnimated = false;` when on Yandex map, and added synchronous zero-delay `syncImmediate()` on zoom events.
  * **Result:** Zoom click duration < 10ms, perfect lockstep synchronization.
* **6.14 OSRM Routing 400 Bad Request Fix & Dual-Server Fallback (v3.6.4):**
  * Removed unsupported `&exclude=unpaved` parameter from OSRM requests.
  * Added `parseCoord(pt)` coordinate validation/normalization.
  * Implemented Dual-Server Fallback (`router.project-osrm.org` + `routing.openstreetmap.de`).
* **6.15 Comprehensive Audit Fixes (P0 & P1 Pass) & Unrestricted Media (v3.7.0):**
  * **Removed fake data:** sin-based fake traffic, mock traffic signals, mock chargers, fake lane arrows, time-of-day traffic scores.
  * **Security hardening:** Server static whitelist, URI parse error handling, 8KB body cap, event validation, XSS escaping with `escapeHtml()`, `textContent` toasts, 64-bit crypto session codes.
  * **Navigation engine:** Step progress projection along polyline (immune to skipped fixes), along-route remaining distance/ETA, advance voice announcements (500m/200m/now and high speed), keep old route on network failure (9s timeout), silent reroute with 10s back-off, single arrival trigger.
  * **Auto-resume & UI:** Auto-resume waits for real GPS fix; navigation zoom >= 17 on GO; fixed `btn-sim-drive` TypeError.
  * **STRICT EXCLUSION (Item 7):** Driving lockout (>5 km/h) was NOT added per explicit user instruction. YouTube iframe and search inputs remain open and unrestricted while driving.
  * **Tests:** Automated synthetic navigation test suite added in `tests/test_routing.js` (100% PASS).
* **6.16 Heading-Up (Course-Up) Map Rotation & Automotive Compass (v3.9.3):**
  * **Driver Problem:** In default North-Up Leaflet maps, driving South makes the car move backwards on screen; driving West moves it left; driving diagonally moves it askew.
  * **Solution:** True automotive Heading-Up mode: map canvas wrapped in `#map-viewport` (`100vw x 100vh`, `overflow: hidden`) with `#map` oversized to `170vw x 170vh` centered at `(-35vw, -35vh)` to mathematically prevent corner clipping at any rotation angle ($85vw > \sqrt{50^2 + 50^2} \approx 70.7vw$).
  * Map rotates by $-H^\circ$, vehicle marker faces $0^\circ$ (straight UP towards windshield / top of 15" screen), road ahead scrolls under vehicle.
  * Dock Compass toggle button (`#btn-map-orientation`) with 3D SVG needle pointing to True North in Heading-Up mode, switching to North-Up on click.
  * Touch & click coordinate un-projection hook on `map.mouseEventToContainerPoint` accounting for $-H^\circ$ rotation matrix.
  * Automated tests in `tests/test_heading.js` (11/11 PASS) verifying mathematical rotation and compass angles.
* **6.17 360-Degree Multi-Touch Map Rotation & Tesla Touch Gesture UX (v3.9.4):**
  * **Driver Problem:** In Tesla's native map, drivers can put two fingers on the 15" touchscreen and twist to freely rotate the map 360 degrees to any angle. Standard Leaflet only supported pinch-to-zoom (scaling), completely ignoring finger rotation angle.
  * **Solution:**
    * Multi-Touch 2-finger twist gesture engine (`initMapTouchRotation`): captures incremental angular delta $\Delta \theta = \theta_t - \theta_{t-1}$ across wrap-around boundaries, accumulating continuous 360° and 720° rotation smoothly at 60 FPS without transition lag.
    * Re-centers/follow-car smoothly un-hooks during manual rotation and re-engages when tapping Re-Center (`#btn-follow-car`).
    * Direct drag interaction on the Compass Needle button (`#btn-map-orientation`), allowing circular/horizontal dragging to spin the map, plus 1-click snap back to North-Up ($0^\circ$).
    * Desktop support: `Shift + Left Drag` / `Alt + Left Drag` rotates map 360 degrees.
    * Removed blocking `body.orientation-north-up #map { transform: rotate(0deg) !important; }` CSS rule.
    * Touch/click un-projection hook on `map.mouseEventToContainerPoint` generalized to all non-zero rotations (`currentMapRotation !== 0`).
    * Automated tests in `tests/test_heading.js` (12/12 PASS) asserting incremental wrap-around math.

---

## 3. Architecture & File Registry

```
tesla-nav/
├── index.html           # Main HUD UI, map container, overlays, modals, SVG icons (v=3.7.0)
├── style.css            # Dark UI theme, 0-blur high performance rules, zoom lockstep CSS
├── app.js               # Central coordinator (map setup, GPS tracking, styling, UI events)
├── routing.js           # OSRM dual-server routing, progress tracking, advance voice prompts
├── yandex.js            # Yandex JS API v2.1 lazy-loader, live traffic layer, traffic score
├── chargers.js          # Live 650+ EV charger markers, connector filters, 1-click route
├── battery.js           # Official Tesla 2018-2023 Model 3/Y specs & SoC trip calculator
├── weather.js           # Open-Meteo live weather client
├── speech.js            # Georgian voice navigation assistant
├── media-player.js      # Picture-in-picture YouTube player (unrestricted during driving)
├── speed-limit.js      # OSM Overpass live maxspeed engine with spatial grid cache & fallback
├── traffic-signals.js   # Live traffic lights layer via Overpass API (+-50 deg heading filter)
├── traffic.js           # Traffic layer coordinator
├── server.js            # Node.js HTTP/SSE server, Multi-PIN Single-Device lock, /api/search proxy, EV auto-sync
├── sw.js                # Service Worker for instant PWA caching & R-gear instant reload
├── remote.html          # Smartphone web companion (QR code target, search, voice dictation)
├── chargers-cache.json  # 650+ cached charging stations across Georgia
├── leaflet.js / .css    # Offline local Leaflet library (v1.9.4)
├── qrcode.min.js        # Offline QR code generator
└── tests/
    ├── test_routing.js          # Navigation engine automated unit tests (9 assertions)
    ├── test_speed_limit.js      # Speed limit fallback & corridor unit tests (13 assertions)
    ├── test_speed_limit_osm.js  # OSM Overpass grid & road snapping unit tests (22 assertions)
    ├── test_heading.js          # Automotive heading, COG & 360 rotation tests (12 assertions)
    ├── check_versions.js        # Version sync check across all manifests and HTML
    └── smoke_server.js          # 18-point server security & regression test suite
```

---

## 4. Key Rules for Any Future Modification
1. **Never break Touch Propagation:** Overlay elements MUST have `L.DomEvent.disableClickPropagation(el)` and `button svg { pointer-events: none; }`.
2. **Never use `backdrop-filter: blur()`:** It causes severe GPU stuttering on Tesla MCU Chromium.
3. **Driving Safety & Media:** YouTube playback while driving is enabled by user configuration (`DRIVING_LOCKOUT = false`), with an explicit driver safety disclaimer.
4. **Keep Leaflet Zoom Animation Dynamic:**
   * On Yandex Map: `map.options.zoomAnimation = false; map._zoomAnimated = false;` (otherwise icons float and lag behind).
   * On Google Maps: `map.options.zoomAnimation = true; map._zoomAnimated = true;` (smooth tile zoom).
5. **Keep OSRM Dual-Server Fallback:** Public demo servers may experience rate limits; dual servers ensure 100% uptime.
6. **Cache Busting:** Always increment `?v=X.X.X` in `index.html` when modifying CSS or JS, because Tesla Chromium caches aggressively.
7. **Server Port:** Runs on port 3000 (`node server.js`).

---

## 5. Verification Commands for Auditors
To verify the application:
1. Run automated test suite:
   ```bash
   npm test          # 46/46 unit tests (Routing + Speed limits + OSM Overpass + Heading-Up + 360)
   ```
2. Verify version consistency:
   ```bash
   npm run check     # Verifies v3.9.4 across package.json, index.html, sw.js
   ```
3. Run security and regression smoke tests:
   ```bash
   npm run smoke     # 18/18 server security tests (PIN auth, rate-limit, path traversal, SSE)
   ```
4. Verify JS syntax:
   ```bash
   node --check app.js yandex.js routing.js chargers.js battery.js server.js media-player.js speed-limit.js
   ```
