from typing import Any
from fastapi import File, Form, HTTPException, Request, UploadFile
from starlette.concurrency import run_in_threadpool
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload
from app import app, audit, db, require_session, validate_video_id, youtube_api

import json
import os
import tempfile
import time
import uuid
from pathlib import Path
from datetime import datetime, timezone
from io import BytesIO
from PIL import Image, UnidentifiedImageError
from fastapi import File, Form, UploadFile
from googleapiclient.http import MediaFileUpload

MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(256 * 1024 * 1024)))


def _perform_resumable_upload(sid: str, body: dict[str, Any], path: str, mime_type: str) -> dict[str, Any]:
    yt = youtube_api(sid)
    media = MediaFileUpload(path, chunksize=8 * 1024 * 1024, resumable=True, mimetype=mime_type)
    call = yt.videos().insert(part="snippet,status", body=body, media_body=media)
    response = None
    while response is None:
        _, response = call.next_chunk()
    return response


def validate_video_id(video_id: str) -> None:
    if not video_id or len(video_id) > 80 or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for ch in video_id):
        raise HTTPException(status_code=400, detail="Invalid video ID.")


@app.patch("/api/videos/{video_id}")
def update_video(video_id: str, request: Request, payload: dict[str, Any]):
    sid = require_session(request)
    validate_video_id(video_id)
    allowed = {"title", "description", "tags", "categoryId", "defaultLanguage", "defaultAudioLanguage"}
    if not payload or set(payload) - allowed:
        raise HTTPException(status_code=400, detail={"code": "INVALID_METADATA", "message": "Only supported metadata fields may be changed.", "allowed": sorted(allowed)})
    snippet: dict[str, Any] = {}
    for key in ("title", "description", "tags", "categoryId", "defaultLanguage", "defaultAudioLanguage"):
        if key in payload:
            value = payload[key]
            if key in {"title", "description", "categoryId", "defaultLanguage", "defaultAudioLanguage"} and not isinstance(value, str):
                raise HTTPException(status_code=400, detail=f"{key} must be text.")
            if key == "title" and (not value.strip() or len(value) > 100):
                raise HTTPException(status_code=400, detail="Title is required and must be 100 characters or fewer.")
            if key == "description" and len(value) > 5000:
                raise HTTPException(status_code=400, detail="Description must be 5,000 characters or fewer.")
            if key == "tags" and (not isinstance(value, list) or len(value) > 500 or any(not isinstance(t, str) or len(t) > 100 for t in value)):
                raise HTTPException(status_code=400, detail="Tags must be a list of up to 500 short text values.")
            snippet[key] = value
    yt = youtube_api(sid)
    try:
        existing = yt.videos().list(part="snippet", id=video_id).execute().get("items", [])
        if not existing:
            raise HTTPException(status_code=404, detail="Video not found or not accessible to this channel.")
        original = existing[0]["snippet"]
        current = {key: original[key] for key in ("title", "description", "tags", "categoryId", "defaultLanguage", "defaultAudioLanguage") if key in original}
        current.update(snippet)
        result = yt.videos().update(part="snippet", body={"id": video_id, "snippet": current}).execute()
        audit(sid, "video_metadata_updated", video_id)
        return {"success": True, "id": result["id"], "title": result.get("snippet", {}).get("title")}
    except HttpError as exc:
        raise HTTPException(status_code=502, detail={"code": "YOUTUBE_API_ERROR", "message": "Metadata update failed. Check channel ownership, permissions, and API quota.", "status": exc.resp.status})


@app.patch("/api/videos/{video_id}/visibility")
def update_visibility(video_id: str, request: Request, payload: dict[str, Any]):
    sid = require_session(request)
    validate_video_id(video_id)
    visibility = payload.get("privacyStatus")
    if visibility not in {"private", "unlisted", "public"}:
        raise HTTPException(status_code=400, detail="privacyStatus must be private, unlisted, or public.")
    yt = youtube_api(sid)
    try:
        result = yt.videos().list(part="status", id=video_id).execute().get("items", [])
        if not result:
            raise HTTPException(status_code=404, detail="Video not found or not accessible.")
        original = result[0].get("status", {})
        status = {key: original[key] for key in ("privacyStatus", "license", "embeddable", "publicStatsViewable", "selfDeclaredMadeForKids") if key in original}
        status["privacyStatus"] = visibility
        updated = yt.videos().update(part="status", body={"id": video_id, "status": status}).execute()
        audit(sid, "video_visibility_changed", video_id + ":" + visibility)
        return {"success": True, "id": updated["id"], "privacyStatus": updated["status"]["privacyStatus"]}
    except HttpError as exc:
        raise HTTPException(status_code=502, detail={"code": "YOUTUBE_API_ERROR", "message": "Visibility change failed.", "status": exc.resp.status})


