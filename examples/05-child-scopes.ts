/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Child scopes — the per-request pattern: app-wide services live in a parent registry;
 *   each request opens a child scope that can see the parent's services, register its
 *   own, and shadow when it needs to. Disposing the parent reaches children first, and
 *   abort signals chain downward.
 *
 *   Run from a clone: `node examples/05-child-scopes.ts`
 *
 *   In your own project, import from "async-init" instead of the relative path.
 */

import { createToken, ServiceRegistry } from "async-init"

interface Logger extends AsyncDisposable {
	log(line: string): void
}

const ILogger = createToken<Logger>("logger")

function createLogger(prefix: string): Logger {
	return {
		log: (line) => console.log(`[${prefix}] ${line}`),
		async [Symbol.asyncDispose](): Promise<void> {
			console.log(`[${prefix}] logger closed`)
		},
	}
}

// The application scope: long-lived, shared services.
const app = new ServiceRegistry()

app.register(ILogger, createLogger("app"))

async function handleRequest(id: number, options?: { verbose: boolean }): Promise<void> {
	// One child scope per request — disposed at the end of this function.
	await using scope = app.createChild()

	// A verbose request shadows the shared logger with its own; others fall back to the parent's.
	if (options?.verbose) {
		scope.register(ILogger, createLogger(`request-${id}`))
	}

	const logger = await scope.get(ILogger)

	logger.log(`handling request ${id}`)
}

await handleRequest(1)
await handleRequest(2, { verbose: true }) // its scoped logger closes when the request ends

// Abort chains downward: every scope's `signal` aborts when an ancestor disposes.
const lingering = app.createChild()

console.log("child aborted before app dispose?", lingering.signal.aborted) // false

await app.dispose()

console.log("child aborted after app dispose?", lingering.signal.aborted) // true
