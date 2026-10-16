import { createHash } from "node:crypto";

/**
 * The deploy lock's key: a hash of everything a deploy writes into the
 * shared checkout before its build reads it. Equal keys write equal bytes,
 * so their deploys may build at once; any difference (the widget's entry or
 * patch surface beside main's, another marker, mode, or config) makes them
 * take turns.
 */
export function createDeployInputsKey(inputs: {
  readonly appSource: string;
  readonly appSourceFile: string;
  readonly bundleProfile: string;
  readonly configSource: string;
  readonly marker: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        inputs.appSourceFile,
        inputs.appSource,
        inputs.bundleProfile,
        inputs.marker,
        inputs.configSource,
      ]),
    )
    .digest("hex");
}
