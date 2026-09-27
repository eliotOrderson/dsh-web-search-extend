# dsh-web-search-extend

[English](README.md) | 中文

官方 DeepSeek Harness web-search 插件（`@deepseek-ai/dsh-web-search-deepseek`）的**原位替换**插件。安装后：

- **停用官方 web-search 插件**，由本插件接管其全部槽位：
  - cordis 插件名 → `web-search-deepseek`
  - Settings 配置条目 → `dsh-web-search-extend`；当 host 提供的是 `web-search-deepseek` 时回落到它
  - 注册的 `ctx.web` provider id → `deepseek-official`（接缝选择不变）
- agent **仍使用旧 `web_search` 工具**——agent 侧零改动；工具仍调 `ctx.web.search`，现在路由到本插件，并按配置的 **search 提供商**（Firecrawl keyless / Tavily / DeepSeek）执行。
- 配置页展示**一等设置卡**：注册进 Plugins 页的 `plugins.item` 席位（id `web-search`、order 40），仅在 host 提供本插件条目时挂载——**provider 列出全部内置引擎**（firecrawl-keyless / tavily / deepseek）、路由模式（优先提供商/仅本地）、随引擎显隐的参数字段、自带 API Key 输入行、中英双语标签。所有控件都取自部署自带的设置套件（`@deepseek-ai/dsh-client-ui-primitives`），与页面其余部分同款样式；选择段的说明走**鼠标悬停在行标题上的气泡**，而不是控件上方的说明文字。`fallbacks` 仍走配置文件/API。卡片用 TypeScript 编写于 `src/ui/*.ts`，构建压缩为 `lib/client.js`（**勿直接编辑产物**）。

分层模块化；适配层**可插拔，不锁死 Tavily**：内置 Firecrawl（开箱 keyless）、DeepSeek（官方后端，保留）、Tavily（**支持 keyless**）。

## 安装

本包是**标准 DSH bundle 插件**：声明 `dsh.bundle` → `./cordis.patch.yml`，官方 `dsh plugin` CLI
会把它作为 profile 层安装。**无需手动编辑 profile overlay**：包内自带的 bundle 层会插入
`dsh-web-search-extend` loader 入口，并携带尾部的
`- id: web-search-deepseek / disabled: true` 标记来停用官方插件——该随包条目就是权威的接管
机制（早期遗留的手动 disable 属冗余但无害）。

```bash
dsh plugin --profile web add github:eliotOrderson/dsh-web-search-extend#48cb333
```

`#` 后缀是 pnpm 的 git ref：tag、分支、commit SHA 或 `#semver:<范围>`。上面这个 SHA 是让
profile 层安装在 dsh 0.1.7 上能正常启动的修订；该 tag 推送后由 `#v0.3.0` 取代。仓库直接提交
构建好的 `lib/`，安装无需构建步骤，也不需要 pnpm `allowBuilds` 放行。tag 挪动后用
`dsh plugin --profile web update dsh-web-search-extend` 强制重新解析。

## 版本兼容性

`main` 始终对齐**最新的 dsh（含预发布）**；tag 对齐**已发布的最新 dsh**，且只在该 harness 正式发布后才打。
你的 harness 有对应 tag 就装 tag，暂时没有就装上面那个已验证的 `main` 提交。

版本范围按**线**写：`0.1.5.x` 表示该线内所有版本（含预发布）；支持到线的边界为止——往上的下一条线是新的
客户端面，只有某行点名了才表示覆盖。`0.1.6.x` 下面没有任何一行点名，因为没有任何发行版适配它。

