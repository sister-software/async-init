/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { asyncInit, isDisposed } from "../lib/protocol.ts"
import type { LifecycleContext } from "../lib/protocol.ts"
import { isServiceConstructor, Service } from "../lib/service.ts"

class Widget {
	public initContext: LifecycleContext | undefined
	public disposeCount = 0

	public async [asyncInit](context?: LifecycleContext): Promise<void> {
		this.initContext = context
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		this.disposeCount += 1
	}
}

/** Subclass with NOTHING own on its prototype — the inherited-disposable trap. */
class InheritedWidget extends Widget {}

describe("isServiceConstructor", () => {
	it("accepts classes, including subclasses with empty prototypes", () => {
		expect(isServiceConstructor(Widget)).toBe(true)
		expect(isServiceConstructor(InheritedWidget)).toBe(true)
	})

	it("rejects factories and non-functions", () => {
		expect(isServiceConstructor(() => new Widget())).toBe(false)
		expect(isServiceConstructor(new Widget())).toBe(false)
		expect(isServiceConstructor(null)).toBe(false)
	})
})

describe("Service resolution", () => {
	it("resolves a pre-built instance and runs asyncInit on it", async () => {
		const widget = new Widget()
		const service = new Service(widget)

		expect(await service).toBe(widget)
		expect(widget.initContext).toBeDefined()
	})

	it("resolves a factory with context and runs asyncInit", async () => {
		const service = new Service((context: LifecycleContext) => {
			expect(context.signal).toBeInstanceOf(AbortSignal)

			return new Widget()
		})

		const widget = await service
		expect(widget.initContext).toBeDefined()
	})

	it("resolves a constructor via `new` — even an inherited-disposable subclass", async () => {
		const service = new Service(InheritedWidget)
		const widget = await service

		expect(widget).toBeInstanceOf(InheritedWidget)
		expect(widget.initContext).toBeDefined()
	})

	it("constructs exactly one instance under concurrent await", async () => {
		let constructed = 0
		const service = new Service(async () => {
			constructed += 1
			await new Promise((resolve) => setTimeout(resolve, 10))

			return new Widget()
		})

		const [a, b, c] = await Promise.all([service.resolve(), service.resolve(), service.resolve()])

		expect(constructed).toBe(1)
		expect(a).toBe(b)
		expect(b).toBe(c)
	})

	it("clears the memo on failure so a later await can retry", async () => {
		let attempts = 0
		const service = new Service(() => {
			attempts += 1

			if (attempts === 1) throw new Error("first attempt fails")

			return new Widget()
		})

		await expect(service.resolve()).rejects.toThrow("first attempt fails")
		await expect(service.resolve()).resolves.toBeInstanceOf(Widget)
		expect(attempts).toBe(2)
	})

	it("exposes the instance after resolution", async () => {
		const service = new Service(Widget)

		expect(service.instance).toBeNull()
		const widget = await service
		expect(service.instance).toBe(widget)
	})
})

describe("Service disposal", () => {
	it("disposes the resolved instance exactly once and marks it", async () => {
		const service = new Service(Widget)
		const widget = await service

		await service[Symbol.asyncDispose]()
		await service[Symbol.asyncDispose]()

		expect(widget.disposeCount).toBe(1)
		expect(isDisposed(widget)).toBe(true)
	})

	it("is a no-op when never resolved", async () => {
		let constructed = 0
		const service = new Service(() => {
			constructed += 1

			return new Widget()
		})

		await service[Symbol.asyncDispose]()
		expect(constructed).toBe(0)
	})

	it("raises E_NO_RESOLVER for a nullish resolver and E_INVALID_RESOLVER for a bogus one", async () => {
		const nullService = new Service(null as never)
		await expect(nullService.resolve()).rejects.toMatchObject({ code: "E_NO_RESOLVER" })

		const bogusService = new Service(42 as never)
		await expect(bogusService.resolve()).rejects.toMatchObject({ code: "E_INVALID_RESOLVER" })
	})

	it("is a no-op when resolution failed", async () => {
		const service = new Service(() => {
			throw new Error("boom")
		})

		await expect(service.resolve()).rejects.toThrow("boom")
		await expect(service[Symbol.asyncDispose]()).resolves.toBeUndefined()
	})

	it("works with await using", async () => {
		let seen: Widget | null = null

		{
			await using service = new Service(Widget)
			seen = await service
			expect(seen.disposeCount).toBe(0)
		}

		expect(seen.disposeCount).toBe(1)
	})
})
