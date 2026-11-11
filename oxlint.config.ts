/**
 * @license MIT
 * @file Oxlint configuration for async-init.
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { createOxlintConfig } from "@sister.software/oxlint-config"

const config: ReturnType<typeof createOxlintConfig> = createOxlintConfig({
	copyrightHolder: "Sister Software",
	spdxLicenseIdentifier: "MIT",
})

export default config
