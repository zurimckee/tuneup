const CACHE_VERSION = "v2"; // bump this any time script.js, styles.css, or index.html changes
const SHELL_CACHE = `tuneup-shell-${CACHE_VERSION}`;
const ART_CACHE = `tuneup-art-${CACHE_VERSION}`;
const AUDIO_CACHE = `tuneup-audio-${CACHE_VERSION}`;
const LIBRARY_CACHE = `tuneup-library-${CACHE_VERSION}`;

const SHELL_FILES = [
    "/",
    "/static/styles.css",
    "/static/script.js",
    "/static/manifest.json",
    "/static/assets/apple-touch-icon.png",
    "/static/assets/android-chrome-192x192.png",
    "/static/assets/android-chrome-512x512.png",
];

// Precache the app shell on install
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES))
    );
    self.skipWaiting();
});

// Clean up old cache versions on activate
self.addEventListener("activate", (event) => {
    const validCaches = [SHELL_CACHE, ART_CACHE, AUDIO_CACHE, LIBRARY_CACHE];
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((key) => !validCaches.includes(key)).map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // App shell — cache-first
    if (SHELL_FILES.includes(url.pathname) || url.pathname === "/") {
        event.respondWith(
            caches.match(event.request).then((cached) => cached || fetch(event.request))
        );
        return;
    }

    // Library data — network-first, fall back to cache when offline
    if (url.pathname === "/library" && !url.searchParams.get("q")) {
        event.respondWith(
            fetch(event.request)
                .then((res) => {
                    const clone = res.clone();
                    caches.open(LIBRARY_CACHE).then((cache) => cache.put(event.request, clone));
                    return res;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // Album art — cache-first, cache automatically (small files)
    if (url.pathname.startsWith("/art/")) {
        event.respondWith(
            caches.open(ART_CACHE).then(async (cache) => {
                const cached = await cache.match(event.request);
                if (cached) return cached;

                const res = await fetch(event.request);
                if (res.ok) cache.put(event.request, res.clone());
                return res;
            })
        );
        return;
    }

    // Audio streaming — only serve from cache if explicitly saved offline
    if (url.pathname.startsWith("/stream/")) {
        event.respondWith(handleStreamRequest(event.request));
        return;
    }
});

async function handleStreamRequest(request) {
    const cache = await caches.open(AUDIO_CACHE);
    // Match ignoring the Range header — we cache the full file under one key
    const cached = await cache.match(request.url);

    if (!cached) {
        // Not saved offline — go straight to network as normal
        return fetch(request);
    }

    const rangeHeader = request.headers.get("Range");
    const buffer = await cached.arrayBuffer();
    const totalLength = buffer.byteLength;

    if (!rangeHeader) {
        return new Response(buffer, {
            status: 200,
            headers: {
                "Content-Type": "audio/mpeg",
                "Content-Length": totalLength,
                "Accept-Ranges": "bytes",
            },
        });
    }

    // Parse "bytes=start-end" and slice the cached buffer to match
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : totalLength - 1;
    const slice = buffer.slice(start, end + 1);

    return new Response(slice, {
        status: 206,
        headers: {
            "Content-Type": "audio/mpeg",
            "Content-Range": `bytes ${start}-${end}/${totalLength}`,
            "Accept-Ranges": "bytes",
            "Content-Length": slice.byteLength,
        },
    });
}

// Listen for messages from the page to explicitly cache a track
self.addEventListener("message", (event) => {
    if (event.data?.type === "CACHE_TRACK") {
        const trackId = event.data.trackId;
        event.waitUntil(cacheTrackForOffline(trackId));
    }
});

async function cacheTrackForOffline(trackId) {
    const url = `/stream/${trackId}`;
    const cache = await caches.open(AUDIO_CACHE);
    const res = await fetch(url); // full request, no Range header
    if (res.ok) {
        await cache.put(url, res.clone());
    }
}

self.addEventListener("message", (event) => {
    if (event.data?.type === "CACHE_TRACK") {
        const trackId = event.data.trackId;
        event.waitUntil(
            cacheTrackForOffline(trackId).then(() => {
                event.source.postMessage({ type: "TRACK_CACHED", trackId });
            })
        );
    }
});