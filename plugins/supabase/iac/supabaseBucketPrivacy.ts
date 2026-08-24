import { p } from "@hot-updater/cli-tools";

type SupabaseBucketPrivacySelection =
  | {
      readonly create: false;
      readonly id: string;
      readonly isPublic: boolean;
      readonly name: string;
    }
  | {
      readonly create: true;
      readonly name: string;
    };

export const preserveSupabaseBucketPrivacy = ({
  selection,
}: {
  readonly selection: SupabaseBucketPrivacySelection;
}): void => {
  if (selection.create || !selection.isPublic) {
    return;
  }
  p.log.warn(
    `Bucket "${selection.name}" is public. Its access level will be preserved for existing apps.`,
  );
};