| Tag | 覆盖的 dsh 线 |
| :-- | :---------- |
| `v0.3.0` | **`0.1.7.x`**——设置卡片改走 0.1.7 客户端面（绑定 `configForms.get(entryId)`、注册进 Plugins 页的 `plugins.item` 席位），且 Readability 正文提取的 DOM 从 jsdom 换成 linkedom——这正是 `github:` / registry 安装得以启动的原因。**不要装在 `0.1.5.x` 上**：客户端半边注入的服务该线不提供，条目会一直 pending，浏览器启动随之中止 |
| `v0.2.4` | **`0.1.5.x`**——设置卡片的写入重新走客户端真实的 `SettingsScope` API：此前调用的是根本不存在的 `scope.write(...)`，于是卡片上所有控件（provider、路由模式、API Key、各 provider 参数）全部静默失效，失败只落进 `console.warn`。**不适用于 `0.1.6.x` / `0.1.7.x`**：0.1.7 已移除 `SettingsScope`，而且在 `0.1.7-rc.2` 上条目会直接 import 失败（jsdom → `tr46` → `require("punycode/")`，profile 层安装被 harness 解析器抛错）。这两条线请用 `v0.3.0` |
| `v0.2.3` | **`0.1.5.x`**，已被 `v0.2.4` 取代——把 Firecrawl SDK 连同它所依赖的 `zod` / `zod-to-json-schema` 一起打进 `lib/index.js`，插件不再向 profile 安装 Firecrawl 或 zod 相关包；devDependencies 对齐已发布的 `0.1.5-rc.2` harness 线，`npm install` / `npm ci` 不需要额外 flag |
| `v0.2.1` | **`0.1.5.x`**，已被 `v0.2.4` 取代——不要在 `0.1.5-rc.1` 上安装：其 loader entry 会因 Firecrawl SDK 的 `zod/v3` 依赖经 profile 解析而导入失败 |
| `v0.2.0` | `0.1.2-rc.1` 之前的 `0.1.x`（旧 `installSettingsSection` API） |

`v0.2.4` 让卡片写入走 `scope.mutate([{ op: "set", path, value }])`。此前的调用指向
`scope.write(...)`，任何客户端版本都没有这个成员；而声明它的本地 interface 只是被断言到
绑定出来的 scope 上，所以 TypeScript 抓不到，打包客户端半边的 esbuild 又从不做类型检查。
`tests/ui-settings.test.ts` 曾用只带真实客户端 scope 成员的替身把这个写入路径钉住；该测试与它驱动的
退役卡片在页面迁到 0.1.7 `configForms` 接口时一并删除。

`v0.2.3` 把 Firecrawl SDK 与它构建时使用的 `zod` / `zod-to-json-schema` 一起打进 bundle（两者
现在都是 build 期 devDependencies）。经 profile 解析这对依赖正是此前安装失败的原因：当 profile
的 lock 把低于 3.25.28 的 zod 提升到根目录、同时又提升了 `zod-to-json-schema` 时，SDK 的
`zod/v3` 导入会失败，整个 loader entry 随之无法加载。仓库的 `.npmrc` 跳过 npm 的 peer 解析也是
同一道理：`@deepseek-ai/*` 这些 peer 由运行中的 harness 提供，本地安装的那份只用于类型检查。

重启 DSH（或重新加载 profile）。插件以 `dsh-web-search-extend` 条目加载，注册官方配置段
（`web-search-deepseek`）与 provider 槽位（`deepseek-official`），agent 原 `web_search`
工具即路由到它。

注意：官方 `@deepseek-ai/dsh-web-search-deepseek` 包仍是**运行时 peer 依赖**。其 loader entry 已被
禁用，但本插件从它的导出中继承官方 DeepSeek 出厂默认值（model / baseURL / API version /
maxTokens / maxUses），从而自动跟随官方更新而非手工镜像。该包随 harness 内置，请保持安装。

## 引擎

| id | 凭据 ref | keyless 行为 | 原生操作 |
| :--- | :--- | :--- | :--- |
| `firecrawl-keyless`（**默认**） | `FIRECRAWL_API_KEY`（可选，用于提升配额） | 开箱即搜；agent 式 research 端点拒绝 keyless 层（HTTP 401）；免费档约每 IP 每月 1000 credits，耗尽返回 HTTP 402 | 全部五个（search/extract/crawl/map/research） |
| `tavily` | `TAVILY_API_KEY` | 仅 search（限流） | 全部五个（search/extract/crawl/map/research） |
| `deepseek` | `DEEPSEEK_API_KEY`（必需） | 无——缺 key 即拒绝 | search |

适配器未原生支持的操作会沿路由阶梯落入通用 composite 层（纯 fetch + 可读性
提取），因此 extract/crawl/map 在任何 provider 上都可用。

## 配置（扩展后的 web-search-deepseek 段）

