// SPDX-FileCopyrightText: Sister Software
// SPDX-License-Identifier: MIT

/**
 * - A definition states the tokens a service needs, so the registry can read the dependency graph.
 * - An optional need resolves to null when its service is unregistered or fails.
 * - `invalidate` replaces a service and everything built from it, while in-flight work keeps what it started with.
 * - `subscribe` reports each build and disposal with its duration.
 *
 * Run from clone: `node examples/06-definitions.ts` In your project, import from "async-init".
 */

import { createToken, optional, ServiceRegistry } from "async-init"

interface Database {
	readonly generation: number
	query(sql: string): string
}

interface Cache {
	get(key: string): string | null
}

interface Search {
	find(term: string): string
}

const IDataPath = createToken<string>("data-path")
const IDatabase = createToken<Database>("database")
const ICache = createToken<Cache>("cache")
const ISearch = createToken<Search>("search")

const app = new ServiceRegistry()

using _subscription = app.subscribe((event) => {
	const detail = "durationMs" in event ? ` in ${event.durationMs.toFixed(2)} ms` : ""

	console.log(`  [event] ${event.type} ${event.token.description}${detail}`)
})

let generation = 0

// A definition may build any value, including a string.
app.define(IDataPath, { build: () => "/var/data" })

app.define(IDatabase, {
	needs: { path: IDataPath },
	build: ({ path }): Database => {
		const opened = ++generation

		return { generation: opened, query: (sql) => `${path} generation ${opened}: ${sql}` }
	},
	release: (database) => console.log(`  closed database generation ${database.generation}`),
})

app.define(ICache, {
	build: (): Cache => {
		throw new Error("the cache host refused the connection")
	},
})

app.define(ISearch, {
	// The search runs without a cache, so a failed cache does not fail the search.
	needs: { database: IDatabase, cache: optional(ICache) },
	build: ({ database, cache }): Search => ({
		find: (term) => cache?.get(term) ?? database.query(`SELECT * FROM places WHERE name = '${term}'`),
	}),
})

console.log("The graph, before anything is built:")

for (const node of app.graph()) {
	const needs = node.needs.map((need) => `${need.key}${need.optional ? "?" : ""}`).join(", ")

	console.log(`  ${node.token.description} needs [${needs}] and is ${node.state}`)
}

console.log("\nA request reads the search through its own child registry:")

const request = app.createChild()
const search = await request.resolve(ISearch)

console.log(`  ${search.find("Lisbon")}`)

const cache = app.graph().find((node) => node.token === ICache)

console.log(`  cache is ${cache?.state}: ${String(cache?.error)}`)

console.log("\nThe data is reloaded while that request is still running:")

await app.invalidate(IDatabase, "new data generation")

console.log(`  the running request still reads: ${search.find("Porto")}`)

const next = app.createChild()

console.log(`  a new request reads: ${(await next.resolve(ISearch)).find("Porto")}`)

console.log("\nThe first request ends, and the old database closes:")

await request.dispose()
await next.dispose()

console.log("\nThe app shuts down:")

await app.dispose()
