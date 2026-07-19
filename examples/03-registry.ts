/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Layer 3 — ServiceRegistry: token-keyed lookup with typed results, and LIFO teardown
 *   through `await using`. Tokens carry a phantom type, so `get` needs no casts — and an
 *   interface-typed service needs no class at all.
 *
 *   Run from a clone: `node examples/03-registry.ts`
 *
 *   In your own project, import from "async-init" instead of the relative path.
 */

import { asyncInit, createToken, ServiceRegistry } from "../index.ts"

// A service typed purely by interface — no class required.
interface Clock extends AsyncDisposable {
	now(): number
}

const IClock = createToken<Clock>("clock")

class AuditLog {
	readonly #records: string[] = []

	public async [asyncInit](): Promise<void> {
		console.log("audit log ready")
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		console.log(`audit log flushed ${this.#records.length} record(s)`)
	}

	public record(line: string): void {
		this.#records.push(line)
	}
}

const IAuditLog = createToken<AuditLog>("audit-log")

{
	await using registry = new ServiceRegistry()

	// Register a pre-built instance...
	registry.register(IClock, {
		now: () => Date.now(),
		async [Symbol.asyncDispose](): Promise<void> {
			console.log("clock stopped")
		},
	})

	// ...or a constructor — resolution is lazy either way.
	registry.register(IAuditLog, AuditLog)

	const clock = await registry.get(IClock) // typed Clock — no cast
	const log = await registry.get(IAuditLog)

	log.record(`started at ${clock.now()}`)
}
// Scope exit disposes in LIFO order: "audit log flushed 1 record(s)", then "clock stopped".
