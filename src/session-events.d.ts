/**
 * Session event keys emitted by this plugin. `session.append` only accepts
 * keys merged into `SessionEventMap` (plugin extension idiom used across the
 * official packages); without this declaration the pre-dispatch request log in
 * `src/index.ts` does not typecheck.
 */
declare module "@deepseek-ai/dsh-session" {
	interface SessionEventMap {
		/** Secret-free pre-dispatch record of one LLM search request. */
		"web/deepseek-search-llm-request": { endpoint: string; params: unknown };
	}
}
