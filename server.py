#!/usr/bin/env python3
"""Local proxy + static server for the photo companion web app.

Keeps API keys off the public internet page origin (no browser-to-xAI CORS),
and streams chat tokens as SSE.
"""

from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DEFAULT_CHAT_BASE = "https://api.x.ai/v1"
DEFAULT_TTS_URL = "https://api.x.ai/v1/tts"
PORT = int(os.environ.get("PORT", "8787"))


def _ssl_ctx() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    return ctx


def read_json(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or "0")
    raw = handler.rfile.read(length) if length else b"{}"
    if not raw:
        return {}
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid json: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("json body must be an object")
    return data


def bearer(handler: SimpleHTTPRequestHandler, body: dict) -> str:
    header = handler.headers.get("X-Api-Key") or handler.headers.get("Authorization", "")
    if header.lower().startswith("bearer "):
        header = header[7:]
    key = (header or body.get("apiKey") or os.environ.get("XAI_API_KEY") or "").strip()
    if not key:
        raise ValueError("missing API key — paste it in Settings, or set XAI_API_KEY")
    return key


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send_json(self, code: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_err(self, code: int, message: str) -> None:
        self._send_json(code, {"error": message})

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Api-Key, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] in ("/", "/index.html"):
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/chat":
                self.handle_chat()
                return
            if path == "/api/tts":
                self.handle_tts()
                return
        except ValueError as exc:
            self._send_err(400, str(exc))
            return
        except Exception as exc:  # noqa: BLE001
            self._send_err(500, str(exc))
            return
        self._send_err(404, "not found")

    def handle_chat(self) -> None:
        body = read_json(self)
        key = bearer(self, body)
        base = (body.get("baseUrl") or DEFAULT_CHAT_BASE).rstrip("/")
        model = body.get("model") or "grok-4-latest"
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("messages required")

        payload = {
            "model": model,
            "stream": True,
            "temperature": float(body.get("temperature", 0.9)),
            "messages": messages,
        }
        req = urllib.request.Request(
            base + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
            method="POST",
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        try:
            with urllib.request.urlopen(req, context=_ssl_ctx(), timeout=120) as resp:
                while True:
                    chunk = resp.readline()
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:800]
            msg = json.dumps({"error": f"chat {exc.code}: {detail}"}, ensure_ascii=False)
            self.wfile.write(f"data: {msg}\n\n".encode("utf-8"))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    def handle_tts(self) -> None:
        body = read_json(self)
        key = bearer(self, body)
        text = (body.get("text") or "").strip()
        if not text:
            raise ValueError("text required")
        tts_url = (body.get("ttsUrl") or DEFAULT_TTS_URL).strip()
        language = body.get("language") or "zh"
        voice_id = body.get("voiceId") or body.get("voice_id") or "eve"
        payload = {
            "text": text[:4000],
            "voice_id": voice_id,
            "language": language,
            "output_format": {"codec": "mp3", "sample_rate": 24000, "bit_rate": 128000},
        }
        req = urllib.request.Request(
            tts_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, context=_ssl_ctx(), timeout=90) as resp:
                audio = resp.read()
                ctype = resp.headers.get("Content-Type") or "audio/mpeg"
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:800]
            self._send_err(exc.code, f"tts {exc.code}: {detail}")
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)


def main() -> None:
    if not (STATIC / "index.html").exists():
        sys.exit(f"missing {STATIC / 'index.html'}")
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Photo companion  http://127.0.0.1:{PORT}")
    print("Paste an xAI key in the page settings. Optional env: XAI_API_KEY")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
