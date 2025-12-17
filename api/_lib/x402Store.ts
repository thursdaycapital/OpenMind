type X402Payment = {
  id: string;
  ts: number;
  to: string;
  amount_usdc: string;
  memo?: string | null;
};

export type X402State = {
  wallet_id: string;
  balance_usdc: string;
  auth_enabled: boolean;
  created_at: number;
  payments: X402Payment[];
};

type StorageKind = "kv" | "memory";

const KV_URL =
  ((globalThis as any)?.process?.env?.KV_REST_API_URL as string) ||
  ((globalThis as any)?.process?.env?.UPSTASH_REDIS_REST_URL as string) ||
  "";
const KV_TOKEN =
  ((globalThis as any)?.process?.env?.KV_REST_API_TOKEN as string) ||
  ((globalThis as any)?.process?.env?.UPSTASH_REDIS_REST_TOKEN as string) ||
  "";

const KEY = "x402_sandbox_state_v1";

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function randomHex(bytes: number) {
  // Node.js runtime in Vercel functions provides crypto.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require("crypto");
  return crypto.randomBytes(bytes).toString("hex");
}

function parseAmount(v: any): number {
  const n = Number(String(v ?? "").trim());
  if (!Number.isFinite(n)) throw new Error("Invalid amount.");
  if (n <= 0) throw new Error("Amount must be > 0.");
  if (n > 1_000_000) throw new Error("Amount too large for sandbox.");
  return n;
}

function fmtUsdc(n: number) {
  // keep it human-friendly for demo
  const s = n.toFixed(6);
  return s.replace(/\.?0+$/, "");
}

function freshState(): X402State {
  return {
    wallet_id: "x402_sandbox_" + randomHex(8),
    balance_usdc: "100.0",
    auth_enabled: false,
    created_at: nowSec(),
    payments: [],
  };
}

async function kvGet(): Promise<X402State | null> {
  if (!KV_URL || !KV_TOKEN) return null;
  const url = `${KV_URL.replace(/\/$/, "")}/get/${encodeURIComponent(KEY)}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  const v = data?.result;
  if (!v) return null;
  try {
    const parsed = typeof v === "string" ? JSON.parse(v) : v;
    return parsed as X402State;
  } catch {
    return null;
  }
}

async function kvSet(state: X402State) {
  if (!KV_URL || !KV_TOKEN) return false;
  const url = `${KV_URL.replace(/\/$/, "")}/set/${encodeURIComponent(KEY)}`;
  const body = new URLSearchParams();
  body.set("value", JSON.stringify(state));
  const r = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KV_TOKEN}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  return r.ok;
}

function mem(): { state?: X402State } {
  const g = globalThis as any;
  if (!g.__x402Sandbox) g.__x402Sandbox = {};
  return g.__x402Sandbox;
}

export async function loadX402State(): Promise<{
  state: X402State;
  storage: StorageKind;
}> {
  const kv = await kvGet();
  if (kv) return { state: kv, storage: "kv" };

  const m = mem();
  if (!m.state) m.state = freshState();
  return { state: m.state, storage: "memory" };
}

export async function saveX402State(
  state: X402State,
): Promise<{ ok: boolean; storage: StorageKind }> {
  const ok = await kvSet(state);
  if (ok) return { ok: true, storage: "kv" };
  const m = mem();
  m.state = state;
  return { ok: true, storage: "memory" };
}

export function x402StatusView(state: X402State, storage: StorageKind) {
  return {
    ok: true,
    sandbox: true,
    storage,
    wallet: {
      wallet_id: state.wallet_id,
      balance_usdc: state.balance_usdc,
      auth_enabled: state.auth_enabled,
    },
    payments_count: state.payments?.length ?? 0,
  };
}

export function x402ApplyAuthorize(state: X402State, enabled: boolean): X402State {
  return { ...state, auth_enabled: !!enabled };
}

export function x402ApplyFaucet(state: X402State, amount_usdc: any): X402State {
  const amt = parseAmount(amount_usdc);
  const bal = Number(state.balance_usdc || "0");
  return { ...state, balance_usdc: fmtUsdc(bal + amt) };
}

export function x402ApplyPay(
  state: X402State,
  input: { to: any; amount_usdc: any; memo?: any },
): { state: X402State; payment: any } {
  if (!state.auth_enabled) throw new Error("x402 authorization is disabled.");
  const to = String(input.to ?? "").trim();
  if (!to) throw new Error("Missing 'to'.");
  const amt = parseAmount(input.amount_usdc);
  const bal = Number(state.balance_usdc || "0");
  if (bal < amt) throw new Error("Insufficient sandbox balance.");
  const memo = String(input.memo ?? "").trim();

  const payment: X402Payment = {
    id: "pay_" + randomHex(10),
    ts: nowSec(),
    to,
    amount_usdc: fmtUsdc(amt),
    memo: memo || null,
  };
  const payments = Array.isArray(state.payments) ? state.payments.slice() : [];
  payments.push(payment);
  const next: X402State = {
    ...state,
    balance_usdc: fmtUsdc(bal - amt),
    payments: payments.slice(-200),
  };
  return { state: next, payment };
}


