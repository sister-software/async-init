/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   ServiceRegistry: an optional, instantiable, token-keyed container over Service<T> handles.
 *   Backed by AsyncDisposableStack — LIFO disposal with SuppressedError aggregation. Disposal
 *   aborts the registry signal first so in-flight resolvers can bail.
 */

import { LifecycleError } from "#errors"
import { proxyService, type ServiceProxy } from "#proxy"
import { Service, type ServiceResolver } from "#service"
import type { ServiceToken } from "#token"

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
 *
 * Duck-typed: an element is accepted as a token if it's a non-null object with a string `description` — the same shape
 * {@linkcode createToken} produces. A stray `dependencies` array on a plain factory function whose elements don't look
 * like tokens (e.g. strings) fails this check, so the factory is routed as a plain resolver instead of misdetected as
 * injectable.
 */
export function isInjectableConstructor(
	input: unknown
): input is InjectableConstructor<object, readonly ServiceToken<unknown>[]> {
	if (typeof input !== "function") return false

	const candidates: unknown = (input as { dependencies?: unknown }).dependencies

	return (
		Array.isArray(candidates) &&
		candidates.every(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				typeof (entry as { description?: unknown }).description === "string"
		)
	)
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
	#parent: ServiceRegistry | null = null
	#children = new Set<ServiceRegistry>()
	#detachFromParent: (() => void) | null = null

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
		this.#assertNotDisposed()

		const found = this.#lookup(token)

		if (!found) {
			throw new LifecycleError("E_UNRESOLVED_TOKEN", `No service registered for token "${token.description}".`)
		}

		return found as unknown as Service<T> & ServiceProxy<T>
	}

	/**
	 * Create a child scope. Lookups fall back to this registry; disposal of this registry disposes children first (LIFO);
	 * aborts chain down. A child disposed on its own unlinks and is skipped during parent teardown.
	 */
	public createChild(options?: ServiceRegistryOptions): ServiceRegistry {
		this.#assertNotDisposed()

		const child = new ServiceRegistry({ onWarning: options?.onWarning ?? this.#onWarning })
		child.#parent = this
		this.#children.add(child)

		// The closures below share one context, and the parent's signal holds the listener for as long as the child
		// is live. They reach the child only through a weak reference, so once the child disposes and leaves
		// `#children`, nothing the parent holds keeps the child or the services it resolved.
		const childRef = new WeakRef(child)

		const propagateAbort = (): void => {
			const live = childRef.deref()

			if (live) {
				live.#abortController.abort(this.signal.reason)
			}
		}

		this.signal.addEventListener("abort", propagateAbort, { once: true })
		child.#detachFromParent = (): void => {
			this.signal.removeEventListener("abort", propagateAbort)
		}

		return child
	}

	#lookup(token: ServiceToken<unknown>): (Service<object> & ServiceProxy<object>) | null {
		const local = this.#services.get(token)

		if (local) return local

		if (this.#parent) return this.#parent.#lookup(token)

		return null
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
		const local = this.#dependencies.get(token)

		if (local) return local

		if (this.#parent) return this.#parent.#dependenciesOf(token)

		return []
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
		if (this.#disposed) return

		this.#disposed = true
		this.#detachFromParent?.()

		if (this.#parent) {
			this.#parent.#children.delete(this)
		}

		this.#abortController.abort(new LifecycleError("E_DISPOSED", "The service registry is disposing."))

		// Children dispose first, newest first, then this registry's own services in reverse registration order. One
		// stack runs both, so a failure in either is aggregated as SuppressedError rather than stopping the rest.
		const teardown = new AsyncDisposableStack()

		teardown.use(this.#stack)

		for (const child of this.#children) {
			teardown.use(child)
		}

		await teardown.disposeAsync()
		this.#services.clear()
		this.#dependencies.clear()
		this.#children.clear()
	}

	/**
	 * Alias for `[Symbol.asyncDispose]()`. Warns (via `onWarning`) on repeat calls.
	 */
	public dispose(): Promise<void> {
		if (this.#disposed) {
			this.#onWarning?.("Service registry already disposed.")
		}

		return this[Symbol.asyncDispose]()
	}
}

/**
 * The module-level default registry — the convenience path for applications with one scope.
 */
export const defaultRegistry: ServiceRegistry = new ServiceRegistry()