| 键 | 默认 | 含义 |
| :--- | :--- | :--- |
| `provider` | `firecrawl-keyless` | 每次搜索使用哪个适配器：firecrawl-keyless / tavily / deepseek。 |
| `apiKey` | 省略 | 字面 key（secret 角色）。官方设置卡会把值写入 `apiKeyEnv` 指向的 ref，而不是设置文件。 |
| `apiKeyEnv` | `FIRECRAWL_API_KEY` | 顶层凭据引用：卡片读它来决定 describe / 写入哪个 ref，且不再为它单独出行。当其值为受管 ref（`TAVILY_API_KEY` / `DEEPSEEK_API_KEY` / `FIRECRAWL_API_KEY`）时，`apply()` 会在 provider 变更时自动同步为当前 provider 的默认 ref，于是密钥行跟随 provider；任意自定义 ref 不覆盖。 |
| `baseURL` | 按 provider | 端点主机根；回退到适配器 env（`DEEPSEEK_SEARCH_BASE_URL` / `TAVILY_BASE_URL` / `FIRECRAWL_BASE_URL`）。 |
| `fetchBackend` | `"local"` | `local`：不动现有 fetch provider。`"adapter"`：额外注册 `web-search-extend` WebFetchProvider 提供单 URL extract（要求当前适配器有**原生** extract，如 tavily；用 `fetchProvider` / `DSH_WEB_FETCH_PROVIDER` 选择）。 |
| `compositeFallback` | `true` | 当前适配器原生支持 extract/crawl/map 但调用失败时，改用零配额的本地 composite 层重试，并在结果上附 warning；`false` 则直接抛出失败。 |
| `fallbacks` | `[]` | 在主适配器发生可切换失败（后端 / 配额 / 限流 / 缺凭据）后依次尝试的有序 adapter id 列表。未知 id、重复项与自引用会以可见错误拒绝该次设置写入；provider 会把 `[primary, ...fallbacks]` 包装为一个 ChainAdapter 运行。 |
| `tools.extract` | `true` | 注册 `web_extract`。 |
| `tools.crawl` | `true` | 注册 `web_crawl`。 |
| `tools.map` | `true` | 注册 `web_map`。 |
| `tools.scoped` | `true` | 注册 `web_search_scoped`（显式的时间 / 主题 / 地区 / 域名过滤）。 |
| `tools.research` | `true` | 注册 `web_research` + `web_research_status`（耗 credits）。 |
| `tools.doctor` | `true` | 注册 `web_doctor`（离线诊断；零网络/零配额）。 |
| `limits.extractMaxUrls` | `10` | 每次 web_extract 的最大 URL 数。 |
| `limits.crawlMaxPages` | `10` | 每次 web_crawl 的最大页数。 |
| `limits.mapMaxUrls` | `100` | 每次 web_map 的最大 URL 数。 |
| `limits.perPageChars` | `20000` | 提取/爬取内容的单页渲染上限。 |
| `cache.enabled` | `true` | 重复的 `web_search` 由本地结果缓存服务，不再走网络。 |
| `cache.ttlSeconds` | `900` | 缓存结果可被继续服务的时长。 |
| `cache.maxEntries` | `200` | 缓存条目上限，超出后淘汰最久未使用的一条。 |

`cache.*` 是配置文件项，不是卡片上的行：卡片保持官方控件清单（`provider`、`routeMode`、
`apiKey`、各 provider 参数），因此调缓存需要编辑 `web-search-deepseek` 段或经 settings RPC 写入。
| `deepseek.model` | 继承自 `@deepseek-ai/dsh-web-search-deepseek` | 官方 DeepSeek 模型 id。 |
| `deepseek.apiVersion` | 继承自 `@deepseek-ai/dsh-web-search-deepseek` | Messages API 版本。 |
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
    provider: firecrawl-keyless # 或：tavily | deepseek
    tools:
      research: true            # 打开耗 credits 的 research 工具
    limits:
      extractMaxUrls: 10
    tavily:
      searchDepth: basic
      includeAnswer: true
