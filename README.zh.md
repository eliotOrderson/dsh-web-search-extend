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
    registry.ts       # AdapterRegistry（可插拔机制）
    abort.ts          # 取消处理（横切）
    errors.ts         # WebError 分类（横切）
  adapters/           # 适配层（每后端一文件，可插拔）
    deepseek.ts       # DeepSeekAdapter（官方 Anthropic-compatible API，保留）
    tavily.ts         # TavilyAdapter（keyless）+ 响应映射
    demo.ts           # DemoAdapter（示例，零网络）
    index.ts          # createDefaultRegistry() 注册全部内置适配器
```

新增 provider = 新增 `adapters/<vendor>.ts` 实现 `SearchAdapter` 并在 `createDefaultRegistry()` 注册；core 不动。

## 适配器契约

```ts
interface SearchAdapter {
  readonly id: string;
  readonly label: string;
  readonly requiresApiKey: boolean;
  readonly defaultApiKeyEnv: string;
  readonly baseURLEnv: string;
  readonly defaultBaseURL: string;
  available(runtime: AdapterRuntime): boolean;
  search(request: WebSearchRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<WebSearchResult>;
}
```

## 内置适配器

| id | 后端 | requiresApiKey | 说明 |
|---|---|---|---|
| `deepseek` | DeepSeek Anthropic-compatible Messages API | **是** | 保留官方后端（model/apiVersion/maxTokens/maxUses） |
| `tavily` | Tavily Search（`@tavily/core`） | **否**（keyless） | `answer`→`content`（开启时），`results[]`→`sources[]` |
| `demo` | 无（固定） | 否 | 零配置示例，证明可插拔 |

## 配置（扩展后的 `web-search-deepseek` 段）

| 键 | 默认 | 含义 |
|---|---|---|
| `provider` | `tavily` | 每次搜索使用哪个适配器 |
| `apiKey` | 省略 | 字面 key（secret） |
| `apiKeyEnv` | 按 provider | 凭据引用：`DEEPSEEK_API_KEY` / `TAVILY_API_KEY`（回退 `DEEPSEEK_API_KEY`） |
| `baseURL` | 按 provider | 端点主机根；回退到适配器 env（`DEEPSEEK_SEARCH_BASE_URL` / `TAVILY_BASE_URL`） |
| `deepseek.*` | `model`=`deepseek-v4-flash`、`apiVersion`=`2023-06-01`、`maxTokens`=4096、`maxUses`=5 | 官方 deepseek 参数 |
| `tavily.*` | `searchDepth`=`basic`、`topic`=`general`、`maxResults`=5、`includeAnswer`=false、`timeRange`=`""` | Tavily 参数 |

## Keyless Tavily

`requiresApiKey: false` → 无 key 也可 `available()` 并 `search()`。keyless 额度耗尽时报清晰
`WEB_PROVIDER_ERROR`（"Tavily keyless rate limit reached; set TAVILY_API_KEY for full access"）。

## 错误分类

`WEB_PROVIDER_CREDENTIAL_MISSING`（需 key 后端无 key）· `WEB_PROVIDER_ERROR`（后端失败/keyless 上限）· `WEB_ABORTED`（取消）。

## 已验证

- 单测/smoke：注册 id 恒为 `deepseek-official`；DeepSeek 映射+请求体、Tavily keyless 映射/去重/
  maxResults/错误/取消、Demo 可插拔、credential-missing 全部通过。
- 实机：停用官方后，harness 内置 **`web_search` 工具（未改动）** 通过 Tavily keyless 返回真实结果——无 key、agent 零改动。

## 开发

```bash
npx tsc -p tsconfig.json      # src/ -> lib/（保留分层目录）
node smoke.mjs                # smoke：身份 + 适配器 + apply 注册
node test/search.test.mjs     # search 测试（mock 后端）
```
