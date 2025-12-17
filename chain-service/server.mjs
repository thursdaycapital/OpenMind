import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import { ethers } from "ethers";

const PORT = Number(process.env.CHAIN_SERVICE_PORT || "8790");

function normalizeRpcUrl(rpcUrl) {
  if (typeof rpcUrl !== "string" || !rpcUrl) return rpcUrl;
  if (rpcUrl.startsWith("http://") || rpcUrl.startsWith("https://")) return rpcUrl;
  // Most public RPC endpoints are https.
  return `https://${rpcUrl}`;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function handleExecute(payload) {
  const type = payload?.type;

  // Default envs: you can set these once and omit in each request.
  const rpcUrl = normalizeRpcUrl(payload?.rpc_url || process.env.RPC_URL);
  if (!rpcUrl) throw new Error("Missing rpc_url (or env RPC_URL)");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const expectedChainId =
    payload?.expected_chain_id ?? process.env.EXPECTED_CHAIN_ID ?? null;
  if (expectedChainId) {
    const network = await provider.getNetwork();
    const want = BigInt(String(expectedChainId));
    if (network.chainId !== want) {
      throw new Error(
        `Unexpected chainId: got ${network.chainId.toString()} want ${want.toString()}`,
      );
    }
  }

  // ---- Read-only helpers (no private key required) ----
  if (type === "get_code") {
    const address = payload?.address;
    if (typeof address !== "string" || !address) throw new Error("Missing address");
    const code = await provider.getCode(address);
    return {
      ok: true,
      type,
      address,
      code_len: code.length,
      is_contract: code !== "0x",
    };
  }

  if (type === "erc20_metadata") {
    const token = payload?.token_address;
    if (typeof token !== "string" || !token) throw new Error("Missing token_address");
    const abi = [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function totalSupply() view returns (uint256)",
    ];
    const c = new ethers.Contract(token, abi, provider);
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      c.name(),
      c.symbol(),
      c.decimals(),
      c.totalSupply(),
    ]);
    return {
      ok: true,
      type,
      token_address: token,
      name,
      symbol,
      decimals: Number(decimals),
      total_supply: totalSupply.toString(),
    };
  }

  // ---- Write actions (require private key) ----
  const privateKey = payload?.private_key || process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("Missing private_key (or env PRIVATE_KEY)");
  const wallet = new ethers.Wallet(privateKey, provider);

  if (type === "transfer_native") {
    const to = payload?.to;
    const amountEth = payload?.amount_eth;
    if (typeof to !== "string" || !to) throw new Error("Missing to");
    if (typeof amountEth !== "string" || !amountEth) {
      throw new Error("Missing amount_eth (string), e.g. \"0.001\"");
    }
    const value = ethers.parseEther(amountEth);
    const tx = await wallet.sendTransaction({ to, value });
    const receipt = await tx.wait();
    return {
      ok: true,
      type,
      from: wallet.address,
      to,
      value_wei: value.toString(),
      tx_hash: tx.hash,
      receipt_status: receipt?.status ?? null,
    };
  }

  if (type === "transfer_erc20") {
    const token = payload?.token_address;
    const to = payload?.to;
    const amount = payload?.amount; // string
    const decimals = payload?.decimals ?? 6;
    if (typeof token !== "string" || !token) throw new Error("Missing token_address");
    if (typeof to !== "string" || !to) throw new Error("Missing to");
    if (typeof amount !== "string" || !amount) {
      throw new Error('Missing amount (string), e.g. "1.5"');
    }
    const d = Number(decimals);
    if (!Number.isFinite(d) || d < 0 || d > 36) throw new Error("Invalid decimals");

    const abi = [
      "function transfer(address to, uint256 amount) returns (bool)",
    ];
    const contract = new ethers.Contract(token, abi, wallet);
    const value = ethers.parseUnits(amount, d);
    const tx = await contract.transfer(to, value);
    const receipt = await tx.wait();
    return {
      ok: true,
      type,
      from: wallet.address,
      token_address: token,
      to,
      amount_units: value.toString(),
      decimals: d,
      tx_hash: tx.hash,
      receipt_status: receipt?.status ?? null,
    };
  }

  if (type === "transfer_from_erc20") {
    const token = payload?.token_address;
    const from = payload?.from;
    const to = payload?.to;
    const amount = payload?.amount; // string
    const decimals = payload?.decimals ?? 6;
    if (typeof token !== "string" || !token) throw new Error("Missing token_address");
    if (typeof from !== "string" || !from) throw new Error("Missing from");
    if (typeof to !== "string" || !to) throw new Error("Missing to");
    if (typeof amount !== "string" || !amount) {
      throw new Error('Missing amount (string), e.g. "1.5"');
    }
    const d = Number(decimals);
    if (!Number.isFinite(d) || d < 0 || d > 36) throw new Error("Invalid decimals");

    const abi = [
      "function transferFrom(address from, address to, uint256 amount) returns (bool)",
    ];
    const contract = new ethers.Contract(token, abi, wallet);
    const value = ethers.parseUnits(amount, d);
    const tx = await contract.transferFrom(from, to, value);
    const receipt = await tx.wait();
    return {
      ok: true,
      type,
      relayer: wallet.address,
      from,
      token_address: token,
      to,
      amount_units: value.toString(),
      decimals: d,
      tx_hash: tx.hash,
      receipt_status: receipt?.status ?? null,
    };
  }

  if (type === "contract_call") {
    const to = payload?.to;
    const abi = payload?.abi;
    const method = payload?.method;
    const args = payload?.args ?? [];
    const valueEth = payload?.value_eth ?? "0";

    if (typeof to !== "string" || !to) throw new Error("Missing to (contract)");
    if (!Array.isArray(abi)) throw new Error("Missing abi (array)");
    if (typeof method !== "string" || !method) throw new Error("Missing method");
    if (!Array.isArray(args)) throw new Error("args must be an array");

    const contract = new ethers.Contract(to, abi, wallet);
    const value = ethers.parseEther(String(valueEth));
    const tx = await contract[method](...args, { value });
    const receipt = await tx.wait();
    return {
      ok: true,
      type,
      from: wallet.address,
      contract: to,
      method,
      args,
      value_wei: value.toString(),
      tx_hash: tx.hash,
      receipt_status: receipt?.status ?? null,
    };
  }

  // Swap + NFT mint are covered via contract_call (router / mint function).
  throw new Error(
    `Unsupported type: ${type}. Use "get_code", "erc20_metadata", "transfer_native", "transfer_erc20", "transfer_from_erc20", or "contract_call".`,
  );
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/execute") {
      // Optional shared secret for local-only control
      const configured = process.env.CHAIN_SERVICE_SHARED_SECRET;
      if (configured) {
        const got = req.headers["x-chain-secret"];
        if (got !== configured) {
          return json(res, 401, { ok: false, error: "Invalid x-chain-secret" });
        }
      }

      const payload = await readJson(req);
      const result = await handleExecute(payload);
      return json(res, 200, result);
    }

    return json(res, 404, { error: "Not Found" });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[chain-service] listening on http://127.0.0.1:${PORT}`);
});


