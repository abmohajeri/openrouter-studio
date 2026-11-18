#!/usr/bin/env python3
"""OpenRouter Studio: a local, AI-Studio-style web UI for every kind of OpenRouter model.

    python app.py            # opens http://localhost:8000 in your browser
    python app.py --port 9000 --no-browser

Each model gets the inputs and outputs it supports: chat (text, images, PDFs, audio,
video), image and video generation, text-to-speech, transcription, embeddings, and
decision models like TypeSafe's Jev. Prices are pulled live from OpenRouter.

Your API key stays on this machine (in .env); the browser talks only to this server.
Chats are saved as JSON in ./chats/, generated images/audio/video in ./media/.
"""

from __future__ import annotations

import sys

if sys.version_info < (3, 9):
    print("OpenRouter Studio requires Python 3.9 or newer.", file=sys.stderr)
    sys.exit(1)

import argparse
import base64
import json
import os
import re
import threading
import time
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

import openrouter_client as orc
from openrouter_client import OpenRouterClient, OpenRouterError

WEB_DIR = orc.PROJECT_DIR / "web"
CHATS_DIR = orc.PROJECT_DIR / "chats"
MEDIA_DIR = orc.PROJECT_DIR / "media"
CATALOG_TTL = 300   # model list + prices are re-fetched from OpenRouter every 5 minutes
PROVIDERS_TTL = 120

SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
MEDIA_NAME = re.compile(r"^[A-Za-z0-9_-]{1,160}\.[a-z0-9]{2,5}$")
GEN_ID = re.compile(r"^gen-[0-9A-Za-z-]{1,120}$")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]"}
MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
    ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
    ".mp4": "video/mp4", ".webm": "video/webm", ".json": "application/json",
}
EXT_FOR_MIME = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    "image/svg+xml": "svg", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav",
    "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac", "video/mp4": "mp4", "video/webm": "webm",
}

# Which OpenRouter endpoint gives a model which "mode" in the UI. The first match is the default.
MODE_ENDPOINTS = [
    ("image", "/api/v1/images"),
    ("video", "/api/v1/videos"),
    ("extract", "/api/alpha/extractions"),
    ("chat", "/api/v1/chat/completions"),
    ("decisions", "/api/alpha/decisions"),
    ("speech", "/api/v1/audio/speech"),
    ("transcription", "/api/v1/audio/transcriptions"),
    ("embeddings", "/api/v1/embeddings"),
]
OVERRIDE_PRICE_KEYS = {"prompt", "completion", "audio", "input_audio_cache",
                       "input_cache_read", "input_cache_write", "input_cache_write_1h"}


# ---- model catalog (live prices) ---------------------------------------------------------

