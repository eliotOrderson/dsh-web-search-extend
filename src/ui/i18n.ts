import type { LocaleRuntimeLike } from "./types.js";

const I18N: Record<string, Record<string, string>> = {
    zh: {
        cardTitle: "网页搜索",
        cardDescription: "搜索引擎、路由与各提供方参数。",
        apiKeyLabel: "API Key",
        apiKeyHint: "不写入设置文件。留空表示保持当前密钥。",
        badge_configured: "已配置密钥。",
        badge_firecrawl_keyless: "免密钥即可搜索；配置 fc- 密钥仅用于提升配额。",
        badge_tavily: "免密钥即可搜索；配置密钥后解锁 extract / crawl / map / research。",
        badge_deepseek: "未配置密钥；配置之前搜索不可用。",
        providerLabel: "搜索提供方 (Provider)",
        providerHint: "选择本次搜索使用的后端，接口地址由提供方自动决定。",
        provider_tavily: "Tavily（免密钥）",
        provider_deepseek: "DeepSeek（官方后端）",
        provider_firecrawl_keyless: "Firecrawl（免密钥）",
        routeModeLabel: "路由模式（extract / crawl / map）",
        route_provider_first: "优先提供商，失败走本地",
        route_local_only: "仅本地",
        bool_on: "开",
        bool_off: "关",
        keylessNote: "Firecrawl keyless 无额外参数；各参数仅对当前所选提供方生效。",
        "tavily.searchDepth.label": "搜索深度",
        "tavily.searchDepth.hint": "Basic 快而省（1 credit）；Advanced 深挖更多来源并重排（约 2 credits）；Fast / Ultra-Fast 为低延迟档。",
        "tavily.topic.label": "话题类别",
        "tavily.topic.hint": "General 常规网页；News 新闻源、时效优先；Finance 财经数据源。",
        "tavily.maxResults.label": "单次返回结果数",
        "tavily.maxResults.hint": "单次搜索返回的结果条数上限。",
        "tavily.includeAnswer.label": "附带摘要回答",
        "tavily.includeAnswer.hint": "由后端在结果之外再生成一段摘要回答。",
        "tavily.timeRange.label": "时间范围",
        "tavily.timeRange.hint": "限制结果发布时间：day / week / month / year，留空不限。",
        "tavily.extractDepth.label": "抽取深度",
        "tavily.extractDepth.hint": "Basic 常规抽取；Advanced 提取更完整（含页面嵌入内容），更慢、更耗配额。",
        "tavily.researchModel.label": "Research 模型",
        "tavily.researchModel.hint": "research 异步任务所用模型：Auto 自选 / Mini 快 / Pro 强。",
        "deepseek.maxTokens.label": "单次最大 Token",
        "deepseek.maxTokens.hint": "每次服务端搜索调用的响应 Token 上限，影响成本与截断点。",
        "deepseek.maxUses.label": "单次请求最多搜索次数",
        "deepseek.maxUses.hint": "单次对话内允许工具执行的搜索次数上限。",
    },
    en: {
        cardTitle: "Web search",
        cardDescription: "Search engine, routing, and per-provider parameters.",
        apiKeyLabel: "API Key",
        apiKeyHint: "Not stored in the settings file. Leave empty to keep the current key.",
        badge_configured: "Key configured.",
        badge_firecrawl_keyless: "Search works without a key; an fc- key only raises the quota.",
        badge_tavily: "Keyless search works; a configured key unlocks extract / crawl / map / research.",
        badge_deepseek: "No key configured; search is unavailable until one is.",
        providerLabel: "Search provider",
        providerHint: "Choose the backend serving each search; the endpoint follows automatically.",
        provider_tavily: "Tavily (keyless)",
        provider_deepseek: "DeepSeek (official backend)",
        provider_firecrawl_keyless: "Firecrawl (keyless)",
        routeModeLabel: "Routing mode (extract / crawl / map)",
        route_provider_first: "Provider first, fall back to local",
        route_local_only: "Local only",
        bool_on: "On",
        bool_off: "Off",
        keylessNote: "Firecrawl keyless has no extra parameters; fields below apply to the selected provider.",
        "tavily.searchDepth.label": "Search depth",
        "tavily.searchDepth.hint": "Basic is fast and cheap (1 credit); Advanced digs deeper and re-ranks (~2 credits); Fast / Ultra-Fast are low-latency tiers.",
        "tavily.topic.label": "Topic",
        "tavily.topic.hint": "General covers the open web; News favors news sources and recency; Finance targets financial sources.",
        "tavily.maxResults.label": "Max results",
        "tavily.maxResults.hint": "Upper bound on results returned per search.",
        "tavily.includeAnswer.label": "Include answer",
        "tavily.includeAnswer.hint": "Generates a short summary answer alongside the results.",
        "tavily.timeRange.label": "Time range",
        "tavily.timeRange.hint": "Restrict results to day / week / month / year; leave empty for no limit.",
        "tavily.extractDepth.label": "Extract depth",
        "tavily.extractDepth.hint": "Basic is standard extraction; Advanced pulls fuller content (embedded data), slower and costlier.",
        "tavily.researchModel.label": "Research model",
        "tavily.researchModel.hint": "Model for async research tasks: Auto / Mini (fast) / Pro (strongest).",
        "deepseek.maxTokens.label": "Max tokens per search",
        "deepseek.maxTokens.hint": "Response token ceiling of each server-side search call; affects cost and truncation.",
        "deepseek.maxUses.label": "Max searches per request",
        "deepseek.maxUses.hint": "How many times the tool may search within one conversation turn.",
    },
};

export interface Translator {
    (key: string, lang?: string): string;
    language(): string;
    subscribeLanguage(listener: () => void): (() => void) | undefined;
}

export type TranslateKey = (key: string) => string;

export function createTranslator(locale: LocaleRuntimeLike): Translator {
    const language = (): string => {
        try {
            return locale.getSnapshot().active === "en" ? "en" : "zh";
        } catch {
            return "zh";
        }
    };

    const translate = ((key: string, lang: string = language()) =>
        I18N[lang]?.[key] ?? I18N.zh?.[key] ?? key) as Translator;
    translate.language = language;
    translate.subscribeLanguage = (listener: () => void) => {
        try {
            return locale.subscribe(listener);
        } catch {
            return undefined;
        }
    };
    return translate;
}
