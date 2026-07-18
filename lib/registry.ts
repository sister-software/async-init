/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   ServiceRegistry: an optional, instantiable, token-keyed container over Service<T> handles.
 *   Backed by AsyncDisposableStack — LIFO disposal with SuppressedError aggregation. Disposal
 *   aborts the registry signal first so in-flight resolvers can bail.
 */

import { LifecycleError } from "./errors.ts"
import { proxyService } from "./proxy.ts"
import type { ServiceProxy } from "./proxy.ts"
import { Service } from "./service.ts"
import type { ServiceResolver } from "./service.ts"
import type { ServiceToken } from "./token.ts"

export interface ServiceRegistryOptions {
	/**
	 * The registry's only logging hook — silent by default.
	 */
	onWarning?: (message: string) => void
}

/**
 * A scoped, disposable service container. Fully optional — every service works without one.
 */
export class ServiceRegistry implements AsyncDisposable {
	#services = new Map<ServiceToken<unknown>, Service<object> & ServiceProxy<object>>()
	#stack = new AsyncDisposableStack()
	#abortController = new AbortController()
	#onWarning: ((message: string) => void) | undefined
	#disposed = false

	constructor(options?: ServiceRegistryOptions) {
		this.#onWarning = options?.onWarning
	}

	/**
	 * Aborted when the registry disposes, before any service disposal runs.
	 */
	public get signal(): AbortSignal {
		return this.#abortController.signal
	}

	/**
	 * Register a resolver under a token. Records the service for disposal immediately — registration, not first-await, is
	 * what enters it into the lifecycle.
	 */
	public register<T extends object>(
		token: ServiceToken<T>,
		resolver: ServiceResolver<T>
	): Service<T> & ServiceProxy<T> {
		this.#assertNotDisposed()

		if (this.#services.has(token)) {
			throw new LifecycleError("E_DUPLICATE_TOKEN", `A service is already registered for token "${token.description}".`)
		}

		const service = new Service<T>(resolver, { signal: this.signal })
		this.#stack.use(service)

		const proxied = proxyService(service)
		this.#services.set(token, proxied as unknown as Service<object> & ServiceProxy<object>)

		return proxied
	}

	/**
	 * Look up a token. Throws {@linkcode LifecycleError} `E_UNRESOLVED_TOKEN` when absent.
	 */
	public get<T extends object>(token: ServiceToken<T>): Service<T> & ServiceProxy<T> {
		const found = this.#lookup(token)

		if (!found) {
			throw new LifecycleError("E_UNRESOLVED_TOKEN", `No service registered for token "${token.description}".`)
		}

		return found as unknown as Service<T> & ServiceProxy<T>
	}

	#lookup(token: ServiceToken<unknown>): (Service<object> & ServiceProxy<object>) | null {
		return this.#services.get(token) ?? null
	}

	#assertNotDisposed(): void {
		if (this.#disposed) {
			throw new LifecycleError("E_DISPOSED", "The service registry has been disposed.")
		}
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		if (this.#disposed) {
			this.#onWarning?.("Service registry already disposed.")

			return
		}

		this.#disposed = true
		this.#abortController.abort(new LifecycleError("E_DISPOSED", "The service registry is disposing."))

		await this.#stack.disposeAsync()
		this.#services.clear()
	}

	/**
	 * Alias for `[Symbol.asyncDispose]()`.
	 */
	public dispose(): Promise<void> {
		return this[Symbol.asyncDispose]()
	}
}

/**
 * The module-level default registry — the convenience path for applications with one scope.
 */
export const defaultRegistry: ServiceRegistry = new ServiceRegistry()
