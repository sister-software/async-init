/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Layer 1 — the protocol: a symbol for async construction, plus guards that walk the
 *   prototype chain.
 *
 *   Run from a clone: `node examples/01-protocol.ts`
 *
 *   In your own project, import from "async-init" instead of the relative path.
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

// `construct` is `new` + init in one call — arguments are typed against the constructor.
const db = await construct(Database, "postgres://localhost/demo")

console.log("connected?", db.connected) // true

// `init` covers the case where you already hold an instance.
const other = await init(new Database("postgres://localhost/other"))

// The guards use `in`, so subclasses inheriting the symbol methods are still detected.
class ReplicaDatabase extends Database {}

console.log("initializable?", isAsyncInitializable(new ReplicaDatabase("postgres://replica"))) // true
console.log("disposable?", isAsyncDisposable(db)) // true

// `await using` pairs with the protocol for scoped teardown:
async function scopedDemo(): Promise<void> {
	await using scoped = await construct(Database, "postgres://localhost/scoped")

	console.log("inside the scope, connected?", scoped.connected)
}

await scopedDemo()
// "closed postgres://localhost/scoped" has printed by this line.

await db[Symbol.asyncDispose]()
await other[Symbol.asyncDispose]()

console.log("marked disposed by a handle?", isDisposed(db)) // false — direct disposal doesn't mark; Service handles do
