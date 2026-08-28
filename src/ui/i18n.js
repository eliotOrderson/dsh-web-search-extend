const I18N = {
	zh: {
		providerLabel: "搜索提供方 (Provider)",
		providerHint: "选择本次搜索使用的后端，接口地址由提供方自动决定。",
        provider_tavily: "Tavily（免密钥 Search）",
		provider_firecrawl_keyless: "Firecrawl（免密钥 Search, default）",
		provider_deepseek: "DeepSeek（官方后端）",
		routeModeLabel: "路由模式（extract / crawl / map）",
		route_provider_first: "优先提供商，失败走本地",
		route_local_only: "仅本地",
		"tavily.searchDepth.label": "搜索深度",
		"tavily.searchDepth.hint": "basic 快而省（1 credit）；advanced 深挖更多来源并重排（约 2 credits）；fast / ultra-fast 为低延迟档。",
		"tavily.topic.label": "话题类别",
		"tavily.topic.hint": "general 常规网页；news 新闻源、时效优先；finance 财经数据源。",
		"tavily.maxResults.label": "单次返回结果数",
		"tavily.maxResults.hint": "单次搜索返回的结果条数上限。",
		"tavily.includeAnswer.label": "附带摘要回答",
		"tavily.includeAnswer.hint": "由后端在结果之外再生成一段摘要回答。",
		"tavily.timeRange.label": "时间范围",
		"tavily.timeRange.hint": "限制结果发布时间：day / week / month / year，留空不限。",
		"tavily.extractDepth.label": "抽取深度",
		"tavily.extractDepth.hint": "basic 常规抽取；advanced 提取更完整（含页面嵌入内容），更慢、更耗配额。",
		"tavily.researchModel.label": "Research 模型",
		"tavily.researchModel.hint": "research 异步任务所用模型：auto 自选 / mini 快 / pro 强。",
		"deepseek.maxTokens.label": "单次最大 Token",
		"deepseek.maxTokens.hint": "每次服务端搜索调用的响应 Token 上限，影响成本与截断点。",
		"deepseek.maxUses.label": "单次请求最多搜索次数",
		"deepseek.maxUses.hint": "单次对话内允许工具执行的搜索次数上限。",
	},
	en: {
		providerLabel: "Search provider",
		providerHint: "Choose the backend serving each search; the endpoint follows automatically.",
        provider_tavily: "Tavily (keyless-search)",
		provider_firecrawl_keyless: "Firecrawl (keyless-search, default)",
		provider_deepseek: "DeepSeek",
		routeModeLabel: "Router mode（extract / crawl / map）",
		route_provider_first: "Provider first, fall back to local",
		route_local_only: "Local only",
		"tavily.searchDepth.label": "Search depth",
		"tavily.searchDepth.hint": "basic is fast and cheap (1 credit); advanced digs deeper and re-ranks (~2 credits); fast / ultra-fast are low-latency tiers.",
		"tavily.topic.label": "Topic",
		"tavily.topic.hint": "general covers the open web; news favors news sources and recency; finance targets financial sources.",
		"tavily.maxResults.label": "Max results",
		"tavily.maxResults.hint": "Upper bound on results returned per search.",
		"tavily.includeAnswer.label": "Include answer",
		"tavily.includeAnswer.hint": "Generates a short summary answer alongside the results.",
		"tavily.timeRange.label": "Time range",
		"tavily.timeRange.hint": "Restrict results to day / week / month / year; leave empty for no limit.",
		"tavily.extractDepth.label": "Extract depth",
		"tavily.extractDepth.hint": "basic is standard extraction; advanced pulls fuller content (embedded data), slower and costlier.",
		"tavily.researchModel.label": "Research model",
		"tavily.researchModel.hint": "Model for async research tasks: auto / mini (fast) / pro (strongest).",
		"deepseek.maxTokens.label": "Max tokens per search",
		"deepseek.maxTokens.hint": "Response token ceiling of each server-side search call; affects cost and truncation.",
		"deepseek.maxUses.label": "Max searches per request",
		"deepseek.maxUses.hint": "How many times the tool may search within one conversation turn.",
	},
};

export function createTranslator(locale) {
	const activeLanguage = () => {
		try {
			return locale?.getSnapshot?.()?.active === "en" ? "en" : "zh";
		} catch {
			return "zh";
		}
	};

	return (key) => I18N[activeLanguage()]?.[key] ?? I18N.zh[key] ?? key;
}
