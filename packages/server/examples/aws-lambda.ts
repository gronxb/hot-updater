// New AWS Lambda using @hot-updater/server
import type { CloudFrontRequestHandler } from "aws-lambda";
import { HotUpdater, dynamoDBDatabase, cloudfrontStorage } from "@hot-updater/server";

declare global {
  var HotUpdater: {
    CLOUDFRONT_KEY_PAIR_ID: string;
    CLOUDFRONT_PRIVATE_KEY_BASE64: string;
  };
}

const hotUpdater = new HotUpdater({
  database: dynamoDBDatabase({
    tableName: process.env.DYNAMODB_TABLE_NAME!,
    region: process.env.AWS_REGION!
  }),
  storage: cloudfrontStorage({
    keyPairId: HotUpdater.CLOUDFRONT_KEY_PAIR_ID,
    privateKey: Buffer.from(HotUpdater.CLOUDFRONT_PRIVATE_KEY_BASE64, "base64").toString("utf-8")
  })
});

export const handler: CloudFrontRequestHandler = async (event) => {
  const request = event.Records[0].cf.request;
  
  // Convert CloudFront request to Web API Request
  const url = new URL(request.uri, `https://${request.headers.host[0].value}`);
  
  // Add query parameters
  if (request.querystring) {
    url.search = request.querystring;
  }

  const headers = new Headers();
  Object.entries(request.headers).forEach(([key, values]) => {
    if (values && values.length > 0) {
      headers.set(key, values[0].value);
    }
  });

  const webRequest = new Request(url.toString(), {
    method: request.method,
    headers,
  });

  const response = await hotUpdater.handler(webRequest);
  
  // Convert Web API Response to CloudFront response
  if (response.status === 200) {
    const responseHeaders: any = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = [{ key, value }];
    });

    return {
      status: response.status.toString(),
      statusDescription: 'OK',
      headers: responseHeaders,
      body: await response.text(),
    };
  }

  // For non-200 responses, return the original request
  return request;
};