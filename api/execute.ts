import * as crypto from "crypto";

type AnyObj = Record<string, any>;

function hmacSha256Hex(secret: string, data: string) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

function sendJson(res: any, status: number, payload: any) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/**
 * POST /api/execute
 *
 * Purpose: forward an already-confirmed payload to local executor, without calling OpenMind.
 *
 * Body:
 *  {
 *    "payload": { ... }  // will be sent to executor /execute
 *  }
 */
export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

    const env = ((globalThis as any)?.process?.env ?? {}) as AnyObj;
    const executorUrl = env.EXECUTOR_URL || "";
    const executorSecret = env.EXECUTOR_SHARED_SECRET || "";
    if (!executorUrl) return sendJson(res, 500, { error: "Missing EXECUTOR_URL on Vercel" });
    if (!executorSecret) return sendJson(res, 500, { error: "Missing EXECUTOR_SHARED_SECRET on Vercel" });

    let body: any = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return sendJson(res, 400, { error: "Invalid JSON body" }); }
    }
    const payload = body?.payload;
    if (!payload || typeof payload !== "object") return sendJson(res, 400, { error: "Missing payload (object)" });

    const timestamp = new Date().toISOString();
    const signedPayload = { ...payload, confirmed: true };
    const payloadStr = JSON.stringify(signedPayload);
    const signature = hmacSha256Hex(executorSecret, `${timestamp}.${payloadStr}`);

    const exResp = await fetch(`${executorUrl.replace(/\/$/, "")}/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-om-timestamp": timestamp,
        "x-om-signature": signature,
      },
      body: payloadStr,
    });

    const exText = await exResp.text();
    let exJson: any = null;
    try { exJson = JSON.parse(exText); } catch {}

    return sendJson(res, 200, {
      executor_status: exResp.status,
      executor_response: exJson ?? exText,
    });
  } catch (e: any) {
    return sendJson(res, 500, { error: "Unhandled server error", message: String(e?.message || e) });
  }
}


