import { InitError, LegacyInfrastructureError } from "@hot-updater/cli-tools";

type Fetch = typeof fetch;

export const assertAwsInfrastructureGeneration = async (input: {
  readonly domainName: string;
  readonly fetchImpl?: Fetch;
}): Promise<void> => {
  const versionUrl = `https://${input.domainName}/version`;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(versionUrl);
  } catch (error) {
    throw new InitError(
      `Could not verify the AWS infrastructure generation at ${versionUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new InitError(
      `Could not verify the AWS infrastructure generation at ${versionUrl}: HTTP ${response.status}`,
    );
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (
    typeof body !== "object" ||
    body === null ||
    !("infrastructureGeneration" in body) ||
    body.infrastructureGeneration !== 1
  ) {
    throw new LegacyInfrastructureError("AWS", versionUrl);
  }
};
