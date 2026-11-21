# async-init

Async setup and cleanup for JavaScript objects.

```bash
yarn add async-init
# or
npm install async-init
```

## The problem

`new` is synchronous. If an object needs to connect, warm a cache, or complete a handshake, callers must remember to await a separate method.

`async-init` provides a shared setup symbol and three optional layers:

1. **Protocol** — initialize an instance or construct one with async setup.
2. **`Service<T>`** — lazily resolve and dispose an instance.
3. **`ServiceRegistry`** — add dependency injection, child scopes, and teardown.

## The protocol

Implement `[asyncInit]` for setup and `[Symbol.asyncDispose]` for cleanup:

```ts
import { asyncInit, construct } from "async-init"

class Database {
	public connected = false

	public async [asyncInit](): Promise<void> {
		this.connected = true
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		this.connected = false
	}
}

const db = await construct(Database) // new Database() + await db[asyncInit]()
db.connected // true
```

- **New instance:** `construct(Database)` creates and initializes it. Constructor arguments are typed.
- **Existing instance:** use `init(instance)`.
- **Checks:** `isAsyncInitializable` and `isAsyncDisposable` detect inherited methods too.
- **Disposal markers:** `markDisposed` and `isDisposed` track disposed objects. `Service` marks an instance only after successful cleanup, so failed cleanup can be retried. The registry tracks its own disposal separately.

## Lazy handles

`Service<T>` wraps an instance, factory, or zero-argument constructor. Await the handle to resolve it. Concurrent awaiters share the same resolution.

```ts
import { Service } from "async-init"

class Greeter {
	public planet = "world"

	public async [Symbol.asyncDispose](): Promise<void> {}

	public greet(name: string): string {
		return `hello ${name} of ${this.planet}`
	}
}

const service = new Service(Greeter)
const greeter = await service // resolves and memoizes
greeter.greet("sister") // 'hello sister of world'
```

If the instance has lifecycle methods, `Service` initializes and disposes it. Plain instances work too.

`proxyService` lets you access members before resolution. Methods return promises; properties become zero-argument functions:

```ts
import { proxyService } from "async-init"

const proxied = proxyService(new Service(Greeter))

await proxied.greet("sister") // 'hello sister of world' — resolves first, then calls
await proxied.planet() // 'world' — a thunk, since `planet` isn't a method
```

## The registry

The optional registry adds typed tokens, dependency injection, and scoped teardown:

```ts
import { createToken, ServiceRegistry } from "async-init"

class Logger {
	public readonly lines: string[] = []

	public log(line: string): void {
		this.lines.push(line)
	}

	public async [Symbol.asyncDispose](): Promise<void> {}
}

const ILogger = createToken<Logger>("logger")

await using registry = new ServiceRegistry()
registry.register(ILogger, Logger)

const logger = await registry.get(ILogger)
```

### Dependencies

Declare tokens in a static `dependencies` tuple. The registry resolves and initializes them in parallel before calling the constructor:

```ts
class Indexer {
	public static readonly dependencies = [ILogger] as const

	constructor(logger: Logger) {
		// The dependency is fully resolved and initialized here.
		logger.log("indexer constructed")
	}

	public async [Symbol.asyncDispose](): Promise<void> {}
}

const IIndexer = createToken<Indexer>("indexer")

await using registry = new ServiceRegistry()
registry.register(ILogger, Logger)
registry.register(IIndexer, Indexer)

const indexer = await registry.get(IIndexer)
```

### Child scopes

`createChild()` falls back to the parent for lookups. Child registrations can shadow parent registrations, and abort signals chain downward. Disposal cleans up children first (last in, first out), then the registry's services.

```ts
class Value {
	public readonly value: string

	constructor(value: string) {
		this.value = value
	}

	public async [Symbol.asyncDispose](): Promise<void> {}
}

const IValue = createToken<Value>("value")

await using parent = new ServiceRegistry()
parent.register(IValue, new Value("from-parent"))

const child = parent.createChild()

// Lookups fall back to the parent chain...
const shared = await child.get(IValue)

// ...and a child registration shadows the parent's.
const scoped = parent.createChild()
scoped.register(IValue, new Value("from-child"))

const fromChild = await scoped.get(IValue)
const fromParent = await parent.get(IValue)

fromChild.value // 'from-child' — shadowed
fromParent.value // 'from-parent' — untouched
```

### Definitions

