/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Dependency injection without decorators: a class declares its dependencies as a
 *   static token tuple, and the registry resolves AND initializes each one before the
 *   constructor body runs — so the constructor can use them as plain values. Signature
 *   mismatches between the tuple and the constructor are compile errors.
 *
 *   Run from a clone: `node examples/04-dependency-injection.ts`
 *
 *   In your own project, import from "async-init" instead of the relative path.
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
		// The dependency is fully resolved and initialized right here.
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
		// Even transitive dependencies are ready — `db` connected before we were built.
		console.log("repository created; db connected?", db.connected)
	}

	public async [Symbol.asyncDispose](): Promise<void> {}
}

const IUserRepository = createToken<UserRepository>("user-repository")

{
	await using registry = new ServiceRegistry()

	// Registration order doesn't matter — resolution follows the declared graph.
	registry.register(IUserRepository, UserRepository)
	registry.register(IDatabase, Database)
	registry.register(IConfig, Config)

	await registry.get(IUserRepository)
}

// Failure modes are typed errors, not mysteries:
{
	await using registry = new ServiceRegistry()

	// Register the database — but nobody registers IConfig.
	registry.register(IDatabase, Database)

	try {
		await registry.get(IDatabase)
	} catch (error) {
		if (error instanceof LifecycleError) {
			console.log(`${error.code}: ${error.message}`)
			// E_MISSING_DEPENDENCY: "database" requires "config", which is not registered.
		}
	}
}
