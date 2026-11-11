/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { createToken, ServiceRegistry } from "async-init"
import type { ServiceProxy, ServiceToken, TokenInstances } from "async-init"
import { describe, expectTypeOf, it } from "vitest"

interface Logger {
	readonly level: number
	log(line: string): Promise<boolean>
}

const ILogger = createToken<Logger>("logger")

describe("ServiceProxy", () => {
	it("methods become promise-returning, properties become thunks", () => {
		expectTypeOf<ServiceProxy<Logger>["log"]>().toEqualTypeOf<(line: string) => Promise<boolean>>()

		expectTypeOf<ServiceProxy<Logger>["level"]>().toEqualTypeOf<() => Promise<number>>()
	})
})

describe("TokenInstances", () => {
	it("maps token tuples to instance tuples", () => {
		expectTypeOf<TokenInstances<readonly [ServiceToken<Logger>, ServiceToken<number>]>>().toEqualTypeOf<
			readonly [Logger, number]
		>()
	})
})

describe("registry inference", () => {
	it("get() infers the token's phantom type", () => {
		const registry = new ServiceRegistry()

		const service = registry.get(ILogger)
		expectTypeOf(service.resolve()).resolves.toEqualTypeOf<Logger>()
	})

	// oxlint-disable-next-line vitest/expect-expect -- Type-level test, no runtime expectation needed.
	it("register() rejects a constructor whose signature contradicts its dependencies", () => {
		class Mismatched {
			public static readonly dependencies = [ILogger] as const

			// Declares [ILogger] (a Logger) but demands a string — must NOT be registrable.
			constructor(_wrong: string) {}

			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		const IMismatched = createToken<Mismatched>("mismatched")
		const registry = new ServiceRegistry()

		// @ts-expect-error — constructor parameter types contradict the declared dependency tokens
		registry.register(IMismatched, Mismatched)
	})
})
