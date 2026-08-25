# dsh-web-search-extend

[English](README.md) | 中文

官方 DeepSeek Harness web-search 插件（`@deepseek-ai/dsh-web-search-deepseek`）的**原位替换**插件。安装后：

- **停用官方 web-search 插件**，由本插件接管其全部槽位：
  - cordis 插件名 → `web-search-deepseek`
  - Settings 配置段 → `web-search-deepseek`（**配置页同位置、同布局，只是扩展**）
  - 注册的 `ctx.web` provider id → `deepseek-official`（接缝选择不变）
- agent **仍使用旧 `web_search` 工具**——agent 侧零改动；工具仍调 `ctx.web.search`，现在路由到本插件，并按配置的 **search 提供商**（DeepSeek / Tavily / Demo）执行。
- 配置页支持**选择 search 提供商**、并配置各提供商的 **api_key** 与专属参数。

分层模块化；适配层**可插拔，不锁死 Tavily**：内置 DeepSeek（官方后端，保留）、Tavily（**支持 keyless**）、Demo。

## 安装（官方 `dsh plugin add`，替换官方）

本包是**标准 DSH bundle 插件**：声明 `dsh.bundle` → `./cordis.patch.yml`，官方 `dsh plugin` CLI
会把它作为 profile 层安装（无需 super-injector）。

1. **停用官方 provider**（本仓库当前 profile 已写入）：

   ```yaml
   # ~/.dsh/profiles/web/cordis.patch.yml
   - id: web-search-deepseek
     disabled: true
   ```

2. **正常安装：**

   ```bash
   dsh plugin --profile web add /path/to/dsh-web-search-extend
   ```

   该命令会把包写入 profile 依赖和 `dsh.profile.bundles`；包内自带的 `cordis.patch.yml`
   会在启动时插入 `web-search-extend` 入口。

3. **重启 DSH**（或重新加载 profile）。插件以 `web-search-extend` 条目加载，注册官方配置段
   （`web-search-deepseek`）与 provider 槽位（`deepseek-official`），agent 原 `web_search`
   工具即路由到它。

super-injector 仅用于开发期热更新；生产用正常 CLI 安装。

## 架构（分层 / 单一责任）

```
src/
  index.ts            # cordis 入口：穿官方身份，串联各层，向 ctx.web 注册 provider
  invariant.ts        # 包所有权伴侣（ctx.invariants）
  types.ts            # 契约层：SearchAdapter + AdapterRuntime
  config.ts           # 配置层：官方配置的超集 schema + 默认值
  core/               # 接缝集成层（harness 接线，零厂商代码）
    provider.ts       # ExtensibleWebSearchProvider（id = deepseek-official）
    capabilities.ts   # capabilitiesOf()：能力由方法存在性推导
    router.ts         # execute()：native → composite → WEB_OP_UNSUPPORTED 阶梯
    composites.ts     # 通用 extract/map/crawl（注入 FetchLike，纯算法）
    html.ts           # 朴素 HTML → text/markdown 转换（兼容下限）
    registry.ts       # AdapterRegistry（可插拔机制）
    abort.ts          # 取消处理（横切）
    errors.ts         # WebError 分类（横切）
  adapters/           # 适配层（每后端一文件，可插拔）
  tools/              # 模型面工具（extract/crawl/map/research）+ 共享格式化器
    deepseek.ts       # DeepSeekAdapter（官方 Anthropic-compatible API，保留）
    tavily.ts         # TavilyAdapter（keyless）+ 响应映射
    demo.ts           # DemoAdapter（示例，零网络）
    index.ts          # createDefaultRegistry() 注册全部内置适配器
```

新增 provider = 新增 `adapters/<vendor>.ts` 实现 `SearchAdapter` 并在 `createDefaultRegistry()` 注册；core 不动。

## WebAdapter 契约（v2）

