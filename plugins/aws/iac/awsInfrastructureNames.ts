export const getAwsV1SsmParameterName = (lambdaName: string): string =>
  `/hot-updater/v1/${lambdaName}/keypair`;
