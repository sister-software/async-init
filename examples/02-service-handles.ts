/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Layer 2 — Service<T>: a lazy, awaitable, disposable handle. Nothing runs until the
 *   first await; concurrent awaiters share one construction; the proxy view lets you
 *   call methods before resolution.
 *
 *   Run from a clone: `node examples/02-service-handles.ts`
 *
 *   In your own project, import from "async-init" instead of the relative path.
 */

import { asyncInit, proxyService, Service } from "../index.ts"

let constructions = 0

class SearchIndex {
	public readonly entries = new Map<string, string>()

	public async [asyncInit](): Promise<void> {
		constructions += 1

		// Simulate a slow index build.
		await new Promise((resolve) => setTimeout(resolve, 50))
		this.entries.set("hello", "world")
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		this.entries.clear()

		console.log("index released")
	}

	public lookup(key: string): string | undefined {
		return this.entries.get(key)
	}
}

const service = new Service(SearchIndex)

// Construction is lazy — nothing has run yet.
console.log("instance before any await:", service.instance) // null

// Concurrent awaiters share ONE in-flight resolution — no duplicate builds.
const [a, b] = await Promise.all([service.resolve(), service.resolve()])

console.log("same instance?", a === b, "— built", constructions, "time(s)")
console.log("lookup:", a.lookup("hello"))

// The proxy view forwards calls through lazy resolution:
const proxied = proxyService(new Service(SearchIndex))

console.log("via proxy method:", await proxied.lookup("hello")) // methods return promises
console.log("via property thunk:", (await proxied.entries()).size) // plain properties become thunks

// Disposing the handle disposes the resolved instance — exactly once, even if called again.
await service[Symbol.asyncDispose]()
await service[Symbol.asyncDispose]()
await proxied[Symbol.asyncDispose]()
