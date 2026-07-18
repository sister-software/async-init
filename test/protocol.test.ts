/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	asyncInit,
	construct,
	init,
	isAsyncDisposable,
	isAsyncInitializable,
	isDisposed,
	markDisposed,
} from "../lib/protocol.ts"

/** A disposable defined via a class METHOD — lives on the prototype, not the instance. */
class PrototypeDisposable {
	public disposeCount = 0

	public async [Symbol.asyncDispose](): Promise<void> {
		this.disposeCount += 1
	}
}

/** Inheritance: the subclass has NOTHING own — everything comes from the base prototype. */
class InheritedDisposable extends PrototypeDisposable {}

class Initializable {
	public initializedWith: unknown = null

	public async [asyncInit](context?: unknown): Promise<void> {
		this.initializedWith = context ?? "no-context"
	}

	public async [Symbol.asyncDispose](): Promise<void> {}
}

describe("isAsyncDisposable", () => {
	it("walks the prototype chain", () => {
		expect(isAsyncDisposable(new PrototypeDisposable())).toBe(true)
		expect(isAsyncDisposable(new InheritedDisposable())).toBe(true)
	})

	it("accepts own-property disposables", () => {
		expect(isAsyncDisposable({ [Symbol.asyncDispose]: async () => {} })).toBe(true)
	})

	it("rejects non-disposables", () => {
		expect(isAsyncDisposable({})).toBe(false)
		expect(isAsyncDisposable(null)).toBe(false)
		expect(isAsyncDisposable(42)).toBe(false)
		expect(isAsyncDisposable({ [Symbol.asyncDispose]: "not a function" })).toBe(false)
	})
})

describe("isAsyncInitializable", () => {
	it("walks the prototype chain", () => {
		expect(isAsyncInitializable(new Initializable())).toBe(true)

		class Sub extends Initializable {}
		expect(isAsyncInitializable(new Sub())).toBe(true)
	})

	it("rejects non-initializables", () => {
		expect(isAsyncInitializable(new PrototypeDisposable())).toBe(false)
		expect(isAsyncInitializable(null)).toBe(false)
	})
})

describe("markDisposed / isDisposed", () => {
	it("round-trips: mark once, further marks refused", () => {
		const target = new PrototypeDisposable()

		expect(isDisposed(target)).toBe(false)
		expect(markDisposed(target)).toBe(true)
		expect(isDisposed(target)).toBe(true)
		expect(markDisposed(target)).toBe(false)
	})
})

describe("init", () => {
	it("awaits the symbol method and returns the instance", async () => {
		const instance = new Initializable()
		const result = await init(instance)

		expect(result).toBe(instance)
		expect(instance.initializedWith).toBe("no-context")
	})

	it("forwards the context", async () => {
		const instance = new Initializable()
		const context = { signal: new AbortController().signal }
		await init(instance, context)

		expect(instance.initializedWith).toBe(context)
	})
})

describe("construct", () => {
	it("news up and initializes in one call, preserving constructor arg types", async () => {
		// Long-form field assignment — parameter properties are forbidden by erasableSyntaxOnly.
		class WithArguments extends Initializable {
			public readonly label: string

			constructor(label: string) {
				super()
				this.label = label
			}
		}

		const instance = await construct(WithArguments, "hello")

		expect(instance.label).toBe("hello")
		expect(instance.initializedWith).toBe("no-context")
	})
})
