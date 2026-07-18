# lifecycle-ts

Async construction and disposal lifecycle primitives — the missing symbol for constructing asynchronous things.

```bash
yarn add lifecycle-ts
# or
npm install lifecycle-ts
```

## The problem

`Symbol.asyncDispose` gave JavaScript a standard teardown hook. Nothing gave it the other half. A class that needs to open a connection, warm a cache, or await a handshake after `new` has no standard place to do it — `new` is synchronous, full stop.

Most codebases patch around this with a `ready()` method the caller has to remember to await, or a factory function that duplicates the class's own fields. Both work until you need composition: an `await using` block, an `AsyncDisposableStack`, a container that resolves ten services in dependency order. Ad-hoc `ready()` conventions don't compose — every consumer has to know your particular flavor of "not ready yet," and a container has no symbol to detect it by.

`lifecycle-ts` adds that symbol. Three layers, each usable on its own:

1. **The protocol** — a symbol and two functions. No state, no dependencies.
2. **`Service<T>`** — a lazy, awaitable handle around a resolver, for when you want deferred construction without a container.
3. **`ServiceRegistry`** — an optional token-keyed container with dependency injection, child scopes, and `await using` teardown.

## The protocol

`asyncInit` is the async complement to `Symbol.asyncDispose`: a symbol-keyed method a class implements to run setup after its constructor returns.

```ts
import { asyncInit, construct, init } from "lifecycle-ts"

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

`construct` is `new` plus `init` in one call, with constructor arguments fully typed against the class. Use `init` directly when you already have an instance — a `new`-then-`init` two-step, or a base class initializing a subclass instance passed in from elsewhere.

Two guards round out the protocol: `isAsyncInitializable` and `isAsyncDisposable` walk an object's prototype chain (not just its own properties), so a subclass inheriting `[Symbol.asyncDispose]` from a base class is still detected correctly. `markDisposed` / `isDisposed` mark an object disposed exactly once, which `Service` and `ServiceRegistry` both use internally to guard against double-disposal.

## Lazy handles

`Service<T>` wraps a resolver — an instance, a factory, or a zero-arg constructor — behind a handle that's awaitable and disposable. Nothing runs until the handle is awaited; the resolution is memoized, so concurrent awaiters share one in-flight promise instead of racing separate constructions.

```ts
import { Service } from "lifecycle-ts"

class Greeter {
	public planet = "world"

	public async [Symbol.asyncDispose](): Promise<void> {}

	public greet(name: string): string {
		return `hello ${name} of ${this.planet}`
	}
}

const service = new Service(Greeter)
const greeter = await service // resolves and memoizes
greeter.greet("teffen") // 'hello teffen of world'
```

If the underlying instance implements the lifecycle protocol, `Service` calls `[asyncInit]` on it during resolution and forwards `[Symbol.asyncDispose]` to it on disposal. A plain instance with neither still works — `Service` degrades to a lazy memoizing wrapper.

`proxyService` goes one step further: it wraps a `Service<T>` in a proxy that exposes `T`'s own members directly, so you can call a method before the service has resolved — the call awaits resolution first, then dispatches. Methods return promises; plain properties become zero-argument thunks, since a property can't be read synchronously off something that isn't built yet.

```ts
import { proxyService } from "lifecycle-ts"

const proxied = proxyService(new Service(Greeter))

await proxied.greet("teffen") // 'hello teffen of world' — resolves first, then calls
await proxied.planet() // 'world' — a thunk, since `planet` isn't a method
```

## The registry

`ServiceRegistry` is a token-keyed container over `Service<T>` handles. It's entirely optional — every layer above works without it — but it's where dependency injection and scoped teardown live.

Tokens bind a runtime key to a phantom type, so `registry.get(token)` comes back typed without a manual cast:

```ts
import { createToken, ServiceRegistry } from "lifecycle-ts"

const ILogger = createToken<Logger>("logger")

await using registry = new ServiceRegistry()
registry.register(ILogger, Logger)

const logger = await registry.get(ILogger)
```

A class can declare its own dependencies as a static `dependencies` tuple of tokens. This is the erasable-TS answer to parameter-decorator DI — decorators need `emitDecoratorMetadata`, which needs a build step, which is exactly what this package avoids. The registry resolves and initializes every declared dependency, in parallel, before calling the constructor — so the constructor body can use them as plain, already-ready values:

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

`registry.createChild()` opens a scope that falls back to its parent on lookup, lets a child registration shadow a parent one, and chains abort signals downward. Disposing a registry disposes its children first (LIFO), then its own services, through an internal `AsyncDisposableStack` — which is also what makes `await using registry` do the right thing at scope exit.

```ts
await using parent = new ServiceRegistry()
parent.register(IValue, createValue("from-parent"))

const child = parent.createChild()
child.register(IValue, createValue("from-child"))

const fromChild = await child.get(IValue)
const fromParent = await parent.get(IValue)

fromChild.value // 'from-child' — shadowed
fromParent.value // 'from-parent' — untouched
```

## Limitations

- **Cycles between injectable constructors are caught, not all cycles are.** The registry walks the statically declared `dependencies` tuples before resolving, and throws `E_DEPENDENCY_CYCLE` with the full path (`a → b → a`) if it finds one. That walk only sees tokens declared in `dependencies` — a cycle routed through an opaque factory resolver (a plain function that calls back into the registry itself) isn't visible to static analysis and will deadlock instead of throwing. Break those by depending on the `Service` handle rather than the resolved value, and awaiting it after your own construction finishes, not during it.
- **Async-only.** There is no synchronous `Disposable` counterpart in v1 — `Service` and `ServiceRegistry` are both `AsyncDisposable`, and `asyncInit` has no sync equivalent. A piece of your system that never needs to await construction or teardown doesn't need this package.

## Type discipline

`lifecycle-ts` compiles under `isolatedDeclarations` — every exported value, function, and class member carries an explicit type annotation, so declaration emit never depends on cross-file inference. It also compiles under `erasableSyntaxOnly`: no `enum`, no constructor parameter properties, nothing that requires more than stripping types to run. That's why the tests above use long-form field assignment instead of parameter properties, and why `LifecycleErrorCode` is a `const` object with a derived type instead of an `enum`.

The practical effect: the package runs directly under `node`'s built-in type stripping. There's no build step between cloning the source and running it.

## License

`lifecycle-ts` is licensed under the MIT license. See [LICENSE.md](./LICENSE.md) for the full text.