@app.post("/api/videos/upload")
async def upload_video(request: Request, file: UploadFile = File(...), title: str = Form(...),
                       description: str = Form(""), tags: str = Form(""), category_id: str = Form("22"),
                       privacy_status: str = Form("private"), publish_at: str = Form("")):
    sid = require_session(request)
    if not file.filename or not file.content_type or not file.content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail="Select a valid video file.")
    if not title.strip() or len(title) > 100 or len(description) > 5000:
        raise HTTPException(status_code=400, detail="Check title and description lengths.")
    if privacy_status not in {"private", "unlisted", "public"}:
        raise HTTPException(status_code=400, detail="Invalid visibility.")
    if privacy_status == "public":
        raise HTTPException(status_code=400, detail="Public publishing needs a separate explicit confirmation workflow. Upload privately first.")
    scheduled_at = None
    if publish_at:
        try:
            scheduled_at = datetime.fromisoformat(publish_at.replace("Z", "+00:00"))
            if scheduled_at.tzinfo is None:
                raise ValueError("timezone required")
            scheduled_at = scheduled_at.astimezone(timezone.utc)
        except ValueError:
            raise HTTPException(status_code=400, detail="Scheduled time must be an ISO 8601 date/time with a timezone.")
        if scheduled_at <= datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="Scheduled publish time must be in the future.")
        if privacy_status != "private":
            raise HTTPException(status_code=400, detail="YouTube scheduled publishing requires private visibility before the scheduled time.")
    try:
        parsed_tags = json.loads(tags) if tags.strip() else []
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Tags must be provided as a JSON list.")
    if not isinstance(parsed_tags, list) or any(not isinstance(tag, str) for tag in parsed_tags):
        raise HTTPException(status_code=400, detail="Tags must be a JSON list of text values.")
    job_id = str(uuid.uuid4())
    now = int(time.time())
    with db() as con:
        con.execute("INSERT INTO upload_jobs(id,session_id,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                    (job_id, sid, "receiving", json.dumps({"title": title, "filename": Path(file.filename).name, "scheduledPublishAt": scheduled_at.isoformat() if scheduled_at else None}), now, now))
    temp_path = None
    total = 0
    try:
        fd, temp_path = tempfile.mkstemp(prefix="ytcc-upload-", suffix=Path(file.filename).suffix[:12])
        with os.fdopen(fd, "wb") as target:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail=f"File exceeds this server's configured {MAX_UPLOAD_BYTES // (1024*1024)} MB upload limit.")
                target.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="The selected file is empty.")
        with db() as con:
            con.execute("UPDATE upload_jobs SET status='uploading', updated_at=? WHERE id=?", (int(time.time()), job_id))
        status_body = {"privacyStatus": "private", "selfDeclaredMadeForKids": False}
        if scheduled_at:
            status_body["publishAt"] = scheduled_at.isoformat().replace("+00:00", "Z")
        body = {"snippet": {"title": title.strip(), "description": description, "tags": parsed_tags[:500], "categoryId": category_id},
                "status": status_body}
        response = await run_in_threadpool(_perform_resumable_upload, sid, body, temp_path, file.content_type)
        video_id = response["id"]
        with db() as con:
            con.execute("UPDATE upload_jobs SET status='completed', video_id=?, updated_at=? WHERE id=?",
                        (video_id, int(time.time()), job_id))
        audit(sid, "video_uploaded_private", video_id)
        return {"success": True, "jobId": job_id, "videoId": video_id, "privacyStatus": "private",
                "scheduledPublishAt": scheduled_at.isoformat() if scheduled_at else None,
                "message": "YouTube confirmed the upload and scheduled its publication." if scheduled_at else "YouTube confirmed the upload. The video was uploaded privately."}
    except HTTPException as exc:
        with db() as con:
            con.execute("UPDATE upload_jobs SET status='failed', error=?, updated_at=? WHERE id=?",
                        (str(exc.detail)[:500], int(time.time()), job_id))
        raise
    except HttpError as exc:
        with db() as con:
            con.execute("UPDATE upload_jobs SET status='failed', error=?, updated_at=? WHERE id=?",
                        (f"YouTube API HTTP {exc.resp.status}", int(time.time()), job_id))
        raise HTTPException(status_code=502, detail={"code": "UPLOAD_FAILED", "jobId": job_id, "message": "YouTube did not confirm upload completion. Check the job before retrying to avoid duplicates.", "status": exc.resp.status})
    except Exception:
        with db() as con:
            con.execute("UPDATE upload_jobs SET status='failed', error=?, updated_at=? WHERE id=?",
                        ("Unexpected upload failure; verify YouTube Studio before retrying.", int(time.time()), job_id))
        raise HTTPException(status_code=502, detail={"code": "UPLOAD_FAILED", "jobId": job_id, "message": "Upload did not complete successfully. Check YouTube Studio before retrying to avoid duplicates."})
    finally:
        await file.close()
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@app.post("/api/videos/{video_id}/thumbnail")
async def upload_thumbnail(video_id: str, request: Request, file: UploadFile = File(...)):
    sid = require_session(request)
    validate_video_id(video_id)
    if file.content_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(status_code=400, detail="Thumbnail must be JPEG or PNG.")
    content = await file.read(2 * 1024 * 1024 + 1)
    await file.close()
    if len(content) > 2 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Thumbnail exceeds 2 MB.")
    if not content:
        raise HTTPException(status_code=400, detail="Thumbnail file is empty.")
    try:
        with Image.open(BytesIO(content)) as image:
            if image.format not in {"JPEG", "PNG"}:
                raise HTTPException(status_code=400, detail="Thumbnail content must be a valid JPEG or PNG image.")
            width, height = image.size
            if width < 640 or height < 360:
                raise HTTPException(status_code=400, detail="Thumbnail must be at least 640 × 360 pixels. 1280 × 720 is recommended.")
    except UnidentifiedImageError:
        raise HTTPException(status_code=400, detail="The uploaded file is not a valid image.")
    suffix = ".jpg" if file.content_type == "image/jpeg" else ".png"
    temp_path = None
    try:
        fd, temp_path = tempfile.mkstemp(prefix="ytcc-thumb-", suffix=suffix)
        with os.fdopen(fd, "wb") as target:
            target.write(content)
        yt = youtube_api(sid)
        result = yt.thumbnails().set(videoId=video_id, media_body=MediaFileUpload(temp_path, mimetype=file.content_type)).execute()
        audit(sid, "thumbnail_updated", video_id)
        return {"success": True, "videoId": video_id, "width": width, "height": height,
                "thumbnail": result.get("items", [{}])[0].get("url")}
    except HttpError as exc:
        raise HTTPException(status_code=502, detail={"code": "THUMBNAIL_FAILED", "message": "Thumbnail update failed. Check channel permissions, image dimensions, and API quota.", "status": exc.resp.status})
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@app.get("/api/upload-jobs")
def upload_jobs(request: Request, limit: int = 25):
    sid = require_session(request)
    with db() as con:
        rows = con.execute("SELECT id,status,payload,video_id,error,created_at,updated_at FROM upload_jobs WHERE session_id=? ORDER BY created_at DESC LIMIT ?",
                           (sid, min(max(limit, 1), 100))).fetchall()
    return {"items": [{**dict(row), "payload": json.loads(row["payload"])} for row in rows]}


