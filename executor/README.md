## Local Executor (runs near the robot)

This service receives signed requests from the Vercel gateway and is the only component that should be able to touch hardware / run OM1 locally.

### Run (with `uv`)

```bash
cd executor
uv run uvicorn app:app --host 0.0.0.0 --port 8787
```

### Environment

- `EXECUTOR_SHARED_SECRET`: shared HMAC secret (must match Vercel `EXECUTOR_SHARED_SECRET`)
- `EXECUTOR_TTS`: `mac_say` (macOS), `print` (default), or `none`
- `OM_API_KEY`: optional; enables `/ws` chat mode (calls OpenMind and speaks the reply)
- `CHAIN_SERVICE_URL`: optional; default `http://127.0.0.1:8790`
- `CHAIN_SERVICE_SHARED_SECRET`: optional; forwarded to chain-service as `x-chain-secret`
- `EXECUTOR_CHAIN_LOCAL_TOKEN`: optional; if set, `/chain/execute` requires `x-local-token`
- `DEFAULT_RPC_URL`: optional; default `https://rpc.testnet.arc.network`
- `DEFAULT_CHAIN_ID`: optional; default `5042002`
- `DEFAULT_USDC_ADDRESS`: optional; default `0x3600000000000000000000000000000000000000`

### Endpoints

- `GET /healthz`: health check
- `POST /execute`: signed gateway requests
- `POST /chain/execute`: local chain execution (forwards to chain-service)
- `WS /ws`: local "conversation" debug socket
  - send text to speak
  - or JSON `{"type":"chat","text":"..."}`
  - list 30 test sentences: `{"type":"tests"}`
  - auto speak 30 test sentences: `{"type":"run_tests"}`
  - chain execute: `{"type":"chain_execute","payload":{...}}`
  - Chinese transfer (with confirmation):
    - `转 1 USDC 到 0x...` → reply `确认` / `取消`
    - `转 0.001 ETH 到 0x...` → reply `确认` / `取消`

### Local conversation-style test (like the official docs)

The OpenMind docs show using a websocket (`wscat -c ws://localhost:8765`) to type text and test audio output.
In this repo, you can do the same against the executor:

```bash
wscat -c ws://localhost:8787/ws
```

Then type a sentence to speak, or send:

```json
{"type":"chat","text":"Hello, who are you?"}
```


