import crypto from "node:crypto";

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

function jsonResponse(status: number, body: Json) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

function hmacSha256Hex(secret: string, data: string) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

/**
 * Vercel Serverless Function
 *
 * POST /api/dispatch
 *
 * Headers:
 * - Authorization: Bearer <OM_API_KEY>        (user supplies their own OpenMind API key)
 *
 * Body (JSON):
 * - openmind: { url?: string, body: object }  (required)
 * - forward_to_executor?: boolean             (default true if EXECUTOR_URL is set)
 * - executor_payload?: object                 (optional extra fields to send executor)
 *
 * Response:
 * - openmind_response: any
 * - executor_forwarded?: boolean
 */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const userOmApiKey = getBearerToken(req);
  if (!userOmApiKey) {
    return jsonResponse(401, {
      error:
        "Missing Authorization header. Use: Authorization: Bearer <OM_API_KEY> (user's key).",
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const openmind = body?.openmind;
  const openmindUrl =
    (typeof openmind?.url === "string" && openmind.url) ||
    "https://api.openmind.org/api/core/openai/chat/completions";
  const openmindBody = openmind?.body;
  if (!openmindBody || typeof openmindBody !== "object") {
    return jsonResponse(400, {
      error:
        "Missing openmind.body (object). Provide the payload to send to OpenMind API.",
    });
  }

  // 1) Call OpenMind API using the user's API key (BYOK)
  const omResp = await fetch(openmindUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${userOmApiKey}`,
    },
    body: JSON.stringify(openmindBody),
  });

  const omText = await omResp.text();
  let omJson: any = null;
  try {
    omJson = JSON.parse(omText);
  } catch {
    // leave as text fallback
  }

  // 2) Optionally forward to local executor (the robot lives near hardware)
  const executorUrl = process.env.EXECUTOR_URL || "";
  const executorSecret = process.env.EXECUTOR_SHARED_SECRET || "";
  const shouldForward =
    body?.forward_to_executor !== false && executorUrl.length > 0;

  let executorForwarded = false;
  let executorStatus: number | undefined;
  let executorResponse: any = undefined;

  if (shouldForward) {
    if (!executorSecret) {
      return jsonResponse(500, {
        error:
          "EXECUTOR_URL is set but EXECUTOR_SHARED_SECRET is missing. Configure both on Vercel.",
      });
    }

    const timestamp = new Date().toISOString();
    const payload = {
      timestamp,
      openmind_url: openmindUrl,
      openmind_request: openmindBody,
      openmind_status: omResp.status,
      openmind_response: omJson ?? omText,
      ...((body?.executor_payload && typeof body.executor_payload === "object"
        ? body.executor_payload
        : {}) as object),
    };
    const payloadStr = JSON.stringify(payload);
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
    executorForwarded = true;
    executorStatus = exResp.status;
    const exText = await exResp.text();
    try {
      executorResponse = JSON.parse(exText);
    } catch {
      executorResponse = exText;
    }
  }

  return jsonResponse(200, {
    openmind_status: omResp.status,
    openmind_response: omJson ?? omText,
    executor_forwarded: executorForwarded,
    executor_status: executorStatus,
    executor_response: executorResponse,
  });
}


