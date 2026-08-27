# dsh-web-search-extend

[English](README.md) | 中文

官方 DeepSeek Harness web-search 插件（`@deepseek-ai/dsh-web-search-deepseek`）的原位替换。停用官方插件，接管同一 Settings 配置段（`web-search-deepseek`）与 provider 槽位（`deepseek-official`），原有 `web_search` 工具继续经可插拔搜索适配器路由。

## 引擎

| id | 凭据 ref | 原生操作 |
| :--- | :--- | :--- |
| `firecrawl-keyless`（默认） | `FIRECRAWL_API_KEY`（可选，提升 keyless 配额） | search / extract / crawl / map / research |
| `tavily` | `TAVILY_API_KEY`（keyless 仅 search） | search / extract / crawl / map / research |
| `deepseek` | `DEEPSEEK_API_KEY`（必需） | search |

非原生的 extract/crawl/map 会回退到本地 composite 层（fetch + Readability）。research 没有 composite 兜底。

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-web-search-extend
```

重启 DSH。随包 `cordis.patch.yml` 会插入本插件并停用官方插件；随包补丁默认打开 `tools.research`。

## 配置

插件扩展官方 `web-search-deepseek` 设置段。主要键：

| 键 | 默认 | 含义 |
| :--- | :--- | :--- |
| `provider` | `firecrawl-keyless` | 当前适配器：`firecrawl-keyless` / `tavily` / `deepseek` |
| `apiKeyEnv` | `FIRECRAWL_API_KEY` | 顶层凭据引用；provider 变更时自动同步为当前 provider 默认 ref |
| `routeMode` | `provider-first` | `provider-first`：先原生后本地 composite；`local-only`：跳过 provider |
| `fetchBackend` | `local` | `local` 注册兜底 fetch provider；`adapter` 额外把原生 extract 暴露为 `web-search-extend` fetch provider |
| `fallbacks` | `[]` | 主适配器可切换失败后依次尝试的 adapter id |
| `tools.research` | `false`（schema）；随包补丁为 `true` | 注册 `web_research` / `web_research_status` |
| `limits.*` | 见代码 | extract/crawl/map 上限与单页渲染上限 |
| `tavily.*` | 见代码 | search/extract/research 参数，含 `researchModel` |
| `deepseek.*` | 见代码 | model / apiVersion / maxTokens / maxUses |

示例：

```yaml
config:
  provider: firecrawl-keyless
  tools:
    research: true
```

`fetchProvider` 是 DSH 全局配置，不是插件配置：使用 `fetchBackend: adapter` 时选择 `web-search-extend`。

## 架构

```
src/
  index.ts            # cordis 入口：官方身份、分层接线、provider 注册
  types.ts            # SearchAdapter + AdapterRuntime 契约
  config.ts           # 扩展的 web-search-deepseek schema + 默认值
  core/               # harness 接线，无厂商代码
    provider.ts       # ExtensibleWebSearchProvider（id = deepseek-official）
    capabilities.ts   # 能力由方法存在性推导
    router.ts         # native → composite → WEB_OP_UNSUPPORTED 阶梯
    composites.ts     # 通用 extract/map/crawl（注入 FetchLike）
    html.ts           # HTML → text/markdown（Readability + turndown）
    registry.ts       # AdapterRegistry
    abort.ts          # 取消处理
    errors.ts         # WebError 分类
    localFetch.ts     # 本地 web_fetch 兜底 provider
    secureFetch.ts    # SSRF/DNS-rebinding 安全本地 fetch
  adapters/           # 每后端一文件（可插拔）
    deepseek.ts
    tavily.ts
    firecrawl.ts
  tools/              # 模型面工具 + 格式化器
  ui/client.js        # 设置卡注入器，构建进 lib/client.js
```

新增 provider = 在 `adapters/<vendor>.ts` 实现 `SearchAdapter` 并在 `createDefaultRegistry()` 注册。

## 工具

| 工具 | 行为 |
| :--- | :--- |
| `web_search` | 经当前 provider 路由（官方工具，未改动） |
| `web_extract` | 从已知 URL 提取可读内容 |
| `web_crawl` | 站点有界爬取 |
| `web_map` | 枚举站点 URL |
| `web_research` | 提交异步深度研究任务 |
| `web_research_status` | 轮询研究到终态 |
| `web_doctor` | 离线引擎就绪报告（零网络/零配额） |

研究说明：

- Tavily research 使用 `tavily.researchModel`（`mini` 最省）。
- Firecrawl research 固定携带内置结构化 schema（`summary` / `analysis` / `sources` / `recommendations`）以返回详细报告；不可配置。

## 故障转移与错误

- `fallbacks` 把适配器包装成链。可切换失败（`WEB_PROVIDER_ERROR`、`WEB_PROVIDER_CREDENTIAL_MISSING`）尝试下一个成员；不可切换错误（`WEB_ABORTED`、`WEB_OP_UNSUPPORTED`、`WEB_OP_FAILED`）立即抛出。
- 配额/限流失败会让成员进入仅内存的冷却窗口（指数退避，约 30 分钟上限）；成功即清除。
- 主 key 可为逗号分隔多个 key；auth/配额/限流失败会先轮换 key 再走链回退。
- research 要求同一成员同时具备 `submitResearch` + `pollResearch`；无跨成员 research failover。

## 开发

```bash
npm test                 # vitest（127 个测试，全离线）
bash scripts/build.sh    # 打包 lib/index.js + lib/invariant.js + lib/client.js
```

`src/ui/client.js` 会打包进 `lib/client.js`；不要直接编辑 `lib/client.js`。
