/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { LifecycleError, LifecycleErrorCode } from "async-init"
import { describe, expect, it } from "vitest"

describe("LifecycleError", () => {
	it("carries a code and message", () => {
		const error = new LifecycleError("E_DUPLICATE_TOKEN", "already registered")

		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe("LifecycleError")
		expect(error.code).toBe("E_DUPLICATE_TOKEN")
		expect(error.message).toBe("already registered")
	})

	it("enumerates every code in the const object", () => {
		const sortedLifecycleErrorCodes = Object.values(LifecycleErrorCode).toSorted((a, b) => a.localeCompare(b))

		expect(sortedLifecycleErrorCodes).toEqual([
			"E_DEPENDENCY_CYCLE",
			"E_DISPOSED",
			"E_DUPLICATE_TOKEN",
			"E_INVALID_RESOLVER",
			"E_MISSING_DEPENDENCY",
			"E_NO_RESOLVER",
			"E_UNRESOLVED_TOKEN",
		])
	})
})
