# agg-proxy（EdgeOne Makers 版）

把原来跑在 K40 手机上的 OpenAI 兼容聚合网关，搬到腾讯 EdgeOne Makers 免费版（原 EdgeOne Pages）。
免费、无需外国信用卡、免 ICP 备案，手机可以退役。

## 端点

| 路径 | 用途 |
|---|---|
| `GET /v1/models` | 列出聚合的全部模型（13 个唯一 id，14 条渠道映射） |
| `POST /v1/chat/completions` | 按 `model` 路由到上游渠道并透传（支持 SSE 流式） |
| `POST /v1/responses` | Codex CLI 的 Responses API（内部转 Chat Completions，回包还原成 Responses 事件流） |
| `GET /` | 静态状态页（列出模型） |

模型路由表在 `functions/_shared/channels.js`（不含密钥）。密钥只放控制台环境变量。

## 部署（EdgeOne Makers 控制台）

1. 把本仓库推到 GitHub（本目录已是 git 仓库）。
2. 打开 https://edgeone.ai/pages/new ，登录后选 **关联 Git 仓库**。
3. 选本仓库 + 生产分支（`main`）。
4. 构建配置：
   - 框架预设：**其他**
   - 构建命令：**留空**
   - 根目录：`./`
   - 输出目录：**`static`**（也可由仓库里的 `edgeone.json` 生效）
5. **环境变量**（Project Settings → Environment Variables）按下面表格逐条添加。
6. 保存并部署，约 1 分钟。拿到免费域名 `https://<项目名>-xxxx.edgeonepage.com`。
7. 验证：
   ```powershell
   curl.exe -s "https://<域名>/v1/models" -H "Authorization: Bearer <EO_PROXY_KEY>"
   ```
   返回 13 个模型 id 即成功。
8. 如果 `/v1/*` 返回 404：把 `functions/` 目录整体改名为 `edge-functions/`（官方文档的目录名），重新部署。代码内容不用改。

## 环境变量

| 变量名 | 对应渠道 | 说明 |
|---|---|---|
| `EO_PROXY_KEY` | — | 客户端调用本代理的密钥（自己设一串随机字符）。不设则任何人可调用（会回带告警头） |
| `EO_KEY_VOLCENGINE_ARK` | VolcengineArk | 火山方舟 key |
| `EO_KEY_AGNES` | AgnesAI | agnes-2.5-flash / agnes-3.0-flash |
| `EO_KEY_ZHIPU` | glm53-flash-zhipu | glm-5.3-flash |
| `EO_KEY_ZEN` | opencode-zen | space-bunny-free（无鉴权，可留空） |
| `EO_KEY_SAIL` | ShanghaiAILab | qwen3.8-27b / deepseek-v4-flash-vision / glm-5.3 |
| `EO_KEY_OPENROUTER` | OpenRouter-Ling31Flash | inclusionai/ling-3.1-flash |
| `EO_KEY_UNISOUND` | UnisoundU2Flash | u2-flash |

真实密钥值见本机 `secrets.local.json`（**已被 .gitignore 排除，不会进 Git**）。逐个复制到控制台环境变量即可，不要在聊天里贴。

## 家里电脑的 Codex 配置

`~/.codex/config.toml`：

```toml
model = "space-bunny-free"
model_provider = "agg"

[model_providers.agg]
name = "agg-edgeone"
base_url = "https://<域名>/v1"
env_key = "AGG_KEY"
wire_api = "responses"
```

然后设环境变量 `AGG_KEY` = 你在控制台设的 `EO_PROXY_KEY`。

验证：

```powershell
$env:AGG_KEY = "<EO_PROXY_KEY>"
curl.exe -s "https://<域名>/v1/models" -H "Authorization: Bearer $env:AGG_KEY"
curl.exe -s -X POST "https://<域名>/v1/responses" -H "Authorization: Bearer $env:AGG_KEY" -H "Content-Type: application/json" --data-binary '{\"model\":\"space-bunny-free\",\"input\":\"hi\",\"stream\":false}'
```

## 限制（已核实，来自官方文档）

- Edge Functions：请求体 **1 MB**、代码包 5 MB、**300 万次/月**、单次执行 CPU 200 ms（I/O 等待不计）。日常 Codex 请求远小于 1 MB。
- 免备案 = 没有大陆节点，走香港/亚太边缘。要大陆节点必须 ICP 备案（官方明文）。
- 上游渠道本身的限制不属于本代理：`glm-5.3-flash` 目前上游返回 429「余额不足」，`ling-3.1-flash` 上游 429 限流。

## 本地验证

```powershell
node tests/local-test.mjs    # 假上游，10 项检查：路由/鉴权/SSE 事件序列/转换
node tests/real-smoke.mjs    # 真实上游冒烟：4 个模型 chat + 2 个模型 Responses 流式
```

`tests/real-smoke.mjs` 会读 `secrets.local.json` 取真实密钥，只在本机跑，不部署。

## 结构

```
edgeone.json                    输出目录配置（./static）
functions/_shared/channels.js   渠道表 + 鉴权 + 上游转发（无密钥）
functions/v1/models/index.js    GET /v1/models
functions/v1/chat/completions/index.js   POST /v1/chat/completions
functions/v1/responses/index.js          POST /v1/responses
static/index.html               状态页
tests/                          本地测试
docs/eo_facts.md                EdgeOne 平台事实核查
docs/free_hosts.md              免费托管方案对比
```
