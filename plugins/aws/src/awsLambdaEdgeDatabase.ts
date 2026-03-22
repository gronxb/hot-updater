import type { S3DatabaseConfig } from "./s3Database";
import { s3Database } from "./s3Database";

export type AwsLambdaEdgeDatabaseConfig = S3DatabaseConfig;

export const awsLambdaEdgeDatabase = s3Database;
