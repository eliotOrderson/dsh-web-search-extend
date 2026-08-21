import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
const stub = pathToFileURL(fileURLToPath(new URL("./tavily-stub.mjs", import.meta.url))).href;
export async function resolve(specifier, context, next) {
	if (specifier === "@tavily/core") return { url: stub, shortCircuit: true };
	return next(specifier, context);
}
