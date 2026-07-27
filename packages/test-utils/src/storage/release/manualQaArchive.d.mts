export declare const assertManualQaArchiveAvailable: (output: string) => string;

export declare const archiveManualQaTarballs: (
  input: Readonly<{
    archiveDirectory: string;
    tarballs: ReadonlyMap<string, string>;
  }>,
) => Map<string, string>;

export declare const discardManualQaTarballArchive: (
  archiveDirectory: string,
) => void;

export type ManualQaArchiveHandoff = Readonly<{
  sourceRoot: string;
  destinationRoot: string;
}>;

export declare const assertManualQaArchiveHandoffAvailable: (
  input: ManualQaArchiveHandoff,
) => ManualQaArchiveHandoff;

export declare const handoffManualQaArchiveRoot: (
  input: ManualQaArchiveHandoff,
) => void;
