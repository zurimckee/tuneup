
import os
import sqlite3
import boto3
from mutagen.id3 import ID3
from datetime import datetime, timezone
import tempfile

from dotenv import load_dotenv
load_dotenv()

R2_BUCKET = os.environ["R2_BUCKET"]
INDEX_KEY = "library_index.db"
# LOCAL_DB_PATH = "/tmp/library_index.db" //uncomment after deploying to railway
LOCAL_DB_PATH = os.path.join(tempfile.gettempdir(), "library_index.db") #local testing

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["R2_ENDPOINT_URL"],
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    region_name="auto",
)


def load_index():
    temp_download_path = LOCAL_DB_PATH + ".downloading"

    try:
        if os.path.exists(temp_download_path):
            os.remove(temp_download_path)

        s3.download_file(R2_BUCKET, INDEX_KEY, temp_download_path)

        if os.path.exists(LOCAL_DB_PATH):
            os.remove(LOCAL_DB_PATH)
        os.replace(temp_download_path, LOCAL_DB_PATH)

        print("Loaded existing index from R2.")
    except s3.exceptions.ClientError:
        print("No index found in R2 — building one now.")
        rebuild_index()


    return sqlite3.connect(LOCAL_DB_PATH, check_same_thread=False)



def rebuild_index():
    """Scans the whole bucket, extracts tags with mutagen, writes a fresh
    SQLite file, and uploads it back to R2. Only call this on first run
    or when you explicitly want to re-scan (e.g. after adding new music)."""
    temp_build_path = LOCAL_DB_PATH + ".building"

    if os.path.exists(temp_build_path):
        os.remove(temp_build_path)

    

    conn = sqlite3.connect(temp_build_path)
    conn.execute("""
        CREATE TABLE tracks (
            id INTEGER PRIMARY KEY,
            r2_key TEXT UNIQUE NOT NULL,
            title TEXT,
            artist TEXT,
            album TEXT,
            genre TEXT,
            track_number INTEGER,
            duration REAL,
            filesize INTEGER,
            date_added TEXT

        )
    """)


    #for fuzzy searching
    conn.execute("""
    CREATE VIRTUAL TABLE tracks_fts USING fts5(
        title, artist, album,
        content='tracks',
        content_rowid='id'
    )
""")
    
    # Keep FTS in sync whenever tracks changes
    conn.execute("""
        CREATE TRIGGER tracks_ai AFTER INSERT ON tracks BEGIN
            INSERT INTO tracks_fts(rowid, title, artist, album)
            VALUES (new.id, new.title, new.artist, new.album);
        END
    """)
    conn.execute("""
        CREATE TRIGGER tracks_ad AFTER DELETE ON tracks BEGIN
            INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
            VALUES ('delete', old.id, old.title, old.artist, old.album);
        END
    """)
    conn.execute("""
        CREATE TRIGGER tracks_au AFTER UPDATE ON tracks BEGIN
            INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
            VALUES ('delete', old.id, old.title, old.artist, old.album);
            INSERT INTO tracks_fts(rowid, title, artist, album)
            VALUES (new.id, new.title, new.artist, new.album);
        END
    """)

    conn.execute("CREATE INDEX idx_artist ON tracks(artist)")
    conn.execute("CREATE INDEX idx_album ON tracks(album)")


    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=R2_BUCKET):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not key.lower().endswith(".mp3"):
                continue
            _index_track(conn, key, obj["Size"], obj['LastModified'])

    conn.commit()

    # Most files have no ID3 genre, so fill those in by looking up the artist
    from genres import assign_genres
    assign_genres(conn)

    conn.close()

    s3.upload_file(temp_build_path, R2_BUCKET, INDEX_KEY)

    if os.path.exists(LOCAL_DB_PATH):
        os.remove(LOCAL_DB_PATH)
    os.replace(temp_build_path, LOCAL_DB_PATH)

    print("Index rebuilt and uploaded to R2.")



BITRATE_BPS = 320_000  # matches your ffmpeg -b:a 320k conversion setting

def _get_id3_tag_size(key):
    """Reads just the 10-byte ID3v2 header to determine the actual tag size,
    so we know exactly how many bytes to fetch — handles large embedded art."""
    header_obj = s3.get_object(Bucket=R2_BUCKET, Key=key, Range="bytes=0-9")
    header = header_obj["Body"].read()

    if header[:3] != b"ID3":
        return 262144  # not a valid ID3v2 header — fall back to default guess

    # ID3v2 size is stored as a 4-byte "synchsafe" integer (7 bits used per byte)
    size_bytes = header[6:10]
    tag_size = (
        (size_bytes[0] << 21) | (size_bytes[1] << 14) |
        (size_bytes[2] << 7) | size_bytes[3]
    )
    return tag_size + 10  # +10 for the header itself

def _index_track(conn, key, filesize, last_modified):
    """Fetches just the first chunk of the file to read ID3 tags,
    instead of downloading the entire track. """
    tmp_path = os.path.join(tempfile.gettempdir(), "_tag_scan.mp3")
    tag_size = _get_id3_tag_size(key)
    range_end = min(tag_size, filesize - 1)


    obj = s3.get_object(Bucket=R2_BUCKET, Key=key, Range=f"bytes=0-{range_end}")
    with open(tmp_path, "wb") as f:
        f.write(obj["Body"].read())


    '''range_end = min(262143, filesize - 1)
    obj = s3.get_object(
        Bucket=R2_BUCKET, Key=key,
        Range=f"bytes=0-{range_end}"
    )'''

    try:
        tags = ID3(tmp_path)
        title = str(tags.get("TIT2", key.split("/")[-1]))
        artist = str(tags.get("TPE1", "Unknown Artist"))
        album = str(tags.get("TALB", "Unknown Album"))
        track_number = str(tags.get("TRCK", "0")).split("/")[0]
        tcon = tags.get("TCON")
        genre = tcon.genres[0].strip() if tcon and tcon.genres else "Unknown Genre"
    except Exception as e:
        print(f"Failed to read tags for {key}: {type(e).__name__}: {e}")
        title, artist, album, track_number, genre = key, "Unknown", "Unknown", 0, "Unknown Genre"

    # Estimate duration from filesize and known constant bitrate.
    # duration (seconds) = (filesize in bits) / (bitrate in bits per second)
    duration = (filesize * 8) / BITRATE_BPS

    conn.execute(
        """INSERT OR REPLACE INTO tracks
           (r2_key, title, artist, album, genre, track_number, duration, filesize, date_added)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (key, title, artist, album, genre,int(track_number or 0), duration, filesize,
         last_modified.isoformat())
    )

    os.remove(tmp_path)

if __name__ == "__main__":
    rebuild_index()
    print("Done.")