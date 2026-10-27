/**
 * Reading a store artifact (`.ipa`, `.aab`, `.apk`) built elsewhere, and
 * whether it can be imported as a native build: the CLI's `native-build
 * import` and the Console's Native Builds tab share it. A subpath, so an
 * app's JavaScript bundle, which imports the root, never carries it.
 */
export {
  blobSource,
  bytesSource,
  NativeArtifactError,
  type ByteSource,
  type NativeArtifactProblemCode,
} from "./nativeArtifact/byteSource";
export {
  alreadyImportedProblem,
  checkNativeArtifact,
  type ImportableNativeBuild,
  type NativeArtifactCheck,
  type NativeArtifactProblem,
} from "./nativeArtifact/checkNativeArtifact";
export {
  builtInBundlePathOf,
  nativeArtifactKindOf,
  readNativeArtifact,
  type NativeArtifactInfo,
  type NativeArtifactKind,
  type UnreadableValue,
} from "./nativeArtifact/readNativeArtifact";
export {
  openZipEntry,
  readZipDirectory,
  type ZipEntry,
} from "./nativeArtifact/zip";
