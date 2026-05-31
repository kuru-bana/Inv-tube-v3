import asyncio
import base64 as _b64
import time
from urllib.parse import quote, urlparse as _up

import httpx
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from core import get_client, get_instances, proxy_parallel

router = APIRouter()

# ── Thumbnail proxy ───────────────────────────────────────────────────────────

_THUMB_ALLOWED = (
    "i.ytimg.com", "i9.ytimg.com", "yt3.ggpht.com",
    "yt3.googleusercontent.com", "lh3.googleusercontent.com",
)


@router.get("/api/thumb")
async def thumb_proxy(
    url: str = Query(...),
    w: int = Query(default=None),
    fmt: str = Query(default="img"),
):
    parsed = _up(url)
    if parsed.hostname not in _THUMB_ALLOWED:
        return JSONResponse({"error": "disallowed host"}, status_code=403)
    try:
        client = await get_client()
        fetch_url = url
        if w:
            sep = "&" if "?" in fetch_url else "?"
            fetch_url = f"{fetch_url}{sep}w={w}"
        resp = await client.get(fetch_url, timeout=httpx.Timeout(10.0))
        if not resp.is_success:
            return JSONResponse({"error": f"upstream {resp.status_code}"}, status_code=502)
        data = resp.content
        ct = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
        if fmt == "b64":
            encoded = _b64.b64encode(data).decode()
            data_uri = f"data:{ct};base64,{encoded}"
            return JSONResponse({"src": data_uri})
        return StreamingResponse(
            iter([data]),
            media_type=ct,
            headers={"Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*"},
        )
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


# ── Download proxy ────────────────────────────────────────────────────────────

@router.get("/download")
async def download(url: str = Query(...), filename: str = Query(default="download")):
    try:
        client = await get_client()
        req = client.build_request("GET", url)
        upstream = await client.send(req, stream=True)
        if not upstream.is_success:
            raise Exception(f"HTTP {upstream.status_code}")

        content_type = upstream.headers.get("content-type", "application/octet-stream")
        content_length = upstream.headers.get("content-length")

        response_headers = {
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename, safe='')}",
            "Content-Type": content_type,
        }
        if content_length:
            response_headers["Content-Length"] = content_length

        async def stream_body():
            async for chunk in upstream.aiter_bytes():
                yield chunk
            await upstream.aclose()

        return StreamingResponse(stream_body(), headers=response_headers)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


# ── Channel home ──────────────────────────────────────────────────────────────

_CHANNEL_HOME_BASE = "https://choco-youtube-js.onrender.com"


@router.get("/api/channel-home/{channel_id}")
async def api_channel_home(channel_id: str):
    try:
        client = await get_client()
        resp = await client.get(f"{_CHANNEL_HOME_BASE}/channel/{channel_id}", timeout=15)
        resp.raise_for_status()
        return JSONResponse(resp.json())
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


# ── Instances list ────────────────────────────────────────────────────────────

@router.get("/api/instances")
async def api_instances():
    categories = [
        "video", "search", "trending", "trending_music", "trending_gaming",
        "trending_news", "trending_movies", "channel", "channel_videos",
        "channel_shorts", "channel_streams", "channel_latest", "channel_playlists",
        "channel_comments", "channel_search", "playlist", "mix", "hashtag",
        "comments", "transcripts", "captions", "annotations", "clip",
        "resolveurl", "popular", "stats", "search_suggestions", "search_filters",
    ]
    results = await asyncio.gather(
        *[get_instances(cat) for cat in categories],
        return_exceptions=True,
    )
    all_instances = {
        cat: result
        for cat, result in zip(categories, results)
        if not isinstance(result, Exception)
    }
    return JSONResponse({"all": all_instances})


# ── Link list status ──────────────────────────────────────────────────────────

_LINKLIST_URL = "https://raw.githubusercontent.com/kuru-bana/Link-list/refs/heads/main/choco-tube-plus.json"


async def _check_one(url: str) -> dict:
    base = url.rstrip("/")
    try:
        client = await get_client()
        r = await client.get(f"{base}/version", timeout=8)
        if r.status_code == 200:
            data = r.json()
            return {"url": base, "ver": data.get("ver", "?"), "online": True}
        return {"url": base, "ver": None, "online": False}
    except Exception:
        return {"url": base, "ver": None, "online": False}


@router.get("/api/linklist-status")
async def linklist_status():
    try:
        client = await get_client()
        r = await client.get(_LINKLIST_URL, timeout=10)
        r.raise_for_status()
        urls = r.json()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)
    results = await asyncio.gather(*[_check_one(u) for u in urls])
    return list(results)


# ── Edu params ────────────────────────────────────────────────────────────────

_EDU_PARAMS_URLS = [
    {"label": "choco-1", "url": "https://raw.githubusercontent.com/choco-1515/About-youtube/refs/heads/main/edu/key1.json"},
    {"label": "choco-2", "url": "https://raw.githubusercontent.com/choco-1515/About-youtube/refs/heads/main/edu/key2.json"},
    {"label": "choco-3", "url": "https://raw.githubusercontent.com/choco-1515/About-youtube/refs/heads/main/edu/key3.json"},
]
_EDU_PARAMS_CACHE: dict = {}
_EDU_PARAMS_TTL = 30 * 60


