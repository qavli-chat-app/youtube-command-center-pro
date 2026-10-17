import base64
import json
from contextlib import contextmanager
import os
import secrets
import sqlite3
import time
from datetime import datetime, timezone, date
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest, urlopen

from cryptography.fernet import Fernet, InvalidToken
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("DATABASE_PATH", str(ROOT / "data" / "app.sqlite3")))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
APP_SECRET = os.getenv("APP_SECRET", "")
TOKEN_ENCRYPTION_KEY = os.getenv("TOKEN_ENCRYPTION_KEY", "")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "")
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "").rstrip("/")
COOKIE_NAME = "ytcc_session"
SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
]
app = FastAPI(title="YouTube Command Center PRO API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN] if FRONTEND_ORIGIN else [],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type"],
)
serializer = URLSafeTimedSerializer(APP_SECRET, salt="ytcc-session-v1") if APP_SECRET else None


DATABASE_URL = os.getenv("DATABASE_URL", "").strip()


class PostgresConnection:
    """Small compatibility wrapper so existing parameterized queries work on PostgreSQL."""
    def __init__(self, connection):
        self._connection = connection

    def execute(self, query: str, params=()):
        # App SQL uses SQLite-style '?' placeholders; translate these to psycopg placeholders.
        return self._connection.execute(query.replace("?", "%s"), params)

    def executescript(self, script: str):
        for statement in script.split(";"):
            if statement.strip():
                self._connection.execute(statement)

    def commit(self):
        self._connection.commit()

    def rollback(self):
        self._connection.rollback()

    def close(self):
        self._connection.close()


@contextmanager
def db() -> Iterator[Any]:
    if DATABASE_URL:
        import psycopg
        from psycopg.rows import dict_row
        raw_connection = psycopg.connect(DATABASE_URL, connect_timeout=10, row_factory=dict_row)
        connection = PostgresConnection(raw_connection)
    else:
        # Local development and CI use SQLite; production should set DATABASE_URL.
        connection = sqlite3.connect(DB_PATH, timeout=15)
        connection.row_factory = sqlite3.Row
    try:
        if not DATABASE_URL:
            connection.execute("PRAGMA journal_mode=WAL")
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db() -> None:
    if DATABASE_URL:
        schema = """
        CREATE TABLE IF NOT EXISTS oauth_states (
          state TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS connections (
          session_id TEXT PRIMARY KEY, encrypted_credentials BYTEA NOT NULL,
          channel_id TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_log (
          id BIGSERIAL PRIMARY KEY, session_id TEXT,
          action TEXT NOT NULL, detail TEXT NOT NULL, created_at BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS upload_jobs (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
          payload TEXT NOT NULL, video_id TEXT, error TEXT, created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
        """
    else:
        schema = """
        CREATE TABLE IF NOT EXISTS oauth_states (
          state TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS connections (
          session_id TEXT PRIMARY KEY, encrypted_credentials BLOB NOT NULL,
          channel_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
          action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS upload_jobs (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
          payload TEXT NOT NULL, video_id TEXT, error TEXT, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        """
    with db() as con:
        con.executescript(schema)


init_db()


def check_config() -> None:
    missing = [name for name, value in {
        "APP_SECRET": APP_SECRET,
        "TOKEN_ENCRYPTION_KEY": TOKEN_ENCRYPTION_KEY,
        "GOOGLE_CLIENT_ID": GOOGLE_CLIENT_ID,
        "GOOGLE_CLIENT_SECRET": GOOGLE_CLIENT_SECRET,
        "GOOGLE_REDIRECT_URI": GOOGLE_REDIRECT_URI,
    }.items() if not value]
    if missing:
        raise HTTPException(status_code=503, detail={
            "code": "SETUP_REQUIRED",
            "message": "Backend setup is incomplete. Configure the required server-side environment variables.",
            "missing": missing,
        })
    try:
        Fernet(TOKEN_ENCRYPTION_KEY.encode())
    except (ValueError, TypeError):
        raise HTTPException(status_code=503, detail={
            "code": "INVALID_ENCRYPTION_KEY",
            "message": "TOKEN_ENCRYPTION_KEY must be a valid Fernet key generated by cryptography.fernet.Fernet.generate_key().",
        })


def encrypt(value: dict[str, Any]) -> bytes:
    return Fernet(TOKEN_ENCRYPTION_KEY.encode()).encrypt(json.dumps(value).encode())


def decrypt(value: bytes) -> dict[str, Any]:
    try:
        return json.loads(Fernet(TOKEN_ENCRYPTION_KEY.encode()).decrypt(value).decode())
    except (InvalidToken, ValueError, TypeError):
        raise HTTPException(status_code=500, detail="Stored credentials could not be decrypted. Check the configured encryption key.")


