import Sqids from "sqids";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

export interface HotUpdaterOptions {
  s3Client?: S3Client;
  bucketName: string;
}

export class HotUpdater {
  private s3Client?: S3Client;
  private bucketName: string;
  private sqids = new Sqids({
    alphabet: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  });

  constructor({ s3Client, bucketName }: HotUpdaterOptions) {
    this.s3Client = s3Client ?? new S3Client({});
    this.bucketName = bucketName;
  }

  private encodeVersion(version: number) {
    return this.sqids.encode([version]);
  }

  private decodeVersion(id: string) {
    const [version] = this.sqids.decode(id);
    return version;
  }

  private async getListObjectsV2Command(prefix?: string) {
    /**
     * Uses ListObjectsV2Command to fetch a list of objects from an S3 bucket.
     * Note: A single invocation of ListObjectsV2Command can retrieve a maximum of 1,000 objects.
     */
    const command = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: prefix,
    });
    const data = await this.s3Client.send(command);
    const assetPaths = data.Contents?.map((content) => content.Key).filter(
      (key) => key !== prefix
    );
    return assetPaths;
  }

  public async getVersionList() {
    const assetPaths = await this.getListObjectsV2Command();

    const versionSet = new Set(
      assetPaths.map((assetPaths) => {
        const [prefix] = assetPaths.split("/");
        const version = this.decodeVersion(prefix);
        return version;
      })
    );

    return Array.from(versionSet);
  }

  public async getMetaData(version: number) {
    const prefix = `${this.encodeVersion(version)}/`;

    return {
      assetPaths: await this.getListObjectsV2Command(prefix),
      version,
    };
  }

  public static create(options: HotUpdaterOptions): HotUpdater {
    return new HotUpdater(options);
  }
}
