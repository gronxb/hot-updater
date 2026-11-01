/**
 * Removes the ad hoc profiles Xcode saved for an app and its extensions, whose
 * names hold the bundle ID, while the files are named by UUID. A machine that
 * keeps them reuses one that still fits the export without asking Apple, even
 * one Apple has replaced, so a device registered since can't reach that export.
 * Xcode makes a new one at the next export.
 */
export const removeSavedAdHocProfileCommand = (bundleId: string) =>
  `grep -laE "(Ad Hoc Provisioning Profile|XC Ad Hoc): ${bundleId}" ~/Library/Developer/Xcode/UserData/"Provisioning Profiles"/* | xargs -I{} rm {}`;
