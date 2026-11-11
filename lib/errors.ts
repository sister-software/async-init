/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

/**
 * Machine-readable error codes raised by async-init.
 */
export const LifecycleErrorCode = {
	NoResolver: "E_NO_RESOLVER",
	InvalidResolver: "E_INVALID_RESOLVER",
	DuplicateToken: "E_DUPLICATE_TOKEN",
	UnresolvedToken: "E_UNRESOLVED_TOKEN",
	MissingDependency: "E_MISSING_DEPENDENCY",
	DependencyCycle: "E_DEPENDENCY_CYCLE",
	Disposed: "E_DISPOSED",
} as const

export type LifecycleErrorCode = (typeof LifecycleErrorCode)[keyof typeof LifecycleErrorCode]

/**
 * Error raised by async-init. Inspect {@linkcode LifecycleError.code} to branch on the cause.
 */
export class LifecycleError extends Error {
	public readonly code: LifecycleErrorCode

	constructor(code: LifecycleErrorCode, message: string) {
		super(message)

		this.name = "LifecycleError"
		this.code = code
	}
}
