// Service worker: keeps the app and the city map on the phone so everything works with no signal.
// The build (see vite.config.ts) fills in VERSION, MAP and PRECACHE.
const VERSION = "c8047e6bd9a9";
const MAP = "nyc-v1.pmtiles"; // file name of the city map, e.g. nyc-v1.pmtiles
const PRECACHE = ["./","assets/index-CA82sdec.js","assets/index-Q2-MrwZ3.css","data/board.geojson","data/boroughs.geojson","data/coastline.geojson","data/landmass.geojson","data/places.json","data/station-landmass.json","data/stations.json","data/water-dist.bin","data/water-dist.json","data/water.json","data/zones.geojson","fonts/Noto Sans Italic/0-255.pbf","fonts/Noto Sans Italic/256-511.pbf","fonts/Noto Sans Italic/8192-8447.pbf","fonts/Noto Sans Medium/0-255.pbf","fonts/Noto Sans Medium/256-511.pbf","fonts/Noto Sans Medium/8192-8447.pbf","fonts/Noto Sans Regular/0-255.pbf","fonts/Noto Sans Regular/256-511.pbf","fonts/Noto Sans Regular/8192-8447.pbf","icons/icon-180.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","index.html","manifest.webmanifest"]; // every built file except the map, relative to this file

const SHELL = `shell-${VERSION}`;
const MAP_CACHE = `map-${MAP}`;
const scopeUrl = (p) => new URL(p, self.registration.scope).href;

self.addEventListener("install", (event) => {
    // Only the small app files block installing; the 40 MB map is saved afterwards (see "save-map").
    event.waitUntil(
        caches
            .open(SHELL)
            .then((c) => c.addAll(PRECACHE.map(scopeUrl)))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            // Throw away older versions of the app (but keep the map unless it was renamed).
            for (const key of await caches.keys()) if (key !== SHELL && key !== MAP_CACHE) await caches.delete(key);
            await self.clients.claim();
            await saveMap();
        })(),
    );
});

const tell = async (msg) => (await self.clients.matchAll()).forEach((c) => c.postMessage(msg));

/** Downloads the whole city map once. It is read back in pieces (the map asks for byte ranges). */
let saving = null;
function saveMap() {
    if (saving) return saving;
    saving = (async () => {
        const cache = await caches.open(MAP_CACHE);
        if (await cache.match(scopeUrl(MAP), { ignoreVary: true })) return tell({ type: "map-ready", fresh: false });
        try {
            await tell({ type: "map-saving" });
            const res = await fetch(scopeUrl(MAP), { cache: "no-store" });
            if (!res.ok) throw new Error(`map download failed (${res.status})`);
            await cache.put(scopeUrl(MAP), res);
            await tell({ type: "map-ready", fresh: true });
        } catch (e) {
            await tell({ type: "map-failed" }); // tried again the next time the app opens
        } finally {
            saving = null;
        }
    })();
    return saving;
}

self.addEventListener("message", (event) => {
    if (event.data === "save-map") event.waitUntil(saveMap());
});

/** Answers a "Range: bytes=a-b" request from the full saved file. */
async function rangeResponse(request, full) {
    const blob = await full.blob();
    const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") || "");
    if (!m) return new Response(blob, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    const size = blob.size;
    let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
    let end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    return new Response(blob.slice(start, end + 1), {
        status: 206,
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": String(end - start + 1),
        },
    });
}

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== location.origin) return;

    if (url.pathname.endsWith(`/${MAP}`)) {
        event.respondWith(
            (async () => {
                const hit = await (await caches.open(MAP_CACHE)).match(scopeUrl(MAP), { ignoreVary: true });
                return hit ? rangeResponse(req, hit) : fetch(req);
            })(),
        );
        return;
    }

    event.respondWith(
        (async () => {
            const cache = await caches.open(SHELL);
            const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
            if (hit) return hit;
            try {
                return await fetch(req);
            } catch (e) {
                // Opening the app with no signal at an address we haven't saved (e.g. ".../index.html?x"): show the app.
                if (req.mode === "navigate") return (await cache.match(scopeUrl("./"), { ignoreVary: true })) || (await cache.match(scopeUrl("index.html"), { ignoreVary: true }));
                throw e;
            }
        })(),
    );
});
