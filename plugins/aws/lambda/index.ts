import { SSM } from "@aws-sdk/client-ssm";
import {
  createHotUpdater,
  isCanonicalUpdateRoute,
  rewriteLegacyExactRequestToCanonical,
  wildcardPattern,
} from "@hot-updater/server";
import type { CloudFrontRequestHandler } from "aws-lambda";
import { Hono } from "hono";
import type { Callback, CloudFrontRequest } from "hono/lambda-edge";
import { handle } from "hono/lambda-edge";
import { awsLambdaEdgeDatabase, awsLambdaEdgeStorage } from "../src";
import {
  NO_STORE_CACHE_CONTROL,
  SHARED_EDGE_CACHE_CONTROL,
} from "./cacheControl";

declare global {
  var HotUpdater: {
    CLOUDFRONT_KEY_PAIR_ID: string;
    SSM_PARAMETER_NAME: string;
    SSM_REGION: string;
    S3_BUCKET_NAME: string;
  };
}

const CLOUDFRONT_KEY_PAIR_ID = HotUpdater.CLOUDFRONT_KEY_PAIR_ID;
const SSM_PARAMETER_NAME = HotUpdater.SSM_PARAMETER_NAME;
const SSM_REGION = HotUpdater.SSM_REGION;
const S3_BUCKET_NAME = HotUpdater.S3_BUCKET_NAME;

let cachedPrivateKey: string | null = null;

async function getPrivateKey(): Promise<string> {
  if (cachedPrivateKey !== null) {
    return cachedPrivateKey;
  }

  if (!SSM_REGION) {
    throw new Error(
      `Invalid AWS region format: ${SSM_REGION}. Expected format like 'us-east-1' or 'ap-southeast-1'`,
    );
  }

  const ssmClient = new SSM({ region: SSM_REGION });
  const response = await ssmClient.getParameter({
    Name: SSM_PARAMETER_NAME,
    WithDecryption: true,
  });

  if (!response.Parameter?.Value) {
    throw new Error(
      `Failed to retrieve private key from SSM parameter: ${SSM_PARAMETER_NAME}`,
    );
  }

  let keyPair: { privateKey?: unknown };
  try {
    keyPair = JSON.parse(response.Parameter.Value);
  } catch (error) {
    throw new Error(
      `Invalid JSON format in SSM parameter: ${SSM_PARAMETER_NAME}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const privateKey = keyPair.privateKey;
  if (!privateKey || typeof privateKey !== "string") {
    throw new Error(
      `Invalid private key format in SSM parameter: ${SSM_PARAMETER_NAME}`,
    );
  }

  cachedPrivateKey = privateKey;
  return privateKey;
}

type Bindings = {
  callback: Callback;
  request: CloudFrontRequest;
};

const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"];
const HOT_UPDATER_BASE_PATH = "/api/check-update";
const hotUpdaterCache = new Map<string, ReturnType<typeof createHotUpdater>>();

const cloudFrontHeadersToHeaders = (
  headers: CloudFrontRequest["headers"],
): Headers => {
  const normalizedHeaders = new Headers();

  for (const [key, values] of Object.entries(headers)) {
    for (const value of values) {
      normalizedHeaders.append(key, value.value);
    }
  }

  return normalizedHeaders;
};

const getHotUpdater = (requestUrl: string) => {
  const publicBaseUrl = new URL(requestUrl).origin;
  const cached = hotUpdaterCache.get(publicBaseUrl);

  if (cached) {
    return cached;
  }

  const hotUpdater = createHotUpdater({
    database: awsLambdaEdgeDatabase({
      bucketName: S3_BUCKET_NAME,
      region: SSM_REGION,
    }),
    storages: [
      awsLambdaEdgeStorage({
        bucketName: S3_BUCKET_NAME,
        region: SSM_REGION,
        keyPairId: CLOUDFRONT_KEY_PAIR_ID,
        getPrivateKey,
        publicBaseUrl,
      }),
    ],
    basePath: HOT_UPDATER_BASE_PATH,
  });

  hotUpdaterCache.set(publicBaseUrl, hotUpdater);
  return hotUpdater;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get(HOT_UPDATER_BASE_PATH, async (c) => {
  const hotUpdater = getHotUpdater(c.req.url);
  const rewrittenRequest = rewriteLegacyExactRequestToCanonical({
    basePath: hotUpdater.basePath,
    request: c.req.raw,
    headers: cloudFrontHeadersToHeaders(c.env.request.headers),
  });

  if (rewrittenRequest instanceof Response) {
    rewrittenRequest.headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
    return rewrittenRequest;
  }

  const response = await hotUpdater.handler(rewrittenRequest);

  response.headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
  return response;
});

app.on(
  HOT_UPDATER_METHODS,
  wildcardPattern(HOT_UPDATER_BASE_PATH),
  async (c) => {
    const hotUpdater = getHotUpdater(c.req.url);
    const response = await hotUpdater.handler(c.req.raw);

    if (
      c.req.method === "GET" &&
      isCanonicalUpdateRoute(hotUpdater.basePath, new URL(c.req.url).pathname)
    ) {
      response.headers.set("Cache-Control", SHARED_EDGE_CACHE_CONTROL);
    }

    return response;
  },
);

export const handler = handle(app) as CloudFrontRequestHandler;
