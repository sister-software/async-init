/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 * Quick utilities for async init/dispose checks.
 * No runtime state. Works standalone.
 */

/**
 * Symbol used for async initialization. Global via `Symbol.for(...)` so multiple package copies match.
 */
export const asyncInit: unique symbol = Symbol.for("async-init.asyncInit")

/**
 * Symbol flag: object is already disposed.
 */
export const disposed: unique symbol = Symbol.for("async-init.disposed")

/**
 * Context passed during setup.
 */
export interface LifecycleContext {
	readonly signal: AbortSignal
}

/**
 * Type for objects with async setup after `new`.
 */
export interface AsyncInitializable {
	[asyncInit](context?: LifecycleContext): Promise<void>
}

/**
 * Check: does `input` have `AsyncDisposable` behavior? Includes prototype chain.
 */
export function isAsyncDisposable(input: unknown): input is AsyncDisposable {
	if (!input || (typeof input !== "object" && typeof input !== "function")) return false

	return Symbol.asyncDispose in input && typeof (input as AsyncDisposable)[Symbol.asyncDispose] === "function"
}

/**
 * Check: does `input` have async-init behavior? Includes prototype chain.
 */
export function isAsyncInitializable(input: unknown): input is AsyncInitializable {
	if (!input || (typeof input !== "object" && typeof input !== "function")) return false

	return asyncInit in input && typeof (input as AsyncInitializable)[asyncInit] === "function"
}

/**
 * Check whether `input` is marked disposed.
 */
export function isDisposed(input: object): boolean {
	return disposed in input
}

/**
 * Mark `input` as disposed. Returns `false` if it was already marked.
 */
export function markDisposed(input: object): boolean {
	if (disposed in input) return false

	Object.defineProperty(input, disposed, { value: true })

	return true
}

/**
 * Run async init, then return the same instance.
 */
export async function init<T extends AsyncInitializable>(instance: T, context?: LifecycleContext): Promise<T> {
	await instance[asyncInit](context)

	return instance
}

/**
 * Create + init in one call. Constructor args stay fully typed.
 */
export async function construct<A extends readonly unknown[], T extends AsyncInitializable>(
	Ctor: new (...args: A) => T,
	...args: A
): Promise<T> {
	return init(new Ctor(...args))
}
