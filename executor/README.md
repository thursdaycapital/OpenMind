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

### Endpoints

- `GET /healthz`: health check
- `POST /execute`: signed gateway requests
- `WS /ws`: local "conversation" debug socket
  - send text to speak
  - or JSON `{"type":"chat","text":"..."}`
  - list 30 test sentences: `{"type":"tests"}`
  - auto speak 30 test sentences: `{"type":"run_tests"}`

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