@app.get("/api/comments")
def list_comments(request: Request, video_id: str, page_token: str | None = None):
    sid = require_session(request)
    validate_video_id(video_id)
    yt = youtube_api(sid)
    try:
        data = yt.commentThreads().list(part="snippet,replies", videoId=video_id, maxResults=100,
                                        pageToken=page_token, textFormat="plainText", order="time").execute()
        rows = []
        for item in data.get("items", []):
            thread = item["snippet"]["topLevelComment"]
            snip = thread["snippet"]
            rows.append({"id": thread["id"], "text": snip.get("textDisplay"), "author": snip.get("authorDisplayName"),
                         "publishedAt": snip.get("publishedAt"), "likeCount": snip.get("likeCount", 0),
                         "canReply": item["snippet"].get("canReply", False), "videoId": video_id})
        return {"items": rows, "nextPageToken": data.get("nextPageToken")}
    except HttpError as exc:
        raise HTTPException(status_code=502, detail={"code": "COMMENTS_API_ERROR", "message": "Comments could not be loaded. Check video comments and API permissions.", "status": exc.resp.status})


@app.post("/api/comments/{comment_id}/reply")
def reply_comment(comment_id: str, request: Request, payload: dict[str, Any]):
    sid = require_session(request)
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 10000:
        raise HTTPException(status_code=400, detail="Reply must be 1–10,000 characters.")
    yt = youtube_api(sid)
    try:
        result = yt.comments().insert(part="snippet", body={"snippet": {"parentId": comment_id, "textOriginal": text.strip()}}).execute()
        audit(sid, "comment_replied", comment_id)
        return {"success": True, "id": result.get("id")}
    except HttpError as exc:
        raise HTTPException(status_code=502, detail={"code": "COMMENT_REPLY_FAILED", "message": "Reply failed. Check permissions, moderation settings, and API quota.", "status": exc.resp.status})