@router.get("/api/edu-params")
async def api_edu_params():
    now = time.time()
    cached = _EDU_PARAMS_CACHE.get("data")
    if cached and now - cached["time"] < _EDU_PARAMS_TTL:
        return JSONResponse(cached["json"])
    try:
        client = await get_client()
        responses = await asyncio.gather(
            *[client.get(e["url"], timeout=8) for e in _EDU_PARAMS_URLS],
            return_exceptions=True,
        )
        result = []
        for i, r in enumerate(responses):
            if isinstance(r, Exception) or not r.is_success:
                result.append({"label": _EDU_PARAMS_URLS[i]["label"], "value": ""})
            else:
                data = r.json()
                result.append({"label": _EDU_PARAMS_URLS[i]["label"], "value": data.get("value", "")})
        _EDU_PARAMS_CACHE["data"] = {"json": result, "time": now}
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


# ── Choco chat ────────────────────────────────────────────────────────────────

_CHOCO_CHAT_CACHE: dict = {}
_CHOCO_CHAT_TTL = 30 * 60


@router.get("/choco-chat-new")
async def choco_chat_new():
    now = time.time()
    cached = _CHOCO_CHAT_CACHE.get("data")
    if cached and now - cached["time"] < _CHOCO_CHAT_TTL:
        return JSONResponse(cached["json"])
    try:
        client = await get_client()
        resp = await client.get(
            "https://raw.githubusercontent.com/kuru-bana/choco-chat-tool/refs/heads/main/url.json"
        )
        resp.raise_for_status()
        data = resp.json()
        _CHOCO_CHAT_CACHE["data"] = {"json": data, "time": now}
        return JSONResponse(data)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


# ── Transcript endpoints ──────────────────────────────────────────────────────

from youtube_transcript_api import YouTubeTranscriptApi as _YTA_Class

_YTA = _YTA_Class()


@router.get("/api/transcript-langs/{video_id}")
async def transcript_langs(video_id: str):
    """Return available caption tracks. Tries youtube-transcript-api first, falls back to Invidious."""
    try:
        loop = asyncio.get_event_loop()
        transcript_list = await loop.run_in_executor(None, lambda: list(_YTA.list(video_id)))
        if transcript_list:
            tracks = [
                {
                    "label": t.language,
                    "language_code": t.language_code,
                    "source": "yta",
                    "is_generated": getattr(t, "is_generated", False),
                    "is_translatable": getattr(t, "is_translatable", False),
                }
                for t in transcript_list
            ]
            return JSONResponse(tracks)
    except Exception:
        pass

    try:
        result = await proxy_parallel("captions", f"/api/v1/captions/{video_id}")
        data = result.get("data", {})
        captions = data.get("captions", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
        if captions:
            return JSONResponse([
                {
                    "label": c.get("label") or c.get("languageCode") or c.get("language_code") or "?",
                    "language_code": c.get("languageCode") or c.get("language_code") or "",
                    "source": "invidious",
                    "is_generated": c.get("isGenerated", False),
                    "is_translatable": False,
                }
                for c in captions
            ])
    except Exception:
        pass

    return JSONResponse({"error": "no tracks found", "tracks": []}, status_code=502)


@router.get("/api/transcript-data/{video_id}")
async def transcript_data(video_id: str, lang: str = "en", source: str = "auto"):
    """Return transcript lines. Tries youtube-transcript-api first, falls back to Invidious."""
    if source != "invidious":
        try:
            loop = asyncio.get_event_loop()
            def _fetch():
                fetched = _YTA.fetch(video_id, languages=[lang])
                return [{"text": s.text, "start": s.start, "duration": s.duration} for s in fetched]
            lines = await loop.run_in_executor(None, _fetch)
            if lines:
                return JSONResponse(lines)
        except Exception:
            pass

    try:
        result = await proxy_parallel("transcripts", f"/api/v1/transcripts/{video_id}?lang={quote(lang)}")
        data = result.get("data", [])
        if isinstance(data, list):
            lines = data
        elif isinstance(data, dict):
            lines = data.get("transcript", data.get("captions", []))
        else:
            lines = []
        if lines:
            return JSONResponse(lines)
    except Exception:
        pass

    return JSONResponse({"error": "no transcript found"}, status_code=502)


@router.get("/api/transcript-translate/{video_id}")
async def transcript_translate(video_id: str, lang: str = "en", target: str = "ja"):
    """Translate transcript via youtube-transcript-api's built-in translation."""
    try:
        loop = asyncio.get_event_loop()
        def _fetch():
            tl = _YTA.list(video_id)
            tr = tl.find_transcript([lang])
            translated = tr.translate(target)
            fetched = translated.fetch()
            return [{"text": s.text, "start": s.start, "duration": s.duration} for s in fetched]
        lines = await loop.run_in_executor(None, _fetch)
        return JSONResponse(lines)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


# ── Misc ──────────────────────────────────────────────────────────────────────

@router.get("/whats")
async def whats():
    return {"name": "choco-tube-plus"}


@router.get("/version")
async def version():
    return {"ver": "1.26"}
