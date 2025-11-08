import { type BucketLocationConstraint, S3 } from "@aws-sdk/client-s3";
import { p } from "@hot-updater/cli-tools";
import { type S3Migration, S3Migrator } from "./migrations/migrator";
import type { AwsRegion } from "./regionLocationMap";

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
        .filter((bucket) => bucket.Name)
        .map(async (bucket) => {
          const { LocationConstraint: region } =
            await s3Client.getBucketLocation({ Bucket: bucket.Name! });
          return { name: bucket.Name!, region: region as AwsRegion };
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
    bucketName,
    region,
    migrations,
  }: {
    bucketName: string;
    region: AwsRegion;
    migrations: S3Migration[];
  }): Promise<void> {
    const migrator = new S3Migrator({
      s3: new S3({ region: region, credentials: this.credentials }),
      bucketName,
      migrations: migrations,
    });

    const { pending } = await migrator.list();
    await migrator.migrate({ dryRun: true });
    if (pending.length > 0) {
      p.log.step("Pending migrations:");
      for (const m of pending) {
        p.log.step(`- ${m.name}`);
      }
    }
    const confirm = await p.confirm({ message: "Do you want to continue?" });
    if (p.isCancel(confirm) || !confirm) {
      p.log.info("Migration cancelled.");
      process.exit(1);
    }
    await migrator.migrate({ dryRun: false });
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
    const bucketPolicy = {
      Version: "2008-10-17",
      Id: "PolicyForCloudFrontPrivateContent",
      Statement: [
        {
          Sid: "AllowCloudFrontServicePrincipal",
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
