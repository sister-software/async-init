/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { ServiceRegistry } from "../lib/registry.ts"
import { createToken } from "../lib/token.ts"

const IValue = createToken<{ readonly value: string } & AsyncDisposable>("value")

function createValue(value: string, onDispose?: () => void): { readonly value: string } & AsyncDisposable {
	return {
		value,
		async [Symbol.asyncDispose](): Promise<void> {
			onDispose?.()
		},
	}
}

describe("createChild", () => {
	it("falls back to the parent chain on lookup", async () => {
		await using parent = new ServiceRegistry()
		parent.register(IValue, createValue("from-parent"))

		const child = parent.createChild()
		expect((await child.get(IValue)).value).toBe("from-parent")
	})

	it("lets a child shadow a parent registration", async () => {
		await using parent = new ServiceRegistry()
		parent.register(IValue, createValue("from-parent"))

		const child = parent.createChild()
		child.register(IValue, createValue("from-child"))

		expect((await child.get(IValue)).value).toBe("from-child")
		expect((await parent.get(IValue)).value).toBe("from-parent")
	})

	it("parent disposal reaches children first (LIFO)", async () => {
		const order: string[] = []

		const parent = new ServiceRegistry()
		parent.register(
			IValue,
			createValue("p", () => order.push("parent-service"))
		)
		await parent.get(IValue).resolve()

		const child = parent.createChild()
		const IChildValue = createToken<AsyncDisposable>("child-value")
		child.register(
			IChildValue,
			createValue("c", () => order.push("child-service"))
		)
		await child.get(IChildValue).resolve()

		await parent.dispose()
		expect(order).toEqual(["child-service", "parent-service"])
	})

	it("chains aborts down to descendants", async () => {
		const parent = new ServiceRegistry()
		const child = parent.createChild()
		const grandchild = child.createChild()

		expect(grandchild.signal.aborted).toBe(false)
		await parent.dispose()
		expect(child.signal.aborted).toBe(true)
		expect(grandchild.signal.aborted).toBe(true)
	})

	it("a disposed child unlinks — parent disposal does not double-dispose it", async () => {
		let disposeCount = 0

		const parent = new ServiceRegistry()
		const child = parent.createChild()
		child.register(
			IValue,
			createValue("c", () => (disposeCount += 1))
		)
		await child.get(IValue).resolve()

		await child.dispose()
		expect(disposeCount).toBe(1)

		await parent.dispose()
		expect(disposeCount).toBe(1)
	})

	it("a disposed child's parent still tears down its own services exactly once", async () => {
		let parentDisposeCount = 0
		let childDisposeCount = 0

		const parent = new ServiceRegistry()
		parent.register(
			IValue,
			createValue("p", () => (parentDisposeCount += 1))
		)
		await parent.get(IValue).resolve()

		const child = parent.createChild()
		const IChildValue = createToken<AsyncDisposable>("child-value")
		child.register(
			IChildValue,
			createValue("c", () => (childDisposeCount += 1))
		)
		await child.get(IChildValue).resolve()

		await child.dispose()
		expect(childDisposeCount).toBe(1)

		await expect(parent.dispose()).resolves.toBeUndefined()
		expect(parentDisposeCount).toBe(1)
		expect(childDisposeCount).toBe(1)
	})

	it("child inherits parent onWarning unless overridden", async () => {
		const parentWarnings: string[] = []
		const childWarnings: string[] = []

		const parent = new ServiceRegistry({ onWarning: (message) => parentWarnings.push(message) })

		const inheriting = parent.createChild()
		await inheriting.dispose()
		await inheriting.dispose()
		expect(parentWarnings).toHaveLength(1)

		const overriding = parent.createChild({ onWarning: (message) => childWarnings.push(message) })
		await overriding.dispose()
		await overriding.dispose()
		expect(childWarnings).toHaveLength(1)
		expect(parentWarnings).toHaveLength(1)

		await parent.dispose()
	})
})
