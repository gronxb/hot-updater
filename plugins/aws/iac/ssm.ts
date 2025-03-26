import crypto from "crypto";
import { ParameterNotFound, SSM } from "@aws-sdk/client-ssm";
import * as p from "@clack/prompts";
import type { AwsRegion } from "./regionLocationMap";

export class SSMKeyPairManager {
  private region: AwsRegion;
  private credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };

  constructor(
    region: AwsRegion,
    credentials: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    },
  ) {
    this.region = region;
    this.credentials = credentials;
  }

  private async getParameter(name: string): Promise<string | null> {
    const ssm = new SSM({ region: this.region, credentials: this.credentials });
    try {
      const { Parameter } = await ssm.getParameter({
        Name: name,
        WithDecryption: true,
      });
      return Parameter?.Value || null;
    } catch (error) {
      if (error instanceof ParameterNotFound) {
        return null;
      }
      throw error;
    }
  }

  private async putParameter(name: string, value: string): Promise<void> {
    const ssm = new SSM({ region: this.region, credentials: this.credentials });
    await ssm.putParameter({
      Name: name,
      Value: value,
      Type: "SecureString",
      Overwrite: true,
    });
  }

  async getOrCreateKeyPair(
    parameterName: string,
  ): Promise<{ keyPairId: string; publicKey: string; privateKey: string }> {
    const existing = await this.getParameter(parameterName);
    if (existing) {
      const keyPair = JSON.parse(existing);
      p.log.info("Using existing CloudFront key pair from SSM Parameter Store");
      return keyPair;
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const keyPairId = `HOTUPDATER-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const keyPair = { keyPairId, publicKey, privateKey };
    await this.putParameter(parameterName, JSON.stringify(keyPair));
    p.log.success(
      "Created and stored new CloudFront key pair in SSM Parameter Store",
    );
    return keyPair;
  }
}
