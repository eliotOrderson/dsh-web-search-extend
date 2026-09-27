import type { LocaleRuntimeLike } from "./types.js";

const I18N: Record<string, Record<string, string>> = {
    zh: {
        cardTitle: "网页搜索",
        cardDescription: "搜索引擎、路由与各提供方参数。",
        apiKeyLabel: "API Key",
        apiKeyHint: "不写入设置文件。留空表示保持当前密钥。",
        providerLabel: "搜索提供方",
        provider_tavily: "Tavily（免密钥）",
        provider_deepseek: "DeepSeek（官方后端）",
        provider_firecrawl_keyless: "Firecrawl（免密钥）",
        routeModeLabel: "路由模式（extract / crawl / map）",
        route_provider_first: "优先提供商，失败走本地",
        route_local_only: "仅本地",
        bool_on: "开",
        bool_off: "关",
        optionAny: "不限",
        "tavily.searchDepth.label": "搜索深度",
        "tavily.searchDepth.hint": "Advanced 约 2 credits，且会重排更多来源。",
        "tavily.topic.label": "话题类别",
        "tavily.maxResults.label": "单次返回结果数",
        "tavily.includeAnswer.label": "附带摘要回答",
        "tavily.timeRange.label": "时间范围",
        "tavily.extractDepth.label": "抽取深度",
        "tavily.extractDepth.hint": "Advanced 会连同页面嵌入内容一起抽取。",
        "tavily.researchModel.label": "Research 模型",
        "deepseek.maxTokens.label": "单次最大 Token",
        "deepseek.maxTokens.hint": "每次服务端搜索调用的响应 Token 上限，影响成本与截断点。",
        "deepseek.maxUses.label": "单次请求最多搜索次数",
        save: "保存",
        saving: "保存中…",
        overridden: "已覆盖",
        reset: "恢复默认",
        readOnly: "本部署的设置为只读。",
        unavailable: "该插件当前未加载，暂时无法配置。",
        saveFailed: "本部署没有接受这些值，已保留供你修改。",
        invalidNumber: "请填数字；留空表示使用默认值。",
        apiKeySet: "已配置密钥。",
        apiKeyUnset: "未配置密钥；配置之前搜索不可用。",
        baseUrlLabel: "接口地址",
        baseUrlHint: "留空则使用提供方默认地址。",
    },
    en: {
        cardTitle: "Web search",
        cardDescription: "Search engine, routing, and per-provider parameters.",
        apiKeyLabel: "API Key",
        apiKeyHint: "Not stored in the settings file. Leave empty to keep the current key.",
        providerLabel: "Search provider",
        provider_tavily: "Tavily (keyless)",
        provider_deepseek: "DeepSeek (official backend)",
        provider_firecrawl_keyless: "Firecrawl (keyless)",
        routeModeLabel: "Routing mode (extract / crawl / map)",
        route_provider_first: "Provider first, fall back to local",
        route_local_only: "Local only",
        bool_on: "On",
        bool_off: "Off",
        optionAny: "Any time",
        "tavily.searchDepth.label": "Search depth",
        "tavily.searchDepth.hint": "Advanced costs about 2 credits and re-ranks more sources.",
        "tavily.topic.label": "Topic",
        "tavily.maxResults.label": "Max results",
        "tavily.includeAnswer.label": "Include answer",
        "tavily.timeRange.label": "Time range",
        "tavily.extractDepth.label": "Extract depth",
        "tavily.extractDepth.hint": "Advanced also pulls embedded page data.",
        "tavily.researchModel.label": "Research model",
        "deepseek.maxTokens.label": "Max tokens per search",
        "deepseek.maxTokens.hint": "Response token ceiling of each server-side search call; affects cost and truncation.",
        "deepseek.maxUses.label": "Max searches per request",
        save: "Save",
        saving: "Saving…",
        overridden: "Overridden",
        reset: "Reset to default",
        readOnly: "This deployment stores settings read-only.",
        unavailable: "This plugin is not loaded, so it cannot be configured right now.",
        saveFailed: "The deployment did not accept these values; they were left for you to correct.",
        invalidNumber: "Enter a number, or leave blank to use the default.",
        apiKeySet: "A key is configured.",
        apiKeyUnset: "No key is configured; search is unavailable until one is.",
        baseUrlLabel: "Endpoint",
        baseUrlHint: "Leave blank to use the provider default.",
    },
};

export interface Translator {
    (key: string, lang?: string): string;
    language(): string;
    subscribeLanguage(listener: () => void): (() => void) | undefined;
}

/** The card's dictionary, in the shape `ctx.locale.register(namespace, ...)` takes. */
export const DICTIONARY = I18N;

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