def _num(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def slim_pricing(p: dict) -> dict:
    """OpenRouter prices are strings in USD per unit; turn them into numbers (-1 = varies)."""
    out = {}
    for k, v in p.items():
        if k in ("overrides", "discount"):
            continue
        n = _num(v)
        if n is not None:
            out[k] = n
    if _num(p.get("discount")):
        out["discount"] = _num(p["discount"])
    if isinstance(p.get("overrides"), list):
        out["overrides"] = [{k: (_num(v) if k in OVERRIDE_PRICE_KEYS else v) for k, v in o.items()}
                            for o in p["overrides"] if isinstance(o, dict)]
    return out


def build_catalog() -> dict:
    with ThreadPoolExecutor(3) as pool:
        all_models = pool.submit(orc.fetch_models, "all")
        image_models = pool.submit(orc.fetch_image_models)
        video_models = pool.submit(orc.fetch_video_models)
        models = all_models.result()  # this one is required
        extras = []
        for future in (image_models, video_models):
            try:
                extras.append({m["id"]: m for m in future.result()})
            except (OpenRouterError, requests.RequestException, KeyError, ValueError):
                extras.append({})
    images, videos = extras

    out = []
    for m in models:
        endpoints = m.get("endpoints") or []
        modes = [mode for mode, ep in MODE_ENDPOINTS if ep in endpoints]
        if not modes:
            continue  # batch-only and rerank models aren't in the UI (yet)
        arch = m.get("architecture") or {}
        top = m.get("top_provider") or {}
        item = {
            "id": m["id"],
            "name": m.get("name") or m["id"],
            "created": m.get("created") or 0,
            "description": (m.get("description") or "")[:600],
            "context": m.get("context_length") or top.get("context_length"),
            "max_output": top.get("max_completion_tokens"),
            "modes": modes,
            "input": arch.get("input_modalities") or ["text"],
            "output": arch.get("output_modalities") or ["text"],
            "pricing": slim_pricing(m.get("pricing") or {}),
            "params": m.get("supported_parameters") or [],
            "reasoning": m.get("reasoning"),
            "voices": m.get("supported_voices"),
        }
        if m["id"] in images:
            img = images[m["id"]]
            item["image"] = {"params": img.get("supported_parameters") or {},
                             "streaming": bool(img.get("supports_streaming"))}
        if m["id"] in videos:
            v = videos[m["id"]]
            item["video"] = {
                "durations": v.get("supported_durations") or [],
                "resolutions": v.get("supported_resolutions") or [],
                "aspect_ratios": v.get("supported_aspect_ratios") or [],
                "frame_images": v.get("supported_frame_images") or [],
                "generate_audio": bool(v.get("generate_audio")),
                "seed": bool(v.get("seed")),
                "skus": {k: _num(val) for k, val in (v.get("pricing_skus") or {}).items() if _num(val) is not None},
            }
        out.append(item)
    return {"updated": time.time(), "models": out}


_catalog: dict = {"data": None, "time": 0.0}
_catalog_lock = threading.Lock()


def get_catalog(force: bool = False) -> dict:
    with _catalog_lock:
        age = time.time() - _catalog["time"]
        # A manual refresh (force=True) always re-fetches; the 15 s debounce
        # only applies to automatic background refreshes.
        if _catalog["data"] is None or age > CATALOG_TTL or force:
            _catalog.update(data=build_catalog(), time=time.time())
        return _catalog["data"]


_providers: dict = {}


def get_providers(model_id: str, image: bool) -> list[dict]:
    """Live per-provider prices for one model (cached for 2 minutes)."""
    key = (model_id, image)
    hit = _providers.get(key)
    if hit and time.time() - hit[0] < PROVIDERS_TTL:
        return hit[1]
    data = orc.fetch_model_endpoints(model_id, image_model=image)
    rows = []
    for e in data.get("endpoints") or []:
        if image:
            rows.append({"provider": e.get("provider_name") or e.get("provider_slug"),
                         "pricing": e.get("pricing") or []})
        else:
            rows.append({
                "provider": e.get("provider_name"),
                "pricing": slim_pricing(e.get("pricing") or {}),
                "uptime": e.get("uptime_last_30m"),
                "status": e.get("status"),
                "context": e.get("context_length"),
                "quantization": e.get("quantization"),
                "tier": e.get("service_tier"),
            })
    _providers[key] = (time.time(), rows)
    return rows


# ---- files: chats and generated media ------------------------------------------------

def chat_path(chat_id: str) -> Path | None:
    return CHATS_DIR / f"{chat_id}.json" if SAFE_ID.match(chat_id) else None


def list_chats() -> list[dict]:
    items = []
    for f in CHATS_DIR.glob("*.json"):
        try:
            c = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        items.append({"id": f.stem, "title": c.get("title") or "Untitled",
                      "updated": c.get("updated") or 0, "model": c.get("model"), "kind": c.get("kind") or "chat"})
    return sorted(items, key=lambda c: c["updated"], reverse=True)


def studio_spend() -> dict:
    """What was spent through this app, from the exact costs saved in each chat."""
    today = time.strftime("%Y-%m-%d", time.gmtime())  # UTC, like OpenRouter's usage_daily
    total = day = 0.0
    runs = 0
    by_model: dict[str, float] = {}
    by_kind: dict[str, float] = {}
    for f in CHATS_DIR.glob("*.json"):
        try:
            chat = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for m in chat.get("messages") or []:
            meta = m.get("meta") or {}
            cost = (meta.get("usage") or {}).get("cost") or meta.get("cost") or 0
            if m.get("role") != "assistant" or not cost:
                continue
            runs += 1
            total += cost
            stamp = (m.get("created") or meta.get("started") or chat.get("updated") or 0) / 1000
            if time.strftime("%Y-%m-%d", time.gmtime(stamp)) == today:
                day += cost
            model = m.get("model") or chat.get("model") or "?"
            by_model[model] = by_model.get(model, 0) + cost
            kind = m.get("kind") or "chat"
            by_kind[kind] = by_kind.get(kind, 0) + cost
    top = sorted(by_model.items(), key=lambda kv: kv[1], reverse=True)
    return {"total": total, "today": day, "runs": runs,
            "by_model": [{"model": k, "cost": v} for k, v in top[:8]], "by_kind": by_kind}


def save_media(data: bytes, ext: str) -> str:
    MEDIA_DIR.mkdir(exist_ok=True)
    name = f"{uuid.uuid4().hex[:20]}.{ext}"
    (MEDIA_DIR / name).write_bytes(data)
    return f"/media/{name}"


def data_url_payload(url: str) -> str:
    """'data:audio/wav;base64,AAAA' -> 'AAAA' (raw base64 is what audio APIs want)."""
    return url.split(",", 1)[1] if url.startswith("data:") else url


def clean(params: dict | None) -> dict:
    return {k: v for k, v in (params or {}).items() if v not in (None, "", [])}


# ---- HTTP handler --------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "OpenRouterStudio/2.0"

    def log_message(self, fmt, *args):  # keep the terminal quiet
        pass

    # -- helpers --

    def send_json(self, data, status: int = 200) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def is_trusted(self, mutating: bool) -> bool:
        """Only answer requests from this machine's own UI (blocks other websites)."""
        host = re.sub(r":\d+$", "", self.headers.get("Host", ""))
        if host not in LOCAL_HOSTS:
            self.send_json({"error": "forbidden host"}, 403)
            return False
        if mutating:
            origin = self.headers.get("Origin")
            same_origin = origin is None or urlparse(origin).hostname in {"localhost", "127.0.0.1", "::1"}
            is_json = (self.headers.get("Content-Type") or "").startswith("application/json")
            if not (same_origin and is_json):
                self.send_json({"error": "forbidden"}, 403)
                return False
        return True

    def run_json(self, fn, *args) -> None:
        """Call fn and send its result as JSON, turning failures into readable errors."""
        try:
            self.send_json(fn(*args))
        except OpenRouterError as e:
            self.send_json({"error": str(e)}, 502)
        except requests.RequestException as e:
            self.send_json({"error": f"Network error: {e}"}, 502)
        except (KeyError, ValueError, TypeError) as e:
            self.send_json({"error": f"Bad request: {e}"}, 400)

    def serve_file(self, path: Path, cache: str = "no-cache") -> None:
        """Send a file, honouring Range requests so audio/video can seek."""
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        m = re.match(r"bytes=(\d*)-(\d*)$", (self.headers.get("Range") or "").strip())
        if m and size:
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            elif m.group(2):
                start = max(0, size - int(m.group(2)))
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", MIME.get(path.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", cache)
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with path.open("rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(1 << 16, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    # -- GET --

    def do_GET(self):
        if not self.is_trusted(mutating=False):
            return
        url = urlparse(self.path)
        path, query = url.path, parse_qs(url.query)
        try:
            if path == "/api/status":
                orc.load_dotenv()
                self.send_json({
                    "has_key": bool(os.environ.get("OPENROUTER_API_KEY", "").strip()),
                    "default_model": orc.resolve_model(orc.DEFAULT_MODEL),
                    "aliases": orc.MODEL_ALIASES,
                })
            elif path == "/api/models":
                self.run_json(get_catalog, "refresh" in query)
            elif path == "/api/providers":
                model = query.get("model", [""])[0]
                self.run_json(get_providers, model, query.get("image", ["0"])[0] == "1")
            elif path == "/api/key":
                self.run_json(self.key_info)
            elif path == "/api/spend":
                self.send_json(studio_spend())
            elif path == "/api/generation":
                gen_id = query.get("id", [""])[0]
                if not GEN_ID.match(gen_id):
                    return self.send_json({"error": "bad generation id"}, 400)
                self.run_json(lambda: OpenRouterClient().generation(gen_id))
            elif path == "/api/chats":
                self.send_json(list_chats())
            elif path.startswith("/api/chats/"):
                p = chat_path(path.rsplit("/", 1)[1])
                if p and p.exists():
                    self.send_json(json.loads(p.read_text(encoding="utf-8")))
                else:
                    self.send_json({"error": "chat not found"}, 404)
            elif m := re.fullmatch(r"/api/videos/([A-Za-z0-9_-]{1,128})", path):
                self.run_json(self.video_status, m.group(1))
            elif m := re.fullmatch(r"/api/videos/([A-Za-z0-9_-]{1,128})/content", path):
                self.video_content(m.group(1), int(query.get("index", ["0"])[0] or 0))
            elif path.startswith("/media/"):
                name = path.rsplit("/", 1)[1]
                target = MEDIA_DIR / name
                if MEDIA_NAME.match(name) and target.is_file():
                    self.serve_file(target, cache="max-age=31536000, immutable")
                else:
                    self.send_json({"error": "not found"}, 404)
            else:
                self.serve_static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OpenRouterError as e:
            self.send_json({"error": str(e)}, 502)
        except requests.RequestException as e:
            self.send_json({"error": f"Network error: {e}"}, 502)

    def serve_static(self, path: str) -> None:
        target = (WEB_DIR / (path.lstrip("/") or "index.html")).resolve()
        if not target.is_relative_to(WEB_DIR) or not target.is_file():
            self.send_json({"error": "not found"}, 404)
            return
        self.serve_file(target)

    @staticmethod
    def key_info() -> dict:
        client = OpenRouterClient()
        info = client.key_info()
        try:
            info["account"] = client.credits()
        except (OpenRouterError, requests.RequestException) as e:
            # the account balance needs a management key; the key's own usage is still shown
            info["account_error"] = str(e)
        return info

    @staticmethod
    def video_status(job_id: str) -> dict:
        job = OpenRouterClient().get_video(job_id)
        return {
            "id": job.get("id", job_id),
            "status": job.get("status"),
            "error": job.get("error"),
            "usage": job.get("usage"),
            "count": len(job.get("unsigned_urls") or job.get("urls") or []) or 1,
        }

    def video_content(self, job_id: str, index: int) -> None:
        """Download a finished video once, keep it in ./media, then serve it from disk."""
        cached = next(MEDIA_DIR.glob(f"video_{job_id}_{index}.*"), None) if MEDIA_DIR.exists() else None
        if cached is None:
            data, ctype = OpenRouterClient().download_video(job_id, index)
            ext = EXT_FOR_MIME.get(ctype.split(";")[0].strip(), "mp4")
            MEDIA_DIR.mkdir(exist_ok=True)
            cached = MEDIA_DIR / f"video_{job_id}_{index}.{ext}"
            cached.write_bytes(data)
        self.serve_file(cached, cache="max-age=31536000, immutable")

    # -- POST --

    def do_POST(self):
        if not self.is_trusted(mutating=True):
            return
        path = urlparse(self.path).path
        routes = {
            "/api/decisions": self.api_decisions,
            "/api/extract": self.api_extract,
            "/api/images": self.api_images,
            "/api/speech": self.api_speech,
            "/api/transcribe": self.api_transcribe,
            "/api/videos": self.api_video_submit,
            "/api/embeddings": self.api_embeddings,
            "/api/key": self.api_set_key,
        }
        try:
            body = self.read_json()
        except ValueError:
            return self.send_json({"error": "invalid JSON"}, 400)
        if path == "/api/chat":
            self.stream_chat(body)
        elif path in routes:
            self.run_json(routes[path], body)
        else:
            self.send_json({"error": "not found"}, 404)

    @staticmethod
    def api_set_key(body: dict) -> dict:
        key = str(body.get("key", "")).strip()
        if not key:
            raise ValueError("please paste a key")
        try:
            info = OpenRouterClient(api_key=key).key_info()
        except OpenRouterError as e:
            raise OpenRouterError(f"OpenRouter rejected this key: {e}") from None
        orc.save_api_key(key)
        return info

    @staticmethod
    def api_decisions(body: dict) -> dict:
        start = time.time()
        result = OpenRouterClient().decide(body["state"], body["questions"], model=body["model"])
        result["seconds"] = round(time.time() - start, 2)
        return result

    @staticmethod
    def api_extract(body: dict) -> dict:
        start = time.time()
        extra = {k: body[k] for k in ("assets", "reference_date") if body.get(k)}
        result = OpenRouterClient().extract(body.get("state") or "", body["fields"], model=body["model"], **extra)
        result["seconds"] = round(time.time() - start, 2)
        return result

    @staticmethod
    def api_images(body: dict) -> dict:
        start = time.time()
        params = clean(body.get("params"))
        refs = body.get("references") or []
        if refs:
            params["input_references"] = [{"type": "image_url", "image_url": {"url": u}} for u in refs]
        result = OpenRouterClient().generate_image(body["prompt"], body["model"], **params)
        images = []
        for item in result.get("data") or []:
            media_type = item.get("media_type") or "image/png"
            if item.get("b64_json"):
                url = save_media(base64.b64decode(item["b64_json"]), EXT_FOR_MIME.get(media_type, "png"))
            elif item.get("url"):
                url = item["url"]
            else:
                continue
            images.append({"url": url, "media_type": media_type})
        if not images:
            raise OpenRouterError("The model returned no image.")
        return {"images": images, "usage": result.get("usage"), "seconds": round(time.time() - start, 2)}

    @staticmethod
    def api_speech(body: dict) -> dict:
        start = time.time()
        fmt = body.get("response_format") or "mp3"
        params = clean({k: body.get(k) for k in ("instructions",)})
        if body.get("speed") not in (None, "", 1, 1.0):
            params["speed"] = float(body["speed"])
        audio, info = OpenRouterClient().speech(body["input"], body["model"], voice=body.get("voice") or None,
                                                response_format=fmt, **params)
        ctype = (info["content_type"] or "").split(";")[0].strip()
        if fmt == "pcm" or ctype in ("audio/pcm", "audio/l16"):
            audio, ext = orc.pcm16_to_wav(audio), "wav"  # raw PCM -> playable WAV (24 kHz mono)
        else:
            ext = EXT_FOR_MIME.get(ctype, "mp3")
        return {"url": save_media(audio, ext), "generation_id": info["generation_id"],
                "bytes": len(audio), "seconds": round(time.time() - start, 2)}

    @staticmethod
    def api_transcribe(body: dict) -> dict:
        start = time.time()
        params = clean({"language": body.get("language")})
        if body.get("timestamps"):
            params["response_format"] = "verbose_json"
            params["timestamp_granularities"] = ["segment"]
        result = OpenRouterClient().transcribe(data_url_payload(body["audio"]), body.get("format") or "wav",
                                               body["model"], **params)
        result["seconds"] = round(time.time() - start, 2)
        return result

    @staticmethod
    def api_video_submit(body: dict) -> dict:
        params = clean(body.get("params"))
        frames = body.get("frames") or []
        if frames:
            params["frame_images"] = [{"type": "image_url", "image_url": {"url": f["url"]}, "frame_type": f["frame_type"]}
                                      for f in frames]
        refs = body.get("references") or []
        if refs:
            params["input_references"] = [{"type": "image_url", "image_url": {"url": u}} for u in refs]
        job = OpenRouterClient().create_video(body["prompt"], body["model"], **params)
        return {"id": job["id"], "status": job.get("status", "pending")}

    @staticmethod
    def api_embeddings(body: dict) -> dict:
        start = time.time()
        inputs = [s for s in body["input"] if str(s).strip()]
        if not inputs:
            raise ValueError("no text to embed")
        params = {"dimensions": int(body["dimensions"])} if body.get("dimensions") else {}
        result = OpenRouterClient().embed(inputs, body["model"], **params)
        rows = sorted(result.get("data") or [], key=lambda d: d.get("index", 0))
        return {"vectors": [r["embedding"] for r in rows], "usage": result.get("usage"),
                "model": result.get("model"), "seconds": round(time.time() - start, 2)}

    def stream_chat(self, body: dict) -> None:
        try:
            client = OpenRouterClient()
        except OpenRouterError as e:
            return self.send_json({"error": str(e)}, 401)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        def emit(event: dict) -> None:
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode("utf-8"))
            self.wfile.flush()

        params = body.get("params") or {}
        start = time.time()
        audio_chunks: list[bytes] = []
        stopped = False
        events = None
        try:
            events = client.chat_stream_events(body.get("messages") or [], model=body.get("model"), **params)
            for kind, text in events:
                if kind == "audio":
                    audio_chunks.append(base64.b64decode(text))
                else:
                    emit({"type": kind, "text": text})
            if audio_chunks:
                raw = b"".join(audio_chunks)
                fmt = (params.get("audio") or {}).get("format", "pcm16")
                if fmt == "pcm16":
                    raw, fmt = orc.pcm16_to_wav(raw), "wav"
                emit({"type": "audio", "url": save_media(raw, {"opus": "ogg"}.get(fmt, fmt))})
            emit({
                "type": "done",
                "model": client.last_model,
                "usage": client.last_usage,
                "seconds": round(time.time() - start, 2),
                "stopped": stopped,
            })
        except (BrokenPipeError, ConnectionResetError):
            stopped = True  # the user pressed Stop (or the browser closed the tab)
        except Exception as e:  # report anything else to the UI instead of a silent hang
            message = str(e) if isinstance(e, OpenRouterError) else f"{type(e).__name__}: {e}"
            try:
                emit({"type": "error", "message": message})
            except OSError:
                pass
        finally:
            if events is not None:
                events.close()  # closes the generator, which closes the upstream HTTP response

    # -- PUT / DELETE (saved chats) --

    def do_PUT(self):
        if not self.is_trusted(mutating=True):
            return
        path = urlparse(self.path).path
        p = chat_path(path.rsplit("/", 1)[1]) if path.startswith("/api/chats/") else None
        if not p:
            return self.send_json({"error": "bad chat id"}, 400)
        chat = self.read_json()
        if not isinstance(chat, dict):
            return self.send_json({"error": "chat must be an object"}, 400)
        CHATS_DIR.mkdir(exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(chat, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(p)
        self.send_json({"ok": True})

    def do_DELETE(self):
        if not self.is_trusted(mutating=True):
            return
        path = urlparse(self.path).path
        p = chat_path(path.rsplit("/", 1)[1]) if path.startswith("/api/chats/") else None
        if p and p.exists():
            # also remove the images/audio/videos this chat produced
            for name in set(re.findall(r"/media/([A-Za-z0-9_-]+\.[a-z0-9]{2,5})", p.read_text(encoding="utf-8"))):
                (MEDIA_DIR / name).unlink(missing_ok=True)
            for job_id in set(re.findall(r"/api/videos/([A-Za-z0-9_-]{1,128})/content", p.read_text(encoding="utf-8"))):
                for cached in MEDIA_DIR.glob(f"video_{job_id}_*"):  # downloaded copies of finished videos
                    cached.unlink(missing_ok=True)
            p.unlink()
        self.send_json({"ok": True})


def main() -> None:
    parser = argparse.ArgumentParser(description="Local web UI for OpenRouter.")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser automatically")
    args = parser.parse_args()

    CHATS_DIR.mkdir(exist_ok=True)
    MEDIA_DIR.mkdir(exist_ok=True)

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as e:
        raise SystemExit(f"Can't use port {args.port} ({e.strerror}). Try: python app.py --port 8001")
    server.daemon_threads = True

    url = f"http://localhost:{args.port}"
    print(f"OpenRouter Studio running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.6, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBye!")


if __name__ == "__main__":
    main()
