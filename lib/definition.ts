/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * A service definition: the tokens a service needs, how to build it from them, and how to give it back.
 *
 * - The needs are data, so a registry can read the dependency graph without building anything.
 * - A definition suits a factory. A class with a static `dependencies` tuple keeps using `register()`.
 */

import type { LifecycleContext } from "#protocol"
import type { ServiceToken } from "#token"

/**
 * A need that resolves to `null` when its token is unregistered or its service fails to build.
 */
export interface OptionalNeed<out T> {
	readonly token: ServiceToken<T>
	readonly optional: true
}

/**
 * Mark a need as optional: the service that declares it is built with `null` in its place when the token is
 * unregistered or the needed service fails. The failure stays readable through `registry.graph()`.
 */
export function optional<T>(token: ServiceToken<T>): OptionalNeed<T> {
	return Object.freeze({ token, optional: true })
}

/**
 * True when a need was wrapped with {@linkcode optional}.
 */
export function isOptionalNeed(need: ServiceNeed): need is OptionalNeed<unknown> {
	return "token" in need && need.optional === true
}

/**
 * One declared need: a token, or a token wrapped with {@linkcode optional}.
 */
export type ServiceNeed = ServiceToken<unknown> | OptionalNeed<unknown>

/**
 * The needs of one service, keyed by the name its `build` reads each one under.
 */
export type ServiceNeeds = Readonly<Record<string, ServiceNeed>>

/**
 * Convert a needs record into the record of instances `build` receives.
 */
export type NeedInstances<N extends ServiceNeeds> = {
	readonly [K in keyof N]: N[K] extends OptionalNeed<infer T>
		? T | null
		: N[K] extends ServiceToken<infer T>
			? T
			: never
}

/**
 * How a registry builds and releases one service.
 *
 * - `needs` are resolved, in parallel, before `build` runs.
 * - `build` may return any value, including a primitive or `null`.
 * - `release` gives the value back at disposal. Without it, the registry calls the value's own `Symbol.asyncDispose` or
 *   `Symbol.dispose` when it has one.
 */
export interface ServiceDefinition<T, N extends ServiceNeeds = Record<never, never>> {
	readonly needs?: N
	build(needs: NeedInstances<N>, context: LifecycleContext): T | Promise<T>
	release?(instance: T): void | Promise<void>
}
