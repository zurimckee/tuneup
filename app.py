from flask import Flask, request, jsonify, Response, stream_with_context, render_template, send_from_directory
import os
from dotenv import load_dotenv
load_dotenv()
from library import load_index, s3, R2_BUCKET, _get_id3_tag_size
from search import search_tracks
from mutagen.id3 import ID3
import tempfile



app = Flask(__name__)
db_conn = load_index()

@app.route("/library")
def library():
    """Returns tracks. If a `q` query param is present, does a search.
    Otherwise returns the full library (paginated)."""
    query = request.args.get("q", "").strip()
    limit = int(request.args.get("limit", 50))
    offset = int(request.args.get("offset", 0))

    if query:
        results = search_tracks(db_conn, query, limit=limit)
        return jsonify({"results": results, "query": query})

    cursor = db_conn.execute(
        "SELECT id, r2_key, title, artist, album, duration FROM tracks "
        "ORDER BY artist, album, track_number LIMIT ? OFFSET ?",
        (limit, offset)
    )
    tracks = [
        {"id": r[0], "r2_key": r[1], "title": r[2], "artist": r[3],
         "album": r[4], "duration": r[5]}
        for r in cursor.fetchall()
    ]
    return jsonify({"results": tracks, "query": None})


@app.route("/stream/<int:track_id>")
def stream(track_id):
    """Streams audio from R2 with Range support for seeking."""
    row = db_conn.execute(
        "SELECT r2_key, filesize FROM tracks WHERE id = ?", (track_id,)
    ).fetchone()

    if row is None:
        return jsonify({"error": "Track not found"}), 404

    r2_key, filesize = row
    range_header = request.headers.get("Range")

    if range_header:
        # Parse "bytes=START-END"
        byte_range = range_header.replace("bytes=", "").split("-")
        start = int(byte_range[0]) if byte_range[0] else 0
        end = int(byte_range[1]) if len(byte_range) > 1 and byte_range[1] else filesize - 1
        end = min(end, filesize - 1)

        obj = s3.get_object(
            Bucket=R2_BUCKET, Key=r2_key,
            Range=f"bytes={start}-{end}"
        )

        resp = Response(
            stream_with_context(obj["Body"].iter_chunks(chunk_size=8192)),
            status=206,
            mimetype="audio/mpeg",
            direct_passthrough=True,
        )
        resp.headers["Content-Range"] = f"bytes {start}-{end}/{filesize}"
        resp.headers["Accept-Ranges"] = "bytes"
        resp.headers["Content-Length"] = str(end - start + 1)
        return resp

    # No Range header — send whole file (some clients do this on first request)
    obj = s3.get_object(Bucket=R2_BUCKET, Key=r2_key)
    resp = Response(
        stream_with_context(obj["Body"].iter_chunks(chunk_size=8192)),
        mimetype="audio/mpeg",
        direct_passthrough=True,
    )
    resp.headers["Content-Length"] = str(filesize)
    resp.headers["Accept-Ranges"] = "bytes"
    return resp

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/sw.js")
def service_worker():
    response = send_from_directory("static", "sw.js", mimetype="application/javascript")
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"
    return response

@app.route("/art/<int:track_id>")
def album_art(track_id):
    row = db_conn.execute("SELECT r2_key, filesize FROM tracks WHERE id = ?", (track_id,)
    ).fetchone()
    if row is None:
        return jsonify({"error": "Track not found"}), 404

    r2_key, filesize = row

    # Fetch enough of the file to cover ID3 tags (same approach as indexing)
    tag_size = _get_id3_tag_size(r2_key)
    range_end = min(tag_size, filesize - 1)

    obj = s3.get_object(Bucket=R2_BUCKET, Key=r2_key, Range=f"bytes=0-{range_end}")
    tmp_path = os.path.join(tempfile.gettempdir(), f"_art_scan_{track_id}.mp3")
    with open(tmp_path, "wb") as f:
        f.write(obj["Body"].read())

    try:
        tags = ID3(tmp_path)
        apic_frames = tags.getall("APIC")
        if not apic_frames:
            os.remove(tmp_path)
            return jsonify({"error": "No album art found"}), 404

        image_data = apic_frames[0].data
        mime = apic_frames[0].mime or "image/jpeg"
    finally:
        os.remove(tmp_path)

    return Response(image_data, mimetype=mime)

if __name__ == "__main__":
    app.run(debug=True, port=5000, use_reloader=False)