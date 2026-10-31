import { p } from "@hot-updater/cli-tools";

import { ui } from "../cli-ui";

/** The line deploy ends with when signing stops it, which E2E reads. */
export const DEPLOYMENT_BLOCKED =
  "Deployment blocked. Fix the signing configuration and try again.";

/**
 * Deploy's refusal when it can't read the signing key: the error as its
 * lines lay it out, its command on a line of its own, then the block.
 */
export const reportSigningRefusal = (error: unknown): void => {
  p.log.error(ui.prose(error instanceof Error ? error.message : String(error)));
  p.log.error(DEPLOYMENT_BLOCKED);
};
