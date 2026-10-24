# Aerie London Watch

A live, 3D bird's-eye view of London. Fly over satellite imagery with 3D buildings, tap any of the ~900 public TfL traffic cameras to see its live picture, pin up to nine on a split-screen wall, follow live road disruptions, or set it on **Patrol** to tour every camera on screen.

London only, by design: the map is locked to Greater London.

---

## What it does

| Feature | How |
|---|---|
| 3D bird's-eye map | Satellite, Night and Blueprint styles. Tilt with two fingers (right-drag on desktop), rotate, and fly. 3D buildings from OpenStreetMap heights. |
| Live cameras | Every TfL JamCam as an amber dot, grouped into numbered clusters when zoomed out. Grey = TfL reports it offline. A cyan wedge shows which way a camera faces when TfL says. |
| Into the camera | Tap a dot for the live still (refreshes every minute), the recent video clip, fullscreen, **Street level** (drops to 18× zoom, tilted along the camera's direction) and Google Street View. |
| Split-screen wall | Pin up to 9 cameras; **SPLIT** gives the wall half the screen. Pins are remembered on that device. |
| Patrol | Plans a route through every camera on screen and flies camera to camera every 9 seconds. Touch the map to stop. |
| Road alerts | Live TfL road disruptions, colour-coded by severity. Tapping one flies there and opens the nearest camera. |
| Road filter | Chips for the busiest roads (A40, A4, A13…) to show only their cameras. |
| Search | Camera names, road numbers, streets and postcodes, limited to London. |
| Share | `COPY LINK` gives a link straight to a camera (`/#cam=00001.01251`). |
| Installable | Add to Home Screen on iPhone/Android and it opens full-screen like an app. |

Keyboard: `/` search · `N` next camera · `A` patrol · `W` split · `B` 3D · `R` alerts · `S` `D` `M` map style · `H` home · `Esc` close.

---

## Architecture

```
 Browser (public/)                         Aerie server (server/)                  Upstream
 ┌──────────────────────────┐   /api/*    ┌────────────────────────────┐
 │ MapLibre GL 3D map       │ ──────────▶ │ /api/cameras   cache 3 min │ ──▶ TfL Unified API (JamCams)
 │ app.js  UI, patrol, wall │             │ /api/cameras/:id/image 45s │ ──▶ TfL JamCam images (S3)
 │ api.js  data layer       │             │ /api/disruptions  2 min    │ ──▶ TfL road disruptions
 │ sw.js   offline shell    │             │ /api/geocode   24 h, 1/s   │ ──▶ OpenStreetMap Nominatim
 └──────────┬───────────────┘             │ static files, gzip, CSP    │
            │ map tiles (direct)          │ per-IP rate limits         │
            ▼                             └────────────────────────────┘
   Esri imagery · OpenFreeMap vectors · CARTO
```

**Why a backend at all?** The site works without one (it calls TfL directly), but the server fixes the weak points of a pure front-end build:

- **One TfL call serves everyone.** 1,000 visitors make one upstream request every 3 minutes instead of 1,000. Add a free `TFL_APP_KEY` for higher limits.
- **Image caching.** Camera stills are cached for 45 s, so a busy wall doesn't hammer TfL.
- **Keeps working when TfL blips.** If TfL fails, the last good data is served and marked `stale`.
- **Fair use of OpenStreetMap search.** Nominatim allows one request a second; the server queues and caches searches.
- **Security.** Strict Content-Security-Policy, input validation on camera ids, path-traversal protection, per-IP rate limits, GET-only.

The frontend checks `/api/health` on load. If the server isn't there (a static host), `api.js` switches to direct mode automatically, and the status chip says `DIRECT`.

**Stack:** plain HTML/CSS/ES modules, MapLibre GL 4.7.1, and a zero-dependency Node 18+ server. There is no build step and no `npm install`.

```
aerie/
├── public/            frontend (deployable on its own)
│   ├── index.html
│   ├── styles.css
│   ├── app.js         map, cameras, wall, patrol, search
│   ├── api.js         backend-or-direct data layer
│   ├── sw.js          service worker (app shell only)
│   ├── manifest.webmanifest, icon.svg
├── server/
│   ├── server.js      HTTP server + API
│   └── lib.js         pure helpers (normalisers, cache, rate limiter)
├── test/              node --test unit + HTTP tests
├── render.yaml        one-click Render deploy
├── Dockerfile         any container host
└── netlify.toml       static-only deploy
```

---

## Run it

```bash
npm start            # http://localhost:8080
npm test             # 8 tests
```

Optional environment variables:

| Name | Purpose |
|---|---|
| `PORT` | Port to listen on (default 8080) |
| `TFL_APP_KEY` | Free key from api-portal.tfl.gov.uk for higher TfL rate limits |
| `CONTACT_EMAIL` | Sent to OpenStreetMap with search requests, as their policy asks |

---

## Put it online

**Full version, with the backend (recommended): Render, free**
1. Put this folder in a GitHub repository.
2. On render.com choose **New → Blueprint** and pick the repository. `render.yaml` sets everything up.
3. You get a `https://aerie-london-watch.onrender.com` address. Free instances sleep when idle, so the first visit after a while takes ~30 s.

**Front end only: Netlify, free, no account needed to try**
Drag the `public` folder onto app.netlify.com/drop. You get a live link in seconds. It runs in direct mode.

**Any server or VPS:** `docker build -t aerie . && docker run -p 80:8080 aerie`.

---

## Data, licences and limits

- Camera images and disruptions: Transport for London, Open Government Licence. JamCams are public traffic cameras. TfL updates stills every few minutes and the clips are short recent loops, not a continuous live stream.
- Satellite imagery: Esri World Imagery. Check Esri's terms before heavy commercial use.
- Map data: © OpenStreetMap contributors, served by OpenFreeMap and CARTO.
- This app only shows public, licensed feeds. It doesn't use private CCTV and has no face or plate recognition.
