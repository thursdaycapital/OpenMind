import hmac
import hashlib
import json
import os
import re
from typing import Any, Dict, Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi import WebSocket, WebSocketDisconnect

from chain_client import chain_execute
from openmind_client import chat_completions, get_openmind_api_key
from speech import speak
from test_sentences import TEST_SENTENCES

EXECUTOR_SHARED_SECRET = os.getenv("EXECUTOR_SHARED_SECRET", "")
EXECUTOR_CHAIN_LOCAL_TOKEN = os.getenv("EXECUTOR_CHAIN_LOCAL_TOKEN", "")
DEFAULT_RPC_URL = (os.getenv("DEFAULT_RPC_URL") or "https://rpc.testnet.arc.network").strip()
DEFAULT_CHAIN_ID = int(os.getenv("DEFAULT_CHAIN_ID") or "5042002")
DEFAULT_USDC_ADDRESS = (os.getenv("DEFAULT_USDC_ADDRESS") or "0x3600000000000000000000000000000000000000").strip()
EXECUTOR_ENABLE_CHAIN_FROM_GATEWAY = (os.getenv("EXECUTOR_ENABLE_CHAIN_FROM_GATEWAY") or "false").lower() in (
    "1",
    "true",
    "yes",
)

app = FastAPI(title="OpenMind Local Executor", version="0.1.0")


def _hmac_sha256_hex(secret: str, data: str) -> str:
    return hmac.new(secret.encode("utf-8"), data.encode("utf-8"), hashlib.sha256).hexdigest()


def _safe_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))

_ADDR_RE = re.compile(r"(0x[a-fA-F0-9]{40})")
_AMOUNT_RE = re.compile(r"([0-9]+(?:\.[0-9]+)?)")
_TIMES_RE = re.compile(r"(?:转|转账)\s*([0-9]{1,4})\s*次")


def _parse_cn_transfer(text: str) -> Optional[Dict[str, Any]]:
    """
    Very small Chinese intent parser for transfers.

    Supported examples:
      - 转 1 USDC 到 0xabc...
      - 转账 0.5 usdc 给 0xabc...
      - 转 0.001 ETH 到 0xabc...
    """

    t = text.strip()
    if not t:
        return None

    # Must contain a destination address
    m_addr = _ADDR_RE.search(t)
    if not m_addr:
        return None
    to = m_addr.group(1)

    # Optional: how many times
    times = 1
    m_times = _TIMES_RE.search(t)
    if m_times:
        try:
            times = max(1, int(m_times.group(1)))
        except Exception:
            times = 1

    # Must contain a number (amount)
    m_amt = _AMOUNT_RE.search(t)
    if not m_amt:
        return None
    amount = m_amt.group(1)

    lower = t.lower()
    is_usdc = "usdc" in lower
    is_eth = ("eth" in lower) or ("原生" in t) or ("主币" in t)

    if is_usdc:
        return {
            "type": "transfer_erc20",
            "rpc_url": DEFAULT_RPC_URL,
            "expected_chain_id": DEFAULT_CHAIN_ID,
            "token_address": DEFAULT_USDC_ADDRESS,
            "to": to,
            "amount": amount,
            "decimals": 6,
            "times": times,
        }

    if is_eth:
        return {
            "type": "transfer_native",
            "rpc_url": DEFAULT_RPC_URL,
            "expected_chain_id": DEFAULT_CHAIN_ID,
            "to": to,
            "amount_eth": amount,
            "times": times,
        }

    # If user didn't specify token, we treat it as unknown (ask for clarification)
    return {"_needs_token": True, "to": to, "amount": amount}


def _extract_commands(openmind_response: Any) -> list[Dict[str, Any]]:
    """
    Best-effort extractor for OM1/OpenMind style command outputs.

    Supported shapes (best effort):
    - {"commands":[{"type":"move","value":"..."}]}
    - {"commands":[{"type":"chain_execute","value":{...}}]}
    - OpenAI-like: {"choices":[{"message":{"content":"..."}}]}  (JSON list or JSON object in content)
    """

    if not openmind_response:
        return []

    if isinstance(openmind_response, dict):
        cmds = openmind_response.get("commands")
        if isinstance(cmds, list):
            out: list[Dict[str, Any]] = []
            for c in cmds:
                if isinstance(c, dict) and isinstance(c.get("type"), str):
                    out.append(c)
            return out

        # OpenAI-ish message.content that might contain JSON
        try:
            content = (
                openmind_response.get("choices", [{}])[0]
                .get("message", {})
                .get("content", None)
            )
        except Exception:
            content = None
        if isinstance(content, str) and content.strip():
            s = content.strip()
            # If model returned JSON in plain text, try parse.
            try:
                parsed = json.loads(s)
            except Exception:
                return []
            if isinstance(parsed, list):
                return [c for c in parsed if isinstance(c, dict) and isinstance(c.get("type"), str)]
            if isinstance(parsed, dict) and isinstance(parsed.get("type"), str):
                return [parsed]
            if isinstance(parsed, dict) and isinstance(parsed.get("commands"), list):
                return [c for c in parsed["commands"] if isinstance(c, dict) and isinstance(c.get("type"), str)]

    return []


