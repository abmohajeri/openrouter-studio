"""Small wrapper around the OpenRouter API (https://openrouter.ai).

One API key gives you access to hundreds of models: GPT, Gemini, Claude,
DeepSeek, Llama, Grok, Mistral, Qwen, ... plus image, video, speech,
transcription, embedding and decision models (like TypeSafe's Jev).

Usage:
    from openrouter_studio import OpenRouterClient   # or: from openrouter_client import ...

    client = OpenRouterClient()                    # reads OPENROUTER_API_KEY from env or .env
    print(client.ask("Hello!", model="gemini"))    # alias ...
    print(client.ask("Hello!", model="openai/gpt-5.5"))  # ... or any full OpenRouter model id

    # Decision models answer typed questions with probabilities:
    result = client.decide(
        state="My checkout page is blank after I click Pay.",
        questions={"is_bug": {"type": "noul", "instructions": "Is this a software defect?"}},
        model="jev",
    )
    print(result["answers"]["is_bug"]["noul"])     # e.g. 0.96
"""

from __future__ import annotations

import sys

if sys.version_info < (3, 9):
    print("OpenRouter Studio requires Python 3.9 or newer.", file=sys.stderr)
    sys.exit(1)

import base64
import json
import os
import re
import struct
from pathlib import Path
from typing import Iterator

import requests

API_ROOT = "https://openrouter.ai/api"
BASE_URL = f"{API_ROOT}/v1"
ALPHA_URL = f"{API_ROOT}/alpha"  # Decisions API lives here (still alpha)
PACKAGE_DIR = Path(__file__).resolve().parent


def _data_dir() -> Path:
    """Where .env, chats/ and media/ live.

    1. $OPENROUTER_STUDIO_HOME, if set
    2. the project folder, when running from a source checkout (or `pip install -e .`)
    3. ~/.openrouter-studio, when installed as a normal package
    """
    custom = os.environ.get("OPENROUTER_STUDIO_HOME", "").strip()
    if custom:
        return Path(custom).expanduser().resolve()
    checkout = PACKAGE_DIR.parent
    if (checkout / "pyproject.toml").is_file():
        return checkout
    return Path.home() / ".openrouter-studio"


DATA_DIR = _data_dir()
PROJECT_DIR = DATA_DIR  # older name, kept for code that imported it
ENV_FILE = DATA_DIR / ".env"

# Short names -> full OpenRouter model ids. Add or change entries freely.
# Browse all models at https://openrouter.ai/models or run: openrouter --list-models
MODEL_ALIASES: dict[str, str] = {
    "gpt": "openai/gpt-6.1-sol",
    "gpt-mini": "openai/gpt-6-luna",
    "gemini": "google/gemini-4-argon",
    "gemini-flash": "google/gemini-3.8-flash",
    "claude": "anthropic/claude-sonnet-5.5",
    "claude-opus": "anthropic/claude-opus-5.5",
    "claude-haiku": "anthropic/claude-haiku-5.5",
    "deepseek": "deepseek/deepseek-v4-pro",
    "grok": "x-ai/grok-4.7",
    "llama": "meta-llama/llama-4-maverick",
    "mistral": "mistralai/mistral-large-4-0",
    "qwen": "qwen/qwen3.7-plus",
    "free": "google/gemma-4-31b-it:free",
    "jev": "~typesafe/jev-latest",  # decision model: use client.decide() or the web UI
}

DEFAULT_MODEL = "gpt"


class OpenRouterError(Exception):
    """Raised when OpenRouter returns an error (bad key, unknown model, no credits, ...)."""


