## OpenMind 方案 A：Vercel 网关（BYOK） + 本地执行端（机器人在你家/办公室）

你想要的目标是：**更多的人用自己的 OpenMind API key**，但机器人动作仍由你本地机器（连接传感器/扬声器/机器人底盘那台“中央电脑”）来执行。

官方 OM1 文档中，运行方式是本地 `uv run src/run.py ...`，并在本机配置 `OM_API_KEY` 或 `config/*.json5` 的 `"api_key"`（以及音视频依赖 `portaudio`、`ffmpeg` 等）。参考：

- [Get started / Installation Guide](https://docs.openmind.org/developing/1_get-started)
- [Tutorials / Conversation](https://docs.openmind.org/examples/conversation)

### 架构

- **Vercel（公网）**：只做“网关/策略层”
  - 接收用户请求（用户自带 `Authorization: Bearer <OM_API_KEY>`）
  - 代表用户调用 OpenMind API
  - 将 OpenMind 输出 **签名** 后转发给你的本地执行端
- **Executor（本地常驻）**：只做“执行层”
  - 校验 Vercel 的 HMAC 签名
  - 将指令映射成机器人动作（当前仓库先做 MVP：回显/本地说话）

### 1) 部署到 Vercel

本仓库的 Vercel 函数为：`api/dispatch.ts`

在 Vercel 项目中配置环境变量：

- `EXECUTOR_URL`: 你的本地执行端公网可达地址（建议走隧道/反向代理），例如 `https://xxxxx.example.com`
- `EXECUTOR_SHARED_SECRET`: 共享密钥（随机字符串），用于 HMAC 签名

### 2) 在本地启动执行端

```bash
cd executor
export EXECUTOR_SHARED_SECRET="same-as-vercel"
export EXECUTOR_TTS="mac_say"   # macOS 用 say；也可 print/none
uv run uvicorn app:app --host 0.0.0.0 --port 8787
```

### 3) 公网用户如何“用自己的 key”

用户调用你的 Vercel 网关：

- URL: `POST /api/dispatch`
- Header: `Authorization: Bearer <用户自己的 OM_API_KEY>`
- Body: 传 `openmind.body`（会被转发到 OpenMind 的 chat/completions endpoint）

#### （推荐给普通用户）网页输入框

本仓库提供了一个最小网页：`public/index.html`  
部署到 Vercel 后，用户直接打开你的域名首页即可看到“API key 输入框”，填入自己的 key 后点击发送。

> 注意：这个输入框不会把 key 写入服务器存储，但 **用户仍应只在信任的域名使用**。

#### 网页里直接“中文对话指挥机器人转账”

首页同样提供了一个“机器人中文对话面板”，它会通过 WebSocket 连接你本地 executor 的 `WS /ws`。

注意：
- 如果网页是在 **https（Vercel）** 打开，浏览器会阻止 `ws://...`（混合内容），你需要提供 **`wss://.../ws`** 地址（例如用 ngrok / Cloudflare Tunnel 暴露 executor）。
- `WS /ws` 是调试通道，不建议长期暴露给公网。

#### 关于“把私钥放在前端输入框”

不会做、也不建议做：**前端输入私钥意味着私钥会暴露给浏览器环境、网页脚本、以及任何中间链路**，风险非常高（即使测试网也容易被滥用）。

推荐两种安全替代：
- **本地 `.env`**：私钥只放在你本机 `chain-service/.env`（不会提交到 GitHub/Vercel）
- **浏览器钱包/用户控钥**：用 MetaMask/Passkey 等在用户侧签名，再把签名结果发送给后端执行（更符合 “user-controlled wallet” 思路，参考 [Circle Build Onchain Experiences](https://developers.circle.com/build-onchain)）

### 4) 本地对话（conversation 风格）调试

官方 conversation 教程里使用 websocket 输入来测试音频输出（例如 `wscat -c ws://localhost:8765`）。参考：
- [Tutorials / Conversation](https://docs.openmind.org/examples/conversation)

本仓库在 executor 提供了 `WS /ws`，你可以本地这样测：

```bash
wscat -c ws://localhost:8787/ws
```

- 直接输入文本：executor 会“说出来”（macOS 用 `say`）或打印
- 或发送 JSON：`{"type":"chat","text":"..."}`
  - 需要在 executor 机器上设置 `OM_API_KEY` 才会调用 OpenMind 并朗读回复

### 安全提示（重要）

- 不要把 executor 的 `/ws` 暴露到公网（它是本地调试用）。
- 对公网只暴露 executor 的 `/execute`，并要求 HMAC 签名（本仓库已实现）。
- 建议在 Vercel 侧做：账号体系、限流、配额、动作白名单（例如禁止移动类指令）。

## （测试网）链上动作：transfer / swap / mint（通过独立 chain-service）

你提到要“机器人自动上链交互”，参考 Circle 的 onchain 能力组合思路（钱包/Paymaster/合规等）：
- [Circle Build Onchain Experiences](https://developers.circle.com/build-onchain)

本仓库提供一个本地 `chain-service`（Node + ethers）作为“链上动作执行器”，executor 通过 `chain_execute` 转发请求。

> 说明：Swap / NFT mint 等都可以用通用 `contract_call` 实现（调用 router 或 NFT 合约的 mint 方法）。

### 启动 chain-service（本地）

```bash
cd chain-service
npm install
npm start
```

### executor 转发到 chain-service

```bash
cd executor
export CHAIN_SERVICE_URL="http://127.0.0.1:8790"
uv run uvicorn app:app --host 127.0.0.1 --port 8787
```

### 本地测试（会返回缺少 RPC/私钥的提示）

```bash
curl -sS http://127.0.0.1:8787/chain/execute \
  -H 'content-type: application/json' \
  -d '{"type":"transfer_native","to":"0x0000000000000000000000000000000000000000","amount_eth":"0.001"}' | cat
```

要在测试网真的发交易，请在 `chain-service` 设置：
- `RPC_URL`
- `PRIVATE_KEY`

## 接入 OM1（让 OM1 的 action 触发链上动作）

官方 OM1 的运行与 conversation 参考：
- [Get started / Installation Guide](https://docs.openmind.org/developing/1_get-started)
- [Tutorials / Conversation](https://docs.openmind.org/examples/conversation)

### 推荐集成形态（最少改动 OM1）

1) **OM1 只负责“思考/输出 commands”**  
   让 OM1（或 OpenMind chat endpoint）输出结构化 `commands`，其中包含：
   - `type: "chain_execute"`
   - `value: { ...链上payload... }`

2) **Vercel 网关转发 OpenMind/OM1 输出到本地 executor**  
   你已经有 `api/dispatch.ts` → executor `/execute` 的签名转发链路。

3) **本地 executor 自动执行 chain_execute**  
   在本仓库里，executor 支持从 `/execute` 的 `openmind_response.commands` 中提取 `chain_execute` 并执行（需要你显式开启环境变量）：

   - `EXECUTOR_ENABLE_CHAIN_FROM_GATEWAY=true`

> 说明：这是把“action 执行”放在你本地机器上，避免把私钥/交易能力暴露到云端。

### OM1 config 示例

本仓库提供一个模板：`config/om1.conversation.chain_action.json5`  
把里面的 `agent_actions` 片段复制到你 OM1 的 conversation agent 配置里，让模型“知道”可以输出 `chain_execute`。



