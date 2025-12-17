import { loadX402State, saveX402State, x402ApplyAuthorize } from "../_lib/x402Store";

function sendJson(res: any, status: number, payload: any) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== "object" || typeof body.enabled === "undefined") {
      return sendJson(res, 400, { error: "Body must be { enabled: boolean }" });
    }
    const { state } = await loadX402State();
    const next = x402ApplyAuthorize(state, !!body.enabled);
    const saved = await saveX402State(next);
    return sendJson(res, 200, { ok: true, sandbox: true, auth_enabled: next.auth_enabled, storage: saved.storage });
  } catch (e: any) {
    return sendJson(res, 400, { error: String(e?.message || e) });
  }
}


