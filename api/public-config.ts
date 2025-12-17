type AnyObj = Record<string, any>;

function sendJson(res: any, status: number, payload: any) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/**
 * GET /api/public-config
 *
 * Returns non-secret values needed by the frontend:
 * - chain_id / rpc_url / explorer
 * - usdc_address
 * - relayer_address (spender for USDC approve), if configured
 */
export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });

  const env = ((globalThis as any)?.process?.env ?? {}) as AnyObj;

  const chainId = Number(env.CHAIN_ID || "5042002");
  const rpcUrl = String(env.RPC_URL || "https://rpc.testnet.arc.network");
  const explorer = String(env.EXPLORER_URL || "https://testnet.arcscan.app");
  const usdcAddress = String(
    env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000",
  );
  const relayerAddress = env.RELAYER_ADDRESS ? String(env.RELAYER_ADDRESS) : "";

  return sendJson(res, 200, {
    chain_id: chainId,
    rpc_url: rpcUrl,
    explorer_url: explorer,
    usdc_address: usdcAddress,
    relayer_address: relayerAddress,
  });
}


