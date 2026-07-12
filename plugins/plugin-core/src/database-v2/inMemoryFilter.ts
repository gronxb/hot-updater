import type { Bundle } from "@hot-updater/core";

import type { BundleWhereV2 } from "./bundles";

const compare = (value: string, expected: string | undefined): number =>
  expected === undefined ? 0 : value < expected ? -1 : value > expected ? 1 : 0;

export const bundleMatchesInMemoryWhereV2 = (
  bundle: Bundle,
  where: BundleWhereV2 | undefined,
): boolean => {
  if (where === undefined) return true;
  if (where.channel !== undefined && bundle.channel !== where.channel)
    return false;
  if (where.platform !== undefined && bundle.platform !== where.platform)
    return false;
  if (where.enabled !== undefined && bundle.enabled !== where.enabled)
    return false;
  const id = where.id;
  if (id?.in !== undefined && !id.in.includes(bundle.id)) return false;
  if (id?.eq !== undefined && compare(bundle.id, id.eq) !== 0) return false;
  if (id?.gt !== undefined && compare(bundle.id, id.gt) <= 0) return false;
  if (id?.gte !== undefined && compare(bundle.id, id.gte) < 0) return false;
  if (id?.lt !== undefined && compare(bundle.id, id.lt) >= 0) return false;
  if (id?.lte !== undefined && compare(bundle.id, id.lte) > 0) return false;
  if (
    where.targetAppVersionNotNull === true &&
    bundle.targetAppVersion === null
  )
    return false;
  if (
    where.targetAppVersion !== undefined &&
    bundle.targetAppVersion !== where.targetAppVersion
  )
    return false;
  if (
    where.targetAppVersionIn !== undefined &&
    !where.targetAppVersionIn.includes(bundle.targetAppVersion ?? "")
  )
    return false;
  if (
    where.fingerprintHash !== undefined &&
    bundle.fingerprintHash !== where.fingerprintHash
  )
    return false;
  return true;
};