def session_id_from(request: Request) -> str | None:
    if not serializer:
        return None
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    try:
        return serializer.loads(token, max_age=60 * 60 * 24 * 14)
    except (BadSignature, SignatureExpired):
        return None


def require_session(request: Request) -> str:
    sid = session_id_from(request)
    if not sid:
        raise HTTPException(status_code=401, detail={"code": "AUTH_REQUIRED", "message": "Connect your YouTube channel first."})
    return sid


def audit(sid: str | None, action: str, detail: str = "") -> None:
    with db() as con:
        con.execute("INSERT INTO audit_log(session_id, action, detail, created_at) VALUES(?,?,?,?)",
                    (sid, action, detail[:500], int(time.time())))


def flow_for(state: str | None = None) -> Flow:
    check_config()
    config = {
        "web": {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [GOOGLE_REDIRECT_URI],
        }
    }
    flow = Flow.from_client_config(config, scopes=SCOPES, state=state)
    flow.redirect_uri = GOOGLE_REDIRECT_URI
    return flow


def load_credentials(sid: str) -> Credentials:
    check_config()
    with db() as con:
        row = con.execute("SELECT encrypted_credentials FROM connections WHERE session_id=?", (sid,)).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail={"code": "CHANNEL_NOT_CONNECTED", "message": "Connect a YouTube channel to continue."})
    data = decrypt(row["encrypted_credentials"])
    credentials = Credentials.from_authorized_user_info(data, scopes=SCOPES)
    if credentials.expired and credentials.refresh_token:
        try:
            credentials.refresh(GoogleRequest())
            with db() as con:
                con.execute("UPDATE connections SET encrypted_credentials=?, updated_at=? WHERE session_id=?",
                            (encrypt(json.loads(credentials.to_json())), int(time.time()), sid))
        except Exception:
            audit(sid, "token_refresh_failed")
            raise HTTPException(status_code=401, detail={"code": "RECONNECT_REQUIRED", "message": "Google authorization expired or was revoked. Reconnect your channel."})
    return credentials


def youtube_api(sid: str):
    try:
        return build("youtube", "v3", credentials=load_credentials(sid), cache_discovery=False)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=502, detail={"code": "YOUTUBE_API_ERROR", "message": "YouTube API client could not be initialized."})


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return response


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "youtube-command-center-pro-api",
        "oauth_configured": bool(
            APP_SECRET and TOKEN_ENCRYPTION_KEY and GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI
        ),
        "database_backend": "postgresql" if DATABASE_URL else "sqlite_ephemeral",
        "persistent_storage_configured": bool(DATABASE_URL),
    }


@app.get("/api/auth/start")
def auth_start():
    check_config()
    state = secrets.token_urlsafe(32)
    sid = secrets.token_urlsafe(32)
    with db() as con:
        con.execute("DELETE FROM oauth_states WHERE created_at < ?", (int(time.time()) - 600,))
        con.execute("INSERT INTO oauth_states(state, session_id, created_at) VALUES(?,?,?)", (state, sid, int(time.time())))
    flow = flow_for(state)
    authorization_url, _ = flow.authorization_url(
        access_type="offline", include_granted_scopes="true", prompt="consent"
    )
    response = RedirectResponse(authorization_url, status_code=302)
    response.set_cookie("ytcc_oauth_state", state, httponly=True, secure=True, samesite="lax", max_age=600)
    return response


