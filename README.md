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

## Examples

See [`examples/`](./examples/) for runnable examples. From a clone, run `node examples/<file>.ts`.

## Limitations

- **Dependency cycles:** Declared constructor cycles throw `E_DEPENDENCY_CYCLE` with the path. Cycles through factories are not detected and can deadlock. Break those by passing a `Service` handle and awaiting it after construction.
- **Async only:** There is no synchronous `Disposable` or `init` equivalent in v1.
- **Proxies:** Unknown and symbol-keyed properties return async wrappers. Synchronous protocols such as iteration and inspection can break. The names `then`, `resolve`, and `instance` belong to the handle and shadow instance members.
- **Disposal guards:** `Service` skips already-marked instances and marks them after successful cleanup. Direct calls or concurrent disposal through separate handles may need their own guard. Marking before cleanup prevents concurrent calls, but a failure stays marked and cannot be retried. Marking after cleanup permits retries, but alone does not prevent concurrent calls.

## Type discipline

The package uses `isolatedDeclarations` and `erasableSyntaxOnly`. Its TypeScript can run with Node's built-in type stripping, without a build step.

## License

`async-init` is licensed under the MIT license. See [LICENSE.md](./LICENSE.md) for the full text.
