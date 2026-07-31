import { InitError, p } from "@hot-updater/cli-tools";

import type { SupabaseApi } from "./supabaseApi";

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

export class PublicSupabaseBucketError extends InitError {
  readonly name = "PublicSupabaseBucketError";

  constructor(readonly bucketName: string) {
    super(
      [
        `Supabase bucket "${bucketName}" is public.`,
        "Make the bucket private in Supabase Storage, then rerun init.",
        "Alternatively, rerun without --env-file to approve the change interactively.",
      ].join("\n"),
    );
  }
}

export const ensureSupabaseBucketPrivate = async ({
  api,
  nonInteractive,
  selection,
}: {
  readonly api: SupabaseApi;
  readonly nonInteractive: boolean;
  readonly selection: SupabaseBucketPrivacySelection;
}): Promise<void> => {
  if (selection.create || !selection.isPublic) {
    return;
  }
  if (nonInteractive) {
    throw new PublicSupabaseBucketError(selection.name);
  }

  const confirmed = await p.confirm({
    message: `Bucket "${selection.name}" is public. Make it private?`,
    initialValue: true,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.log.info("Init cancelled.");
    process.exit(1);
  }

  await api.updateBucket(selection.id, { public: false });
  p.log.success(`Bucket "${selection.name}" is now private.`);
};
