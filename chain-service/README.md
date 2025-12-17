## Chain Service (testnet)

This is a local HTTP service that executes onchain actions for the robot/executor.

It uses `ethers` and supports:
- `transfer_native` (send testnet ETH)
- `contract_call` (generic contract method call; can be used for NFT mint / swaps via router contracts)

### Install & run

```bash
cd chain-service
npm install
RPC_URL="https://..." PRIVATE_KEY="0x..." npm start
```

Optional:
- `CHAIN_SERVICE_PORT` (default `8790`)
- `CHAIN_SERVICE_SHARED_SECRET` (if set, requests must include header `x-chain-secret`)
- `EXPECTED_CHAIN_ID` (optional; if set, rejects mismatched networks)

### API

- `GET /healthz`
- `POST /execute`

Example native transfer:

```json
{
  "type": "transfer_native",
  "to": "0xabc...",
  "amount_eth": "0.001"
}
```

Example USDC transfer (ERC20):

```json
{
  "type": "transfer_erc20",
  "token_address": "0xUSDC_CONTRACT",
  "to": "0xabc...",
  "amount": "1.23",
  "decimals": 6
}
```

Example contract call (e.g., mint/swap):

```json
{
  "type": "contract_call",
  "to": "0xContractAddress",
  "abi": [{"type":"function","name":"mint","inputs":[{"name":"to","type":"address"}],"outputs":[],"stateMutability":"nonpayable"}],
  "method": "mint",
  "args": ["0xRecipientAddress"]
}
```


