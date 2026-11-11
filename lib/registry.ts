/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Service registry with async lifecycle management.
 *
 * - Uses AsyncDisposableStack (LIFO cleanup)
 * - Aggregates cleanup failures via SuppressedError
 * - Aborts registry signal before disposal
 */

import { LifecycleError } from "#errors"
import { proxyService, type ServiceProxy } from "#proxy"
import { Service, type ServiceResolver } from "#service"
import type { ServiceToken } from "#token"

export interface ServiceRegistryOptions {
	/**
	 * Optional warning logger. Default: no logging.
	 */
	onWarning?: (message: string) => void
}

/**
 * Convert token tuple -> instance tuple.
 */
export type TokenInstances<D extends readonly ServiceToken<unknown>[]> = {
	[K in keyof D]: D[K] extends ServiceToken<infer T> ? T : never
}

/**
 * Class with static `dependencies` token tuple.
 *
 * - Constructor args must match dependency order/types
 * - Dependencies are resolved before `new`
 */
export interface InjectableConstructor<T extends object, D extends readonly ServiceToken<unknown>[]> {
	readonly dependencies: D
	new (...args: TokenInstances<D>): T
}

/**
 * True when input looks like an injectable constructor.
 *
 * Check:
 *
 * - Input is a function
 * - `dependencies` is an array
 * - Each entry is an object with string `description`
 *
 * Why duck-type?
 *
 * - Avoid misclassifying plain factory functions.
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
 * Scoped, disposable service container. Optional: services can still exist without a registry.
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
	 * Aborts when registry starts disposing. Happens before service cleanup.
	 */
	public get signal(): AbortSignal {
		return this.#abortController.signal
	}

	/**
	 * Register a resolver under a token.
	 *
	 * Important:
	 *
	 * - Service is added to disposal lifecycle at registration time
	 * - Not delayed until first resolve/await
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
	 * Get service by token. Throws `E_UNRESOLVED_TOKEN` if missing.
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
	 * Create child registry scope.
	 *
	 * Behavior:
	 *
	 * - Child lookup falls back to parent
	 * - Parent abort propagates to child
	 * - Parent disposal disposes children first (LIFO)
	 * - Self-disposed child unlinks from parent
	 */
	public createChild(options?: ServiceRegistryOptions): ServiceRegistry {
		this.#assertNotDisposed()

		const child = new ServiceRegistry({ onWarning: options?.onWarning ?? this.#onWarning })
		child.#parent = this
		this.#children.add(child)

		// Keep only a weak reference to child in abort listener.
		// After child disposal + unlink, parent won't retain child/services.
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
	 * Detect cycles in declared dependency tokens.
	 *
	 * Notes:
	 *
	 * - Deterministic static walk over token tuples
	 * - Not affected by async timing
	 * - Opaque factory-internal cycles are not detectable here
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

		// Disposal order:
		// 1) Children first (newest first)
		// 2) Then local services (reverse registration order)
		// Failures are aggregated (SuppressedError), not fail-fast.
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
	 * Alias for `[Symbol.asyncDispose]()`. Repeated calls trigger `onWarning`.
	 */
	public dispose(): Promise<void> {
		if (this.#disposed) {
			this.#onWarning?.("Service registry already disposed.")
		}

		return this[Symbol.asyncDispose]()
	}
}

/**
 * Default module-level registry. Handy for single-scope apps.
 */
export const defaultRegistry: ServiceRegistry = new ServiceRegistry()
