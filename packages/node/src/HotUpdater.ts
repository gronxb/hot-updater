import Sqids from "sqids";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { MetaDataOptions, Version } from "./types";

export interface HotUpdaterOptions {
  baseUrl?: string;
  s3Client?: S3Client;
  bucketName: string;
}

export class HotUpdater {
  private s3Client?: S3Client;
  private bucketName: string;
  private baseUrl: string;
  private sqids = new Sqids({
    alphabet: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  });

  constructor({
    bucketName,
    s3Client = new S3Client({}),
    baseUrl = "",
  }: HotUpdaterOptions) {
    this.s3Client = s3Client;
    this.bucketName = bucketName;
    this.baseUrl = baseUrl;
  }

  private encodeVersion(version: Version) {
    return this.sqids.encode(version.split(".").map(Number));
  }

  private decodeVersion(hash: string) {
    const version = this.sqids.decode(hash);
    return version.join(".");
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
    const files = data.Contents?.filter(({ Key }) => Key !== prefix).map(
      (content) => [this.baseUrl, content.Key].join("/")
    );
    return files;
  }

  public async getVersionList() {
    const files = await this.getListObjectsV2Command();

    const versionSet = new Set(
      files.map((file) => {
        const url = new URL(file);
        const [prefix] = url.pathname.split("/").filter(Boolean);
        const version = this.decodeVersion(prefix);
        return version;
      })
    );

    return Array.from(versionSet);
  }

  public async getMetaData({
    version,
    reloadAfterUpdate = false,
  }: MetaDataOptions) {
    const prefix = `${this.encodeVersion(version)}/`;

    return {
      files: await this.getListObjectsV2Command(prefix),
      id: this.encodeVersion(version),
      version,
      reloadAfterUpdate,
    };
  }

  public static create(options: HotUpdaterOptions): HotUpdater {
    return new HotUpdater(options);
  }
}
