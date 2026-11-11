/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Quick demo: async init + async dispose protocol.
 * Run from repo root: `node examples/01-protocol.ts`
 * In your app, import from "async-init" (not a relative path).
 */

import { asyncInit, construct, init, isAsyncDisposable, isAsyncInitializable, isDisposed } from "async-init"

class Database {
	public connected = false

	readonly #url: string

	constructor(url: string) {
		this.#url = url
	}

	public async [asyncInit](): Promise<void> {
		// Everything `new` can't do: open sockets, handshake, warm caches.
		this.connected = true

		console.log(`connected to ${this.#url}`)
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		this.connected = false

		console.log(`closed ${this.#url}`)
	}
}

// `construct` = `new` + async init (one step).
// Args are type-checked from the constructor.
const db = await construct(Database, "postgres://localhost/demo")

console.log("connected?", db.connected)

// expected: true

// Use `init` when you already created the instance.
const other = await init(new Database("postgres://localhost/other"))

// Guards use `in`, so inherited symbol methods still count.
class ReplicaDatabase extends Database {}

console.log("initializable?", isAsyncInitializable(new ReplicaDatabase("postgres://replica"))) // true
console.log("disposable?", isAsyncDisposable(db))

// expected: true

// `await using` gives auto-cleanup at scope end.
async function scopedDemo(): Promise<void> {
	await using scoped = await construct(Database, "postgres://localhost/scoped")

	console.log("inside the scope, connected?", scoped.connected)
}

await scopedDemo()
// By here, "closed .../scoped" was already logged.

await db[Symbol.asyncDispose]()
await other[Symbol.asyncDispose]()

console.log("marked disposed by a handle?", isDisposed(db)) // false: direct dispose doesn't mark; Service handles do
