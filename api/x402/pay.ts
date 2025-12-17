import { loadX402State, saveX402State, x402ApplyPay } from "../_lib/x402Store";
import { readJsonBody } from "../_lib/readJsonBody";

function sendJson(res: any, status: number, payload: any) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object") {
      return sendJson(res, 400, { error: "Body must be an object" });
    }
    const { state } = await loadX402State();
    const { state: next, payment } = x402ApplyPay(state, {
      to: body.to,
      amount_usdc: body.amount_usdc,
      memo: body.memo,
    });
    const saved = await saveX402State(next);
    return sendJson(res, 200, {
      ok: true,
      sandbox: true,
      payment,
      balance_usdc: next.balance_usdc,
      storage: saved.storage,
    });
  } catch (e: any) {
    const msg = String(e?.message || e);
    const status = msg.includes("authorization is disabled") ? 403 : 400;
    return sendJson(res, status, { error: msg });
  }
}


