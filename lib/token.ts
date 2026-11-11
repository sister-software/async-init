/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

/**
 * Phantom type marker for service tokens
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
