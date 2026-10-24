`builtin_reuse.ttf` is an original, minimal TrueType fixture for builtin-to-OTA
byte reuse. It contains only `.notdef`, space, and a rectangular H glyph, made
for this repository with fontTools 4.65.0. It is distributed under the repository's
MIT license. It is intentionally required by App.tsx in both the native Release
build and OTA build. No platform font-registration step is needed for the byte
reuse assertion; the E2E verifies the actual packaged file, zero downloads, and
the installed target hash.

`builtin_reuse.png` is React Navigation Elements' `back-icon-mask.png`, preserved
byte-for-byte (SHA-256 `9adb8c5efca932e2b732b293da813bd2e31952263056bce9e2517fec0f0b6a76`).
Its MIT license is included in `builtin_reuse-image-license.txt`. The app-local
copy gives native and OTA builds the same logical path even when E2E shards
share another checkout's node_modules. It uses stock native packaging; no
AAPT optimization override or decode/re-encode is used to enable reuse.

`builtin_reuse_uncrunched.png` is a synthetic 64×64 RGB gradient made for this
repository, stored with zlib level 0 so that AAPT2's PNG crunch in Android
release builds re-encodes it (12,420 bytes before, a few hundred after). The
packaged bytes then differ from the OTA's, while the source is the same: the
E2E checks that the first OTA still reuses it instead of downloading it.
