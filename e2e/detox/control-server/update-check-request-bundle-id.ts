const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export type UpdateCheckMetadataState = {
  readonly stagingBundleId: string | null;
};

export function resolveUpdateCheckRequestBundleId(
  metadataState: UpdateCheckMetadataState,
) {
  return metadataState.stagingBundleId ?? NIL_UUID;
}
