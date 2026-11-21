// SPDX-FileCopyrightText: Sister Software
// SPDX-License-Identifier: MIT

/**
 * Service registry with async lifecycle management.
 *
 * - Disposes dependents before the services they need, and otherwise in reverse registration order
 * - Aggregates cleanup failures via SuppressedError
 * - Aborts registry signal before disposal
 * - Replaces one service and its declared dependents while callers keep their handles
 */

import {
	isOptionalNeed,
	type NeedInstances,
	type ServiceDefinition,
	type ServiceNeed,
	type ServiceNeeds,
} from "#definition"
import { LifecycleError } from "#errors"
import { asyncInit, isAsyncInitializable, type LifecycleContext } from "#protocol"
import { proxyService, type ServiceProxy } from "#proxy"
import { type DetachedInstance, Service, type ServiceResolver, ServiceState } from "#service"
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
 * What a registry reports to its subscribers.
 *
 * - `resolve-start` fires after a service's needs resolved, when its own build begins.
 * - `durationMs` on `resolve-end` and `resolve-failed` covers that build, and excludes the wait for needs.
 * - `invalidated` fires for the invalidated service and for each service that declares a need on it.
 * - `disposed` fires when a built instance was given back.
 */
export type ServiceEvent =
	| { readonly type: "resolve-start"; readonly token: ServiceToken<unknown> }
	| { readonly type: "resolve-end"; readonly token: ServiceToken<unknown>; readonly durationMs: number }
	| {
			readonly type: "resolve-failed"
			readonly token: ServiceToken<unknown>
			readonly durationMs: number
			readonly error: unknown
	  }
	| { readonly type: "invalidated"; readonly token: ServiceToken<unknown>; readonly reason: unknown }
	| { readonly type: "disposed"; readonly token: ServiceToken<unknown>; readonly durationMs: number }

/**
 * One declared need of a service, as {@linkcode ServiceRegistry.graph} reports it.
 */
export interface ServiceGraphNeed {
	/**
	 * The name the service reads the need under, or the position for a `dependencies` tuple.
	 */
	readonly key: string
	readonly token: ServiceToken<unknown>
	readonly optional: boolean
	/**
	 * Whether the registry, or an ancestor, has a service for the token now.
	 */
	readonly registered: boolean
}

/**
 * One service, as {@linkcode ServiceRegistry.graph} reports it.
 */
export interface ServiceGraphNode {
	readonly token: ServiceToken<unknown>
	/**
	 * True when the service belongs to an ancestor registry.
	 */
	readonly inherited: boolean
	/**
	 * True when the service states its needs: it was registered with `define()` or as a class with `dependencies`. A
	 * plain instance, factory or constructor has needs the registry cannot read.
	 */
	readonly declared: boolean
	readonly needs: readonly ServiceGraphNeed[]
	/**
	 * The handle's state, or `failed` when the last build threw and no later build has succeeded.
	 */
	readonly state: ServiceState | "failed"
	/**
	 * What the last failed build threw, while `state` is `failed`.
	 */
	readonly error: unknown
}

interface NeedSpec {
	readonly key: string
	readonly token: ServiceToken<unknown>
	readonly optional: boolean
}

/**
 * One built, or building, instance of a service.
 *
 * `refs` counts what still uses it: each instance built from it, and each child registry that resolved it. A stale
 * incarnation is disposed when the count reaches zero.
 */
interface Incarnation {
	readonly entry: Entry
	refs: number
	stale: boolean
	needs: Incarnation[]
	detached: DetachedInstance | null
	disposing: Promise<void> | null
}

interface Entry {
	readonly token: ServiceToken<unknown>
	readonly owner: ServiceRegistry
	readonly service: Service<object>
	readonly proxied: Service<object> & ServiceProxy<object>
	/**
	 * The declared needs, or `null` for a resolver whose needs the registry cannot read.
	 */
	readonly needs: readonly NeedSpec[] | null
	current: Incarnation | null
	failed: boolean
	error: unknown
}

