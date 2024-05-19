import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { HotUpdaterReadStrategy } from "@hot-updater/node";

export interface HotUpdaterAwsOptions {
	s3Client: S3Client;
	bucketName: string;
	baseUrl: string;
}

export const aws = ({
	baseUrl,
	bucketName,
	s3Client,
}: HotUpdaterAwsOptions): HotUpdaterReadStrategy => {
	return {
		async getListObjects(prefix?: string) {
			/**
			 * Uses ListObjectsV2Command to fetch a list of objects from an S3 bucket.
			 * Note: A single invocation of ListObjectsV2Command can retrieve a maximum of 1,000 objects.
			 */
			const command = new ListObjectsV2Command({
				Bucket: bucketName,
				Prefix: prefix,
			});

			const data = await s3Client.send(command);
			const files = data.Contents?.filter(({ Key }) => Key !== prefix).map(
				(content) => [baseUrl, content.Key].join("/"),
			);
			return files ?? [];
		},
	};
};

export { S3Client };
