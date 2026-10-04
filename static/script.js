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
let favorite_btn = document.querySelector(".favorite-track");


let track_index = 0;
let isPlaying = false;
let updateTimer;
let current_track = null;

let curr_track = document.createElement('audio')
curr_track.addEventListener("ended", nextTrack);
curr_track.addEventListener("loadedmetadata", () => {
    total_duration.textContent = formatTime(curr_track.duration);
    seek_slider.max = Math.floor(curr_track.duration);
});

const openFolders = new Set();  // remembers which sidebar folders are open
const FAVORITES_KEY = "tuneup_favorites";
let favorites = new Set(loadFavorites());

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
        r2_key: current_track?.r2_key,
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

function renderSidebar() {
    sidebar_list.innerHTML = "";

    // Favorites folder always goes first
    const favTracks = library_tracks.filter(t => favorites.has(t.r2_key));
    addSidebarFolder("favorites", favTracks, favTracks);

    const folders = {};
    library_tracks.forEach(track => {
        const parts = track.r2_key.split("/");
        const folderName = parts.length > 1 ? parts[0] : "uncategorized";
        (folders[folderName] ||= []).push(track);
    });

    Object.keys(folders).sort().forEach(name => {
        addSidebarFolder(name, folders[name], library_tracks);
    });
}

function addSidebarFolder(folderName, folderTracks, queue) {
    const isOpen = openFolders.has(folderName);

    const header = document.createElement("li");
    header.className = "sidebar-album-header";
    header.innerHTML = `<span class="album-arrow">${isOpen ? "▼" : "▶"}</span> ${folderName} <span class="album-count">(${folderTracks.length})</span>`;

    const group = document.createElement("li");
    group.className = "sidebar-album-tracks" + (isOpen ? "" : " collapsed");

    const inner = document.createElement("ul");
    inner.className = "sidebar-album-tracks-inner";

    if (folderTracks.length === 0) {
        const empty = document.createElement("li");
        empty.className = "sidebar-empty";
        empty.textContent = "nothing here yet";
        inner.appendChild(empty);
    }

    folderTracks.forEach(track => {
        const li = document.createElement("li");
        li.className = "sidebar-item";
        li.innerHTML = `<span class="sidebar-title">${track.title}</span><span class="sidebar-artist">${track.artist}</span>`;
        li.onclick = () => playFromList(queue, queue.indexOf(track));
        inner.appendChild(li);
    });

    group.appendChild(inner);

    header.onclick = () => {
        const nowCollapsed = group.classList.toggle("collapsed");
        header.querySelector(".album-arrow").textContent = nowCollapsed ? "▶" : "▼";
        if (nowCollapsed) openFolders.delete(folderName);
        else openFolders.add(folderName);
    };

    sidebar_list.appendChild(header);
    sidebar_list.appendChild(group);
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
    playFromList(results, index);
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

async function fetchAllTracks() {
    const pageSize = 500;
    let all = [];
    let offset = 0;

    while (true) {
        const res = await fetch(`/library?limit=${pageSize}&offset=${offset}`);
        const data = await res.json();
        all = all.concat(data.results);
        if (data.results.length < pageSize) break;
        offset += pageSize;
    }
    return all;
}

async function fetchLibrary() {

    library_tracks = await fetchAllTracks();
    track_list = library_tracks;

    if (library_tracks.length === 0) return;

    const saved = loadPlayerState();

    if (saved) {
        const idx = saved.r2_key
            ? library_tracks.findIndex(t => t.r2_key === saved.r2_key)
            : saved.track_index;

        if (idx >= 0 && idx < library_tracks.length) {
            track_index = idx;
            isShuffled = saved.isShuffled || false;
            shuffle_btn.classList.toggle("active", isShuffled);
            if (isShuffled) buildShuffleOrder();
        }
    }

    loadTrack(track_index);
    renderSidebar();

    if (saved) {
        // Restore volume and seek position once metadata is available
        curr_track.addEventListener("loadedmetadata", () => {

            if (saved.currentTime) {
                curr_track.currentTime = saved.currentTime;
                seek_slider.value = Math.floor(saved.currentTime);
                curr_time.textContent = formatTime(saved.currentTime);
            }
        }, { once: true });
    }

}

function loadTrack(index) {
    clearInterval(updateTimer);
    resetValues();

    const track = track_list[index];
    if (!track) return;

    current_track = track;

    curr_track.src = `/stream/${track.id}`;
    curr_track.load();

    track_art.style.backgroundImage = `url('/art/${track.id}')`;
    track_name.textContent = track.title;
    track_artist.textContent = track.artist;
    now_player.textContent = `playing ${index + 1} of ${track_list.length}`;

    updateMediaSession(track);
    updateFavoriteButton();

    updateTimer = setInterval(seekUpdate, 1000);
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
        loadQueuedTrack(manual_queue.shift());  // also updates media session
        playTrack();
        savePlayerState();
        return;
    }

    if (isShuffled) {
        shuffle_position++;
        if (shuffle_position >= shuffle_order.length) {
            // End of this pass: reshuffle. The current track is placed first,
            // so the next song is at position 1 (or 0 if it's the only track).
            buildShuffleOrder();
            shuffle_position = shuffle_order.length > 1 ? 1 : 0;
        }
        track_index = shuffle_order[shuffle_position];
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
}

function setupMediaSessionHandlers(){
    if (!("mediaSession" in navigator)) return;
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
        queue_list_inner.innerHTML = '<li class="queue-empty">no tracks in queue</li>';
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
            if (now_player.textContent === "playing from queue" && String(track.id) === curr_track.src.split('/').pop()) {
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

    current_track = track;

    const idx = track_list.findIndex(t => t.id === track.id);
    if (idx !== -1) {
        track_index = idx;
        if (isShuffled) shuffle_position = shuffle_order.indexOf(idx);
    }

    curr_track.src = `/stream/${track.id}`;
    curr_track.load();

    track_art.style.backgroundImage = `url('/art/${track.id}')`;
    track_name.textContent = track.title;
    track_artist.textContent = track.artist;
    now_player.textContent = "playing from queue";

    updateMediaSession(track);
    updateFavoriteButton();

    updateTimer = setInterval(seekUpdate, 1000);
    renderQueue();
}

function loadFavorites() {
    try {
        return JSON.parse(localStorage.getItem(FAVORITES_KEY)) || [];
    } catch (e) {
        return [];
    }
}

function saveFavorites() {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
}

function toggleFavorite() {
    const track = current_track;
    if (!track) return;

    if (favorites.has(track.r2_key)) favorites.delete(track.r2_key);
    else favorites.add(track.r2_key);

    saveFavorites();
    updateFavoriteButton();
    renderSidebar();
}

function updateFavoriteButton() {
    const fav = !!current_track && favorites.has(current_track.r2_key);
    favorite_btn.classList.toggle("active", fav);
    favorite_btn.innerHTML = `<i class="${fav ? "fas" : "far"} fa-heart"></i>`;
}

// Plays `index` within `list`, making `list` the active queue
function playFromList(list, index) {
    track_list = list;
    track_index = index;
    if (isShuffled) buildShuffleOrder();
    loadTrack(track_index);
    playTrack();
    savePlayerState();
}


// Kick things off once the page loads
document.addEventListener("DOMContentLoaded", () => {
    setupMediaSessionHandlers();
    fetchLibrary();
});