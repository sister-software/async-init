/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Service tokens: runtime keys married to interface types. A token's type parameter is
 *   phantom — it exists only at the type level, giving full inference at registry call sites.
 */

declare const serviceTokenBrand: unique symbol

/**
 * A runtime key carrying a phantom interface type. Compared by reference identity.
 */
export interface ServiceToken<out T> {
	readonly description: string
	readonly [serviceTokenBrand]?: T
}

/**
 * Create a token binding `description` (diagnostics only — identity is by reference) to type `T`.
 */
export function createToken<T>(description: string): ServiceToken<T> {
	return Object.freeze({ description })
}
