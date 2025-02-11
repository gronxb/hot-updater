import CloudFront from "@aws-sdk/client-cloudfront";
import Lambda from "@aws-sdk/client-lambda";
import S3 from "@aws-sdk/client-s3";

export const SDK = { Lambda, S3, CloudFront };

export type * from "@aws-sdk/client-cloudfront";
export type { BucketLocationConstraint } from "@aws-sdk/client-s3";