async def _execute_chain_command(value: Any) -> Dict[str, Any]:
    """
    Execute a chain command where value is either:
      - dict payload for chain-service (recommended)
      - JSON string payload
    """

    payload: Any = value
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            return {"ok": False, "error": "chain_execute value must be JSON object or JSON string"}
    if not isinstance(payload, dict):
        return {"ok": False, "error": "chain_execute payload must be an object"}

    # Support batch execution if payload includes "times"
    times = int(payload.get("times") or 1)
    times = max(1, min(times, 50))
    base = dict(payload)
    base.pop("times", None)

    results = []
    for i in range(times):
        r = await chain_execute(base)
        results.append({"index": i + 1, "total": times, "result": r})
    return {"ok": True, "times": times, "results": results}


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

    executed: list[Dict[str, Any]] = []
    if EXECUTOR_ENABLE_CHAIN_FROM_GATEWAY:
        cmds = _extract_commands(openmind_response)
        for c in cmds:
            ctype = c.get("type")
            # Accept either "value" or "payload"
            cvalue = c.get("value", c.get("payload"))
            if ctype in ("chain_execute", "wallet_send", "wallet_sign"):
                executed.append(
                    {
                        "type": "chain_execute",
                        "input": cvalue,
                        "output": await _execute_chain_command(cvalue),
                    }
                )

    return {
        "accepted": True,
        "openmind_status": openmind_status,
        "note": "MVP executor: not executing hardware actions yet (only returns payload).",
        "openmind_response_preview": openmind_response,
        "executed": executed,
    }


@app.post("/chain/execute")
async def chain_execute_http(
    req: Request,
    x_local_token: Optional[str] = Header(default=None),
):
    """
    Local chain execution endpoint.

    If you set:
      EXECUTOR_CHAIN_LOCAL_TOKEN=some-secret
    then requests must include:
      x-local-token: some-secret
    """

    if EXECUTOR_CHAIN_LOCAL_TOKEN:
        if not x_local_token or x_local_token != EXECUTOR_CHAIN_LOCAL_TOKEN:
            raise HTTPException(status_code=401, detail="Invalid x-local-token.")

    try:
        payload = await req.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body.")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object.")

    result = await chain_execute(payload)
    return {"ok": True, "chain_result": result}


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
        pending_chain_payload: Optional[Dict[str, Any]] = None
        await ws.send_json(
            {
                "type": "hello",
                "message": "已连接。你可以直接中文对话，或发送 JSON 指令。\n"
                "例：转 1 USDC 到 0x...\n"
                "或：{\"type\":\"chat\",\"text\":\"...\"} / {\"type\":\"chain_execute\",\"payload\":{...}}",
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

            if obj and isinstance(obj, dict) and obj.get("type") == "chain_execute":
                payload = obj.get("payload")
                if not isinstance(payload, dict):
                    await ws.send_json(
                        {
                            "type": "error",
                            "error": "Missing payload (object). Use {\"type\":\"chain_execute\",\"payload\":{...}}",
                        }
                    )
                    continue
                result = await chain_execute(payload)
                await ws.send_json({"type": "chain_result", "result": result})
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
            if not text:
                continue

            # ---- Chinese conversational control for chain transfers ----
            if text in ("取消", "算了", "不转了", "撤销"):
                pending_chain_payload = None
                await ws.send_json({"type": "cancelled", "message": "已取消。"})
                continue

            if text in ("确认", "确定", "是", "yes", "y") and pending_chain_payload:
                times = int(pending_chain_payload.get("times") or 1)
                times = max(1, min(times, 50))  # avoid accidental huge batches

                await ws.send_json(
                    {
                        "type": "info",
                        "message": f"已确认，准备提交 {times} 笔交易…",
                        "times": times,
                    }
                )

                # Execute sequentially for nonce safety.
                base = dict(pending_chain_payload)
                base.pop("times", None)
                results = []
                for i in range(times):
                    await ws.send_json({"type": "progress", "index": i + 1, "total": times})
                    r = await chain_execute(base)
                    results.append(r)
                    await ws.send_json({"type": "chain_result", "index": i + 1, "total": times, "result": r})

                pending_chain_payload = None
                await ws.send_json({"type": "done", "count": times, "results_count": len(results)})
                continue

            parsed = _parse_cn_transfer(text)
            if parsed and parsed.get("_needs_token"):
                await ws.send_json(
                    {
                        "type": "need_more",
                        "message": "我识别到了金额和收款地址，但没看到币种。请说：转 X USDC 到 0x... 或 转 X ETH 到 0x...",
                        "to": parsed.get("to"),
                        "amount": parsed.get("amount"),
                    }
                )
                continue

            if parsed and parsed.get("type") in ("transfer_erc20", "transfer_native"):
                pending_chain_payload = parsed
                if parsed["type"] == "transfer_erc20":
                    times = int(parsed.get("times") or 1)
                    await ws.send_json(
                        {
                            "type": "confirm",
                            "message": f"确认转账：向 {parsed['to']} 转 {parsed['amount']} USDC（测试网），共 {times} 次。回复“确认”执行，回复“取消”放弃。",
                            "payload": parsed,
                        }
                    )
                else:
                    times = int(parsed.get("times") or 1)
                    await ws.send_json(
                        {
                            "type": "confirm",
                            "message": f"确认转账：向 {parsed['to']} 转 {parsed['amount_eth']} ETH（测试网），共 {times} 次。回复“确认”执行，回复“取消”放弃。",
                            "payload": parsed,
                        }
                    )
                continue

            # Otherwise treat as "speak"
            speak(text)
            await ws.send_json({"type": "spoken", "text": text})
    except WebSocketDisconnect:
        return