```ts
interface WebAdapter {
  readonly id: string;                        // 同时也是注册的 ctx.web provider id
  readonly label: string;
  readonly requiresApiKey: boolean;
  readonly defaultApiKeyEnv: string;
  readonly baseURLEnv: string;
  readonly defaultBaseURL: string;
  available(runtime: AdapterRuntime): boolean;
  search(request, runtime, signal?): Promise<WebSearchResult>;
  // 可选的原生操作——能力由方法存在性推导，无独立声明表：
  extract?(req: ExtractRequest, runtime, signal?): Promise<ExtractResult>;
  crawl?(req: CrawlRequest, runtime, signal?): Promise<CrawlResult>;
  map?(req: MapRequest, runtime, signal?): Promise<MapResult>;
  submitResearch?(input: string, runtime, signal?): Promise<ResearchSubmission>;
  pollResearch?(requestId: string, runtime, signal?): Promise<ResearchStatus>;
}
```

每个操作都走路由阶梯：**native 方法 → composite（基于 fetch 接缝的通用
extract/map/crawl）→ 结构化 WEB_OP_UNSUPPORTED**。新增 provider = 一个实现
WebAdapter 的文件；core 永远不改。


## 配置（扩展后的 web-search-deepseek 段）

| 键 | 默认 | 含义 |
| :--- | :--- | :--- |
| `provider` | `tavily` | 每次搜索使用哪个适配器：tavily / deepseek / demo。 |
| `apiKey` | 省略 | 字面 key（secret 角色）。官方设置卡会把值写入 `apiKeyEnv` 指向的 ref，而不是设置文件。 |
| `apiKeyEnv` | `TAVILY_API_KEY` | 顶层凭据引用：设置卡的 badge 与保存目标。当其值为受管 ref（`TAVILY_API_KEY` / `DEEPSEEK_API_KEY`）时，`apply()` 会在 provider 变更时自动同步为当前 provider 的默认 ref，使 badge 跟随 provider；任意自定义 ref 不覆盖。 |
| `baseURL` | 按 provider | 端点主机根；回退到适配器 env（`DEEPSEEK_SEARCH_BASE_URL` / `TAVILY_BASE_URL`）。 |
| `fetchBackend` | `"local"` | `local`：不动现有 fetch provider。`"adapter"`：额外注册 `web-search-extend` WebFetchProvider 提供单 URL extract（要求当前适配器有**原生** extract，如 tavily；用 `fetchProvider` / `DSH_WEB_FETCH_PROVIDER` 选择）。 |
| `tools.extract` | `true` | 注册 `web_extract`。 |
| `tools.crawl` | `true` | 注册 `web_crawl`。 |
| `tools.map` | `true` | 注册 `web_map`。 |
| `tools.research` | `false` | 注册 `web_research` + `web_research_status`（耗 credits，默认关）。 |
| `limits.extractMaxUrls` | `10` | 每次 web_extract 的最大 URL 数。 |
| `limits.crawlMaxPages` | `10` | 每次 web_crawl 的最大页数。 |
| `limits.mapMaxUrls` | `100` | 每次 web_map 的最大 URL 数。 |
| `limits.perPageChars` | `20000` | 提取/爬取内容的单页渲染上限。 |
| `deepseek.model` | `deepseek-v4-flash` | 官方 DeepSeek 模型 id。 |
| `deepseek.apiVersion` | `2023-06-01` | Messages API 版本。 |
| `deepseek.maxTokens` | `4096` | 最大补全 token。 |
| `deepseek.maxUses` | `5` | 每次请求最多搜索次数。 |
| `deepseek.apiKeyEnv` | `DEEPSEEK_API_KEY` | deepseek 的凭据 ref（子节覆盖）。 |
| `tavily.searchDepth` | `basic` | basic / advanced / fast / ultra-fast。 |
| `tavily.topic` | `general` | general / news / finance。 |
| `tavily.maxResults` | `5` | 结果上限。 |
| `tavily.includeAnswer` | `false` | 附带生成式答案（映射到 content）。 |
| `tavily.timeRange` | `""` | day / week / month / year 时间限制。 |
| `tavily.extractDepth` | `basic` | native extract + crawl 使用：basic / advanced。 |
| `tavily.researchModel` | `auto` | research 任务：mini / pro / auto。 |
| `tavily.apiKeyEnv` | `TAVILY_API_KEY` | tavily 的凭据 ref（子节覆盖）。 |

