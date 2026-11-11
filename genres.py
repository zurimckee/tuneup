"""Fills in track genres by looking up each artist online, since most of the
MP3s in the bucket have no ID3 genre tag.

- Provider: Last.fm if LASTFM_API_KEY is set (better genre tags, faster),
  otherwise MusicBrainz (no key needed, limited to ~1 request/second).
- Raw tags per artist are cached in R2 (artist_genres.json) so each artist is
  only ever looked up once, even across full rebuilds.
- genre_overrides.json (in this repo) lets you hand-fix any artist.
- Raw tags are collapsed into a small set of broad genres via GENRE_BUCKETS.

Backfill the current index without rescanning every MP3:
    python genres.py                 # look up, update index, upload to R2
    python genres.py --dry-run       # look up and print results, upload nothing
    python genres.py --dry-run --limit 20
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from library import s3, R2_BUCKET, LOCAL_DB_PATH, INDEX_KEY

CACHE_KEY = "artist_genres.json"
LOCAL_CACHE_PATH = LOCAL_DB_PATH + ".artist_genres.json"
OVERRIDES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "genre_overrides.json")
UNKNOWN = "Unknown Genre"
USER_AGENT = "TuneupLibrary/1.0 ( https://github.com )"
LASTFM_API_KEY = os.environ.get("LASTFM_API_KEY")

# Checked in order for each tag; the first bucket with a keyword contained in
# the tag wins. Order matters: "neo soul" must hit R&B before Soul & Funk,
# "dubstep" must hit Electronic before Reggae's "dub", etc.
GENRE_BUCKETS = [
    ("Hip-Hop", ["hip hop", "hip-hop", "hiphop", "rap", "trap", "drill", "grime",
                 "boom bap", "crunk", "horrorcore", "plugg"]),
    ("R&B", ["r&b", "rnb", "rhythm and blues", "neo soul", "neo-soul",
             "new jack swing", "quiet storm"]),
    ("Gospel", ["gospel", "christian", "worship"]),
    ("Jazz", ["jazz", "bebop", "bossa nova", "swing"]),
    ("Afrobeats", ["afrobeat", "afropop", "afro pop", "amapiano", "afroswing"]),
    ("Latin", ["latin", "reggaeton", "salsa", "bachata", "cumbia"]),
    ("Electronic", ["electronic", "house", "techno", "edm", "uk garage",
                    "drum and bass", "jungle", "dubstep", "ambient", "trance",
                    "lo-fi", "lofi", "chillhop", "chillwave"]),
    ("Reggae", ["reggae", "dancehall", "dub", "ska", "rocksteady"]),
    ("Soul & Funk", ["soul", "funk", "motown", "disco"]),
    ("Rock", ["rock", "metal", "punk", "grunge", "emo"]),
    ("Indie & Alt", ["indie", "alternative", "bedroom pop", "shoegaze",
                     "dream pop", "psychedelic"]),
    ("Country & Folk", ["country", "folk", "americana", "bluegrass"]),
    ("Classical", ["classical", "orchestral", "soundtrack", "score"]),
    ("Pop", ["pop"]),
]


def bucket_for_tags(tags):
    """tags: list of tag names, most relevant first."""
    for tag in tags:
        t = tag.lower()
        for bucket, keywords in GENRE_BUCKETS:
            if any(k in t for k in keywords):
                return bucket
    return UNKNOWN


def artist_candidates(artist):
    """Full credit first, then the primary artist of a multi-artist credit.
    Full first so names with commas ("Tyler, The Creator") still work."""
    artist = (artist or "").strip()
    cands = [artist]
    primary = re.split(r"\s*/\s*|\s+(?:feat\.?|ft\.?|featuring|x)\s+", artist, flags=re.I)[0]
    cands.append(primary)
    cands.append(primary.split(", ")[0])
    seen, out = set(), []
    for c in cands:
        c = c.strip()
        if c and c.lower() not in seen:
            seen.add(c.lower())
            out.append(c)
    return out


# ---------------------------------------------------------------- HTTP helpers

_last_request = [0.0]

def _get_json(url, min_interval):
    for attempt in range(4):
        wait = min_interval - (time.time() - _last_request[0])
        if wait > 0:
            time.sleep(wait)
        _last_request[0] = time.time()
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 3:
                time.sleep(2 * (attempt + 1))
                continue
            raise
        except urllib.error.URLError:
            if attempt < 3:
                time.sleep(2 * (attempt + 1))
                continue
            raise


def _lucene(s):
    return re.sub(r'["\\]', "", s)


def _clean_title(title):
    # "Song (feat. X) - Remix" -> "Song"
    return re.split(r"\s*[\(\[]|\s+-\s+", title or "")[0].strip()


# ---------------------------------------------------------------- providers

def _lastfm_tags(name, _titles):
    q = urllib.parse.urlencode({"method": "artist.gettoptags", "artist": name,
                                "api_key": LASTFM_API_KEY, "format": "json",
                                "autocorrect": 1})
    try:
        data = _get_json(f"https://ws.audioscrobbler.com/2.0/?{q}", 0.25)
    except urllib.error.HTTPError as e:
        if e.code in (400, 404):
            return []
        raise
    tags = data.get("toptags", {}).get("tag", []) if isinstance(data, dict) else []
    return [t["name"] for t in tags[:15]]


def _mb_artist_id(name, titles):
    """Find the right MusicBrainz artist. Matching on one of their song titles
    avoids same-name mixups (e.g. Steve Lacy the guitarist vs. the jazz
    saxophonist)."""
    for title in titles[:2]:
        t = _clean_title(title)
        if not t:
            continue
        q = urllib.parse.urlencode({
            "query": f'recording:"{_lucene(t)}" AND artist:"{_lucene(name)}"',
            "fmt": "json", "limit": 5})
        data = _get_json(f"https://musicbrainz.org/ws/2/recording/?{q}", 1.1)
        for rec in data.get("recordings", []):
            for credit in rec.get("artist-credit", []):
                a = credit.get("artist", {}) if isinstance(credit, dict) else {}
                if a.get("name", "").lower() == name.lower():
                    return a["id"]
    # Fall back to plain name search (only trust an exact name match)
    q = urllib.parse.urlencode({"query": f'artist:"{_lucene(name)}"', "fmt": "json", "limit": 1})
    data = _get_json(f"https://musicbrainz.org/ws/2/artist/?{q}", 1.1)
    for a in data.get("artists", []):
        if a.get("name", "").lower() == name.lower():
            return a["id"]
    return None


def _musicbrainz_tags(name, titles):
    artist_id = _mb_artist_id(name, titles)
    if not artist_id:
        return []
    data = _get_json(f"https://musicbrainz.org/ws/2/artist/{artist_id}?inc=genres+tags&fmt=json", 1.1)
    # Prefer curated genres; fall back to free-form tags
    items = data.get("genres") or data.get("tags") or []
    items = sorted(items, key=lambda t: -t.get("count", 0))
    return [t["name"] for t in items]


def lookup_tags(artist, titles):
    """Returns raw tags for the first candidate name that has any."""
    fetch = _lastfm_tags if LASTFM_API_KEY else _musicbrainz_tags
    for name in artist_candidates(artist):
        tags = fetch(name, titles)
        if tags:
            return tags
    return []


# ---------------------------------------------------------------- cache

def _load_cache():
    cache = {}
    try:
        obj = s3.get_object(Bucket=R2_BUCKET, Key=CACHE_KEY)
        cache = json.loads(obj["Body"].read())
    except s3.exceptions.ClientError:
        pass
    # A local cache may hold progress from an interrupted run
    if os.path.exists(LOCAL_CACHE_PATH):
        with open(LOCAL_CACHE_PATH) as f:
            cache.update(json.load(f))
    return cache


def _save_local_cache(cache):
    with open(LOCAL_CACHE_PATH, "w") as f:
        json.dump(cache, f)


def _upload_cache(cache):
    s3.put_object(Bucket=R2_BUCKET, Key=CACHE_KEY,
                  Body=json.dumps(cache, indent=1, sort_keys=True).encode(),
                  ContentType="application/json")


def _load_overrides():
    if not os.path.exists(OVERRIDES_PATH):
        return {}
    with open(OVERRIDES_PATH) as f:
        return {k.lower(): v for k, v in json.load(f).items()}


# ---------------------------------------------------------------- main entry

def assign_genres(conn, limit=None, upload_cache=True):
    """Sets tracks.genre for every track that has no ID3 genre, using
    overrides first, then (cached) online lookups by artist."""
    overrides = _load_overrides()
    cache = _load_cache()

    rows = conn.execute(
        "SELECT artist, title FROM tracks "
        "WHERE genre IS NULL OR genre = ? ORDER BY artist", (UNKNOWN,)
    ).fetchall()
    titles_by_artist = {}
    for artist, title in rows:
        titles_by_artist.setdefault(artist, []).append(title)

    artists = [a for a in titles_by_artist
               if a and not a.lower().startswith("unknown")]
    todo = [a for a in artists
            if a not in cache and not any(c.lower() in overrides for c in artist_candidates(a))]
    if limit is not None:
        todo = todo[:limit]

    provider = "Last.fm" if LASTFM_API_KEY else "MusicBrainz"
    print(f"{len(artists)} artists need a genre; {len(todo)} not cached, looking up via {provider}...")
    for i, artist in enumerate(todo, 1):
        try:
            tags = lookup_tags(artist, titles_by_artist[artist])
        except Exception as e:
            print(f"  [{i}/{len(todo)}] {artist}: lookup failed ({e}); will retry next run")
            continue
        cache[artist] = tags
        print(f"  [{i}/{len(todo)}] {artist}: {bucket_for_tags(tags)}  {tags[:4]}")
        if i % 10 == 0:
            _save_local_cache(cache)
    _save_local_cache(cache)
    if upload_cache:
        _upload_cache(cache)

    updated = 0
    for artist in artists:
        genre = next((overrides[c.lower()] for c in artist_candidates(artist)
                      if c.lower() in overrides), None)
        if genre is None:
            genre = bucket_for_tags(cache.get(artist, []))
        if genre != UNKNOWN:
            cur = conn.execute(
                "UPDATE tracks SET genre = ? WHERE artist = ? AND (genre IS NULL OR genre = ?)",
                (genre, artist, UNKNOWN))
            updated += cur.rowcount
    conn.commit()
    print(f"Assigned genres to {updated} tracks.")
    return updated


if __name__ == "__main__":
    import sqlite3
    from library import load_index

    dry_run = "--dry-run" in sys.argv
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    conn = load_index()
    if dry_run:
        # Work on a throwaway copy so neither the index nor R2 is touched
        mem = sqlite3.connect(":memory:")
        conn.backup(mem)
        conn.close()
        conn = mem
    if "--reassign" in sys.argv:
        # Re-sort every track using the current GENRE_BUCKETS (uses cached tags, no new lookups)
        conn.execute("UPDATE tracks SET genre = ?", (UNKNOWN,))

    assign_genres(conn, limit=limit, upload_cache=not dry_run)

    for genre, count in conn.execute(
            "SELECT genre, COUNT(*) FROM tracks GROUP BY genre ORDER BY 2 DESC"):
        print(f"{count:5d}  {genre}")

    if not dry_run:
        conn.close()
        s3.upload_file(LOCAL_DB_PATH, R2_BUCKET, INDEX_KEY)
        print("Updated index uploaded to R2.")
