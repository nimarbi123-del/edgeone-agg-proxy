# EdgeOne Makers（原 EdgeOne Pages）事实核查

核查时间：2026-10-10。来源：pages.edgeone.ai 官方文档（经 r.jina.ai 渲染抓取）。
凡本文件未标注「官方原文」的推断，都标了「推断」。

## 一、结论速览

1. 免费版真实存在，一键开通，无需信用卡（官方 FAQ：*"EdgeOne Makers currently offers a free edition. All users can activate it with one click in the console"*）。
2. 免费额度足够本项目：Edge Functions **300 万次/月**、代码包 5 MB、**请求体上限 1 MB**；Cloud Functions 100 万次/月、代码包 128 MB、请求体 6 MB。
3. **不要备案的前提 = 不能用中国大陆节点**。官方原文：加速区域为「Chinese mainland availability zone」或「global availability zone (including Chinese mainland)」时，绑定域名必须先完成 ICP 备案。平台免费域名 `*.edgeonepage.com` 无法备案 → 走海外区，最近节点在香港/亚太（官方称全球 3200+ 节点，其中亚太 2500+）。
4. Edge Functions 无「最长执行时长」条目；Cloud Functions 有（默认 30 秒，可配到 120 秒）。Edge Functions 的限制是 **单次执行 CPU 时间 200 ms**（官方原文：*"CPU time slice allocated for single execution of a function, excluding I/O wait time"*）——纯转发的 SSE 代理 CPU 占用极低，I/O 等待不计入。
5. 目录约定（官方 Getting Started）：`./edge-functions/api` 建 Edge Function，`./cloud-functions/api` 建 Cloud Function，导出 `onRequest(context)`。
   - 官方模板库里同时存在 `functions/` 目录的老例子（deepseek、mcp-on-edge）和 `edge-functions/` 目录的新例子（edge-ai-gateway、functions-fetch）。本项目按官方文档用 `edge-functions/`；若构建不识别，把目录名改成 `functions/` 再部署。
   - 官方路由映射原文：`/edge-functions/helloworld.js` → `example.com/helloworld`，即目录内路径直接映射到根路径，所以 `edge-functions/v1/chat/completions/index.js` → `/v1/chat/completions`。

## 二、Functions 写法（官方）

```js
// ./edge-functions/api/hello.js
export default function onRequest(context) {
  return new Response('Hello from Edge Functions!');
}
```

- context 里有 `request`、`env`（环境变量）、`params`；官方 AI 网关模板用 `export async function onRequest({ request, env })` 解构写法，本项目沿用。
- 流式：官方 edge-ai-gateway 模板直接 `return new Response(upstream.body, { headers: { 'Content-Type': 'text/event-stream' } })`，即 **SSE 边收边发**。
- 官方模板还做了一步 `request.headers.delete('accept-encoding')`，避免压缩层干扰流式。

## 三、免费额度（官方 limits-and-quotas 原文数字）

| 项目 | 免费版 |
|---|---|
| 项目数 | 40 |
| 构建次数 | 500 /月 |
| 存储 | 5 GB（站点级合计） |
| KV 存储 | 1 GB |
| Blob 存储 | 1 GB |
| Edge Functions 执行次数 | 300 万 /月 |
| Edge Functions CPU 时间 | 300 万 ms /月 |
| Edge Functions 代码包 | 5 MB |
| Edge Functions 请求体 | 1 MB |
| Cloud Functions 执行次数 | 100 万 /月 |
| Cloud Functions 内存时间 | 500,000 GB-s /月 |
| Cloud Functions 代码包（含依赖） | 128 MB |
| Cloud Functions 请求体 | 6 MB |
| Cloud Functions 单次最长执行 | 默认 30 秒，可配 10-120 秒 |
| 构建单实例超时 | 20 分钟 |

## 四、备案 / 大陆节点（关键）

- 官方 custom-domain 原文：*"When the acceleration region of a project is 'Chinese mainland availability zone' or 'global availability zone (including Chinese mainland)', the added domain must first complete registration [ICP]"*。
- 推论（推断）：想用大陆节点 → 必须备案；不备案 → 项目只能选不含大陆的加速区域，大陆用户走香港/亚太边缘节点。**本方案就是「免备案 + 香港/亚太边缘」，不是「免备案 + 大陆节点」，不存在这种组合。**
- 对比 Cloudflare 免费版：CF 免费版大陆同样无节点，且本次原链路是 Argo Tunnel 双跳（客户端→CF 边缘→隧道→手机）。EdgeOne 方案是单跳（客户端→EdgeOne 边缘→上游 API），少了手机和隧道两段，这是本次提速的主要来源。

## 五、坑与对策

| 坑 | 对策 |
|---|---|
| 请求体 1 MB 上限（Edge Functions） | 日常 Codex 请求远小于 1 MB；超大上下文改用 Cloud Functions（6 MB，`cloud-functions/` 目录） |
| `functions/` 与 `edge-functions/` 两种目录名并存 | 本项目用 `functions/`；路由 404 就重命名为 `edge-functions/` 重新部署 |
| 免费域名 `*.edgeonepage.com` 不能备案 | 本来就不需要备案；要大陆节点才需要自有已备案域名 |
| 出网（egress）能力 | 官方 AI 网关模板即调用外部 LLM API，说明 egress 可用；本项目已在本机实测 7 个上游全部可达（见 tests/real-smoke.mjs 输出） |
| 密钥泄露 | 密钥只放控制台环境变量，不进 Git；`.gitignore` 已排除 secrets.local.json |

## 六、来源

- https://pages.edgeone.ai/document/pages-functions-overview
- https://pages.edgeone.ai/document/edge-functions
- https://pages.edgeone.ai/document/limits-and-quotas
- https://pages.edgeone.ai/document/edgeone-json
- https://pages.edgeone.ai/document/custom-domain
- https://pages.edgeone.ai/document/faqs
- https://pages.edgeone.ai/document/pricing-and-plans
- 官方模板（AI 网关示例）：https://github.com/TencentEdgeOne/pages-templates/tree/main/examples/edge-ai-gateway
- 第三方可用参考：https://github.com/6Kmfi6HP/edgeone-proxy
