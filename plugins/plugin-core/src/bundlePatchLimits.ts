/** Maximum ordered base patches retained for one target bundle. */
// A complete DynamoDB replacement can require one owner update plus four
// actions per patch: remove the old base reference and patch, then add the new
// base reference and patch. Keeping this at 24 leaves that worst case at 97
// actions, below DynamoDB's 100-action transaction limit.
export const MAX_BUNDLE_PATCHES = 24;
