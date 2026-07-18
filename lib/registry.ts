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
 * Maps a tuple of tokens to the tuple of instance types they carry.
 */
export type TokenInstances<D extends readonly ServiceToken<unknown>[]> = {
	[K in keyof D]: D[K] extends ServiceToken<infer T> ? T : never
}

/**
 * A class declaring its dependencies as a static token tuple. The constructor signature must match the token tuple — a
 * mismatch is a compile error. Dependencies are resolved AND initialized before construction, so the constructor body
 * may use them freely.
 */
export interface InjectableConstructor<T extends object, D extends readonly ServiceToken<unknown>[]> {
	readonly dependencies: D
	new (...args: TokenInstances<D>): T
}

/**
 * Type-predicate: a constructor carrying a static `dependencies` token array.
 */
export function isInjectableConstructor(
	input: unknown
): input is InjectableConstructor<object, readonly ServiceToken<unknown>[]> {
	return typeof input === "function" && Array.isArray((input as { dependencies?: unknown }).dependencies)
}

/**
 * A scoped, disposable service container. Fully optional — every service works without one.
 */
export class ServiceRegistry implements AsyncDisposable {
	#services = new Map<ServiceToken<unknown>, Service<object> & ServiceProxy<object>>()
	#dependencies = new Map<ServiceToken<unknown>, readonly ServiceToken<unknown>[]>()
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
	public register<T extends object, const D extends readonly ServiceToken<unknown>[]>(
		token: ServiceToken<T>,
		resolver: InjectableConstructor<T, D>
	): Service<T> & ServiceProxy<T>
	public register<T extends object>(token: ServiceToken<T>, resolver: ServiceResolver<T>): Service<T> & ServiceProxy<T>
	public register<T extends object>(
		token: ServiceToken<T>,
		resolver: ServiceResolver<T> | InjectableConstructor<T, readonly ServiceToken<unknown>[]>
	): Service<T> & ServiceProxy<T> {
		this.#assertNotDisposed()

		if (this.#services.has(token)) {
			throw new LifecycleError("E_DUPLICATE_TOKEN", `A service is already registered for token "${token.description}".`)
		}

		let effectiveResolver: ServiceResolver<T>

		if (isInjectableConstructor(resolver)) {
			this.#dependencies.set(token, resolver.dependencies)
			effectiveResolver = this.#createInjectableFactory(
				token,
				resolver as InjectableConstructor<T, readonly ServiceToken<unknown>[]>
			)
		} else {
			effectiveResolver = resolver
		}

		const service = new Service<T>(effectiveResolver, { signal: this.signal })
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

	#createInjectableFactory<T extends object>(
		token: ServiceToken<T>,
		Injectable: InjectableConstructor<T, readonly ServiceToken<unknown>[]>
	): ServiceResolver<T> {
		return async (): Promise<T> => {
			this.#assertAcyclic(token)

			const instances = await Promise.all(
				Injectable.dependencies.map((dependency) => {
					const dependencyService = this.#lookup(dependency)

					if (!dependencyService) {
						throw new LifecycleError(
							"E_MISSING_DEPENDENCY",
							`"${token.description}" requires "${dependency.description}", which is not registered.`
						)
					}

					return dependencyService.resolve()
				})
			)

			return new Injectable(...(instances as TokenInstances<readonly ServiceToken<unknown>[]>))
		}
	}

	#dependenciesOf(token: ServiceToken<unknown>): readonly ServiceToken<unknown>[] {
		return this.#dependencies.get(token) ?? []
	}

	/**
	 * Walk the statically declared dependency graph looking for a path back to `root`.
	 *
	 * Static analysis on declared token tuples — deterministic, immune to async interleaving. Cycles hidden inside opaque
	 * factory resolvers cannot be detected (they hang instead); that limitation is documented in the README.
	 */
	#assertAcyclic(root: ServiceToken<unknown>): void {
		const visited = new Set<ServiceToken<unknown>>()

		const visit = (token: ServiceToken<unknown>, path: readonly ServiceToken<unknown>[]): void => {
			for (const dependency of this.#dependenciesOf(token)) {
				if (dependency === root) {
					const cycle = [...path, dependency].map((entry) => entry.description).join(" → ")

					throw new LifecycleError("E_DEPENDENCY_CYCLE", `Dependency cycle detected: ${cycle}`)
				}

				if (visited.has(dependency)) continue

				visited.add(dependency)
				visit(dependency, [...path, dependency])
			}
		}

		visit(root, [root])
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