```

key ref 按 provider 各自解析，**无跨 provider 回退**（config.apiKeyEnv → 子节
apiKeyEnv → adapter 默认；受管 ref 的自动同步在 `apply()` 内，解析顺序见 AGENTS.md）。


## 模型面工具

| 工具 | 参数 | 行为 |
| :--- | :--- | :--- |
| `web_search` | `queries: string[]` | 官方工具，未改动——经所选 provider 路由。 |
| `web_search_scoped` | `query`、`provider?`、`maxResults?`、`timeRange?`（枚举 `day\|week\|month\|year`）、`afterDate?`、`topic?`、`locale?`、`includeDomains?`、`excludeDomains?` | 由**调用方显式命名**过滤条件，编译成各 provider 的原生参数。结果会报告哪些过滤生效、哪些当前 provider 表达不了。指定 `provider` 时精确使用该 provider，不并入失效转移链。 |
| `web_extract` | `urls: string[]`、`query?`、`format?` | 已知 URL 的可读内容（markdown/text）。tavily / firecrawl 原生；通用 composite 兜底。 |
| `web_crawl` | `url`、`maxPages?`、`includeDomains?`、`excludeDomains?` | 站点有界爬取。tavily / firecrawl 原生；BFS composite 兜底。 |
| `web_map` | `url`、`maxUrls?` | 枚举站点 URL。tavily / firecrawl 原生；sitemap/robots composite 兜底。 |
| `web_research` | `input` | 提交异步深度研究任务（耗 credits！）；返回 requestId。 |
| `web_research_status` | `requestId` | 轮询研究任务到终态；随后返回内容 + 来源列表。 |
| `web_doctor` | （无） | 离线就绪报告：列出每个已注册引擎的 key-ref 状态（仅布尔，绝不出值）、端点来源（config/env/default）、冷却窗口、可用性判定与解析后的生效链。零网络、零配额。 |

### 为什么要有 `web_search_scoped`，以及为什么不解析你的查询

`web_search` 是 seam 自带的工具，签名是 `{ query, maxResults? }`；加宽它就动了这个
插件存在的前提——"agent 侧什么都不变"。所以过滤条件走同级的另一个工具，而且由
**调用方**提供——这里**不会**去查询文本里找"最新""本周"这类词，因此没有词表要维护，
也没有猜错的机会。时间窗的词表是**封闭**的：`timeRange` 是四档枚举，`afterDate` 接
绝对日期 `YYYY-MM-DD`；一个自由字符串字段正是让"编译器认不出的拼法"悄悄消失的原因。
`afterDate` 格式非法、或两个时间字段同时给出，都会**报错**，而不是无声地按无约束搜索。

**调用方**提供过滤条件：模型决定调用它的那一刻，早已理解"本周"或"只搜 docs.example.com"
是什么意思，把过滤作为参数问出来不需要任何额外推理。从查询文本去猜则是另一回事，
而一个会静默收窄搜索的猜测，调用方根本看不见。

剩下的是机械翻译，每个 provider 一张映射表：

| 过滤 | tavily | firecrawl-keyless | deepseek |
| :--- | :--- | :--- | :--- |
| 时间窗口 | `timeRange`（最近档位）或 `startDate` | `tbs=qdr:*`（仅相对形式） | 忽略 |
| 主题 | `topic` | `sources: ["news"]` | 忽略 |
| 地区 | `country` | `location` | 忽略 |
| 域名 | `includeDomains` / `excludeDomains` | 同上，且两者绝不同时下发 | 忽略 |

每个结果都会写明哪些过滤真正到达了 provider（`Search (tavily, freshness, topic)`），
并点名没能到达的那些——被静默丢弃的过滤会把"本周没有任何发布"变成一句假话。当可能有
多个成员应答（配置了失效转移链，或指名 provider）时，只有**每个成员都能表达**的过滤
才会被编译：链由谁应答取决于谁先成功，某个跳次会忽略的条件会让含义随跳次漂移。两个
已知边界：`locale` 在两个 SDK 里都**没有可验证的格式**（调用方的字符串原样透传、不做
校验），而 `deepseek` 表达不了任何过滤，在它上面所有过滤都会被报为 ignored。

工具不随 provider 切换而消失——切换 provider 只改变每个调用走哪一层
（native / composite / unsupported）。research 由随包 `cordis.patch.yml` 条目配置默认
开启（`tools.research: true`）；schema 层的兜底默认值是 `false`。

**doctor 用法**：当搜索表现异常（疑似走错引擎、突然 402/429、"不可用"判定）时
调用 `web_doctor`。它离线、零配额地打印每引擎就绪状况——key-ref 解析（仅布尔）、
端点来源（config/env/default）、冷却窗口、可用性——以及生效链与 fallbacks 校验
问题。在动凭据或设置之前，先用它确认实际服务的是哪个引擎。


## Keyless Tavily

`TavilyAdapter.requiresApiKey = false` → 无 key 也可 `available()` 并 `search()`。
**keyless 只覆盖 search**：extract/crawl/map/research 会报凭据错误（WEB_PROVIDER_ERROR：
keyless 上限 / 端点不可用）。在凭据服务（Models 页）配置 TAVILY_API_KEY 即可完整
使用。ref 按 provider 各自解析，无跨 provider 回退（见 AGENTS.md）。


## Firecrawl keyless

`FirecrawlKeylessAdapter` 是默认 `provider`：全部五个操作都原生走 Firecrawl 托管 v2
端点——搜索零配置即可用。注意：

- **每月 credit 配额** —— keyless 层免费但有上限（约每 IP 每月 1000 credits；
  search 每 10 个结果消耗 2 credits）。耗尽后 Firecrawl 返回 HTTP 402，插件以
  `WEB_PROVIDER_ERROR` 上报，并指明配额与 `FIRECRAWL_API_KEY`。
- **配置 key 可提升配额** —— 在 `FIRECRAWL_API_KEY`（凭据服务 / Models 页）存入
  `fc-...` key 即可解除上限；已解析的 key 会以 Bearer token 发送，而非空且不以
  `fc-` 开头的值会让适配器不可用（视为存错 ref）。
- **research 需要 key** —— agent 式 research 端点拒绝 keyless 免费层（HTTP 401 →
  `WEB_PROVIDER_ERROR` 并指明 `FIRECRAWL_API_KEY`）；search/extract/crawl/map
  共享每月 credit 池。


## 故障转移链

设置 `fallbacks` 后，provider 会把 `[primary, ...fallbacks]` 包装为一个
`ChainAdapter`（core/chain.ts），router 与工具看到的仍是一个适配器：

- **可切换失败** —— `WEB_PROVIDER_ERROR`（后端失败 / 402 配额 / 429 限流 /
  网络）与 `WEB_PROVIDER_CREDENTIAL_MISSING` —— 尝试下一个成员。注意粒度较粗：
  各适配器目前把 bad-request 与服务端错误折叠为同一 code，硬 400 也会多消耗
  一次 fallback 尝试。
- **不可切换** —— `WEB_ABORTED`、`WEB_OP_UNSUPPORTED`、`WEB_OP_FAILED`、非
  WebError 崩溃 —— 立即原样抛出原始错误，不尝试其余成员。
- 每个操作只由具备该操作**原生方法**的成员执行；没有任何成员原生支持的操作
  在链上不存在，composite 层照旧兜底。一旦某成员对某操作是原生的，该操作就
  不会再落到 composite 层。
- `capabilitiesOf(chain)` = 成员能力并集；research 要求同一成员同时具备两个方
  法，并委托给第一个完整成员，**不做跨成员 failover**（request id 按厂商隔离）。
- 每次尝试都会通过注入的 `onAttempt` sink 追加一条 `{adapterId, outcome,
  durationMs}` 记录，且该轨迹以**附加字段**呈现在降级结果上（Step 5）：凡发生
  fallback/跳过的结果或错误都会携带 `attempts[]` 与人类可读的 `warnings[]`
  （"fell back X -> Y"、"X cooling until T"）。首个成员直接成功时不携带任何
  附加字段——静默即代表没有发生降级。
- **Cooldown** —— 任何 `WEB_PROVIDER_ERROR`（429 / 配额 / 5xx / 网络——与链的
  switchable 失效转移同一分类）都会让该成员进入冷却窗口：
  `60s * 2^(此前连续失败数)`，上限约 30 分钟。上游真的发了 `Retry-After` 时它
  **压过**这个估算值（下限 1 秒、上限同为 30 分钟）：服务端知道自己的配额何时
  重置，我们不知道。只有 deepseek 适配器能读到该响应头（HTTP 调用归它自己）；
  Tavily SDK 把该延迟作为响应体派生的 `retryAfter`（秒）暴露出来，已映射进同一
  信号；Firecrawl SDK 则完全丢弃，该成员继续走指数估算。
  `WEB_PROVIDER_CREDENTIAL_MISSING`
  绝不触发冷却：缺 key 不会随时间自愈。冷却成员被跳过（记录为 `skipped` 尝试），
  但当所有可执行成员都在冷却时会全部作为最后手段重试；任一成功都会清除该成员
  的窗口与计数。冷却板会持久化到 `<state dir>/state.json`，重启后接着走完剩余
  窗口，而不是立刻再去撞刚拒绝过我们的引擎；加载时丢弃已过期、以及超出上限的
  窗口，而失败计数在窗口过期后保留——与「进程一直没重启」的内存语义一致。
- **结果缓存** —— 两个搜索入口（经 seam provider 的 `web_search`、经自身 runner 的
  `web_search_scoped`）**共用同一个存储**，所以带过滤与不带过滤的调用不会互相serve
  对方的答案：key 也覆盖编译后的 settings，不同过滤条件天然是不同条目。
  extract/crawl/map/research 仍然每次都走网络。相同的查询 + 影响答案的配置在
  `cache.ttlSeconds` 内由内存直接服务；key 覆盖适配器、provider、base URL、
  settings 快照与请求本身，绝不包含凭据。
  命中属于降级成功：它会在 `warnings[]` 轨迹上带 `cache hit (age Ns)`，且**不带**
  `attempts[]`——因为没有任何成员被调用过。缓存与冷却板一起跨重启存活；状态文件
  写不进去时插件静默退化为纯内存，绝不会变成搜索失败。
- **Key rotation** —— 主适配器解析出的 key 值可包含逗号分隔的多个 key
  （`k1,k2,k3`，字面量或单个凭据 ref 的值）。auth / 配额 / 限流失败会在错误逃
  逸到链之前轮换到下一个 key；其他失败立即原样抛出；耗尽全部 key 后抛出原始
  最后错误并附加 `keyIndex` 诊断字段。轮换只在**一个 provider 自己的 ref**内进
  行，绝不跨 provider 借用（AGENTS.md 事故规则）；对外只暴露索引，绝不暴露
  key 本身。
- 已知限制：各成员共享由**主适配器**配置子节构建的同一个 runtime，因此某成员
  作为 fallback 服务时不会套用自己的 `tavily.*` 类专属参数（provider 接缝只
  下发单个 settings 对象）。


## 故障排查：`web_fetch` 报 `WEB_BLOCKED_URL`

`web_fetch` **不是**本插件的工具，但所有回落到 composite 层的 `web_*` 工具共用同一条 fetch
seam，因此它的失败会在这里暴露出来。

fetch provider 自行解析主机名，并**校验整个应答集**：只要有一条地址不是公网地址，请求在建立
连接之前就被拒绝。因此 TUN 模式代理下的失败分两类，且都与本插件配置无关：

| 现象 | 原因 | 处理 |
| :--- | :--- | :--- |
| 所有域名都失败，解析落在 `198.18.0.0/15` | 代理 DNS 处于 `fake-ip` 模式，而该段不是全局单播 | 把代理 DNS 的 `enhanced-mode` 改为 `redir-host`，或在启动环境里显式指定代理，让被路由的那一跳自行解析源站 |
| 只有个别域名失败 | 该域名的 AAAA 应答含校验器拒绝的地址，典型是 RFC 7050 的 NAT64 发现哨兵地址 `2001::1`（`ipaddr.js` 归类为 `teredo`） | 关掉代理 DNS 段的 IPv6（`dns.ipv6: false`）。主机没有全局 IPv6 地址时该记录本就无用，丢弃它可让干净的 A 应答通过 |

解析是竞速的，**失败与否取决于哪条应答先到**，所以什么都没改结果也可能在两次之间翻转。下结论
前先确认当前状态。

另有两个已在 Clash Verge + Hyprland 主机上验证过的坑：

- **订阅 profile 会覆盖 GUI 里的 DNS 覆写。** profile 自带 `dns:` 段时，会在下次重载时重新
  强加它自己的 `enhanced-mode`，于是 GUI 里的修改看似生效、随后静默回退。复测前请检查合成后的
  配置（`clash-verge.yaml`），而不是 GUI。
- **决定成败的是 IPv6 开关，不是解析器列表。** 只要 AAAA 应答参与校验，换 nameserver 就无济
  于事：A 应答完全干净，请求仍会因为旁边那条 AAAA 而失败。

## 错误分类

- `WEB_PROVIDER_CREDENTIAL_MISSING` — 需 key 后端无可用 key。
- `WEB_PROVIDER_ERROR` — 后端失败 / keyless 上限。
- `WEB_ABORTED` — 调用方取消。
- `WEB_OP_UNSUPPORTED` — 当前适配器既无 native 也无 composite 路径（如 deepseek 上的 research）。
- `WEB_OP_FAILED` — composite 执行了但无可用产出（如 web_map 找不到 sitemap）。


## 架构（分层 / 单一责任）

```
src/
  index.ts            # cordis 入口：穿官方身份，串联各层，向 ctx.web 注册 provider
  invariant.ts        # 包所有权伴侣（ctx.invariants）
  types.ts            # 契约层：SearchAdapter + AdapterRuntime
  config.ts           # 配置层：官方配置的超集 schema；DeepSeek 默认值继承自官方导出
  core/               # 接缝集成层（harness 接线，零厂商代码）
    provider.ts       # ExtensibleWebSearchProvider（id = deepseek-official）
    capabilities.ts   # capabilitiesOf()：能力由方法存在性推导
    router.ts         # execute()：native → composite → WEB_OP_UNSUPPORTED 阶梯
    composites.ts     # 通用 extract/map/crawl（注入 FetchLike，纯算法）
    html.ts           # 朴素 HTML → text/markdown 转换（兼容下限）
    registry.ts       # AdapterRegistry（可插拔机制）
    cache.ts          # ResultCache：LRU + TTL 的键值存储（纯逻辑，时钟注入）
    state.ts          # 冷却层与缓存层共享的原子 JSON 状态文档
    cooldown.ts       # 冷却板：Retry-After 解析 + 持久化
    abort.ts          # 取消处理（横切）
    errors.ts         # WebError 分类（横切）
  adapters/           # 适配层（每后端一文件，可插拔）
  tools/              # 模型面工具（extract/crawl/map/research）+ 共享格式化器
  ui/
    client.ts         # 入口：绑定配置表单、注册 plugins.item 卡片
    i18n.ts           # 语言字典 + translator
    config.ts         # providers/字段规格/slot 常量（类型化）
    types.ts          # DSH client 上下文/服务类型 + 表单控制器接口
    deepseek.ts       # DeepSeekAdapter（官方 Anthropic-compatible API，保留）
    tavily.ts         # TavilyAdapter（keyless）+ 响应映射
    firecrawl.ts      # FirecrawlKeylessAdapter（全部五个操作，key 可选）+ 响应映射
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

