// SPDX-FileCopyrightText: Sister Software
// SPDX-License-Identifier: MIT

/**
 * @file Oxlint configuration for async-init.
 */

import { createOxlintConfig } from "@sister.software/oxlint-config"

const config: ReturnType<typeof createOxlintConfig> = createOxlintConfig({
	copyrightText: "Sister Software",
	spdxLicenseIdentifier: "MIT",
})

export default config