`define()` registers a factory together with the tokens it needs. The needs are data, so the registry can read the dependency graph without building anything. `build` may return any value, including a string or `null`, and `resolve()` reads it.

```ts
import { createToken, optional, ServiceRegistry } from "async-init"

interface Database {
	query(sql: string): string
}

interface Cache {
	get(key: string): string | null
}

const IDataPath = createToken<string>("data-path")
const IDatabase = createToken<Database>("database")
const ICache = createToken<Cache>("cache")
const ISearch = createToken<{ find(term: string): string }>("search")

await using registry = new ServiceRegistry()

registry.define(IDataPath, { build: () => "/var/data" })

registry.define(IDatabase, {
	needs: { path: IDataPath },
	build: ({ path }): Database => ({ query: (sql) => `${path}: ${sql}` }),
	release: (database) => console.log("closed", database),
})

registry.define(ISearch, {
	// An optional need is null when its token is unregistered or its service fails to build.
	needs: { database: IDatabase, cache: optional(ICache) },
	build: ({ database, cache }) => ({
		find: (term) => cache?.get(term) ?? database.query(term),
	}),
})

const search = await registry.resolve(ISearch)
```

- **Needs** resolve in parallel before `build` runs. A definition that would complete a cycle throws `E_DEPENDENCY_CYCLE` when it is defined.
- **Release** gives the value back at disposal. Without it, the registry calls the value's `Symbol.asyncDispose`, or its synchronous `Symbol.dispose`.
- **Disposal order** follows the graph: a service is disposed after every service built from it.
- **Wrapping:** a child's definition that needs its own token receives the parent's service, so a child can wrap what it shadows.

### The graph

`registry.graph()` lists every service the registry can resolve, with its declared needs, whether each need is registered, its state, and the error of a failed build. It builds nothing.

```ts
for (const node of registry.graph()) {
	console.log(
		node.token.description,
		node.state,
		node.needs.map((need) => need.key)
	)
}
```

### Replacing a service

`invalidate(token)` replaces a service and every service that declares a need on it. Handles stay valid: the next resolution builds new instances.

A child registry keeps what it read. Once a child resolves a parent's service with `resolve()`, later reads through that child return the same instance, and the instance stays open until the child is disposed. A registry per request therefore reads one consistent set of instances while the parent reloads.

```ts
const request = registry.createChild()
const search = await request.resolve(ISearch)

await registry.invalidate(IDatabase, "new data")

// `search` still reads the database it started with.
// A child created now builds a new database and a new search.

await request.dispose() // the old search and the old database are disposed here
```

Invalidation follows declared needs only. A service registered as a plain factory keeps the instance it read.

### Events

`subscribe()` reports each build, failure, invalidation and disposal. A build's `durationMs` covers the service's own work and excludes the wait for its needs.

```ts
using subscription = registry.subscribe((event) => {
	if (event.type === "resolve-end") console.log(event.token.description, event.durationMs)
})
```

## Examples

See [`examples/`](./examples/) for runnable examples. From a clone, run `node examples/<file>.ts`.

## Limitations

- **Dependency cycles:** Cycles of declared needs throw `E_DEPENDENCY_CYCLE` with the path: at `define()` for a definition, and at first resolution for a class with a `dependencies` tuple. Cycles through plain factories are not detected and can deadlock. Break those by passing a `Service` handle and awaiting it after construction.
- **Initialization is async only:** There is no synchronous `init` equivalent. Disposal accepts both `Symbol.asyncDispose` and `Symbol.dispose`.
- **Holding across an invalidation:** Only a child registry's `resolve()` keeps an invalidated instance open. An instance read from the owning registry, or through a `get()` handle, is disposed as soon as nothing built from it remains.
- **Proxies:** Unknown and symbol-keyed properties return async wrappers. Synchronous protocols such as iteration and inspection can break. The names `then`, `resolve`, and `instance` belong to the handle and shadow instance members.
- **Disposal guards:** `Service` skips already-marked instances and marks them after successful cleanup. Direct calls or concurrent disposal through separate handles may need their own guard. Marking before cleanup prevents concurrent calls, but a failure stays marked and cannot be retried. Marking after cleanup permits retries, but alone does not prevent concurrent calls.

## Type discipline

The package uses `isolatedDeclarations` and `erasableSyntaxOnly`. Its TypeScript can run with Node's built-in type stripping, without a build step.

## License

`async-init` is licensed under the MIT license. See [LICENSE.md](./LICENSE.md) for the full text.
