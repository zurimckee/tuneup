let now_player = document.querySelector(".now-playing")
let track_art = document.querySelector(".track-art")
let track_name = document.querySelector(".track-name")
let track_artist = document.querySelector(".track-artist")

let playpause_btn = document.querySelector(".playpause-track")
let next_btn = document.querySelector(".next-track")
let prev_btn = document.querySelector(".prev-track")

let seek_slider = document.querySelector(".seek-slider")
let curr_time = document.querySelector(".current-time")
let total_duration = document.querySelector(".total-duration")

let search_input = document.querySelector(".search-input");
let search_results_view = document.querySelector(".search-results");
let results_list = document.querySelector(".results-list");
let player_view = document.querySelector(".player");
let sidebar_list = document.querySelector(".sidebar-list");

let queue_list = document.querySelector(".queue-list");
let queue_list_inner = document.querySelector(".queue-list-inner");

let isShuffled = false;
let shuffle_order = [];      // array of indices into track_list, in shuffled order
let shuffle_position = 0;    // where we are within shuffle_order

let shuffle_btn = document.querySelector(".shuffle-track");

let track_index = 0;
let isPlaying = false;
let updateTimer;

let curr_track = document.createElement('audio')

let track_list = [];
let full_library = [];
let library_tracks = [];
let manual_queue = [];

const STORAGE_KEY = "tuneup_state";


function savePlayerState() {
    const state = {
        track_index: track_index,
        currentTime: curr_track.currentTime,
        isShuffled: isShuffled,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadPlayerState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch (e) {
        console.warn("Corrupt player state in localStorage, ignoring:", e);
        return null;
    }
}

function toggleSidebar() {
    document.querySelector(".sidebar").classList.toggle("open");
    document.querySelector(".sidebar-toggle").classList.toggle("open");
}

async function renderSidebar() {
    sidebar_list.innerHTML = "";

    // --- Downloads section ---
    const downloadedTracks = await getDownloadedTracks();

    const downloadsHeader = document.createElement("li");
    downloadsHeader.className = "sidebar-album-header";
    downloadsHeader.innerHTML = `<span class="album-arrow">▶</span> downloads <span class="album-count">(${downloadedTracks.length})</span>`;

    const downloadsGroup = document.createElement("li");
    downloadsGroup.className = "sidebar-album-tracks collapsed";

    const downloadsInner = document.createElement("ul");
    downloadsInner.className = "sidebar-album-tracks-inner";

    if (downloadedTracks.length === 0) {
        const empty = document.createElement("li");
        empty.className = "sidebar-item no-downloads";
        empty.innerHTML = `<span class="sidebar-title">no downloads yet</span>`;
        downloadsInner.appendChild(empty);
    } else {
        downloadedTracks.forEach(track => {
            const li = document.createElement("li");
            li.className = "sidebar-item";
            li.innerHTML = `<span class="sidebar-title">${track.title}</span><span class="sidebar-artist">${track.artist}</span>`;
            li.onclick = () => {
                track_list = full_library;
                track_index = track.originalIndex;
                loadTrack(track_index);
                playTrack();
            };
            downloadsInner.appendChild(li);
        });
    }

    downloadsGroup.appendChild(downloadsInner);

    downloadsHeader.onclick = () => {
        downloadsGroup.classList.toggle("collapsed");
        const arrow = downloadsHeader.querySelector(".album-arrow");
        arrow.textContent = downloadsGroup.classList.contains("collapsed") ? "▶" : "▼";
    };

    sidebar_list.appendChild(downloadsHeader);
    sidebar_list.appendChild(downloadsGroup);

    const folders = {};
    library_tracks.forEach((track, i) => {
        // r2_key looks like "Ctrl/Anything - SZA.mp3" — grab everything before the last "/"
        const parts = track.r2_key.split("/");
        const folderName = parts.length > 1 ? parts[0] : "Uncategorized";

        if (!folders[folderName]) folders[folderName] = [];
        folders[folderName].push({ ...track, originalIndex: i });
    });

    Object.keys(folders).sort().forEach(folderName => {
        const folderTracks = folders[folderName];

        const folderHeader = document.createElement("li");
        folderHeader.className = "sidebar-album-header";
        folderHeader.innerHTML = `<span class="album-arrow">▶</span> ${folderName} <span class="album-count">(${folderTracks.length})</span>`;

        // Outer grid wrapper — this is what animates open/closed
        const folderGroup = document.createElement("li");
        folderGroup.className = "sidebar-album-tracks collapsed";

        // Inner wrapper — required for the grid-row trick to work;
        // this is what actually gets clipped via overflow: hidden
        const innerWrapper = document.createElement("ul");
        innerWrapper.className = "sidebar-album-tracks-inner";

        folderTracks.forEach(track => {
            const li = document.createElement("li");
            li.className = "sidebar-item";
            li.innerHTML = `
                <span class="sidebar-info">
                    <span class="sidebar-title">${track.title}</span>
                    <span class="sidebar-artist">${track.artist}</span>
                </span>
                <button class="add-queue-btn" title="add to queue">+</button>
            `;
            li.onclick = () => {
                track_list = folderTracks;
                track_index = folderTracks.findIndex(t => t.id === track.id);
                loadTrack(track_index);
                playTrack();
            };
            li.querySelector(".add-queue-btn").onclick = (e) => addToQueue(track, e);
            innerWrapper.appendChild(li);
        });
        
        folderGroup.appendChild(innerWrapper);

        folderHeader.onclick = () => {
            folderGroup.classList.toggle("collapsed");
            const arrow = folderHeader.querySelector(".album-arrow");
            arrow.textContent = folderGroup.classList.contains("collapsed") ? "▶" : "▼";
        };

        sidebar_list.appendChild(folderHeader);
        sidebar_list.appendChild(folderGroup);
    });
}

search_input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        const query = search_input.value.trim();
        if (query) searchLibrary(query);
    }
});

