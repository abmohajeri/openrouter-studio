"""Offline tests for the library helpers and the local web server.

    python -m unittest discover tests

They never call OpenRouter: chats and media go to a temporary folder.
"""

from __future__ import annotations

import http.client
import json
import os
import stat
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app  # noqa: E402
import openrouter_client as orc  # noqa: E402


class LibraryTests(unittest.TestCase):
    def test_parse_json_reply(self):
        self.assertEqual(orc.parse_json_reply('```json\n{"a": 1,}\n```'), {"a": 1})
        self.assertEqual(orc.parse_json_reply('Sure! {"ok": true} hope that helps'), {"ok": True})
        self.assertEqual(orc.parse_json_reply("[1, 2]"), [1, 2])
        with self.assertRaises(orc.OpenRouterError):
            orc.parse_json_reply("no json here")

    def test_resolve_model(self):
        self.assertEqual(orc.resolve_model(" Claude "), orc.MODEL_ALIASES["claude"])
        self.assertEqual(orc.resolve_model("openai/gpt-x"), "openai/gpt-x")

    def test_save_api_key(self):
        with tempfile.TemporaryDirectory() as d:
            env = Path(d) / ".env"
            env.write_text("OTHER=1\nOPENROUTER_API_KEY=old\nOPENROUTER_API_KEY_BACKUP=keep\n")
            old = os.environ.get("OPENROUTER_API_KEY")
            try:
                orc.save_api_key("  sk-new  ", env)
                lines = env.read_text().splitlines()
                self.assertEqual(lines, ["OTHER=1", "OPENROUTER_API_KEY_BACKUP=keep", "OPENROUTER_API_KEY=sk-new"])
                self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)
                with self.assertRaises(ValueError):
                    orc.save_api_key("sk-a\nINJECTED=1", env)
            finally:
                if old is None:
                    os.environ.pop("OPENROUTER_API_KEY", None)
                else:
                    os.environ["OPENROUTER_API_KEY"] = old

    def test_pcm16_to_wav_header(self):
        wav = orc.pcm16_to_wav(b"\x00\x00" * 10)
        self.assertTrue(wav.startswith(b"RIFF") and wav[8:12] == b"WAVE")
        self.assertEqual(len(wav), 44 + 20)

    def test_slim_pricing(self):
        out = app.slim_pricing({"prompt": "0.000001", "completion": "-1", "discount": 0, "junk": "x",
                                "overrides": [{"prompt": "0.5", "min_context": 200000}]})
        self.assertEqual(out["prompt"], 1e-6)
        self.assertEqual(out["completion"], -1)
        self.assertNotIn("junk", out)
        self.assertNotIn("discount", out)
        self.assertEqual(out["overrides"], [{"prompt": 0.5, "min_context": 200000}])


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls._saved = (app.CHATS_DIR, app.MEDIA_DIR)
        app.CHATS_DIR, app.MEDIA_DIR = root / "chats", root / "media"
        app.CHATS_DIR.mkdir()
        app.MEDIA_DIR.mkdir()
        cls.server = app.StudioServer(("127.0.0.1", 0), app.Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        app.CHATS_DIR, app.MEDIA_DIR = cls._saved
        cls.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": f"localhost:{self.port}"}
        if body is not None:
            h["Content-Type"] = "application/json"
            body = body if isinstance(body, (bytes, str)) else json.dumps(body)
        h.update(headers or {})
        conn.request(method, path, body=body, headers=h)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, data, resp

    def test_foreign_host_and_origin_are_rejected(self):
        status, _, _ = self.request("GET", "/api/chats", headers={"Host": "evil.example"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("PUT", "/api/chats/x", {"a": 1}, headers={"Origin": "http://localhost:3000"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("PUT", "/api/chats/x", {"a": 1}, headers={"Origin": f"http://localhost:{self.port}"})
        self.assertEqual(status, 200)
        self.request("DELETE", "/api/chats/x", {})

    def test_non_object_body_is_a_clean_400(self):
        for path in ("/api/chat", "/api/decisions"):
            status, data, _ = self.request("POST", path, "[1, 2]")
            self.assertEqual(status, 400, path)
            self.assertIn("error", json.loads(data))

    def test_concurrent_saves_of_one_chat(self):
        chat = {"title": "t", "messages": [{"role": "user", "content": "x" * 50_000}]}
        with ThreadPoolExecutor(16) as pool:
            statuses = list(pool.map(lambda _: self.request("PUT", "/api/chats/race", chat)[0], range(40)))
        self.assertEqual(statuses, [200] * 40)
        self.assertEqual(list(app.CHATS_DIR.glob("*.tmp")), [])
        status, data, _ = self.request("GET", "/api/chats/race")
        self.assertEqual(json.loads(data)["title"], "t")
        self.request("DELETE", "/api/chats/race", {})

    def test_delete_keeps_media_another_chat_uses(self):
        (app.MEDIA_DIR / "shared.png").write_bytes(b"png")
        (app.MEDIA_DIR / "own.png").write_bytes(b"png")
        self.request("PUT", "/api/chats/a1", {"messages": [{"images": ["/media/shared.png", "/media/own.png"]}]})
        self.request("PUT", "/api/chats/b1", {"messages": [{"images": ["/media/shared.png"]}]})
        self.request("DELETE", "/api/chats/a1", {})
        self.assertTrue((app.MEDIA_DIR / "shared.png").exists())
        self.assertFalse((app.MEDIA_DIR / "own.png").exists())
        self.request("DELETE", "/api/chats/b1", {})
        self.assertFalse((app.MEDIA_DIR / "shared.png").exists())

    def test_range_requests(self):
        (app.MEDIA_DIR / "clip.mp4").write_bytes(bytes(range(100)))
        status, data, resp = self.request("GET", "/media/clip.mp4", headers={"Range": "bytes=10-19"})
        self.assertEqual((status, data), (206, bytes(range(10, 20))))
        self.assertEqual(resp.getheader("Content-Range"), "bytes 10-19/100")
        status, data, _ = self.request("GET", "/media/clip.mp4", headers={"Range": "bytes=-5"})
        self.assertEqual(data, bytes(range(95, 100)))
        status, _, _ = self.request("GET", "/media/clip.mp4", headers={"Range": "bytes=500-"})
        self.assertEqual(status, 416)

    def test_static_files_cannot_escape_web_dir(self):
        status, _, _ = self.request("GET", "/../app.py")
        self.assertEqual(status, 404)
        status, _, _ = self.request("GET", "/%2e%2e/app.py")
        self.assertEqual(status, 404)
        status, data, _ = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"<html", data.lower())

    def test_bad_ids_are_rejected(self):
        self.assertEqual(self.request("GET", "/api/providers?model=../../key")[0], 400)
        self.assertEqual(self.request("GET", "/api/videos/abc/content?index=x")[0], 400)
        self.assertEqual(self.request("GET", "/api/generation?id=nope")[0], 400)
        self.assertEqual(self.request("PUT", "/api/chats/bad.id", {})[0], 400)


if __name__ == "__main__":
    unittest.main()
