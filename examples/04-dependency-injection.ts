/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Quick demo: dependency injection with async init.
 *
 * How it works:
 * - Each class lists dependencies as a token tuple.
 * - The registry resolves + initializes them before constructor code runs.
 * - Constructors get ready-to-use values.
 * - Tuple/constructor mismatches fail at compile time.
 *
 * Run from a clone:
 * - `node examples/04-dependency-injection.ts`
 *
 * In your own project:
 * - Import from "async-init" (not this relative path).
 */

import { asyncInit, createToken, LifecycleError, ServiceRegistry } from "async-init"

class Config {
	public readonly databaseURL = "postgres://localhost/app"

	public async [Symbol.asyncDispose](): Promise<void> {}
}

const IConfig = createToken<Config>("config")

class Database {
	public static readonly dependencies = [IConfig] as const

	public connected = false

	readonly #url: string

	constructor(config: Config) {
		// `config` is already resolved + initialized here.
		this.#url = config.databaseURL
	}

	public async [asyncInit](): Promise<void> {
		this.connected = true

		console.log(`connected to ${this.#url}`)
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		console.log("database closed")
	}
}

const IDatabase = createToken<Database>("database")

class UserRepository {
	public static readonly dependencies = [IDatabase] as const

	constructor(db: Database) {
		// Transitive deps are ready too: `db` connected before this constructor runs.
		console.log("repository created; db connected?", db.connected)
	}

	public async [Symbol.asyncDispose](): Promise<void> {}
}

const IUserRepository = createToken<UserRepository>("user-repository")

{
	await using registry = new ServiceRegistry()

	// Order does not matter. Resolution follows the dependency graph.
	registry.register(IUserRepository, UserRepository)
	registry.register(IDatabase, Database)
	registry.register(IConfig, Config)

	await registry.get(IUserRepository)
}

// Failure mode demo: typed error (clear + debuggable).
{
	await using registry = new ServiceRegistry()

	// `IConfig` is intentionally missing.
	registry.register(IDatabase, Database)

	try {
		await registry.get(IDatabase)
	} catch (error) {
		if (error instanceof LifecycleError) {
			console.log(`${error.code}: ${error.message}`)
			// Expected: E_MISSING_DEPENDENCY
			// Meaning: "database" needs "config", but "config" was not registered.
		}
	}
}
