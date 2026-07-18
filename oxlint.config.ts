/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 * @file oxlint configuration for async-init.
 */

import { createOxlintConfig } from "@sister.software/oxlint-config"

const config: ReturnType<typeof createOxlintConfig> = createOxlintConfig({
	copyrightHolder: "Sister Software",
	spdxLicenseIdentifier: "MIT",
})

export default config