type Produce = (needs: Record<string, unknown>, context: LifecycleContext) => unknown

/**
 * Throw the collected errors as one: the last error, with each earlier one as its `suppressed` chain.
 */
function throwCollected(errors: readonly unknown[]): void {
	if (!errors.length) return

	let combined: unknown = errors[0]

	for (const error of errors.slice(1)) {
		combined = new SuppressedError(error, combined)
	}

	throw combined
}

function disposable(dispose: () => Promise<void>): AsyncDisposable {
	return { [Symbol.asyncDispose]: dispose }
}

/**
 * Scoped, disposable service container. Optional: services can still exist without a registry.
 */
export class ServiceRegistry implements AsyncDisposable {
	#entries = new Map<ServiceToken<unknown>, Entry>()
	#abortController = new AbortController()
	#onWarning: ((message: string) => void) | undefined
	#disposed = false
	#parent: ServiceRegistry | null = null
	#children = new Set<ServiceRegistry>()
	#detachFromParent: (() => void) | null = null
	#listeners = new Set<(event: ServiceEvent) => void>()
	/**
	 * The instance of each ancestor service this registry resolved, kept alive until this registry is disposed. A later
	 * read of the same service returns the held instance, even after the ancestor invalidated it.
	 */
	#holds = new Map<Entry, { readonly incarnation: Incarnation; readonly promise: Promise<unknown> }>()
	/**
	 * Invalidated incarnations of this registry's services that something still uses.
	 */
	#retired = new Set<Incarnation>()

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
		this.#assertUnregistered(token)

		let entry: Entry

