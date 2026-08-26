ALTER TABLE bundles
ADD COLUMN archive_byte_size REAL NOT NULL DEFAULT 0
  CONSTRAINT bundles_archive_byte_size_check CHECK (
    archive_byte_size BETWEEN 0 AND 9007199254740991
  );

ALTER TABLE bundle_patches
ADD COLUMN byte_size REAL NOT NULL DEFAULT 0
  CONSTRAINT bundle_patches_byte_size_check CHECK (
    byte_size BETWEEN 0 AND 9007199254740991
  );
