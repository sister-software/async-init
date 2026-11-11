/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { defineConfig } from "vitest/config"

const config: ReturnType<typeof defineConfig> = defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		typecheck: {
			include: ["test/**/*.test-d.ts"],
		},
	},
})

export default config
