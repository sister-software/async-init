/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * - Each request gets a child scope.
 * - Child scopes can use parent services.
 * - Child scopes can override (shadow) services.
 * - Disposing parent disposes children first.
 * - Abort signals flow parent -> child.
 *
 * Run from clone: `node examples/05-child-scopes.ts`
 * In your project, import from "async-init".
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

// App scope = long-lived + shared services.
const app = new ServiceRegistry()

app.register(ILogger, createLogger("app"))

async function handleRequest(id: number, options?: { verbose: boolean }): Promise<void> {
	// 1 request = 1 child scope.
	// Auto-disposed when this function ends.
	await using scope = app.createChild()

	// Verbose request? Use request-specific logger (shadows app logger).
	// Not verbose? Use app logger.
	if (options?.verbose) {
		scope.register(ILogger, createLogger(`request-${id}`))
	}

	const logger = await scope.get(ILogger)

	logger.log(`handling request ${id}`)
}

await handleRequest(1)
await handleRequest(2, { verbose: true }) // request logger closes when request ends

// Abort flows downward.
// If parent disposes, child `signal` aborts too.
const lingering = app.createChild()

console.log("child aborted before app dispose?", lingering.signal.aborted)

// expected: false

await app.dispose()

console.log("child aborted after app dispose?", lingering.signal.aborted) // expected: true
