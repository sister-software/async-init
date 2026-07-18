/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   The lifecycle protocol: symbols for asynchronous construction and disposal marking, plus
 *   prototype-chain-aware guards. Zero runtime state — usable without any other layer.
 */

/**
 * Global symbol for asynchronous construction — the async complement to `Symbol.asyncDispose`.
 *
 * Namespaced via `Symbol.for` so duplicated copies of this package agree on symbol identity.
 */
export const asyncInit: unique symbol = Symbol.for("async-init.asyncInit")

/**
 * Global symbol marking an object as already disposed.
 */
export const disposed: unique symbol = Symbol.for("async-init.disposed")

/**
 * Ambient state made available to services during resolution and initialization.
 */
export interface LifecycleContext {
	readonly signal: AbortSignal
}

/**
 * An object which can be further constructed asynchronously after its synchronous constructor runs.
 */
export interface AsyncInitializable {
	[asyncInit](context?: LifecycleContext): Promise<void>
}

/**
 * Type-predicate: does `input` implement `AsyncDisposable`? Walks the prototype chain.
 */
export function isAsyncDisposable(input: unknown): input is AsyncDisposable {
	if (!input || (typeof input !== "object" && typeof input !== "function")) return false

	return Symbol.asyncDispose in input && typeof (input as AsyncDisposable)[Symbol.asyncDispose] === "function"
}

/**
 * Type-predicate: does `input` implement {@linkcode AsyncInitializable}? Walks the prototype chain.
 */
export function isAsyncInitializable(input: unknown): input is AsyncInitializable {
	if (!input || (typeof input !== "object" && typeof input !== "function")) return false

	return asyncInit in input && typeof (input as AsyncInitializable)[asyncInit] === "function"
}

/**
 * Has `input` been marked disposed via {@linkcode markDisposed}?
 */
export function isDisposed(input: object): boolean {
	return disposed in input
}

/**
 * Mark `input` as disposed. Returns false — without re-marking — if it already was.
 */
export function markDisposed(input: object): boolean {
	if (disposed in input) return false

	Object.defineProperty(input, disposed, { value: true })

	return true
}

/**
 * Await `instance`'s {@linkcode asyncInit} method and return the same instance.
 */
export async function init<T extends AsyncInitializable>(instance: T, context?: LifecycleContext): Promise<T> {
	await instance[asyncInit](context)

	return instance
}

/**
 * `new` + {@linkcode init} in one call. Constructor arguments are fully typed.
 */
export async function construct<A extends readonly unknown[], T extends AsyncInitializable>(
	Ctor: new (...args: A) => T,
	...args: A
): Promise<T> {
	return init(new Ctor(...args))
}
