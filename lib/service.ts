/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Service<T>: a lazy, awaitable, disposable handle around a resolver. Usable standalone —
 *   the registry layer builds on this but is never required.
 */

import { LifecycleError } from "./errors.ts"
import { asyncInit, isAsyncDisposable, isAsyncInitializable, markDisposed } from "./protocol.ts"
import type { LifecycleContext } from "./protocol.ts"

/**
 * A function which produces a service instance, optionally asynchronously.
 */
export type ServiceFactory<T extends object> = (context: LifecycleContext) => T | Promise<T>

/**
 * A zero-argument class constructor producing a service instance.
 */
export type ServiceConstructor<T extends object> = new () => T

/**
 * Anything a {@linkcode Service} can resolve: a pre-built instance, a factory, or a constructor.
 */
export type ServiceResolver<T extends object> = T | ServiceFactory<T> | ServiceConstructor<T>

/**
 * Type-predicate distinguishing class constructors from factory functions.
 *
 * Class syntax is detected via `Function.prototype.toString`; ES5-style constructors are accepted when their prototype
 * carries a lifecycle symbol (walking the chain, so inherited implementations count — the `Object.hasOwn` trap this
 * replaces crashed on exactly that case).
 */
export function isServiceConstructor<T extends object>(input: unknown): input is ServiceConstructor<T> {
	if (typeof input !== "function") return false

	const prototype: unknown = (input as { prototype?: unknown }).prototype

	if (!prototype || typeof prototype !== "object") return false

	if (Function.prototype.toString.call(input).startsWith("class")) return true

	return Symbol.asyncDispose in prototype || asyncInit in prototype
}

/**
 * A lazy, awaitable, disposable handle. Awaiting the service resolves (and memoizes) the instance; disposal forwards to
 * the instance if it resolved and is disposable.
 */
export class Service<T extends object> implements PromiseLike<T>, AsyncDisposable {
	#resolver: ServiceResolver<T>
	#context: LifecycleContext
	#promise: Promise<T> | null = null
	#instance: T | null = null

	constructor(resolver: ServiceResolver<T>, context?: LifecycleContext) {
		this.#resolver = resolver
		this.#context = context ?? { signal: new AbortController().signal }
	}

	/**
	 * The resolved instance, or null before the first successful resolution.
	 */
	public get instance(): T | null {
		return this.#instance
	}

	/**
	 * Resolve the instance. Concurrent callers share one in-flight resolution; a failed resolution clears the memo so a
	 * later call may retry.
	 */
	public resolve(): Promise<T> {
		this.#promise ??= this.#resolveUncached().then(
			(instance) => {
				this.#instance = instance

				return instance
			},
			(error: unknown) => {
				this.#promise = null

				throw error
			}
		)

		return this.#promise
	}

	async #resolveUncached(): Promise<T> {
		const resolver = this.#resolver
		let instance: T

		if (typeof resolver === "function") {
			if (isServiceConstructor<T>(resolver)) {
				instance = new resolver()
			} else {
				instance = await (resolver as ServiceFactory<T>)(this.#context)
			}
		} else if (resolver && typeof resolver === "object") {
			instance = resolver
		} else if (resolver == null) {
			throw new LifecycleError(
				"E_NO_RESOLVER",
				"Service has no resolver. Provide an instance, factory, or constructor."
			)
		} else {
			throw new LifecycleError(
				"E_INVALID_RESOLVER",
				`Resolver must be an instance, factory, or constructor. Received: ${String(resolver)}`
			)
		}

		if (isAsyncInitializable(instance)) {
			await instance[asyncInit](this.#context)
		}

		return instance
	}

	/**
	 * Resolve the service. Called implicitly when the service is awaited.
	 */
	// oxlint-disable-next-line unicorn/no-thenable -- intentional: a Service is awaitable by design
	public then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
	): Promise<TResult1 | TResult2> {
		return this.resolve().then(onfulfilled, onrejected)
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		if (!this.#promise) return

		let instance: T

		try {
			instance = await this.#promise
		} catch {
			return
		}

		if (!isAsyncDisposable(instance)) return

		if (!markDisposed(instance)) return

		await instance[Symbol.asyncDispose]()
	}
}
