export const storageUriProtocols = [
  { protocol: "s3", origin: "s3://release-bucket" },
  { protocol: "r2", origin: "r2://release-bucket" },
  { protocol: "gs", origin: "gs://release-bucket" },
  {
    protocol: "supabase-storage",
    origin: "supabase-storage://release-bucket",
  },
  { protocol: "http", origin: "http://releases.example.com" },
  { protocol: "https", origin: "https://releases.example.com" },
  { protocol: "storage", origin: "storage://release-bucket" },
] as const;

export const historicalStorageLayout = {
  asset: "updates/bundle-id/files/assets/logo.png",
  assetBase: "updates/bundle-id/files",
  bundle: "updates/bundle-id/bundle.zip",
  contentAddressedAsset: "updates/assets/sha256/ab/abcdef.png",
  contentAddressedAssetBase: "updates/assets",
  manifest: "updates/bundle-id/manifest.json",
  patch: "updates/bundle-id/patches/base-bundle-id/index.ios.bundle.bsdiff",
} as const;