@app.get("/api/auth/callback")
def auth_callback(request: Request, response: Response, state: str | None = None, error: str | None = None):
    check_config()
    if error:
        audit(None, "oauth_cancelled", error)
        return RedirectResponse((FRONTEND_ORIGIN or "") + "/?oauth=cancelled", status_code=303)
    # Validate the unpredictable, one-time state against the server-side store.
    # Do not require a browser cookie here: mobile browsers and privacy settings can
    # drop the auxiliary cookie across Google's cross-site redirect. The DB-backed
    # state is single-use and expires after 10 minutes.
    if not state:
        raise HTTPException(status_code=400, detail="OAuth state is missing. Please start Connect YouTube again.")
    with db() as con:
        row = con.execute("SELECT session_id, created_at FROM oauth_states WHERE state=?", (state,)).fetchone()
        if row:
            con.execute("DELETE FROM oauth_states WHERE state=?", (state,))
    if not row or int(time.time()) - row["created_at"] > 600:
        raise HTTPException(status_code=400, detail="OAuth request expired or was already used. Please start Connect YouTube again.")
    flow = flow_for(state)
    try:
        flow.fetch_token(authorization_response=str(request.url))
        credentials = flow.credentials
        if not credentials.refresh_token:
            raise HTTPException(status_code=400, detail="Google did not return a refresh token. Revoke this app's access in your Google account and connect again.")
        sid = row["session_id"]
        with db() as con:
            con.execute("""INSERT INTO connections(session_id, encrypted_credentials, created_at, updated_at)
              VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET encrypted_credentials=excluded.encrypted_credentials, updated_at=excluded.updated_at""",
              (sid, encrypt(json.loads(credentials.to_json())), int(time.time()), int(time.time())))
        audit(sid, "oauth_connected")
        target = (FRONTEND_ORIGIN or "").rstrip("/") + "/?oauth=connected"
        out = RedirectResponse(target or "/?oauth=connected", status_code=303)
        out.set_cookie(COOKIE_NAME, serializer.dumps(sid), httponly=True, secure=True, samesite="lax", max_age=60*60*24*14)
        out.delete_cookie("ytcc_oauth_state")
        return out
    except HTTPException:
        raise
    except Exception:
        audit(None, "oauth_callback_failed")
        raise HTTPException(status_code=400, detail="Google OAuth could not be completed. Check the callback URL and OAuth configuration.")


@app.get("/api/auth/status")
def auth_status(request: Request):
    sid = session_id_from(request)
    if not sid:
        return {"connected": False, "reason": "not_connected"}
    with db() as con:
        row = con.execute("SELECT encrypted_credentials, channel_id, updated_at FROM connections WHERE session_id=?", (sid,)).fetchone()
    if not row:
        return {"connected": False, "reason": "not_connected"}
    try:
        data = decrypt(row["encrypted_credentials"])
        creds = Credentials.from_authorized_user_info(data, scopes=SCOPES)
        return {"connected": True, "channelId": row["channel_id"], "tokenExpired": bool(creds.expired),
                "hasRefreshToken": bool(creds.refresh_token), "updatedAt": row["updated_at"]}
    except HTTPException:
        return {"connected": False, "reason": "credential_error"}


