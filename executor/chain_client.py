import os
from typing import Any, Dict, Optional

import httpx


def _chain_service_url() -> str:
    return (os.getenv("CHAIN_SERVICE_URL") or "http://127.0.0.1:8790").rstrip("/")


def _chain_service_secret() -> Optional[str]:
    v = os.getenv("CHAIN_SERVICE_SHARED_SECRET")
    return v if v else None


async def chain_execute(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Forward a chain execution payload to the local chain service.

    Env:
      - CHAIN_SERVICE_URL: default http://127.0.0.1:8790
      - CHAIN_SERVICE_SHARED_SECRET: if set, sent as header x-chain-secret
    """

    url = f"{_chain_service_url()}/execute"
    headers: Dict[str, str] = {"content-type": "application/json"}
    secret = _chain_service_secret()
    if secret:
        headers["x-chain-secret"] = secret

    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(url, headers=headers, json=payload)
        try:
            data = r.json()
        except Exception:
            data = {"raw": r.text}
        return {"status": r.status_code, "data": data}


