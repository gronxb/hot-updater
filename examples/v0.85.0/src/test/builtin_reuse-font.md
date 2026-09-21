`builtin_reuse.ttf` is an original, minimal TrueType fixture for builtin-to-OTA
byte reuse. It contains only `.notdef`, space, and a rectangular H glyph, made
for this repository with fontTools 4.65.0. It is distributed under the repository's
MIT license. It is intentionally required by App.tsx in both the native Release
build and OTA build. No platform font-registration step is needed for the byte
reuse assertion; the E2E verifies the actual packaged file, zero downloads, and
the installed target hash.