def load_dotenv(path: Path = ENV_FILE) -> None:
    """Load KEY=VALUE lines from a .env file into os.environ (real env vars win)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        os.environ.setdefault(key, value.strip().strip("'\""))


def save_api_key(key: str, path: Path = ENV_FILE) -> None:
    """Write OPENROUTER_API_KEY into .env (keeping other lines) and use it right away."""
    key = key.strip()
    if not key or any(c.isspace() for c in key):
        raise ValueError("an API key can't be empty or contain spaces or line breaks")
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    lines = [ln for ln in lines
             if ln.strip().removeprefix("export ").split("=", 1)[0].strip() != "OPENROUTER_API_KEY"]
    lines.append(f"OPENROUTER_API_KEY={key}")
    path.parent.mkdir(parents=True, exist_ok=True)
    # Create the file owner-only from the start, so the key is never readable by others.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(path, 0o600)
    os.environ["OPENROUTER_API_KEY"] = key


def resolve_model(name: str) -> str:
    """Turn an alias like 'gemini' into a full id; full ids are returned unchanged."""
    name = name.strip()
    return MODEL_ALIASES.get(name.lower(), name)


def build_messages(prompt: str, system: str | None = None) -> list[dict]:
    messages = [{"role": "system", "content": system}] if system else []
    messages.append({"role": "user", "content": prompt})
    return messages


def parse_json_reply(text: str):
    """Parse a model's JSON reply, tolerating ```json fences, extra prose and trailing commas."""
    t = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", t)
    if fence:
        t = fence.group(1).strip()
    candidates = [t]
    start, end = min((i for i in (t.find("{"), t.find("[")) if i >= 0), default=-1), max(t.rfind("}"), t.rfind("]"))
    if 0 <= start < end:
        inner = t[start:end + 1]
        candidates += [inner, re.sub(r",\s*([}\]])", r"\1", inner)]
    for c in candidates:
        try:
            return json.loads(c)
        except ValueError:
            continue
    raise OpenRouterError(f"The model did not return valid JSON: {text[:200]!r}")


def pcm16_to_wav(pcm: bytes, sample_rate: int = 24000, channels: int = 1) -> bytes:
    """Wrap raw 16-bit PCM audio (what streaming audio models send) in a playable WAV header."""
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate, sample_rate * channels * 2, channels * 2, 16)
    return header + b"data" + struct.pack("<I", len(pcm)) + pcm


# ---- public catalog endpoints (no API key needed) --------------------------------

def fetch_models(output_modalities: str = "text") -> list[dict]:
    """List models. Use output_modalities="all" to include image/video/speech/decision models."""
    resp = requests.get(f"{BASE_URL}/models", params={"output_modalities": output_modalities}, timeout=30)
    _raise_for_error(resp)
    return resp.json()["data"]


def fetch_image_models() -> list[dict]:
    """Image models with the settings each one accepts (aspect_ratio, resolution, n, ...)."""
    resp = requests.get(f"{BASE_URL}/images/models", timeout=30)
    _raise_for_error(resp)
    return resp.json()["data"]


def fetch_video_models() -> list[dict]:
    """Video models with supported durations, resolutions, aspect ratios and price SKUs."""
    resp = requests.get(f"{BASE_URL}/videos/models", timeout=30)
    _raise_for_error(resp)
    return resp.json()["data"]


def fetch_model_endpoints(model_id: str, image_model: bool = False) -> dict:
    """Live per-provider prices (and uptime) for one model."""
    path = f"images/models/{model_id}/endpoints" if image_model else f"models/{model_id}/endpoints"
    resp = requests.get(f"{BASE_URL}/{path}", timeout=30)
    _raise_for_error(resp)
    data = resp.json()
    return data.get("data", data)


def _raise_for_error(resp: requests.Response) -> None:
    if resp.ok:
        return
    try:
        message = resp.json()["error"]["message"]
    except (ValueError, KeyError, TypeError):
        message = resp.text[:500] or resp.reason
    raise OpenRouterError(f"HTTP {resp.status_code}: {message}")