## 已验证

- **326 个 vitest 测试**（`tests/`）：路由阶梯、能力 pinning（tavily/firecrawl 五操作；
  deepseek 仅 search）、composite fixtures（sitemap 解析、HTML 转换、BFS 环路安全、单页失败隔离）、
  Tavily 全部响应形状映射、Firecrawl keyless（mock fetch：五个操作映射、鉴权头规则、
  402/429 配额/限流错误、research-keyless 401）、ChainAdapter 故障转移（可切换 vs 不可切换、原生能力跳过、
  D3 校验）、假时钟 cooldown 调度（指数退避、成功重置、全冷却最后手段）、多 key
  轮换（首个 key 401 → 第二个 key 服务）、降级轨迹（降级结果/错误携带 warnings +
  attempts，直接成功保持静默）与离线 doctor 报告（列出全部成员；输出不含任何
  key 形态内容）——全离线（假 fetch / mock SDK，零网络）。
- **缓存与状态**：存储行为（TTL 过期、LRU 顺序、容错加载）、挂载它的 provider 接缝
  （重复查询不再发起调用、命中被标注且不伪造 attempts、调用方的改动无法触达存储条目）、
  并发写入下的原子状态写、只读目录降级、两种 RFC 形式的 `Retry-After`（无该响应头时指数
  调度逐字节不变），以及跨真实进程边界（`spawnSync`）恢复的冷却板。
- 三层冷启动 preflight（composition 试跑 / resolve / client 身份）通过。
- 实机（人工）：各 provider ref 存储已验证；密钥行显示所解析 ref 的状态；真实 Tavily search/extract。
- `48cb333` 的 `github:` 安装在 dsh 0.1.7-rc.2 上能启动（卡片所需的 `configForms` 服务就位后未激活
  条目为 0）并正常渲染卡片；换成 linkedom 之前，同样的安装会 failed to import。


## 开发

```bash
npx tsc -p tsconfig.json      # src/ -> lib/（保留分层目录）
npm test                      # vitest（tests/），全离线
bash scripts/build.sh         # 打包 lib/index.js + lib/invariant.js（esbuild）
```
