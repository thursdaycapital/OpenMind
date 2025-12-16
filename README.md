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


