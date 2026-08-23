import { InitError, LegacyInfrastructureError } from "./initOptions";

type Fetch = typeof fetch;

export const assertInfrastructureGenerationPayload = ({
  payload,
  provider,
  resource,
}: {
  readonly payload: unknown;
  readonly provider: string;
  readonly resource: string;
}): void => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("infrastructureGeneration" in payload) ||
    payload.infrastructureGeneration !== 1
  ) {
    throw new LegacyInfrastructureError(provider, resource);
  }
};

export const assertInfrastructureGenerationAtUrl = async ({
  fetchImpl = fetch,
  provider,
  resource,
  versionUrl,
}: {
  readonly fetchImpl?: Fetch;
  readonly provider: string;
  readonly resource: string;
  readonly versionUrl: string;
}): Promise<void> => {
  let response: Response;
  try {
    response = await fetchImpl(versionUrl);
  } catch (error) {
    throw new InitError(
      `Could not verify the ${provider} infrastructure generation at ${resource}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 404) {
    throw new LegacyInfrastructureError(provider, resource);
  }
  if (!response.ok) {
    throw new InitError(
      `Could not verify the ${provider} infrastructure generation at ${resource}: HTTP ${response.status}`,
    );
  }

  const payload: unknown = await response.json().catch(() => undefined);
  assertInfrastructureGenerationPayload({ payload, provider, resource });
};
