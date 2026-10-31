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
  sandboxArtifactProblem,
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
export {
  createPreviewLink,
  isSandboxChannel,
  isSandboxUrlScheme,
  parsePreviewLink,
  type PreviewLink,
  SANDBOX_ACTIVITY,
  SANDBOX_APPLICATION_ID_SUFFIX,
  SANDBOX_CODE_MARKER,
  SANDBOX_INFO_PLIST_KEY,
  SANDBOX_META_DATA,
  sandboxChannelOf,
  sandboxUrlSchemeOf,
} from "./nativeArtifact/sandbox";