@app.post("/api/auth/disconnect")
def auth_disconnect(request: Request, response: Response):
    sid = require_session(request)
    with db() as con:
        row = con.execute("SELECT encrypted_credentials FROM connections WHERE session_id=?", (sid,)).fetchone()
    revoke_result = "not_attempted"
    if row and TOKEN_ENCRYPTION_KEY:
        try:
            stored = decrypt(row["encrypted_credentials"])
            token = stored.get("refresh_token") or stored.get("token")
            if token:
                body = urlencode({"token": token}).encode()
                revoke_request = UrlRequest("https://oauth2.googleapis.com/revoke", data=body,
                                            headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
                with urlopen(revoke_request, timeout=5) as revoke_response:
                    revoke_result = "revoked" if revoke_response.status in (200, 204) else "failed"
        except Exception:
            revoke_result = "failed"
    with db() as con:
        con.execute("DELETE FROM connections WHERE session_id=?", (sid,))
    audit(sid, "oauth_disconnected", "google_token_" + revoke_result)
    response = Response(content=json.dumps({"connected": False, "googleTokenRevocation": revoke_result}), media_type="application/json")
    response.delete_cookie(COOKIE_NAME, httponly=True, secure=True, samesite="lax")
    return response


@app.get("/api/channel")
def channel(request: Request):
    sid = require_session(request)
    yt = youtube_api(sid)
    try:
        data = yt.channels().list(part="snippet,statistics,contentDetails", mine=True, maxResults=1).execute()
        items = data.get("items", [])
        if not items:
            raise HTTPException(status_code=404, detail="No YouTube channel was found for the connected Google account.")
        item = items[0]
        channel_id = item["id"]
        with db() as con:
            con.execute("UPDATE connections SET channel_id=?, updated_at=? WHERE session_id=?", (channel_id, int(time.time()), sid))
        return {"id": channel_id, "title": item["snippet"]["title"], "description": item["snippet"].get("description", ""),
                "thumbnail": item["snippet"].get("thumbnails", {}).get("high", {}).get("url"),
                "publishedAt": item["snippet"].get("publishedAt"),
                "subscriberCount": item.get("statistics", {}).get("subscriberCount"),
                "videoCount": item.get("statistics", {}).get("videoCount"),
                "viewCount": item.get("statistics", {}).get("viewCount"),
                "hiddenSubscriberCount": item.get("statistics", {}).get("hiddenSubscriberCount", False)}
    except HttpError as exc:
        raise HTTPException(status_code=502, detail={"code": "YOUTUBE_API_ERROR", "message": "YouTube could not return channel data.", "status": exc.resp.status})


@app.get("/api/videos")
def videos(request: Request, query: str = "", page_token: str | None = None, max_results: int = 25):
    sid = require_session(request)
    yt = youtube_api(sid)
    max_results = min(max(1, max_results), 50)
    try:
        channel_data = yt.channels().list(part="contentDetails", mine=True, maxResults=1).execute()
        items = channel_data.get("items", [])
        if not items:
            return {"items": [], "nextPageToken": None}
        uploads = items[0]["contentDetails"]["relatedPlaylists"]["uploads"]
        playlist = yt.playlistItems().list(part="snippet,contentDetails", playlistId=uploads,
                                           maxResults=max_results, pageToken=page_token).execute()
        ids = [x["contentDetails"]["videoId"] for x in playlist.get("items", [])]
        details = yt.videos().list(part="snippet,status,statistics,contentDetails,processingDetails", id=",".join(ids)).execute() if ids else {"items": []}
        rows = []
        needle = query.casefold().strip()
        for item in details.get("items", []):
            snippet = item.get("snippet", {})
            if needle and needle not in (snippet.get("title", "") + " " + snippet.get("description", "")).casefold():
                continue
            rows.append({"id": item["id"], "title": snippet.get("title"), "description": snippet.get("description"),
                         "thumbnail": snippet.get("thumbnails", {}).get("medium", {}).get("url"),
                         "publishedAt": snippet.get("publishedAt"), "tags": snippet.get("tags", []),
                         "categoryId": snippet.get("categoryId"), "defaultLanguage": snippet.get("defaultLanguage"),
                         "privacyStatus": item.get("status", {}).get("privacyStatus"),
                         "uploadStatus": item.get("status", {}).get("uploadStatus"),
                         "viewCount": item.get("statistics", {}).get("viewCount"),
                         "likeCount": item.get("statistics", {}).get("likeCount"),
                         "commentCount": item.get("statistics", {}).get("commentCount"),
                         "processingStatus": item.get("processingDetails", {}).get("processingStatus")})
        return {"items": rows, "nextPageToken": playlist.get("nextPageToken")}
    except HttpError as exc:
        raise HTTPException(status_code=502, detail={"code": "YOUTUBE_API_ERROR", "message": "Video library request failed.", "status": exc.resp.status})


@app.get("/api/analytics")
def analytics(request: Request, start_date: str, end_date: str):
    sid = require_session(request)
    try:
        start = date.fromisoformat(start_date)
        end = date.fromisoformat(end_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="Dates must use YYYY-MM-DD format.")
    if start > end or (end - start).days > 365:
        raise HTTPException(status_code=400, detail="Choose a valid date range of no more than 366 calendar days.")
    if end > datetime.now(timezone.utc).date():
        raise HTTPException(status_code=400, detail="End date cannot be in the future.")
    creds = load_credentials(sid)
    try:
        analytics_api = build("youtubeAnalytics", "v2", credentials=creds, cache_discovery=False)
        report = analytics_api.reports().query(ids="channel==MINE", startDate=start_date, endDate=end_date,
                                               metrics="views,estimatedMinutesWatched,subscribersGained,subscribersLost",
                                               dimensions="day", sort="day").execute()
        headers = [h.get("name") for h in report.get("columnHeaders", [])]
        return {"headers": headers, "rows": report.get("rows", []), "startDate": start_date, "endDate": end_date}
    except HttpError as exc:
        raise HTTPException(status_code=502, detail={"code": "ANALYTICS_API_ERROR", "message": "Analytics report unavailable for this account or date range.", "status": exc.resp.status})


@app.get("/api/audit")
def audit_history(request: Request, limit: int = 50):
    sid = require_session(request)
    with db() as con:
        rows = con.execute("SELECT action, detail, created_at FROM audit_log WHERE session_id=? ORDER BY id DESC LIMIT ?",
                           (sid, min(max(limit, 1), 100))).fetchall()
    return {"items": [dict(row) for row in rows]}


@app.get("/")
def index():
    return FileResponse(ROOT / "index.html")


@app.get("/app.css")
def css():
    return FileResponse(ROOT / "app.css", media_type="text/css")


@app.get("/app.js")
def javascript():
    return FileResponse(ROOT / "app.js", media_type="application/javascript")


def validate_video_id(video_id: str) -> None:
    """Validate a YouTube video identifier before making API calls."""
    if not video_id or len(video_id) > 80 or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for ch in video_id):
        raise HTTPException(status_code=400, detail="Invalid video ID.")


# Register the additional YouTube video and comments routes.
import api_extensions  # noqa: E402,F401
