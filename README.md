# KeyStorm
多 API 密钥负载均衡器和代理服务

> 这是一个部署在 Cloudflare Workers 上的多 API 负载均衡器和代理服务，支持 Google Gemini 和 OpenAI API。使用 Durable Objects 来存储和管理 API 密钥，无论你连接的 worker 节点在属于哪个地区，最后都会转发到美国以后再发起请求，不用再担心地区不支持的问题！

它旨在解决以下问题：
*   将多个 API 密钥聚合到一个端点中。
*   通过随机轮询密钥池来实现请求的负载均衡。
*   提供与 OpenAI API 兼容的接口，使现有工具可以轻松集成。
*   支持多种 AI 服务商的 API（目前支持 Google Gemini 和 OpenAI）。

## ✨ 主要功能

*   **多 API 支持**: 支持 Google Gemini 和 OpenAI API。
*   **API 代理**: 作为 LLM API 的稳定代理。
*   **负载均衡**: 在配置的多个 API 密钥之间随机分配请求。
*   **本地 key 透传**：如果不想使用多 key 负载均衡，可以开启本地 key 透传，此时本项目仅作为一个 API 中转
*   **OpenAI API 格式兼容**: 支持 `/v1/chat/completions`, `/v1/embeddings` 和 `/v1/models` 等常用 OpenAI 端点。
*   **流式响应**: 完全支持流式响应。
*   **API 密钥管理**:
    *   提供一个简单的 Web UI 用于批量添加和查看不同类型的 API 密钥。
    *   提供 API 接口用于检查并自动清理失效的密钥。
*   **持久化存储**: 使用 Cloudflare Durable Objects 内的 SQLite 安全地存储 API 密钥。

## 🚀 部署

你可以通过以下两种方式将此项目部署到你自己的 Cloudflare 账户：

### 方法一：通过 Wrangler CLI 部署

1.  **克隆项目**
    ```bash
    git clone https://github.com/yCENzh/KeyStorm.git
    cd KeyStorm
    ```

2.  **安装依赖**
    ```bash
    pnpm install
    ```

3.  **登录 Wrangler**
    ```bash
    npx wrangler login
    ```

4.  **部署到 Cloudflare**
    ```bash
    pnpm run deploy
    ```
    部署成功后，Wrangler 会输出你的 Worker URL。

### 方法二：通过 Cloudflare Dashboard 部署 (推荐)

1.  **Fork 项目**: 点击本仓库右上角的 "Fork" 按钮，将此项目复刻到你自己的 GitHub 账户。

2.  **登录 Cloudflare**: 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/)。

3.  **创建 Worker**:
    *   在左侧导航栏中，进入 `Workers & Pages`。
    *   点击 `创建应用程序` -> `连接到 Git`。
    *   选择你刚刚 Fork 的仓库。
    *   在“构建和部署”设置中，Cloudflare 通常会自动检测到这是一个 Worker 项目，无需额外配置。
    *   点击 `保存并部署`。

## 🔑 API 密钥管理

部署完成后，你可以通过访问你的 Worker URL 来管理 Gemini API 密钥。

*   **访问管理面板**: 在浏览器中打开你的 Worker URL (例如 `https://keystorm.your-worker.workers.dev`)，首次访问会显示登录框，需要输入你的 HOME_ACCESS_KEY 进行认证，认证通过后才能进入管理页面。
*   **批量添加密钥**: 在文本框中输入你的 Gemini API 密钥，每行一个，然后点击“添加密钥”。
*   **查看和刷新**: 在右侧面板可以查看已存储的密钥，并可以点击“刷新”按钮更新列表。
*   **一键检查**： 点击“一键检查”按钮，可以检查 API key 可用性。
*   **批量删除**： 选中无效的 API key，可以一键删除所有无效的 API key。

## 配置

`FORWARD_CLIENT_KEY_ENABLED` : 默认为 false，设置为 true 时，会透传客户端的 key，此时仅作为 Gemini API 代理，没有多 key 负载均衡功能。

`AUTH_KEY` ： 默认为：`yCENzh`，本项目API请求密钥，如果 `FORWARD_CLIENT_KEY_ENABLED` 为 true，那么本项目仅作为一个 Gemini API 代理，无需认证

`HOME_ACCESS_KEY`：网页管理面板密码，默认为 `e86ea1ceb610e1ed502f5a99a386a0a252a933525187a43f18db6a6d91c91434`

**强烈建议你在Cloudflare Worker环境变量中修改 `HOME_ACCESS_KEY` 和 `AUTH_KEY` 的值，修改完成后重新部署即可。**

## 💻 API 用法

使用方式，在 AI 客户端中，填入以下配置：

BaseURL: <你的worker地址>

API 密钥: `<你的AUTH_KEY>`，如果设置了 `FORWARD_CLIENT_KEY_ENABLED` 为 true，那么这里需要填你自己的 key 就行

### 管理 API

所有管理 API 均需在请求头添加 `Authorization: Bearer <你的HOME_ACCESS_KEY>` 或自动携带 cookie `auth-key` 进行认证：

*   `GET /api/keys`: 获取所有已存储的 API 密钥。
*   `POST /api/keys`: 批量添加 API 密钥。请求体为 `{"keys": ["key1", "key2"], "apiType": "gemini"}` 或 `{"keys": ["key1", "key2"], "apiType": "openai"}`。对于 OpenAI 类型密钥，还可以指定自定义端点：`{"keys": ["key1"], "apiType": "openai", "customEndpoint": "https://your-custom-endpoint.com/v1"}`。
*   `GET /api/keys/check`: 检查所有密钥的有效性。
*   `DELETE /api/keys`: 批量删除 API 密钥。请求体为 `{"keys": ["key1", "key2"]}`。

普通 OpenAI API 调用只需使用 `AUTH_KEY`，无需管理权限认证

### 支持的 API 类型

1. **Google Gemini API**:
   - 密钥格式: `AIzaSy...`
   - 支持所有 Gemini 模型

2. **OpenAI API**:
   - 密钥格式: `sk-...`
   - 支持所有 OpenAI 模型 (GPT-3.5, GPT-4, etc.)
   - 支持自定义端点 URL (适用于中转站或其他兼容 OpenAI 格式的模型服务)

### 自定义端点说明

对于 OpenAI 类型的密钥，您可以指定自定义端点 URL，这使得 KeyStorm 可以与各种兼容 OpenAI 格式的中转站或模型服务一起使用。例如：
- 中转站服务
- 私有部署的模型服务
- 其他兼容 OpenAI API 格式的第三方服务

### 添加自定义端点及TOKEN

1. **在 Web 管理界面的"添加 API 密钥"页面中**：
   - 选择 API 类型为 "OpenAI"
   - 在"自定义端点"输入框中输入端点 URL（可选）
   - 输入 OpenAI 格式的 API 密钥（每行一个）
   - 点击"添加密钥"按钮

2. **通过 API 添加**：
```
# 添加带自定义端点的 OpenAI 密钥
curl -X POST /api/keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_HOME_ACCESS_KEY" \
  -d '{"keys": ["sk-..."], "apiType": "openai", "customEndpoint": "https://your-custom-endpoint.com/v1"}'
```

## 支持

如果你觉得这个项目对你有点用，就赶紧给我点点Star，算我求你了！你要是不点，下次我还求🙏你！

## 感谢

- [gemini-balance-do](https://github.com/zaunist/gemini-balance-do)

- [cloudflare](https://www.cloudflare.com/)