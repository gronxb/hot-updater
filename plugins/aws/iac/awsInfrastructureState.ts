import { Lambda } from "@aws-sdk/client-lambda";
import {
  assertInfrastructureGenerationAtUrl,
  assertInfrastructureGenerationPayload,
  InitError,
} from "@hot-updater/cli-tools";

type Fetch = typeof fetch;

export type AwsDistributionGeneration = "unknown" | "v0" | "v1";

const AWS_DISTRIBUTION_VERSION_PATHS = [
  "/version",
  "/api/check-update/version",
] as const;

const readAwsDistributionGeneration = (
  payload: unknown,
): AwsDistributionGeneration => {
  if (typeof payload !== "object" || payload === null) return "unknown";
  if ("infrastructureGeneration" in payload) {
    return payload.infrastructureGeneration === 1 ? "v1" : "unknown";
  }
  return "version" in payload && typeof payload.version === "string"
    ? "v0"
    : "unknown";
};

export const resolveAwsDistributionGeneration = async ({
  domainName,
  fetchImpl = fetch,
}: {
  readonly domainName: string;
  readonly fetchImpl?: Fetch;
}): Promise<AwsDistributionGeneration> => {
  const generations = await Promise.all(
    AWS_DISTRIBUTION_VERSION_PATHS.map(async (path) => {
      try {
        const response = await fetchImpl(`https://${domainName}${path}`);
        if (!response.ok) return "unknown";
        return readAwsDistributionGeneration(
          await response.json().catch(() => undefined),
        );
      } catch {
        return "unknown";
      }
    }),
  );
  if (generations.includes("v1")) return "v1";
  if (generations.includes("v0")) return "v0";
  return "unknown";
};

export const assertAwsInfrastructureGeneration = async (input: {
  readonly domainName: string;
  readonly fetchImpl?: Fetch;
}): Promise<void> => {
  const versionUrl = `https://${input.domainName}/version`;
  await assertInfrastructureGenerationAtUrl({
    fetchImpl: input.fetchImpl,
    provider: "AWS",
    resource: versionUrl,
    versionUrl,
  });
};

type AwsLambdaClient = Pick<Lambda, "getFunctionConfiguration" | "invoke">;

const createVersionEvent = () => ({
  Records: [
    {
      cf: {
        config: {
          distributionDomainName: "hot-updater-init.invalid",
          distributionId: "hot-updater-init",
          eventType: "origin-request",
          requestId: "hot-updater-init",
        },
        request: {
          clientIp: "127.0.0.1",
          headers: {
            host: [
              {
                key: "host",
                value: "hot-updater-init.invalid",
              },
            ],
          },
          method: "GET",
          querystring: "",
          uri: "/version",
        },
      },
    },
  ],
});

const readLambdaResponsePayload = (payload: Uint8Array | undefined) => {
  if (!payload) return undefined;
  const response: unknown = JSON.parse(new TextDecoder().decode(payload));
  if (typeof response !== "object" || response === null) return undefined;

  const status = Reflect.get(response, "status");
  if (status !== 200 && status !== "200") {
    if (status === 404 || status === "404") return undefined;
    throw new InitError(
      `Could not verify the AWS Lambda infrastructure generation: HTTP ${String(status)}`,
    );
  }

  const body = Reflect.get(response, "body");
  if (typeof body === "string") return JSON.parse(body);
  if (typeof body !== "object" || body === null) return undefined;

  const data = Reflect.get(body, "data");
  const encoding = Reflect.get(body, "encoding");
  if (typeof data !== "string") return undefined;
  return JSON.parse(
    encoding === "base64" ? Buffer.from(data, "base64").toString("utf8") : data,
  );
};

export const assertAwsLambdaCanInitialize = async ({
  credentials,
  lambdaClient = new Lambda({ credentials, region: "us-east-1" }),
  lambdaName,
}: {
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  readonly lambdaClient?: AwsLambdaClient;
  readonly lambdaName: string;
}): Promise<void> => {
  try {
    await lambdaClient.getFunctionConfiguration({ FunctionName: lambdaName });
  } catch (error) {
    if (error instanceof Error && error.name === "ResourceNotFoundException") {
      return;
    }
    throw new InitError(
      `Could not check whether AWS Lambda ${lambdaName} already exists: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const resource = `Lambda function ${lambdaName}`;
  let result: {
    readonly FunctionError?: string;
    readonly Payload?: Uint8Array;
  };
  try {
    result = await lambdaClient.invoke({
      FunctionName: lambdaName,
      Payload: Buffer.from(JSON.stringify(createVersionEvent())),
    });
  } catch (error) {
    throw new InitError(
      `Could not verify the AWS infrastructure generation at ${resource}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (result.FunctionError) {
    throw new InitError(
      `Could not verify the AWS infrastructure generation at ${resource}: ${result.FunctionError}`,
    );
  }

  let payload: unknown;
  try {
    payload = readLambdaResponsePayload(result.Payload);
  } catch (error) {
    if (error instanceof InitError) throw error;
    payload = undefined;
  }
  assertInfrastructureGenerationPayload({
    payload,
    provider: "AWS",
    resource,
  });
};
