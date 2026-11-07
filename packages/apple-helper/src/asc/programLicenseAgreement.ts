/**
 * What to do when Apple holds a team's requests until the Account Holder
 * accepts the latest Apple Developer Program License Agreement: App Store
 * Connect answers 403, and xcodebuild prints "PLA Update available".
 */
export const PROGRAM_LICENSE_AGREEMENT_HINT = [
  "The Account Holder must accept the latest Program License Agreement:",
  "https://developer.apple.com/account",
].join("\n");

/** The code App Store Connect answers a team with a pending agreement. */
const AGREEMENT_ERROR_CODE = "FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED";

/**
 * Whether App Store Connect's JSON:API errors say the team has a Program
 * License Agreement to accept, by its code or its detail.
 */
export const isProgramLicenseAgreementError = (
  errors: readonly { code?: string; detail?: string; title?: string }[],
): boolean =>
  errors.some(
    ({ code, detail, title }) =>
      code === AGREEMENT_ERROR_CODE ||
      /Program License Agreement/iu.test(`${detail ?? ""} ${title ?? ""}`),
  );

/** Whether xcodebuild's output says the team has an agreement to accept. */
export const mentionsProgramLicenseAgreement = (output: string): boolean =>
  output.includes("PLA Update available");
