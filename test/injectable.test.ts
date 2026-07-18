/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { asyncInit } from "../lib/protocol.ts"
import { ServiceRegistry } from "../lib/registry.ts"
import { createToken } from "../lib/token.ts"

class Logger {
	public readonly lines: string[] = []
	public initialized = false

	public async [asyncInit](): Promise<void> {
		this.initialized = true
	}

	public async [Symbol.asyncDispose](): Promise<void> {}

	public log(line: string): void {
		this.lines.push(line)
	}
}

const ILogger = createToken<Logger>("logger")

describe("injectable constructors", () => {
	it("resolves + initializes declared dependencies BEFORE the constructor body runs", async () => {
		class Indexer {
			public static readonly dependencies = [ILogger] as const

			public readonly sawInitializedLogger: boolean

			constructor(logger: Logger) {
				// The whole point: the dependency is usable inside the constructor.
				logger.log("indexer constructed")
				this.sawInitializedLogger = logger.initialized
			}

			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		const IIndexer = createToken<Indexer>("indexer")

		await using registry = new ServiceRegistry()
		registry.register(ILogger, Logger)
		registry.register(IIndexer, Indexer)

		const indexer = await registry.get(IIndexer)
		expect(indexer.sawInitializedLogger).toBe(true)

		const logger = await registry.get(ILogger)
		expect(logger.lines).toEqual(["indexer constructed"])
	})

	it("shares dependency instances (memoized through the same handles)", async () => {
		class ConsumerA {
			public static readonly dependencies = [ILogger] as const
			public readonly logger: Logger

			constructor(logger: Logger) {
				this.logger = logger
			}

			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		class ConsumerB {
			public static readonly dependencies = [ILogger] as const
			public readonly logger: Logger

			constructor(logger: Logger) {
				this.logger = logger
			}

			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		const IA = createToken<ConsumerA>("consumer-a")
		const IB = createToken<ConsumerB>("consumer-b")

		await using registry = new ServiceRegistry()
		registry.register(ILogger, Logger)
		registry.register(IA, ConsumerA)
		registry.register(IB, ConsumerB)

		const [a, b] = await Promise.all([registry.get(IA).resolve(), registry.get(IB).resolve()])
		expect(a.logger).toBe(b.logger)
	})

	it("throws E_MISSING_DEPENDENCY naming both the requester and the missing token", async () => {
		class Needy {
			public static readonly dependencies = [ILogger] as const

			constructor(_logger: Logger) {}

			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		const INeedy = createToken<Needy>("needy")

		await using registry = new ServiceRegistry()
		registry.register(INeedy, Needy)

		const error: unknown = await registry
			.get(INeedy)
			.resolve()
			.then(
				() => null,
				(caught: unknown) => caught
			)

		expect(error).toMatchObject({ code: "E_MISSING_DEPENDENCY" })
		expect((error as Error).message).toContain("needy")
		expect((error as Error).message).toContain("logger")
	})

	it("throws E_DEPENDENCY_CYCLE with the full path", async () => {
		const IA = createToken<object>("a")
		const IB = createToken<object>("b")

		class A {
			public static readonly dependencies = [IB] as const
			constructor(_b: object) {}
			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		class B {
			public static readonly dependencies = [IA] as const
			constructor(_a: object) {}
			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		await using registry = new ServiceRegistry()
		registry.register(IA, A)
		registry.register(IB, B)

		await expect(registry.get(IA).resolve()).rejects.toThrowError(
			expect.objectContaining({
				code: "E_DEPENDENCY_CYCLE",
				message: expect.stringContaining("a → b → a"),
			})
		)
	})

	it("routes a factory with a stray non-token `dependencies` array as a plain resolver", async () => {
		// A plain factory function that happens to carry a `dependencies` property whose elements don't look like
		// tokens (no `description` string). `isInjectableConstructor` must reject this — it should be treated as an
		// ordinary factory, not misdetected as an injectable constructor and passed through the DI machinery.
		function createWidget(): { readonly label: string } {
			return { label: "plain-widget" }
		}
		createWidget.dependencies = ["not-a-token"]

		const IWidget = createToken<{ readonly label: string }>("widget")

		await using registry = new ServiceRegistry()
		registry.register(IWidget, createWidget as unknown as () => { readonly label: string })

		const widget = await registry.get(IWidget)
		expect(widget.label).toBe("plain-widget")
	})

	it("detects indirect cycles (a → b → c → a)", async () => {
		const IA = createToken<object>("a")
		const IB = createToken<object>("b")
		const IC = createToken<object>("c")

		class A {
			public static readonly dependencies = [IB] as const
			constructor(_b: object) {}
			public async [Symbol.asyncDispose](): Promise<void> {}
		}
		class B {
			public static readonly dependencies = [IC] as const
			constructor(_c: object) {}
			public async [Symbol.asyncDispose](): Promise<void> {}
		}
		class C {
			public static readonly dependencies = [IA] as const
			constructor(_a: object) {}
			public async [Symbol.asyncDispose](): Promise<void> {}
		}

		await using registry = new ServiceRegistry()
		registry.register(IA, A)
		registry.register(IB, B)
		registry.register(IC, C)

		await expect(registry.get(IA).resolve()).rejects.toThrowError(
			expect.objectContaining({ code: "E_DEPENDENCY_CYCLE" })
		)
	})
})
