/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { proxyService } from "../lib/proxy.ts"
import { Service } from "../lib/service.ts"

class Greeter {
	public planet = "world"

	public async [Symbol.asyncDispose](): Promise<void> {}

	public greet(name: string): string {
		return `hello ${name} of ${this.planet}`
	}
}

describe("proxyService", () => {
	it("forwards method calls through lazy resolution, preserving `this`", async () => {
		const proxied = proxyService(new Service(Greeter))

		await expect(proxied.greet("teffen")).resolves.toBe("hello teffen of world")
	})

	it("exposes non-function properties as thunks", async () => {
		const proxied = proxyService(new Service(Greeter))

		await expect(proxied.planet()).resolves.toBe("world")
	})

	it("keeps Service members functional through the proxy (private-field safety)", async () => {
		const proxied = proxyService(new Service(Greeter))

		// resolve() reads #promise — it must be bound to the target, not the proxy.
		const instance = await proxied.resolve()
		expect(instance).toBeInstanceOf(Greeter)
		expect(proxied.instance).toBe(instance)

		// then() — awaiting the proxy itself must work too.
		expect(await proxied).toBe(instance)
	})

	it("disposes through the proxy", async () => {
		let disposeCount = 0

		class Tracked {
			public async [Symbol.asyncDispose](): Promise<void> {
				disposeCount += 1
			}
		}

		const proxied = proxyService(new Service(Tracked))
		await proxied.resolve()
		await proxied[Symbol.asyncDispose]()

		expect(disposeCount).toBe(1)
	})
})
