/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { ServiceRegistry, createToken } from "async-init"
import { describe, expect, it } from "vitest"

interface Logger {
	readonly lines: string[]
	log(line: string): void
}

const ILogger = createToken<Logger & AsyncDisposable>("logger")

function createTestLogger(onDispose?: () => void): Logger & AsyncDisposable {
	return {
		lines: [],
		log(line: string): void {
			this.lines.push(line)
		},
		async [Symbol.asyncDispose](): Promise<void> {
			onDispose?.()
		},
	}
}

describe("createToken", () => {
	it("produces frozen, identity-keyed tokens", () => {
		const token = createToken<Logger>("logger")

		expect(token.description).toBe("logger")
		expect(Object.isFrozen(token)).toBe(true)
		expect(createToken<Logger>("logger")).not.toBe(token)
	})
})

describe("ServiceRegistry", () => {
	it("registers and gets by token, typed by interface", async () => {
		await using registry = new ServiceRegistry()

		registry.register(ILogger, createTestLogger())
		const logger = await registry.get(ILogger)

		logger.log("hi")
		expect(logger.lines).toEqual(["hi"])
	})

	it("register returns the proxied handle directly", async () => {
		await using registry = new ServiceRegistry()

		const handle = registry.register(ILogger, createTestLogger())
		await handle.log("via proxy")

		expect((await handle).lines).toEqual(["via proxy"])
	})

	it("throws E_DUPLICATE_TOKEN on double registration", async () => {
		await using registry = new ServiceRegistry()
		registry.register(ILogger, createTestLogger())

		expect(() => registry.register(ILogger, createTestLogger())).toThrow(
			expect.objectContaining({ code: "E_DUPLICATE_TOKEN" })
		)
	})

	it("throws E_UNRESOLVED_TOKEN for unknown tokens", async () => {
		await using registry = new ServiceRegistry()

		expect(() => registry.get(ILogger)).toThrow(expect.objectContaining({ code: "E_UNRESOLVED_TOKEN" }))
	})

	it("disposes resolved services LIFO, aborting the signal first", async () => {
		const order: string[] = []
		const registry = new ServiceRegistry()

		const IFirst = createToken<AsyncDisposable>("first")
		const ISecond = createToken<AsyncDisposable>("second")

		registry.register(IFirst, {
			async [Symbol.asyncDispose]() {
				order.push("first")
			},
		})

		registry.register(ISecond, {
			async [Symbol.asyncDispose]() {
				order.push("second")
			},
		})

		await registry.get(IFirst).resolve()
		await registry.get(ISecond).resolve()

		registry.signal.addEventListener("abort", () => order.push("abort"), {
			once: true,
		})

		await registry.dispose()

		expect(order).toEqual(["abort", "second", "first"])
	})

	it("disposes a resolved-but-never-awaited-by-caller service", async () => {
		let disposeCount = 0
		const registry = new ServiceRegistry()

		const handle = registry.register(
			ILogger,
			createTestLogger(() => (disposeCount += 1))
		)

		await handle.resolve()

		await registry.dispose()
		expect(disposeCount).toBe(1)
	})

	it("second dispose is a warned no-op", async () => {
		const warnings: string[] = []

		const registry = new ServiceRegistry({
			onWarning: (message) => warnings.push(message),
		})

		await registry.dispose()
		await registry.dispose()

		expect(warnings).toHaveLength(1)
	})

	it("refuses registration after disposal", async () => {
		const registry = new ServiceRegistry()
		await registry.dispose()

		expect(() => registry.register(ILogger, createTestLogger())).toThrow(
			expect.objectContaining({ code: "E_DISPOSED" })
		)
	})

	it("refuses get() after disposal — E_DISPOSED, not E_UNRESOLVED_TOKEN", async () => {
		const registry = new ServiceRegistry()
		registry.register(ILogger, createTestLogger())
		await registry.dispose()

		expect(() => registry.get(ILogger)).toThrow(expect.objectContaining({ code: "E_DISPOSED" }))
	})
})
