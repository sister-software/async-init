# Examples

Each file is self-contained and runs directly under `node` — no build step, thanks to type stripping (Node 24+):

```bash
node examples/01-protocol.ts
```

The examples import from the repo root (`../index.ts`) so they run from a fresh clone. In your own project, import from `"async-init"` instead.

| Example                                                    | Shows                                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [01-protocol.ts](./01-protocol.ts)                         | The `asyncInit` symbol, `construct`/`init`, prototype-chain-aware guards, `await using` teardown                  |
| [02-service-handles.ts](./02-service-handles.ts)           | `Service<T>` lazy memoized resolution, concurrent-await sharing, the `proxyService` method/thunk view             |
| [03-registry.ts](./03-registry.ts)                         | Tokens (interface-typed services without classes), `register`/`get`, LIFO disposal via `await using registry`     |
| [04-dependency-injection.ts](./04-dependency-injection.ts) | Static `dependencies` tuples, init-before-construct, transitive resolution, typed `E_MISSING_DEPENDENCY` failures |
| [05-child-scopes.ts](./05-child-scopes.ts)                 | The per-request pattern: parent fallback, scoped shadowing, LIFO child teardown, abort chaining                   |
