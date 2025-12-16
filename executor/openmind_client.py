import os
from typing import Any, Dict, Optional

import httpx


DEFAULT_OPENMIND_URL = "https://api.openmind.org/api/core/openai/chat/completions"


def get_openmind_api_key() -> Optional[str]:
    return os.getenv("OM_API_KEY") or os.getenv("OPENMIND_API_KEY")


async def chat_completions(
    *,
    api_key: str,
    body: Dict[str, Any],
    url: str = DEFAULT_OPENMIND_URL,
    timeout_s: float = 60.0,
) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        r = await client.post(
            url,
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {api_key}",
            },
            json=body,
        )
        # Return both status + parsed json/text for debugging.
        try:
            payload = r.json()
        except Exception:
            payload = {"raw": r.text}
        return {"status": r.status_code, "data": payload}


