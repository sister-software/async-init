/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 * Quick tour:
 * - Build a tiny service registry.
 * - Auto-clean resources with `await using`.
 * - Keep strong types with tokens (`get` needs no casts).
 * - Use interface-only services (no class required).
 *
 * Run from a clone:
 * - `node examples/03-registry.ts`
 *
 * In your app:
 * - Import from "async-init" (not this relative path).
 */

import { asyncInit, createToken, ServiceRegistry } from "async-init"

// Interface-only service type. No class needed.
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

	// Option A: register an existing instance.
	registry.register(IClock, {
		now: () => Date.now(),
		async [Symbol.asyncDispose](): Promise<void> {
			console.log("clock stopped")
		},
	})

	// Option B: register a constructor.
	// Both options are resolved lazily.
	registry.register(IAuditLog, AuditLog)

	const clock = await registry.get(IClock) // Typed as Clock. No cast.
	const log = await registry.get(IAuditLog)

	log.record(`started at ${clock.now()}`)
}
// On scope exit, disposal is LIFO:
// 1) "audit log flushed 1 record(s)"
// 2) "clock stopped"
