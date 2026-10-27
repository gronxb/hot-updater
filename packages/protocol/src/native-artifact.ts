/**
 * Reading an artifact built elsewhere (`.ipa`, `.aab`, `.apk`, a simulator
 * `.app.zip`), and whether it can be imported as a native build: what the
 * CLI's `native-build import` reads with. It has no dependencies and treats
 * the artifact as untrusted input. A subpath, so an app's JavaScript bundle,
 * which imports the root, never carries it.
 */
export {
  blobSource,
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
  readNativeArtifact,
  type NativeArtifactInfo,
  type NativeArtifactKind,
  type UnreadableValue,
} from "./nativeArtifact/readNativeArtifact";
export {
  findZipEntry,
  openZipEntry,
  readZipDirectory,
  type ZipEntry,
} from "./nativeArtifact/zip";
