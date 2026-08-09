import { type BucketLocationConstraint, S3 } from "@aws-sdk/client-s3";
import { MissingInitInputsError, p } from "@hot-updater/cli-tools";

import { type S3Migration, S3Migrator } from "./migrations/migrator";
import type { AwsRegion } from "./regionLocationMap";

function normalizeBucketRegion(
  region: BucketLocationConstraint | null | undefined,
): AwsRegion {
  if (region == null) {
    return "us-east-1";
  }

  if (region === "EU") {
    return "eu-west-1";
  }

  return region;
}

export class S3Manager {
  private credentials: { accessKeyId: string; secretAccessKey: string };

  constructor(credentials: { accessKeyId: string; secretAccessKey: string }) {
    this.credentials = credentials;
  }

  async listBuckets(): Promise<{ name: string; region: AwsRegion }[]> {
    const s3Client = new S3({
      region: "us-east-1",
      credentials: this.credentials,
    });
    const bucketsResult = await s3Client.listBuckets({});
    const buckets = bucketsResult.Buckets ?? [];
    const bucketInfos = await Promise.all(
      buckets
        .filter(
          (bucket): bucket is typeof bucket & { Name: string } =>
            typeof bucket.Name === "string",
        )
        .map(async (bucket) => {
          const { LocationConstraint } = await s3Client.getBucketLocation({
            Bucket: bucket.Name,
          });
          return {
            name: bucket.Name,
            region: normalizeBucketRegion(LocationConstraint),
          };
        }),
    );
    return bucketInfos;
  }

  async createBucket(bucketName: string, region: AwsRegion): Promise<void> {
    const s3Client = new S3({
      region: region,
      credentials: this.credentials,
    });
    await s3Client.createBucket({
      Bucket: bucketName,
      ...(region === "us-east-1"
        ? {}
        : {
            CreateBucketConfiguration: {
              LocationConstraint: region as BucketLocationConstraint,
            },
          }),
    });
    p.log.info(`Created S3 bucket: ${bucketName}`);
  }

  async runMigrations({
    approved,
    bucketName,
    nonInteractive,
    region,
    migrations,
  }: {
    approved?: boolean;
    bucketName: string;
    nonInteractive?: boolean;
    region: AwsRegion;
    migrations: S3Migration[];
  }): Promise<boolean> {
    const migrator = new S3Migrator({
      s3: new S3({ region: region, credentials: this.credentials }),
      bucketName,
      migrations: migrations,
    });

    const { pending } = await migrator.list();
    await migrator.migrate({ dryRun: true });
    if (pending.length === 0) {
      return false;
    }

    p.log.step("Pending migrations:");
    for (const migration of pending) {
      p.log.step(`- ${migration.name}`);
    }
    if (!nonInteractive || !approved) {
      if (nonInteractive) {
        throw new MissingInitInputsError([
          "HOT_UPDATER_AWS_MIGRATION_APPROVED",
        ]);
      }
      const confirm = await p.confirm({
        initialValue: approved,
        message: "Do you want to continue?",
      });
      if (p.isCancel(confirm) || !confirm) {
        p.log.info("Migration cancelled.");
        process.exit(1);
      }
    }
    await migrator.migrate({ dryRun: false });
    return true;
  }

  async updateBucketPolicy({
    bucketName,
    region,
    distributionId,
    accountId,
  }: {
    bucketName: string;
    region: AwsRegion;
    distributionId: string;
    accountId: string;
  }): Promise<void> {
    const s3Client = new S3({
      region: region,
      credentials: this.credentials,
    });
    let existingPolicy: Record<string, unknown> = {};
    try {
      const { Policy } = await s3Client.getBucketPolicy({
        Bucket: bucketName,
      });
      if (Policy) {
        const parsed: unknown = JSON.parse(Policy);
        if (typeof parsed !== "object" || parsed === null) {
          throw new Error("Existing S3 bucket policy is not a JSON object");
        }
        existingPolicy = Object.fromEntries(Object.entries(parsed));
      }
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        Reflect.get(error, "name") !== "NoSuchBucketPolicy"
      ) {
        throw error;
      }
    }
    const policyStatements = Array.isArray(existingPolicy.Statement)
      ? existingPolicy.Statement
      : typeof existingPolicy.Statement === "object" &&
          existingPolicy.Statement !== null
        ? [existingPolicy.Statement]
        : [];
    const existingStatements = policyStatements.filter(
      (statement) =>
        typeof statement !== "object" ||
        statement === null ||
        (Reflect.get(statement, "Sid") !== "AllowCloudFrontServicePrincipal" &&
          Reflect.get(statement, "Sid") !== "AllowHotUpdaterCloudFrontRead"),
    );
    const bucketPolicy = {
      ...existingPolicy,
      Version:
        typeof existingPolicy.Version === "string"
          ? existingPolicy.Version
          : "2012-10-17",
      Statement: [
        ...existingStatements,
        {
          Sid: "AllowHotUpdaterCloudFrontRead",
          Effect: "Allow",
          Principal: { Service: "cloudfront.amazonaws.com" },
          Action: "s3:GetObject",
          Resource: `arn:aws:s3:::${bucketName}/*`,
          Condition: {
            StringEquals: {
              "AWS:SourceArn": `arn:aws:cloudfront::${accountId}:distribution/${distributionId}`,
            },
          },
        },
      ],
    };
    await s3Client.putBucketPolicy({
      Bucket: bucketName,
      Policy: JSON.stringify(bucketPolicy),
    });
    p.log.success(
      "S3 bucket policy updated to allow access from CloudFront distribution",
    );
  }
}
