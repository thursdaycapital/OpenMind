import { loadX402State, x402StatusView } from "../_lib/x402Store";

function sendJson(res: any, status: number, payload: any) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
    const { state, storage } = await loadX402State();
    return sendJson(res, 200, x402StatusView(state, storage));
  } catch (e: any) {
    return sendJson(res, 500, { error: "Unhandled server error", message: String(e?.message || e) });
  }
}


