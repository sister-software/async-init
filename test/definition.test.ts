// SPDX-FileCopyrightText: Sister Software
// SPDX-License-Identifier: MIT

import { createToken, optional, type ServiceEvent, ServiceRegistry } from "async-init"
import { describe, expect, it } from "vitest"

interface Connection {
	readonly generation: number
	closed: boolean
}

interface Reader {
	readonly connection: Connection
	closed: boolean
}

const IConnection = createToken<Connection>("connection")
const IReader = createToken<Reader>("reader")
const IPath = createToken<string | null>("path")

/**
 * Defines a connection whose every build gets the next generation number, and a reader built from it.
 */
function defineConnectionAndReader(registry: ServiceRegistry, log: string[] = []): { builds: () => number } {
	let builds = 0

	registry.define(IConnection, {
		build: (): Connection => ({ generation: ++builds, closed: false }),
		release: (connection) => {
			connection.closed = true
			log.push(`connection ${connection.generation}`)
		},
	})

	registry.define(IReader, {
		needs: { connection: IConnection },
		build: ({ connection }): Reader => ({ connection, closed: false }),
		release: (reader) => {
			reader.closed = true
			log.push(`reader of ${reader.connection.generation}`)
		},
	})

	return { builds: () => builds }
}

describe("define", () => {
	it("builds a service from its declared needs, and accepts a primitive or null value", async () => {
		await using registry = new ServiceRegistry()

		registry.define(IPath, { build: () => null })
		defineConnectionAndReader(registry)

		const reader = await registry.resolve(IReader)

		expect(reader.connection).toBe(await registry.resolve(IConnection))
		expect(await registry.resolve(IPath)).toBeNull()
	})

	it("rejects a required need that is unregistered, naming both tokens", async () => {
		await using registry = new ServiceRegistry()

		registry.define(IReader, {
			needs: { connection: IConnection },
			build: ({ connection }): Reader => ({ connection, closed: false }),
		})

		await expect(registry.resolve(IReader)).rejects.toThrow(
			expect.objectContaining({
				code: "E_MISSING_DEPENDENCY",
				message: expect.stringMatching(/reader.*connection/),
			})
		)
	})

	it("refuses the definition that completes a cycle, and leaves its token unregistered", async () => {
		const IA = createToken<object>("a")
		const IB = createToken<object>("b")

		await using registry = new ServiceRegistry()

		registry.define(IA, { needs: { b: IB }, build: () => ({}) })

		expect(() => registry.define(IB, { needs: { a: IA }, build: () => ({}) })).toThrow(
			expect.objectContaining({ code: "E_DEPENDENCY_CYCLE", message: expect.stringContaining("b → a → b") })
		)

		expect(registry.has(IB)).toBe(false)
	})

	it("gives a child's definition the parent's service when it needs its own token", async () => {
		await using parent = new ServiceRegistry()

		parent.define(IPath, { build: () => "/data" })

		const child = parent.createChild()

		child.define(IPath, {
			needs: { inherited: IPath },
			build: ({ inherited }) => `${inherited}/generation-2`,
		})

		expect(await child.resolve(IPath)).toBe("/data/generation-2")
		expect(await parent.resolve(IPath)).toBe("/data")
	})

	it("disposes a synchronous handle that has no release function", async () => {
		const IHandle = createToken<Disposable & { closed: boolean }>("handle")
		const registry = new ServiceRegistry()

		registry.define(IHandle, {
			build: () => {
				const opened = {
					closed: false,
					[Symbol.dispose]: (): void => {
						opened.closed = true
					},
				}

				return opened
			},
		})

		const handle = await registry.resolve(IHandle)

		await registry.dispose()

		expect(handle.closed).toBe(true)
	})

	it("disposes a dependent before the service it was built from, whatever the registration order", async () => {
		const log: string[] = []
		const registry = new ServiceRegistry()

		registry.define(IReader, {
			needs: { connection: IConnection },
			build: ({ connection }): Reader => ({ connection, closed: false }),
			release: () => void log.push("reader"),
		})

		registry.define(IConnection, {
			build: (): Connection => ({ generation: 1, closed: false }),
			release: () => void log.push("connection"),
		})

		await registry.resolve(IReader)
		await registry.dispose()

		expect(log).toEqual(["reader", "connection"])
	})
})

describe("optional needs", () => {
	it("builds with null when the token is unregistered", async () => {
		const IReport = createToken<{ readonly connection: Connection | null }>("report")

		await using registry = new ServiceRegistry()

		registry.define(IReport, {
			needs: { connection: optional(IConnection) },
			build: ({ connection }) => ({ connection }),
		})

		expect((await registry.resolve(IReport)).connection).toBeNull()
	})

	it("builds with null when the needed service fails, and reports the failure in the graph", async () => {
		const IReport = createToken<{ readonly connection: Connection | null }>("report")
		const failure = new Error("the database file is missing")

		await using registry = new ServiceRegistry()

		registry.define(IConnection, {
			build: (): Connection => {
				throw failure
			},
		})

		registry.define(IReport, {
			needs: { connection: optional(IConnection) },
			build: ({ connection }) => ({ connection }),
		})

		expect((await registry.resolve(IReport)).connection).toBeNull()

		const node = registry.graph().find((entry) => entry.token === IConnection)

		expect(node).toMatchObject({ state: "failed", error: failure })
	})
})