		if (isInjectableConstructor(resolver)) {
			const Injectable = resolver as InjectableConstructor<T, readonly ServiceToken<unknown>[]>

			const needs = Injectable.dependencies.map((dependency, index): NeedSpec => ({
				key: String(index),
				token: dependency,
				optional: false,
			}))

			entry = this.#add(token, needs, (resolved) => {
				const instances = needs.map((need) => resolved[need.key])

				return new Injectable(...(instances as TokenInstances<readonly ServiceToken<unknown>[]>))
			})
		} else {
			// A throwaway handle applies the resolver rules: construct a class, call a factory, or pass an instance through.
			entry = this.#add(token, null, (_resolved, context) =>
				new Service<T>(resolver, context, { init: false }).resolve()
			)
		}

		return entry.proxied as unknown as Service<T> & ServiceProxy<T>
	}

	/**
	 * Register a service by its definition: the tokens it needs, its `build`, and an optional `release`.
	 *
	 * - The needs are resolved in parallel before `build` runs.
	 * - A need on the service's own token reads the nearest ancestor's service, so a child can wrap what it shadows.
	 * - A definition that would complete a cycle of declared needs throws `E_DEPENDENCY_CYCLE` here, with the path.
	 * - `build` may return any value. Read it with {@linkcode ServiceRegistry.resolve}.
	 */
	public define<T, const N extends ServiceNeeds = Record<never, never>>(
		token: ServiceToken<T>,
		definition: ServiceDefinition<T, N>
	): void {
		this.#assertNotDisposed()
		this.#assertUnregistered(token)

		const declared: Record<string, ServiceNeed> = definition.needs ?? {}

		const needs = Object.entries(declared).map(([key, need]): NeedSpec =>
			isOptionalNeed(need) ? { key, token: need.token, optional: true } : { key, token: need, optional: false }
		)

		const entry = this.#add(
			token,
			needs,
			(resolved, context) => definition.build(resolved as NeedInstances<N>, context),
			definition.release ? (instance) => definition.release?.(instance as T) : undefined
		)

		try {
			this.#assertAcyclic(entry)
		} catch (error) {
			this.#entries.delete(token)

			throw error
		}
	}

	/**
	 * Get service by token. Throws `E_UNRESOLVED_TOKEN` if missing.
	 */
	public get<T extends object>(token: ServiceToken<T>): Service<T> & ServiceProxy<T> {
		this.#assertNotDisposed()

		const found = this.#findEntry(token)

		if (!found) {
			throw new LifecycleError("E_UNRESOLVED_TOKEN", `No service registered for token "${token.description}".`)
		}

		return found.proxied as unknown as Service<T> & ServiceProxy<T>
	}

	/**
	 * Whether this registry, or an ancestor, has a service for the token.
	 */
	public has(token: ServiceToken<unknown>): boolean {
		return !this.#disposed && this.#findEntry(token) !== null
	}

	/**
	 * Resolve a service to its value, building it on first use.
	 *
	 * A registry that resolves an ancestor's service this way keeps that instance alive until the registry itself is
	 * disposed, even when the ancestor invalidates the service meanwhile. A per-request child registry therefore reads
	 * one consistent set of instances for its whole life.
	 */
	public resolve<T>(token: ServiceToken<T>): Promise<T> {
		if (this.#disposed) {
			return Promise.reject(new LifecycleError("E_DISPOSED", "The service registry has been disposed."))
		}

		const entry = this.#findEntry(token)

		if (!entry) {
			return Promise.reject(
				new LifecycleError("E_UNRESOLVED_TOKEN", `No service registered for token "${token.description}".`)
			)
		}

		if (entry.owner === this) return entry.service.resolve() as Promise<unknown> as Promise<T>

		const held = this.#holds.get(entry)

		if (held) return held.promise as Promise<T>

		const promise: Promise<unknown> = entry.service.resolve()
		const incarnation = entry.current

		if (!incarnation) return promise as Promise<T>

		incarnation.refs += 1

		// A failed build has no instance to hold, so the next read tries the service again.
		const tracked = promise.catch((error: unknown) => {
			if (this.#holds.get(entry)?.incarnation === incarnation) {
				this.#holds.delete(entry)
				ServiceRegistry.#release(incarnation).catch((error_: unknown) => this.#warn(error_))
			}

			throw error
		})

		this.#holds.set(entry, { incarnation, promise: tracked })

		return tracked as Promise<T>
	}

	/**
	 * Replace a service: the next resolution builds a new instance of it and of every service that declares a need on it,
	 * directly or through other services, in this registry's owner and its descendants.
	 *
	 * - Handles from `get()` and `register()` stay valid and resolve to the new instance.
	 * - An old instance is disposed once nothing built from it remains and no child registry that resolved it is alive. The
	 *   returned promise settles after the instances that could be disposed at once were.
	 * - A service registered without declared needs is not followed: it keeps the instance it read.
	 *
	 * @param reason Reported on the `invalidated` event.
	 */
	public async invalidate(token: ServiceToken<unknown>, reason?: unknown): Promise<void> {
		this.#assertNotDisposed()

		const root = this.#findEntry(token)

		if (!root) {
			throw new LifecycleError("E_UNRESOLVED_TOKEN", `No service registered for token "${token.description}".`)
		}

		const retired: Incarnation[] = []

		for (const entry of root.owner.#dependentsOf(root)) {
			entry.owner.#emit({ type: "invalidated", token: entry.token, reason })

			const incarnation = entry.current

			if (!incarnation) continue

			entry.current = null
			incarnation.stale = true
			incarnation.detached = entry.service.detach()
			entry.owner.#retired.add(incarnation)
			retired.push(incarnation)
		}

		const settled = await Promise.allSettled(
			retired
				.filter((incarnation) => incarnation.refs <= 0)
				.map((incarnation) => ServiceRegistry.#disposeIncarnation(incarnation))
		)

		throwCollected(settled.flatMap((result): unknown[] => (result.status === "rejected" ? [result.reason] : [])))
	}

	/**
	 * Describe every service this registry can resolve, its own first and then each ancestor's that it does not shadow.
	 * Builds nothing.
	 */
	public graph(): ServiceGraphNode[] {
		this.#assertNotDisposed()

		const nodes: ServiceGraphNode[] = []
		const seen = new Set<ServiceToken<unknown>>()

		for (const registry of this.#lineage()) {
			for (const entry of registry.#entries.values()) {
				if (seen.has(entry.token)) continue

				seen.add(entry.token)

				const state = entry.service.state
				const failed = entry.failed && state === ServiceState.Idle

				nodes.push({
					token: entry.token,
					inherited: registry !== this,
					declared: entry.needs !== null,
					needs: (entry.needs ?? []).map((need) => ({
						key: need.key,
						token: need.token,
						optional: need.optional,
						registered: registry.#findNeed(entry, need.token) !== null,
					})),
					state: failed ? "failed" : state,
					error: failed ? entry.error : undefined,
				})
			}
		}

		return nodes
	}

	/**
	 * Receive this registry's {@linkcode ServiceEvent}s until the returned object is disposed.
	 *
	 * A registry reports its own services. A child's listener does not receive its parent's events.
	 */
	public subscribe(listener: (event: ServiceEvent) => void): Disposable {
		this.#listeners.add(listener)

		return {
			[Symbol.dispose]: () => {
				this.#listeners.delete(listener)
			},
		}
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

	#add(
		token: ServiceToken<unknown>,
		needs: readonly NeedSpec[] | null,
		produce: Produce,
		release?: (instance: unknown) => void | Promise<void>
	): Entry {
		// The factory runs synchronously inside `service.resolve()` up to its first await,
		// so `entry.current` is the incarnation of the promise that call returned.
		const service = new Service<object>(
			(context) => this.#build(entry, produce, context),
			{ signal: this.signal },
			{ init: false, ...(release ? { release } : {}) }
		)

		const entry: Entry = {
			token,
			owner: this,
			service,
			proxied: proxyService(service),
			needs,
			current: null,
			failed: false,
			error: undefined,
		}

		this.#entries.set(token, entry)

		return entry
	}

	async #build(entry: Entry, produce: Produce, context: LifecycleContext): Promise<object> {
		const incarnation: Incarnation = { entry, refs: 0, stale: false, needs: [], detached: null, disposing: null }

		entry.current = incarnation

		let startedAt = performance.now()

		try {
			let resolved: Record<string, unknown> = {}

			if (entry.needs) {
				this.#assertAcyclic(entry)
				resolved = await this.#resolveNeeds(entry, incarnation)
			}

			startedAt = performance.now()
			this.#emit({ type: "resolve-start", token: entry.token })

			const instance: unknown = await produce(resolved, context)

			if (isAsyncInitializable(instance)) {
				await instance[asyncInit](context)
			}

			entry.failed = false
			entry.error = undefined
			this.#emit({ type: "resolve-end", token: entry.token, durationMs: performance.now() - startedAt })

			// A definition may build any value. The handle's type parameter only constrains its public signatures.
			return instance as object
		} catch (error) {
			if (entry.current === incarnation) {
				entry.current = null
			}

			entry.failed = true
			entry.error = error
			this.#emit({ type: "resolve-failed", token: entry.token, durationMs: performance.now() - startedAt, error })

			await ServiceRegistry.#releaseNeeds(incarnation).catch((error_: unknown) => this.#warn(error_))

			throw error
		}
	}

	/**
	 * Resolve every declared need of `entry`, and count `incarnation` as a user of each instance it was given.
	 *
	 * Every need settles before a failure is thrown, so each instance taken is on record when the caller releases them.
	 */
	async #resolveNeeds(entry: Entry, incarnation: Incarnation): Promise<Record<string, unknown>> {
		const settled = await Promise.allSettled(
			(entry.needs ?? []).map(async (need): Promise<[string, unknown]> => {
				const dependency = this.#findNeed(entry, need.token)

				if (!dependency) {
					if (need.optional) return [need.key, null]

					throw new LifecycleError(
						"E_MISSING_DEPENDENCY",
						`"${entry.token.description}" requires "${need.token.description}", which is not registered.`
					)
				}

				const promise = dependency.service.resolve()
				const taken = dependency.current

				if (taken) {
					taken.refs += 1
					incarnation.needs.push(taken)
				}

				try {
					return [need.key, await promise]
				} catch (error) {
					if (taken) {
						incarnation.needs.splice(incarnation.needs.indexOf(taken), 1)
						await ServiceRegistry.#release(taken).catch((error_: unknown) => this.#warn(error_))
					}

					if (need.optional) return [need.key, null]

					throw error
				}
			})
		)

		const resolved: Record<string, unknown> = {}

		for (const result of settled) {
			if (result.status === "rejected") throw result.reason

			resolved[result.value[0]] = result.value[1]
		}

		return resolved
	}

	static async #release(incarnation: Incarnation): Promise<void> {
		incarnation.refs -= 1

		if (incarnation.stale && incarnation.refs <= 0) {
			await ServiceRegistry.#disposeIncarnation(incarnation)
		}
	}

	static async #releaseNeeds(incarnation: Incarnation): Promise<void> {
		const errors: unknown[] = []

		// Newest first, matching the order a stack would release them in.
		for (const need of incarnation.needs.splice(0).toReversed()) {
			try {
				await ServiceRegistry.#release(need)
			} catch (error) {
				errors.push(error)
			}
		}

		throwCollected(errors)
	}

	/**
	 * Dispose one incarnation's instance, then release the instances it was built from. Repeated calls share one
	 * disposal.
	 */
	static #disposeIncarnation(incarnation: Incarnation): Promise<void> {
		incarnation.disposing ??= (async (): Promise<void> => {
			const owner = incarnation.entry.owner
			const startedAt = performance.now()
			const errors: unknown[] = []

			try {
				await incarnation.detached?.dispose()
			} catch (error) {
				errors.push(error)
			}

			owner.#retired.delete(incarnation)
			owner.#emit({ type: "disposed", token: incarnation.entry.token, durationMs: performance.now() - startedAt })

			try {
				await ServiceRegistry.#releaseNeeds(incarnation)
			} catch (error) {
				errors.push(error)
			}

			throwCollected(errors)
		})()

		return incarnation.disposing
	}

	async #disposeEntry(entry: Entry): Promise<void> {
		const incarnation = entry.current

		entry.current = null

		if (!incarnation) {
			await entry.service[Symbol.asyncDispose]()

			return
		}

		incarnation.stale = true
		incarnation.detached = { dispose: () => entry.service[Symbol.asyncDispose]() }

		await ServiceRegistry.#disposeIncarnation(incarnation)
	}

	/**
	 * This registry, then each ancestor, nearest first.
	 */
	*#lineage(): Generator<ServiceRegistry> {
		yield this

		if (this.#parent) {
			yield* this.#parent.#lineage()
		}
	}

	#findEntry(token: ServiceToken<unknown>): Entry | null {
		for (const registry of this.#lineage()) {
			const entry = registry.#entries.get(token)

			if (entry) return entry
		}

		return null
	}

	/**
	 * The service `entry` receives for one of its needs.
	 *
	 * A need on the entry's own token reads the nearest ancestor's service, because the entry shadows it.
	 */
	#findNeed(entry: Entry, token: ServiceToken<unknown>): Entry | null {
		if (token !== entry.token) return this.#findEntry(token)

		return this.#parent ? this.#parent.#findEntry(token) : null
	}

	/**
	 * `root` and every service, here or in a descendant registry, that reaches it through declared needs.
	 */
	#dependentsOf(root: Entry): Set<Entry> {
		const affected = new Set<Entry>([root])
		const registries: ServiceRegistry[] = []
		const queue: ServiceRegistry[] = [this]

		for (let registry = queue.shift(); registry; registry = queue.shift()) {
			registries.push(registry)
			queue.push(...registry.#children)
		}

		for (let grew = true; grew;) {
			grew = false

			for (const registry of registries) {
				for (const entry of registry.#entries.values()) {
					if (affected.has(entry) || !entry.needs) continue

					const reaches = entry.needs.some((need) => {
						const dependency = registry.#findNeed(entry, need.token)

						return dependency !== null && affected.has(dependency)
					})

					if (reaches) {
						affected.add(entry)
						grew = true
					}
				}
			}
		}

		return affected
	}

	/**
	 * Detect cycles in declared needs.
	 *
	 * Notes:
	 *
	 * - Deterministic static walk over declared tokens
	 * - Not affected by async timing
	 * - Opaque factory-internal cycles are not detectable here
	 * - A need on the service's own token with no ancestor to read it from counts as a cycle
	 */
	#assertAcyclic(root: Entry): void {
		const visited = new Set<Entry>()

		const visit = (entry: Entry, path: readonly ServiceToken<unknown>[]): void => {
			for (const need of entry.needs ?? []) {
				const dependency = entry.owner.#findNeed(entry, need.token)
				const closes = dependency === root || (need.token === entry.token && dependency === null && !need.optional)

				if (closes) {
					const cycle = [...path, need.token].map((token) => token.description).join(" → ")

					throw new LifecycleError("E_DEPENDENCY_CYCLE", `Dependency cycle detected: ${cycle}`)
				}

				if (!dependency || visited.has(dependency)) continue

				visited.add(dependency)
				visit(dependency, [...path, need.token])
			}
		}

		visit(root, [root.token])
	}

	/**
	 * The order to dispose this registry's services in: reverse registration order, except that a service waits until
	 * every service built from its instance has gone first.
	 */
	#teardownOrder(): Entry[] {
		const remaining = [...this.#entries.values()].toReversed()
		const uses = new Map<Incarnation, number>()

		for (const entry of remaining) {
			if (entry.current) {
				uses.set(entry.current, entry.current.refs)
			}
		}

		const order: Entry[] = []

		while (remaining.length) {
			const free = remaining.findIndex((entry) => !entry.current || (uses.get(entry.current) ?? 0) <= 0)
			const [entry] = remaining.splice(Math.max(free, 0), 1)

			order.push(entry!)

			for (const need of entry!.current?.needs ?? []) {
				uses.set(need, (uses.get(need) ?? 0) - 1)
			}
		}

		return order
	}

	async #disposeOwn(): Promise<void> {
		const teardown = new AsyncDisposableStack()

		// A stack disposes newest first, so what is added first runs last.
		teardown.use(
			disposable(async () => {
				const errors: unknown[] = []

				const held = [...this.#holds.values()].toReversed()

				this.#holds.clear()

				for (const { incarnation } of held) {
					try {
						await ServiceRegistry.#release(incarnation)
					} catch (error) {
						errors.push(error)
					}
				}

				throwCollected(errors)
			})
		)

		for (const entry of this.#teardownOrder().toReversed()) {
			teardown.use(disposable(() => this.#disposeEntry(entry)))
		}

		for (const incarnation of this.#retired) {
			teardown.use(disposable(() => ServiceRegistry.#disposeIncarnation(incarnation)))
		}

		await teardown.disposeAsync()
	}

	#emit(event: ServiceEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event)
			} catch (error) {
				this.#warn(error)
			}
		}
	}

	#warn(failure: unknown): void {
		this.#onWarning?.(failure instanceof Error ? failure.message : String(failure))
	}

	#assertUnregistered(token: ServiceToken<unknown>): void {
		if (this.#entries.has(token)) {
			throw new LifecycleError("E_DUPLICATE_TOKEN", `A service is already registered for token "${token.description}".`)
		}
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
		// 2) Then local services, dependents before what they were built from
		// 3) Then the ancestor instances this registry kept alive
		// Failures are aggregated (SuppressedError), not fail-fast.
		const teardown = new AsyncDisposableStack()

		teardown.use(disposable(() => this.#disposeOwn()))

		for (const child of this.#children) {
			teardown.use(child)
		}

		try {
			await teardown.disposeAsync()
		} finally {
			this.#entries.clear()
			this.#children.clear()
			this.#listeners.clear()
			this.#holds.clear()
			this.#retired.clear()
		}
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
