import hmac
import hashlib
import json
import os
from typing import Any, Dict, Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi import WebSocket, WebSocketDisconnect

from openmind_client import chat_completions, get_openmind_api_key
from speech import speak
from test_sentences import TEST_SENTENCES

EXECUTOR_SHARED_SECRET = os.getenv("EXECUTOR_SHARED_SECRET", "")

app = FastAPI(title="OpenMind Local Executor", version="0.1.0")


def _hmac_sha256_hex(secret: str, data: str) -> str:
    return hmac.new(secret.encode("utf-8"), data.encode("utf-8"), hashlib.sha256).hexdigest()


def _safe_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/execute")
async def execute(
    req: Request,
    x_om_timestamp: Optional[str] = Header(default=None),
    x_om_signature: Optional[str] = Header(default=None),
):
    """
    Receives signed requests from the Vercel gateway.

    Signature scheme:
      signature = HMAC_SHA256_HEX(EXECUTOR_SHARED_SECRET, f"{timestamp}.{payload_json}")

    Where payload_json is the exact raw JSON string sent as body (no re-serialization).
    """

    if not EXECUTOR_SHARED_SECRET:
        raise HTTPException(
            status_code=500,
            detail="EXECUTOR_SHARED_SECRET is not set on executor.",
        )
    if not x_om_timestamp or not x_om_signature:
        raise HTTPException(status_code=401, detail="Missing signature headers.")

    raw = await req.body()
    try:
        payload_str = raw.decode("utf-8")
    except Exception:
        raise HTTPException(status_code=400, detail="Body must be UTF-8 JSON.")

    expected = _hmac_sha256_hex(EXECUTOR_SHARED_SECRET, f"{x_om_timestamp}.{payload_str}")
    if not _safe_equal(expected, x_om_signature):
        raise HTTPException(status_code=401, detail="Invalid signature.")

    try:
        payload: Dict[str, Any] = json.loads(payload_str)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body.")

    # ---- TODO: Map OpenMind output to robot actions here ----
    # For MVP, we just log/return the payload.
    # If you already run OM1 locally, this is where you'd call your action layer (move/speak/etc.).
    openmind_status = payload.get("openmind_status")
    openmind_response = payload.get("openmind_response")

    return {
        "accepted": True,
        "openmind_status": openmind_status,
        "note": "MVP executor: not executing hardware actions yet (only returns payload).",
        "openmind_response_preview": openmind_response,
    }


@app.websocket("/ws")
async def ws_conversation(ws: WebSocket):
    """
    Lightweight "conversation" mode inspired by the official tutorial:
    - Connect via websocket
    - Send text
    - Executor speaks it (local TTS) OR, if OM_API_KEY is set on this machine,
      it will call OpenMind and speak the model response.

    This is meant for local debugging (like `wscat -c ws://localhost:8765` in docs),
    not for exposing to the public internet.
    """

    await ws.accept()
    try:
        await ws.send_json(
            {
                "type": "hello",
                "message": "Connected. Send text to speak, or JSON: {\"type\":\"chat\",\"text\":\"...\"}.",
                "chat_enabled": bool(get_openmind_api_key()),
            }
        )
        while True:
            msg = await ws.receive_text()

            # Allow either raw text (speak) or JSON messages
            try:
                obj = json.loads(msg)
            except Exception:
                obj = None

            if obj and isinstance(obj, dict) and obj.get("type") == "tests":
                await ws.send_json({"type": "tests", "sentences": TEST_SENTENCES})
                continue

            if obj and isinstance(obj, dict) and obj.get("type") == "run_tests":
                # Speak them in order (best-effort). This is purely for local debugging.
                for s in TEST_SENTENCES:
                    speak(s)
                    await ws.send_json({"type": "spoken", "text": s})
                await ws.send_json({"type": "done"})
                continue

            if obj and isinstance(obj, dict) and obj.get("type") == "chat":
                text = str(obj.get("text") or "").strip()
                if not text:
                    await ws.send_json({"type": "error", "error": "Missing text"})
                    continue

                api_key = get_openmind_api_key()
                if not api_key:
                    await ws.send_json(
                        {
                            "type": "error",
                            "error": "Chat disabled: set OM_API_KEY on the executor machine.",
                        }
                    )
                    continue

                # Minimal OpenAI-compatible body; you can expand this to match your config.
                body = {
                    "model": obj.get("model") or "gpt-4.1-mini",
                    "messages": [
                        {"role": "system", "content": obj.get("system") or "You are a helpful robot."},
                        {"role": "user", "content": text},
                    ],
                }
                result = await chat_completions(api_key=api_key, body=body)
                await ws.send_json({"type": "openmind_result", "result": result})

                # Best-effort extract assistant text
                assistant_text = ""
                try:
                    assistant_text = (
                        result["data"]["choices"][0]["message"]["content"]  # type: ignore[index]
                    )
                except Exception:
                    assistant_text = json.dumps(result["data"])

                if assistant_text:
                    speak(assistant_text)
                    await ws.send_json({"type": "spoken", "text": assistant_text})
                continue

            # Default: speak what you typed
            text = msg.strip()
            if text:
                speak(text)
                await ws.send_json({"type": "spoken", "text": text})
    except WebSocketDisconnect:
        return