describe("graph", () => {
	it("reports declared needs, whether each is registered, and inherited services, without building any", async () => {
		await using parent = new ServiceRegistry()
		let built = false

		parent.define(IConnection, {
			build: (): Connection => {
				built = true

				return { generation: 1, closed: false }
			},
		})

		const child = parent.createChild()

		child.define(IReader, {
			needs: { connection: IConnection, path: optional(IPath) },
			build: ({ connection }): Reader => ({ connection, closed: false }),
		})

		expect(child.graph()).toEqual([
			{
				token: IReader,
				inherited: false,
				declared: true,
				needs: [
					{ key: "connection", token: IConnection, optional: false, registered: true },
					{ key: "path", token: IPath, optional: true, registered: false },
				],
				state: "idle",
				error: undefined,
			},
			{ token: IConnection, inherited: true, declared: true, needs: [], state: "idle", error: undefined },
		])

		expect(built).toBe(false)
	})

	it("marks a plain resolver as undeclared", async () => {
		const IPlain = createToken<object>("plain")

		await using registry = new ServiceRegistry()

		registry.register(IPlain, () => ({}))

		expect(registry.graph()).toMatchObject([{ token: IPlain, declared: false }])
	})
})

describe("invalidate", () => {
	it("rebuilds the service and its dependents on the next resolve, through the same handle", async () => {
		const log: string[] = []

		await using registry = new ServiceRegistry()

		const { builds } = defineConnectionAndReader(registry, log)
		const handle = registry.get(IReader)
		const before = await handle.resolve()

		await registry.invalidate(IConnection)

		// Nothing else used the old instances, so both were given back at once, the dependent first.
		expect(log).toEqual(["reader of 1", "connection 1"])
		expect(before.closed).toBe(true)

		const after = await handle.resolve()

		expect(after).not.toBe(before)
		expect(after.connection.generation).toBe(2)
		expect(builds()).toBe(2)
	})

	it("keeps an instance open for a child registry that resolved it, until that child is disposed", async () => {
		const log: string[] = []

		await using parent = new ServiceRegistry()

		defineConnectionAndReader(parent, log)

		const request = parent.createChild()
		const held = await request.resolve(IReader)

		await parent.invalidate(IConnection)

		expect(held.closed).toBe(false)
		expect(held.connection.closed).toBe(false)
		// A read through the same child returns the instance it started with.
		expect(await request.resolve(IReader)).toBe(held)

		const next = parent.createChild()

		expect((await next.resolve(IReader)).connection.generation).toBe(2)

		await request.dispose()

		expect(log).toEqual(["reader of 1", "connection 1"])
		await next.dispose()
	})

	it("leaves a service that does not reach the invalidated one untouched", async () => {
		await using registry = new ServiceRegistry()

		defineConnectionAndReader(registry)
		registry.define(IPath, { build: () => "/data" })

		const connection = await registry.resolve(IConnection)

		await registry.invalidate(IPath)

		expect(await registry.resolve(IConnection)).toBe(connection)
		expect(connection.closed).toBe(false)
	})

	it("follows a child's dependents of a parent service", async () => {
		await using parent = new ServiceRegistry()
		let builds = 0

		parent.define(IConnection, { build: (): Connection => ({ generation: ++builds, closed: false }) })

		const child = parent.createChild()

		child.define(IReader, {
			needs: { connection: IConnection },
			build: ({ connection }): Reader => ({ connection, closed: false }),
		})

		expect((await child.resolve(IReader)).connection.generation).toBe(1)

		await parent.invalidate(IConnection)

		expect((await child.resolve(IReader)).connection.generation).toBe(2)
	})

	it("throws E_UNRESOLVED_TOKEN for an unregistered token", async () => {
		await using registry = new ServiceRegistry()

		await expect(registry.invalidate(IConnection)).rejects.toMatchObject({ code: "E_UNRESOLVED_TOKEN" })
	})
})

describe("subscribe", () => {
	it("reports each build, failure, invalidation and disposal, until the subscription is disposed", async () => {
		const events: ServiceEvent[] = []
		const registry = new ServiceRegistry()
		const subscription = registry.subscribe((event) => events.push(event))

		defineConnectionAndReader(registry)

		await registry.resolve(IReader)
		await registry.invalidate(IConnection, "reload")

		expect(events.map((event) => `${event.type} ${event.token.description}`)).toEqual([
			"resolve-start connection",
			"resolve-end connection",
			"resolve-start reader",
			"resolve-end reader",
			"invalidated connection",
			"invalidated reader",
			"disposed reader",
			"disposed connection",
		])

		expect(events.find((event) => event.type === "invalidated")).toMatchObject({ reason: "reload" })

		for (const event of events) {
			if (event.type === "resolve-end" || event.type === "disposed") {
				expect(event.durationMs).toBeGreaterThanOrEqual(0)
			}
		}

		subscription[Symbol.dispose]()
		await registry.resolve(IReader)

		expect(events).toHaveLength(8)

		await registry.dispose()
	})

	it("reports a failed build with what it threw", async () => {
		const events: ServiceEvent[] = []
		const failure = new Error("no route to host")

		await using registry = new ServiceRegistry()

		registry.subscribe((event) => events.push(event))

		registry.define(IConnection, {
			build: (): Connection => {
				throw failure
			},
		})

		await expect(registry.resolve(IConnection)).rejects.toBe(failure)

		expect(events.at(-1)).toMatchObject({ type: "resolve-failed", token: IConnection, error: failure })
	})
})