async function searchLibrary(query) {
    const res = await fetch(`/library?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    const results = data.results;

    results_list.innerHTML = "";

    if (results.length === 0) {
        results_list.innerHTML = `<li class="no-results">no results for "${query}"</li>`;
    } else {
        results.forEach((track, i) => {
            const li = document.createElement("li");
            li.className = "result-item";
            li.innerHTML = `
                <span class="result-info">
                    <span class="result-title">${track.title}</span> — <span class="result-artist">${track.artist}</span>
                </span>
                <button class="add-queue-btn" title="add to queue">+</button>
            `;
            li.onclick = () => playFromResults(results, i);
            li.querySelector(".add-queue-btn").onclick = (e) => addToQueue(track, e);
            results_list.appendChild(li);
        });
    }

    showSearchResults();
}

function playFromResults(results, index) {
    track_list = results;
    track_index = index;
    loadTrack(track_index);
    playTrack();
    closeSearchResults();
}

function showSearchResults() {
    search_results_view.style.display = "block";
    player_view.style.display = "none";
}

function closeSearchResults() {
    search_results_view.style.display = "none";
    player_view.style.display = "flex";
}

async function fetchLibrary() {
    track_list = [];
    let offset = 0;
    const pageSize = 500;

    while (true) {
        const res = await fetch(`/library?limit=${pageSize}&offset=${offset}`);
        const data = await res.json();
        track_list = track_list.concat(data.results);

        if (data.results.length < pageSize) break; // last page
        offset += pageSize;
    }

    library_tracks = track_list;

    if (track_list.length > 0) {
        const saved = loadPlayerState();

        if (saved && saved.track_index < track_list.length) {
            track_index = saved.track_index;
            isShuffled = saved.isShuffled || false;
            shuffle_btn.classList.toggle("active", isShuffled);
        }

        loadTrack(track_index);
        await renderSidebar();

        if (saved) {
            // Restore seek position once metadata is available
            curr_track.addEventListener("loadedmetadata", () => {
                if (saved.currentTime) {
                    curr_track.currentTime = saved.currentTime;
                    seek_slider.value = Math.floor(saved.currentTime);
                    curr_time.textContent = formatTime(saved.currentTime);
                }
            }, { once: true });
        }

    }
}

function loadTrack(track_index){
    clearInterval(updateTimer);
    resetValues();

    const track = track_list[track_index]
    if (!track) return;

    curr_track.src = `/stream/${track.id}`;
    curr_track.load()

    track_art.style.backgroundImage = `url('/art/${track.id}')`;

    track_name.textContent = track.title;
    track_artist.textContent = track.artist;
    now_player.textContent = `playing ${track_index + 1} of ${track_list.length}`;

    updateMediaSession(track); 

    updateTimer = setInterval(seekUpdate, 1000);

    curr_track.addEventListener("loadedmetadata", () => {
        total_duration.textContent = formatTime(curr_track.duration);
        seek_slider.max = Math.floor(curr_track.duration)
    });

    curr_track.onended = nextTrack;
    updateOfflineIcon(track.id);  
    renderQueue();
}

function toggleShuffle() {
    isShuffled = !isShuffled;
    shuffle_btn.classList.toggle("active", isShuffled);

    if (isShuffled) {
        buildShuffleOrder();
    }
    savePlayerState();
    renderQueue();
}

function buildShuffleOrder() {
    // Fisher-Yates shuffle of all indices in track_list
    shuffle_order = track_list.map((_, i) => i);
    for (let i = shuffle_order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffle_order[i], shuffle_order[j]] = [shuffle_order[j], shuffle_order[i]];
    }

    // Put the currently-playing track first, so toggling shuffle
    // mid-song doesn't jump you somewhere else immediately
    const currentPos = shuffle_order.indexOf(track_index);
    if (currentPos > -1) {
        shuffle_order.splice(currentPos, 1);
        shuffle_order.unshift(track_index);
    }

    shuffle_position = 0;
}

function nextTrack() {
    if (manual_queue.length > 0) {
        const queuedTrack = manual_queue.shift();
        loadQueuedTrack(queuedTrack);
        playTrack();
        return;
    }
    if (isShuffled) {
        shuffle_position++;
        if (shuffle_position >= shuffle_order.length) {
            // Reached the end of this shuffled pass — generate a fresh one
            buildShuffleOrder();
        } else {
            track_index = shuffle_order[shuffle_position];
        }
    } else {
        track_index = (track_index + 1) % track_list.length;
    }
    loadTrack(track_index);
    playTrack();
    savePlayerState();
}

function prevTrack() {
    if (isShuffled) {
        shuffle_position = (shuffle_position - 1 + shuffle_order.length) % shuffle_order.length;
        track_index = shuffle_order[shuffle_position];
    } else {
        track_index = (track_index - 1 + track_list.length) % track_list.length;
    }
    loadTrack(track_index);
    playTrack();
}

function resetValues() {
    curr_time.textContent = "00:00";
    total_duration.textContent = "00:00";
    seek_slider.value = 0;
}

function playpauseTrack() {
    isPlaying ? pauseTrack() : playTrack();
}

function playTrack() {
    curr_track.play();
    isPlaying = true;
    playpause_btn.innerHTML = '<i class="fa fa-pause-circle fa-5x"></i>';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = "playing";
}

function pauseTrack() {
    curr_track.pause();
    isPlaying = false;
    playpause_btn.innerHTML = '<i class="fa fa-play-circle fa-5x"></i>';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = "paused";
}

function seekTo() {
    curr_track.currentTime = seek_slider.value;
    savePlayerState();
}

function seekUpdate() {
    seek_slider.value = Math.floor(curr_track.currentTime);
    curr_time.textContent = formatTime(curr_track.currentTime);
    savePlayerState();
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}


function updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: [
            { src: `/art/${track.id}`, sizes: '512x512', type: 'image/jpeg' }
        ]
    });
    navigator.mediaSession.setActionHandler('play', () => playTrack());
    navigator.mediaSession.setActionHandler('pause', () => pauseTrack());
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined) {
            curr_track.currentTime = details.seekTime;
            savePlayerState();
        }
    });
}


if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch((err) => {
            console.warn("Service worker registration failed:", err);
        });
    });
}

function saveTrackOffline(trackId) {
    if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
            type: "CACHE_TRACK",
            trackId: trackId,
        });
    }
}

async function isTrackCached(trackId) {
    const cache = await caches.open("tuneup-audio-v1");
    const match = await cache.match(`/stream/${trackId}`);
    return !!match;
}

async function toggleOfflineForCurrentTrack() {
    const track = track_list[track_index];
    if (!track) return;

    const cached = await isTrackCached(track.id);

    if (cached) {
        const cache = await caches.open("tuneup-audio-v1");
        await cache.delete(`/stream/${track.id}`);
        showToast(`Removed "${track.title}" from downloads`);
    } else {
        saveTrackOffline(track.id);
        showToast(`Downloading "${track.title}"...`);
    }

    updateOfflineIcon(track.id);
    await renderSidebar();
}

async function updateOfflineIcon(trackId) {
    const cached = await isTrackCached(trackId);
    const icon = document.querySelector(".save-offline i");
    icon.className = cached ? "fa fa-check-circle" : "fa fa-download";
}

function showToast(message) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add("show"), 10);
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "TRACK_CACHED") {
            showToast("saved for offline listening");
            updateOfflineIcon(event.data.trackId);
        }
    });
}


async function getDownloadedTracks() {
    const cache = await caches.open("tuneup-audio-v1");
    const requests = await cache.keys();

    // requests are full URLs like ".../stream/42" — extract the track id from each
    const cachedIds = requests.map(req => {
        const match = req.url.match(/\/stream\/(\d+)/);
        return match ? parseInt(match[1], 10) : null;
    }).filter(id => id !== null);

    // Match cached ids back to full track objects (with metadata) from track_list
    return track_list
        .map((track, i) => ({ ...track, originalIndex: i }))
        .filter(track => cachedIds.includes(track.id));
}

function toggleQueue() {
    queue_list.classList.toggle("collapsed");
    const arrow = document.querySelector(".queue-arrow");
    arrow.textContent = queue_list.classList.contains("collapsed") ? "▶" : "▼";
}

function getUpcomingTracks(count) {
    const upcoming = [];
    if (isShuffled && shuffle_order.length > 0) {
        for (let i = 1; i <= count; i++) {
            const pos = (shuffle_position + i) % shuffle_order.length;
            const idx = shuffle_order[pos];
            upcoming.push({ track: track_list[idx], index: idx });
        }
    } else {
        for (let i = 1; i <= count; i++) {
            const idx = (track_index + i) % track_list.length;
            upcoming.push({ track: track_list[idx], index: idx });
        }
    }
    return upcoming;
}

function renderQueue() {
    queue_list_inner.innerHTML = "";

    if (manual_queue.length === 0 && (!track_list || track_list.length <= 1)) {
        queue_list_inner.innerHTML = '<li class="queue-empty">no upcoming tracks</li>';
        return;
    }

    manual_queue.forEach((track, i) => {
        const li = document.createElement("li");
        li.className = "queue-item queued";
        li.innerHTML = `
            <span class="queue-item-info">
                <span class="queue-item-title">${track.title}</span>
                <span class="queue-item-artist">${track.artist}</span>
            </span>
            <button class="queue-remove-btn" title="remove from queue">&times;</button>
        `;
        li.querySelector(".queue-remove-btn").onclick = (e) => removeFromQueue(i, e);
        queue_list_inner.appendChild(li);
    });

    const remainingSlots = 5 - manual_queue.length;
    if (remainingSlots > 0 && track_list && track_list.length > 1) {
        getUpcomingTracks(remainingSlots).forEach(({ track, index }) => {
            if (!track) return;
            if (now_player.textContent === "playing from queue" && track.id === curr_track.src.split('/').pop()) {
                return;
            }
            const li = document.createElement("li");
            li.className = "queue-item";
            li.innerHTML = `<span class="queue-item-title">${track.title}</span><span class="queue-item-artist">${track.artist}</span>`;
            li.onclick = () => {
                if (isShuffled) shuffle_position = shuffle_order.indexOf(index);
                track_index = index;
                loadTrack(track_index);
                playTrack();
            };
            queue_list_inner.appendChild(li);
        });
    }
}
function addToQueue(track, event) {
    if (event) event.stopPropagation(); // don't trigger the row's own onclick (which plays immediately)
    manual_queue.push(track);
    renderQueue();
}

function removeFromQueue(index, event) {
    if (event) event.stopPropagation();
    manual_queue.splice(index, 1);
    renderQueue();
}

function loadQueuedTrack(track) {
    clearInterval(updateTimer);
    resetValues();

    track_index = track_list.findIndex(t => t.id === track.id);

    if (track_index === -1) {
        // Fallback: just use the track object as-is and set a dummy index
        track_index = 0;
    }

    curr_track.src = `/stream/${track.id}`;
    curr_track.load();

    track_art.style.backgroundImage = `url('/art/${track.id}')`;
    track_name.textContent = track.title;
    track_artist.textContent = track.artist;
    now_player.textContent = "playing from queue";

    updateTimer = setInterval(seekUpdate, 1000);

    curr_track.loadedmetadata = () => {
        total_duration.textContent = formatTime(curr_track.duration);
        seek_slider.max = Math.floor(curr_track.duration);
    };

    curr_track.onended = nextTrack;
    renderQueue();
}


// Kick things off once the page loads
document.addEventListener("DOMContentLoaded", fetchLibrary);