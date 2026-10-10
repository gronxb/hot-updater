package com.hotupdater.lynx.internal

internal object ArchiveLimits {
    const val MAX_ARCHIVE_BYTES = 128L * 1024 * 1024
    const val MAX_EXTRACTED_BYTES = 512L * 1024 * 1024
    const val MAX_TAR_STREAM_BYTES = 567_581_936L
    const val MAX_FILE_BYTES = 128L * 1024 * 1024
    const val MAX_ENTRIES = 10000
    const val MAX_METADATA_BYTES = 1024L * 1024
    const val MAX_PATH_BYTES = 1024
}
