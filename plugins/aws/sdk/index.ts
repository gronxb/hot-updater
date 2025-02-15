import CloudFront from "@aws-sdk/client-cloudfront";
import Lambda from "@aws-sdk/client-lambda";
import S3 from "@aws-sdk/client-s3";
import CredentialsProvider from "@aws-sdk/credential-providers";

export const SDK = { Lambda, S3, CloudFront, CredentialsProvider };

export type * from "@aws-sdk/client-cloudfront";
export type { BucketLocationConstraint } from "@aws-sdk/client-s3";