class OpenRouterClient:
    def __init__(
        self,
        api_key: str | None = None,
        default_model: str = DEFAULT_MODEL,
        timeout: float = 300,
    ):
        load_dotenv()
        self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY", "").strip()
        if not self.api_key:
            raise OpenRouterError(
                "No API key found. Run `openrouter --setup` (or `python main.py --setup` in the project folder), "
                f"or put OPENROUTER_API_KEY=... in {ENV_FILE}."
            )
        self.default_model = default_model
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "X-Title": "OpenRouter Studio",
            }
        )
        # Filled after every chat call so you can inspect cost / token counts.
        self.last_model: str | None = None
        self.last_usage: dict | None = None

    # ---- simple one-shot helpers -------------------------------------------------

    def ask(self, prompt: str, model: str | None = None, system: str | None = None, **params) -> str:
        """Send one prompt, get the full answer back as a string."""
        return self.chat(build_messages(prompt, system), model=model, **params)

    def ask_stream(
        self, prompt: str, model: str | None = None, system: str | None = None, **params
    ) -> Iterator[str]:
        """Like ask(), but yields the answer piece by piece as it is generated."""
        return self.chat_stream(build_messages(prompt, system), model=model, **params)

    # ---- full conversation API ---------------------------------------------------

    def chat(self, messages: list[dict], model: str | None = None, **params) -> str:
        """Send a list of {"role": ..., "content": ...} messages, return the reply text.

        Extra keyword args (temperature, max_tokens, top_p, ...) are passed to the API as-is.
        """
        self.last_model = self.last_usage = None
        resp = self.session.post(
            f"{BASE_URL}/chat/completions",
            json=self._payload(messages, model, params),
            timeout=self.timeout,
        )
        _raise_for_error(resp)
        try:
            data = resp.json()
        except ValueError:
            raise OpenRouterError(f"Unexpected response from OpenRouter: {resp.text[:300]!r}") from None
        if "error" in data:
            raise OpenRouterError(data["error"].get("message", str(data["error"])))
        self.last_model = data.get("model")
        self.last_usage = data.get("usage")
        choices = data.get("choices") or []
        if not choices:
            raise OpenRouterError(f"OpenRouter returned no answer: {str(data)[:300]}")
        return (choices[0].get("message") or {}).get("content") or ""

    def chat_stream(self, messages: list[dict], model: str | None = None, **params) -> Iterator[str]:
        """Streaming version of chat(): yields text chunks as they arrive."""
        for kind, text in self.chat_stream_events(messages, model, **params):
            if kind == "content":
                yield text

    def chat_stream_events(
        self, messages: list[dict], model: str | None = None, **params
    ) -> Iterator[tuple[str, str]]:
        """Like chat_stream(), but also yields the model's thinking and spoken audio.

        Yields ("reasoning", text), ("content", text), and for audio-output models
        ("transcript", text) and ("audio", base64_chunk) tuples.
        """
        payload = self._payload(messages, model, params)
        payload["stream"] = True
        payload.setdefault("usage", {"include": True})  # ask for token counts + cost
        self.last_model = self.last_usage = None  # never report the previous call's cost
        with self.session.post(
            f"{BASE_URL}/chat/completions", json=payload, stream=True, timeout=self.timeout
        ) as resp:
            _raise_for_error(resp)
            for raw in resp.iter_lines():
                line = raw.decode("utf-8")
                if not line.startswith("data: "):
                    continue  # blank lines and ": OPENROUTER PROCESSING" keep-alives
                data = line[len("data: "):]
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except ValueError:
                    continue  # skip a malformed line instead of losing the whole reply
                if "error" in chunk:
                    raise OpenRouterError(chunk["error"].get("message", str(chunk["error"])))
                self.last_model = chunk.get("model", self.last_model)
                if chunk.get("usage"):
                    self.last_usage = chunk["usage"]
                for choice in chunk.get("choices", []):
                    delta = choice.get("delta") or {}
                    if delta.get("reasoning"):
                        yield "reasoning", delta["reasoning"]
                    if delta.get("content"):
                        yield "content", delta["content"]
                    audio = delta.get("audio") or {}
                    if audio.get("transcript"):
                        yield "transcript", audio["transcript"]
                    if audio.get("data"):
                        yield "audio", audio["data"]

    # ---- structured output ------------------------------------------------------------

    def ask_json(self, prompt: str, schema: dict, model: str | None = None, system: str | None = None,
                 name: str = "result", **params):
        """Ask for an answer that follows a JSON Schema and get it back as Python data.

        Example schema: {"type": "object", "properties": {"is_bug": {"type": "boolean"}},
                         "required": ["is_bug"], "additionalProperties": False}
        """
        params["response_format"] = {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}}
        params.setdefault("provider", {"require_parameters": True})  # only providers that enforce the schema
        return parse_json_reply(self.chat(build_messages(prompt, system), model=model, **params))

    def extract(self, state: str, fields: dict, model: str = "cloudflare/clairic", **extra) -> dict:
        """Pull typed fields (text, number, date, list, estimate, ...) out of text with an extraction model."""
        body = {"model": resolve_model(model), "state": state, "fields": fields, **extra}
        return self._request("POST", f"{ALPHA_URL}/extractions", body)

    # ---- other model types ---------------------------------------------------------

    def decide(self, state, questions: dict, model: str = "jev", **extra) -> dict:
        """Ask a decision model (e.g. Jev) typed questions about `state`.

        Question types: "noul" (yes/no probability), "choice" (pick one option from
        `criteria`), "score" (ordered `criteria` list, low to high) and "box" (find a
        region in an image). Returns {"answers": {...}, "usage": {...}, ...}.
        """
        body = {"model": resolve_model(model), "state": state, "questions": questions, **extra}
        return self._request("POST", f"{ALPHA_URL}/decisions", body)

    def generate_image(self, prompt: str, model: str, **params) -> dict:
        """Generate images. Returns {"data": [{"b64_json", "media_type"}], "usage": {...}}."""
        return self._request("POST", f"{BASE_URL}/images", {"model": resolve_model(model), "prompt": prompt, **params})

    def speech(self, text: str, model: str, voice: str | None = None,
               response_format: str = "mp3", **params) -> tuple[bytes, dict]:
        """Text to speech. Returns (audio_bytes, {"content_type", "generation_id"})."""
        body = {"model": resolve_model(model), "input": text, "response_format": response_format, **params}
        if voice:
            body["voice"] = voice
        resp = self.session.post(f"{BASE_URL}/audio/speech", json=body, timeout=self.timeout)
        _raise_for_error(resp)
        return resp.content, {
            "content_type": resp.headers.get("Content-Type", ""),
            "generation_id": resp.headers.get("X-Generation-Id"),
        }

    def transcribe(self, audio: bytes | str, audio_format: str, model: str, **params) -> dict:
        """Speech to text. `audio` is raw bytes or a base64 string. Returns {"text", "usage", ...}."""
        data = base64.b64encode(audio).decode() if isinstance(audio, bytes) else audio
        body = {"model": resolve_model(model), "input_audio": {"data": data, "format": audio_format}, **params}
        return self._request("POST", f"{BASE_URL}/audio/transcriptions", body)

    def create_video(self, prompt: str, model: str, **params) -> dict:
        """Start a video job. Returns {"id", "status", "polling_url"}; poll with get_video()."""
        return self._request("POST", f"{BASE_URL}/videos", {"model": resolve_model(model), "prompt": prompt, **params})

    def get_video(self, job_id: str) -> dict:
        """Job status: pending, in_progress, completed or failed (+ usage.cost when done)."""
        return self._request("GET", f"{BASE_URL}/videos/{job_id}")

    def download_video(self, job_id: str, index: int = 0) -> tuple[bytes, str]:
        """Download a finished video. Returns (bytes, content_type)."""
        resp = self.session.get(f"{BASE_URL}/videos/{job_id}/content", params={"index": index}, timeout=self.timeout)
        _raise_for_error(resp)
        return resp.content, resp.headers.get("Content-Type", "video/mp4")

    def embed(self, inputs: str | list[str], model: str, **params) -> dict:
        """Embedding vectors. Returns {"data": [{"embedding": [...], "index"}], "usage": {...}}."""
        return self._request("POST", f"{BASE_URL}/embeddings", {"model": resolve_model(model), "input": inputs, **params})

    def generation(self, generation_id: str) -> dict:
        """Cost and stats of a finished request (e.g. speech), by its generation id."""
        return self._request("GET", f"{BASE_URL}/generation", params={"id": generation_id}).get("data", {})

    # ---- account / model info ----------------------------------------------------

    def key_info(self) -> dict:
        """Info about your API key: label, credits used, limit, ..."""
        return self._request("GET", f"{BASE_URL}/key").get("data", {})

    def credits(self) -> dict:
        """Account balance: {"total_credits": ..., "total_usage": ...} in USD."""
        return self._request("GET", f"{BASE_URL}/credits").get("data", {})

    @staticmethod
    def list_models(output_modalities: str = "text") -> list[dict]:
        return fetch_models(output_modalities)

    # ---- internals ---------------------------------------------------------------

    def _payload(self, messages: list[dict], model: str | None, params: dict) -> dict:
        payload = {"model": resolve_model(model or self.default_model), "messages": messages}
        payload.update({k: v for k, v in params.items() if v is not None})
        return payload

    def _request(self, method: str, url: str, body: dict | None = None, params: dict | None = None) -> dict:
        resp = self.session.request(method, url, json=body, params=params, timeout=self.timeout)
        _raise_for_error(resp)
        try:
            data = resp.json()
        except ValueError:
            raise OpenRouterError(f"Unexpected response from OpenRouter: {resp.text[:300]!r}") from None
        # A bare {"error": ...} body is a failure; job objects (video status) carry their own error field.
        if isinstance(data, dict) and "error" in data and not ({"answers", "status"} & data.keys()):
            err = data["error"]
            raise OpenRouterError(err.get("message", str(err)) if isinstance(err, dict) else str(err))
        return data
