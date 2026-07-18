/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Method-resolving proxy over Service<T>: call instance methods before the service has
 *   resolved — the call awaits resolution first. Types are honest: non-function properties
 *   surface as explicit thunks, matching what the runtime returns.
 */

import { Service } from "./service.ts"

/**
 * The lazy view of `T` exposed by {@linkcode proxyService}: methods return promises; plain properties become
 * zero-argument thunks returning promises.
 */
export type ServiceProxy<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : () => Promise<T[K]>
}

/**
 * Wrap a {@linkcode Service} so instance members can be invoked before resolution.
 *
 * `Service.prototype`'s own members (except `constructor`) win over instance members and are bound to the unproxied
 * target — `Service` uses private fields, which throw when accessed through a proxy receiver. Everything else —
 * `Object.prototype` names included — delegates to the resolved instance.
 */
export function proxyService<T extends object>(service: Service<T>): Service<T> & ServiceProxy<T> {
	return new Proxy(service, {
		get(target, property) {
			if (property !== "constructor" && Object.hasOwn(Service.prototype, property)) {
				const value: unknown = Reflect.get(target, property)

				return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value
			}

			return async (...args: unknown[]): Promise<unknown> => {
				const instance = await target
				const value: unknown = Reflect.get(instance, property)

				return typeof value === "function" ? (value as (...args: unknown[]) => unknown).apply(instance, args) : value
			}
		},
	}) as Service<T> & ServiceProxy<T>
}
