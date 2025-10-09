import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

// Object to store fake bucket in memory
let fakeBucket: Record<string, string> = {};

// Function to reset the bucket (called in tests)
export function resetFakeBucket(initial: Record<string, string>) {
  fakeBucket = { ...initial };
}

// Function to return the current state of the bucket
export function getFakeBucket() {
  return fakeBucket;
}

// Function to set up S3 client mocking
export function setupS3Mock() {
  // Override the send method of S3Client
  S3Client.prototype.send = async (command: any) => {
    if (command instanceof ListObjectsV2Command) {
      // Return all keys matching the prefix
      const prefix = command.input.Prefix || "";
      const keys = Object.keys(fakeBucket).filter((key) =>
        key.startsWith(prefix),
      );
      return { Contents: keys.map((key) => ({ Key: key })) };
    }

    if (command instanceof GetObjectCommand) {
      const key = command.input.Key;
      if (key && Object.hasOwn(fakeBucket, key)) {
        return {
          Body: {
            transformToString: async () => fakeBucket[key],
          },
        };
      }
      throw new Error("NoSuchKey");
    }
    if (command instanceof CopyObjectCommand) {
      // CopySource format: "bucket/key"
      // Use all characters after the bucket name as the sourceKey
      const copySource = command.input.CopySource || "";
      const sourceKey = copySource.substring(copySource.indexOf("/") + 1);
      const destKey = command.input.Key;
      if (destKey && Object.hasOwn(fakeBucket, sourceKey)) {
        fakeBucket[destKey] = fakeBucket[sourceKey];
      } else {
        throw new Error("Source key not found");
      }
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      const key = command.input.Key;
      if (key && Object.hasOwn(fakeBucket, key)) {
        delete fakeBucket[key];
      } else {
        console.warn(`Key ${key} not found during deletion, ignoring.`);
      }
      return {};
    }
    // For Upload or other commands, use command.input if command.params is not available
    const params = command.params || command.input;
    if (!params) {
      throw new Error("Missing parameters in command");
    }
    const { Key, Body } = params;
    if (!Key) {
      throw new Error("Missing Key in command parameters");
    }
    // If Body is a Buffer, convert to string before storing, otherwise store as is
    if (Buffer.isBuffer(Body)) {
      fakeBucket[Key] = Body.toString();
    } else {
      fakeBucket[Key] = Body;
    }
    return {};
  };
}
