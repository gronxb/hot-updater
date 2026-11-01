const shellQuoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * Removes the ad hoc profiles Xcode saved for exactly these bundle IDs, whose
 * files are named by UUID. A machine that keeps them reuses one that still fits
 * the export without asking Apple, even one Apple has replaced, so a device
 * registered since can't reach that export. Xcode makes a new one at the next
 * export.
 *
 * This deletes files on someone's Mac, so a pattern is a fixed string up to the
 * end of the profile's `Name`: another app's profile whose ID merely starts with
 * or resembles one of these never matches.
 */
export const removeSavedAdHocProfileCommand = (
  bundleIds: readonly string[],
) => {
  const patterns = bundleIds
    .flatMap((bundleId) => [
      `Ad Hoc Provisioning Profile: ${bundleId}</string>`,
      `XC Ad Hoc: ${bundleId}</string>`,
    ])
    .map((pattern) => `-e ${shellQuoted(pattern)}`)
    .join(" ");
  return `grep -laF ${patterns} ~/Library/Developer/Xcode/UserData/"Provisioning Profiles"/* | xargs -I{} rm {}`;
};
