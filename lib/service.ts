// SPDX-FileCopyrightText: Sister Software
// SPDX-License-Identifier: MIT

/**
 * The registry layer builds on this but is never required.
 */

import { LifecycleError } from "#errors"
import {
	asyncInit,
	isAsyncDisposable,
	isAsyncInitializable,
	isDisposed,
	isSyncDisposable,
	markDisposed,
} from "#protocol"
import type { LifecycleContext } from "#protocol"

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
 * The lifecycle states a {@linkcode Service} handle reports.
 */
export const ServiceState = {
	/**
	 * No resolution has started, or the last one failed.
	 */
	Idle: "idle",
	/**
	 * A resolution is in flight.
	 */
	Resolving: "resolving",
	/**
	 * The handle has an instance.
	 */
	Ready: "ready",
	/**
	 * The handle was disposed and refuses a later `resolve()`.
	 */
	Disposed: "disposed",
} as const

export type ServiceState = (typeof ServiceState)[keyof typeof ServiceState]

/**
 * Optional behavior of a {@linkcode Service} handle.
 */
export interface ServiceOptions<T extends object> {
	/**
	 * Gives the instance back at disposal, in place of the instance's own `Symbol.asyncDispose` or `Symbol.dispose`.
	 */
	release?: (instance: T) => void | Promise<void>
	/**
	 * Pass `false` when the resolver already ran the instance's `[asyncInit]`, so the handle does not run it again.
	 */
	init?: boolean
}

/**
 * An instance separated from its handle by {@linkcode Service.detach}.
 */
export interface DetachedInstance {
	/**
	 * Disposes the instance once it has resolved. Repeated calls share one disposal.
	 */
	dispose(): Promise<void>
}

/**
 * A lazy, awaitable, disposable handle. Awaiting the service resolves (and memoizes) the instance; disposal forwards to
 * the instance if it resolved and is disposable, asynchronously or synchronously.
 */
export class Service<T extends object> implements PromiseLike<T>, AsyncDisposable {
	#resolver: ServiceResolver<T>
	#context: LifecycleContext
	#options: ServiceOptions<T>
	#promise: Promise<T> | null = null
	#instance: T | null = null
	#resolved = false
	#disposed = false
	#disposePromise: Promise<void> | null = null

	constructor(resolver: ServiceResolver<T>, context?: LifecycleContext, options?: ServiceOptions<T>) {
		this.#resolver = resolver
		this.#context = context ?? { signal: new AbortController().signal }
		this.#options = options ?? {}
	}

	/**
	 * The resolved instance, or null before the first successful resolution.
	 */
	public get instance(): T | null {
		return this.#instance
	}

	/**
	 * Where the handle is in its lifecycle. A failed resolution returns the handle to `idle`.
	 */
	public get state(): ServiceState {
		if (this.#disposed) return ServiceState.Disposed

		if (!this.#promise) return ServiceState.Idle

		return this.#resolved ? ServiceState.Ready : ServiceState.Resolving
	}

	/**
	 * Resolve the instance. Concurrent callers share one in-flight resolution; a failed resolution clears the memo so a
	 * later call may retry.
	 */
	public resolve(): Promise<T> {
		if (this.#disposed) {
			return Promise.reject(new LifecycleError("E_DISPOSED", "The service has been disposed."))
		}

		if (this.#promise) return this.#promise

		// A resolution that settles after `detach()` belongs to the detached instance, so it leaves the handle alone.
		const promise: Promise<T> = this.#resolveUncached().then(
			(instance) => {
				if (this.#promise === promise) {
					this.#instance = instance
					this.#resolved = true
				}

				return instance
			},
			(error: unknown) => {
				if (this.#promise === promise) {
					this.#promise = null
				}

				throw error
			}
		)

		this.#promise = promise

		return promise
	}

	/**
	 * Separate the current instance from the handle, so the next `resolve()` builds a new one.
	 *
	 * The caller owns the detached instance and disposes it through the returned object, once nothing uses it. Returns
	 * `null` when the handle has no instance or is disposed. The registry replaces a service this way while callers keep
	 * the handle.
	 */
	public detach(): DetachedInstance | null {
		const promise = this.#promise

		if (!promise || this.#disposed) return null

		this.#promise = null
		this.#instance = null
		this.#resolved = false

		let disposing: Promise<void> | null = null

		return {
			dispose: () => (disposing ??= this.#releaseInstance(promise)),
		}
	}

	async #resolveUncached(): Promise<T> {
		const instance = await this.#instantiate()

		if (this.#options.init !== false && isAsyncInitializable(instance)) {
			await instance[asyncInit](this.#context)
		}

		return instance
	}

	/**
	 * Turn the resolver into an instance: construct a class, call a factory, or pass an instance through.
	 */
	#instantiate(): T | Promise<T> {
		const resolver = this.#resolver

		if (resolver == null) {
			throw new LifecycleError(
				"E_NO_RESOLVER",
				"Service has no resolver. Provide an instance, factory, or constructor."
			)
		}

		if (isServiceConstructor<T>(resolver)) return new resolver()

		if (typeof resolver === "function") return (resolver as ServiceFactory<T>)(this.#context)

		if (typeof resolver === "object") return resolver

		throw new LifecycleError(
			"E_INVALID_RESOLVER",
			`Resolver must be an instance, factory, or constructor. Received: ${String(resolver)}`
		)
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
		const promise = this.#promise

		if (!promise) {
			this.#disposed = true

			return
		}

		this.#disposePromise ??= this.#disposeInstance(promise)

		return this.#disposePromise
	}

	#disposeInstance(promise: Promise<T>): Promise<void> {
		this.#disposed = true

		return this.#releaseInstance(promise)
	}

	/**
	 * Give one resolved instance back: through the `release` option when the handle has one, else through the instance's
	 * `Symbol.asyncDispose`, else through its `Symbol.dispose`. A resolution that failed has no instance to release.
	 */
	async #releaseInstance(promise: Promise<T>): Promise<void> {
		let instance: T

		try {
			instance = await promise
		} catch {
			return
		}

		const release = this.#options.release

		if (release) {
			await release(instance)

			return
		}

		if (isAsyncDisposable(instance)) {
			if (isDisposed(instance)) return

			await instance[Symbol.asyncDispose]()
			markDisposed(instance)

			return
		}

		if (isSyncDisposable(instance)) {
			if (isDisposed(instance)) return

			instance[Symbol.dispose]()
			markDisposed(instance)
		}
	}
}