@app.post("/api/comments/{comment_id}/moderate")
def moderate_comment(comment_id: str, request: Request, payload: dict[str, Any]):
    sid = require_session(request)
    moderation_status = payload.get("moderationStatus")
    if moderation_status not in {"published", "heldForReview", "rejected"}:
        raise HTTPException(status_code=400, detail="Unsupported moderation status.")
    if payload.get("confirm") is not True:
        raise HTTPException(status_code=400, detail="Explicit confirmation is required for moderation changes.")
    yt = youtube_api(sid)
    try:
        yt.comments().setModerationStatus(id=comment_id, moderationStatus=moderation_status, banAuthor=False).execute()
        audit(sid, "comment_moderated", comment_id + ":" + moderation_status)
        return {"success": True, "id": comment_id, "moderationStatus": moderation_status}
    except HttpError as exc:
        raise HTTPException(status_code=502, detail={"code": "COMMENT_MODERATION_FAILED", "message": "Moderation failed. Check comment ownership, permissions, and API quota.", "status": exc.resp.status})


@app.get("/api/channel/settings")
def channel_settings(request: Request):
    sid = require_session(request)
    yt = youtube_api(sid)
    try:
        data = yt.channels().list(part="snippet,brandingSettings", mine=True, maxResults=1).execute()
        if not data.get("items"):
            raise HTTPException(status_code=404, detail="Channel not found.")
        item = data["items"][0]
        snippet = item.get("snippet", {})
        branding = item.get("brandingSettings", {}).get("channel", {})
        return {"id": item["id"], "title": snippet.get("title"), "description": snippet.get("description"),
                "country": snippet.get("country"), "defaultLanguage": snippet.get("defaultLanguage"),
                "keywords": branding.get("keywords"), "customUrl": snippet.get("customUrl"),
                "note": "Many channel-level settings must be changed in YouTube Studio; this endpoint is read-only."}
    except HttpError as exc:
        raise HTTPException(status_code=502, detail={"code": "CHANNEL_SETTINGS_FAILED", "message": "Channel settings could not be loaded.", "status": exc.resp.status})


@app.get("/api/notifications")
def notifications(request: Request):
    sid = require_session(request)
    with db() as con:
        jobs = con.execute("SELECT id,status,payload,error,updated_at FROM upload_jobs WHERE session_id=? AND status IN ('failed','completed') ORDER BY updated_at DESC LIMIT 20", (sid,)).fetchall()
    items = []
    for job in jobs:
        payload = json.loads(job["payload"])
        items.append({"id": job["id"], "type": "upload_" + job["status"], "title": payload.get("title", "Video upload"),
                      "message": job["error"] or ("Upload confirmed by YouTube." if job["status"] == "completed" else "Upload failed."),
                      "createdAt": job["updated_at"]})
    return {"items": items}


@app.get("/api/research")
def topic_research(request: Request, q: str, max_results: int = 10):
    sid = require_session(request)
    query = q.strip()
    if len(query) < 2 or len(query) > 100:
        raise HTTPException(status_code=400, detail="Research query must be between 2 and 100 characters.")
    max_results = min(max(1, max_results), 25)
    yt = youtube_api(sid)
    try:
        data = yt.search().list(part="snippet", q=query, type="video", maxResults=max_results,
                                order="relevance", safeSearch="moderate").execute()
        ids = [item.get("id", {}).get("videoId") for item in data.get("items", []) if item.get("id", {}).get("videoId")]
        stats = yt.videos().list(part="statistics", id=",".join(ids)).execute() if ids else {"items": []}
        stat_map = {item["id"]: item.get("statistics", {}) for item in stats.get("items", [])}
        rows = []
        for item in data.get("items", []):
            video_id = item.get("id", {}).get("videoId")
            if not video_id:
                continue
            snippet = item.get("snippet", {})
            rows.append({"id": video_id, "title": snippet.get("title"), "description": snippet.get("description"),
                         "channelTitle": snippet.get("channelTitle"), "publishedAt": snippet.get("publishedAt"),
                         "thumbnail": snippet.get("thumbnails", {}).get("medium", {}).get("url"),
                         "viewCount": stat_map.get(video_id, {}).get("viewCount")})
        audit(sid, "topic_research", query)
        return {"query": query, "items": rows, "note": "Search results and public counts are snapshots, not private competitor analytics or predictions."}
    except HttpError as exc:
        raise HTTPException(status_code=502, detail={"code": "RESEARCH_API_ERROR", "message": "YouTube search failed. Check API quota and permissions.", "status": exc.resp.status})
