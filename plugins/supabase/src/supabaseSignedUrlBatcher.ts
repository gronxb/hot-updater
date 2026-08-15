type SignedUrlBatchResult = {
  error?: string | null;
  signedUrl?: string | null;
};

type PendingSignedUrl = {
  key: string;
  reject: (error: Error) => void;
  resolve: (signedUrl: string) => void;
};

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

export const createSupabaseSignedUrlBatcher = ({
  createSignedUrls,
  expiresIn,
  formatObjectPath,
}: {
  createSignedUrls: (
    bucketName: string,
    keys: string[],
    expiresIn: number,
  ) => Promise<{
    data: SignedUrlBatchResult[] | null;
    error?: unknown;
  }>;
  expiresIn: number;
  formatObjectPath: (bucketName: string, key: string) => string;
}) => {
  let pendingByBucket = new Map<string, PendingSignedUrl[]>();
  let flushScheduled = false;

  const createSignedUrlError = (
    bucketName: string,
    key: string,
    error: unknown,
  ) =>
    new Error(
      `Failed to generate download URL for "${formatObjectPath(bucketName, key)}": ${getErrorMessage(error)}`,
    );

  const flush = async () => {
    const batches = pendingByBucket;
    pendingByBucket = new Map();
    flushScheduled = false;

    await Promise.all(
      [...batches.entries()].map(async ([bucketName, pending]) => {
        try {
          const { data, error } = await createSignedUrls(
            bucketName,
            pending.map(({ key }) => key),
            expiresIn,
          );

          if (error || !data) {
            const batchError =
              error ?? new Error("missing signed URL response");
            for (const request of pending) {
              request.reject(
                createSignedUrlError(bucketName, request.key, batchError),
              );
            }
            return;
          }

          pending.forEach((request, index) => {
            const result = data[index];
            if (!result?.error && result?.signedUrl) {
              request.resolve(result.signedUrl);
              return;
            }

            request.reject(
              createSignedUrlError(
                bucketName,
                request.key,
                result?.error ?? new Error("missing signed URL"),
              ),
            );
          });
        } catch (error) {
          for (const request of pending) {
            request.reject(
              createSignedUrlError(bucketName, request.key, error),
            );
          }
        }
      }),
    );
  };

  return (bucketName: string, key: string) =>
    new Promise<string>((resolve, reject) => {
      const pending = pendingByBucket.get(bucketName) ?? [];
      pending.push({ key, reject, resolve });
      pendingByBucket.set(bucketName, pending);

      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(() => {
          void flush();
        });
      }
    });
};
