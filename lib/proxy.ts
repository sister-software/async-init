/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * You can call service members before the service is ready.
 *
 * - Calls wait until the service resolves.
 * - Types match runtime behavior.
 * - Non-function properties are exposed as thunks: `() => Promise<value>`.
 */

import { Service } from "#service"

/**
 * Lazy view of `T` from {@linkcode proxyService}.
 *
 * - Methods -> `(...args) => Promise<result>`
 * - Plain properties -> `() => Promise<value>`
 */
export type ServiceProxy<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : () => Promise<T[K]>
}

/**
 * Wrap a {@linkcode Service} so you can use members before it resolves.
 *
 * Rules:
 *
 * - `Service.prototype` members (except `constructor`) take priority.
 * - Those members are bound to the raw target (important for private fields).
 * - Everything else (including `Object.prototype` names) is forwarded to the resolved instance.
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