```yaml
- id: web-search-deepseek
  name: 'dsh-web-search-extend'
  config:
    provider: tavily            # 或：deepseek | demo
    tools:
      research: true            # 打开耗 credits 的 research 工具
    limits:
      extractMaxUrls: 10
    tavily:
      searchDepth: basic
      includeAnswer: true
```

key ref 按 provider 各自解析，**无跨 provider 回退**（config.apiKeyEnv → 子节
apiKeyEnv → adapter 默认；badge 机制与受管 ref 自动同步见 AGENTS.md）。


## 模型面工具

| 工具 | 参数 | 行为 |
| :--- | :--- | :--- |
| `web_search` | `queries: string[]` | 官方工具，未改动——经所选 provider 路由。 |
| `web_extract` | `urls: string[]`、`query?`、`format?` | 已知 URL 的可读内容（markdown/text）。tavily 原生；通用 composite 兜底。 |
| `web_crawl` | `url`、`maxPages?`、`includeDomains?`、`excludeDomains?` | 站点有界爬取。tavily 原生；BFS composite 兜底。 |
| `web_map` | `url`、`maxUrls?` | 枚举站点 URL。tavily 原生；sitemap/robots composite 兜底。 |
| `web_research` | `input` | 提交异步深度研究任务（耗 credits！）；返回 requestId。 |
| `web_research_status` | `requestId` | 轮询研究任务到终态；随后返回内容 + 来源列表。 |

工具不随 provider 切换而消失——切换 provider 只改变每个调用走哪一层
（native / composite / unsupported）。research 默认关闭（tools.research: false）。


## Keyless Tavily

`TavilyAdapter.requiresApiKey = false` → 无 key 也可 `available()` 并 `search()`。
**keyless 只覆盖 search**：extract/crawl/map/research 会报凭据错误（WEB_PROVIDER_ERROR：
keyless 上限 / 端点不可用）。在凭据服务（Models 页）配置 TAVILY_API_KEY 即可完整
使用。ref 按 provider 各自解析，无跨 provider 回退（见 AGENTS.md）。


## 错误分类

- `WEB_PROVIDER_CREDENTIAL_MISSING` — 需 key 后端无可用 key。
- `WEB_PROVIDER_ERROR` — 后端失败 / keyless 上限。
- `WEB_ABORTED` — 调用方取消。
- `WEB_OP_UNSUPPORTED` — 当前适配器既无 native 也无 composite 路径（如 deepseek/demo 上的 research）。
- `WEB_OP_FAILED` — composite 执行了但无可用产出（如 web_map 找不到 sitemap）。


## 已验证

- **48 个 vitest 测试**（`tests/`）：路由阶梯、能力 pinning（tavily 五操作；deepseek/demo
  仅 search）、composite fixtures（sitemap 解析、HTML 转换、BFS 环路安全、单页失败隔离）、
  Tavily 全部响应形状映射——全离线（假 fetch / mock SDK，零网络）。
- 三层冷启动 preflight（composition 试跑 / resolve / client 身份）通过。
- 实机（人工）：各 provider ref 存储已验证；badge 跟随 provider；真实 Tavily search/extract。


## 开发

```bash
npx tsc -p tsconfig.json      # src/ -> lib/（保留分层目录）
npm test                      # vitest（tests/），全离线
bash scripts/build.sh         # 打包 lib/index.js + lib/invariant.js（esbuild）
```

注：`test/search.test.mjs` 是遗留旧 harness，import `lib/core/provider.js`（当前 bundle
构建不产出该路径）——请用 `tests/`（vitest）替代。
