package com.hotupdater

import android.util.Log

/**
 * Factory for creating the appropriate UnzipService based on content encoding
 */
object UnzipServiceFactory {
    private const val TAG = "UnzipServiceFactory"

    /**
     * Creates an UnzipService based on the content encoding header
     * @param contentEncoding The Content-Encoding header from HTTP response (e.g., "br", null)
     * @return Appropriate UnzipService implementation
     */
    fun createUnzipService(contentEncoding: String?): UnzipService =
        when (contentEncoding?.lowercase()) {
            "br" -> {
                Log.d(TAG, "Using TarBrotliUnzipService for Content-Encoding: br")
                TarBrotliUnzipService()
            }
            null, "" -> {
                Log.d(TAG, "Using ZipFileUnzipService (default, no Content-Encoding)")
                ZipFileUnzipService()
            }
            else -> {
                Log.w(TAG, "Unknown Content-Encoding: $contentEncoding, falling back to ZipFileUnzipService")
                ZipFileUnzipService()
            }
        }
}
