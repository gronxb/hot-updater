import Foundation
import SWCompression
import Compression

/**
 * UnzipService implementation for tar+brotli compressed files.
 * Uses Apple's native Compression framework for brotli decompression
 * and SWCompression for tar extraction.
 * Requires iOS 11.0 or later for native brotli support.
 */
class TarBrotliUnzipService: UnzipService {

    /**
     * Unzips a tar.br file to a destination directory.
     * @param file Path to the tar.br file
     * @param destination Directory to extract to
     * @throws Error if unzipping fails or path traversal is detected
     */
    func unzip(file: String, to destination: String) throws {
        NSLog("[TarBrotliUnzipService] Starting extraction of \(file) to \(destination)")

        // Read the compressed file
        guard let compressedData = try? Data(contentsOf: URL(fileURLWithPath: file)) else {
            throw NSError(
                domain: "TarBrotliUnzipService",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to read tar.br file at: \(file)"]
            )
        }

        // Decompress brotli using native Compression framework
        let decompressedData: Data
        do {
            decompressedData = try decompressBrotli(compressedData)
            NSLog("[TarBrotliUnzipService] Brotli decompression successful, size: \(decompressedData.count) bytes")
        } catch {
            throw NSError(
                domain: "TarBrotliUnzipService",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Brotli decompression failed: \(error.localizedDescription)"]
            )
        }

        // Extract tar entries
        let tarEntries: [TarEntry]
        do {
            tarEntries = try TarContainer.open(container: decompressedData)
            NSLog("[TarBrotliUnzipService] Tar extraction successful, found \(tarEntries.count) entries")
        } catch {
            throw NSError(
                domain: "TarBrotliUnzipService",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Tar extraction failed: \(error.localizedDescription)"]
            )
        }

        // Get canonical destination path for security checks
        let destinationURL = URL(fileURLWithPath: destination)
        let canonicalDestination = destinationURL.standardized.path

        // Create destination directory if it doesn't exist
        let fileManager = FileManager.default
        if !fileManager.fileExists(atPath: canonicalDestination) {
            try fileManager.createDirectory(
                atPath: canonicalDestination,
                withIntermediateDirectories: true,
                attributes: nil
            )
        }

        // Extract each entry
        for entry in tarEntries {
            try extractTarEntry(entry, to: canonicalDestination)
        }

        NSLog("[TarBrotliUnzipService] Successfully extracted all entries")
    }

    /**
     * Decompresses brotli-compressed data using Apple's native Compression framework.
     * Uses streaming decompression for memory efficiency with large files.
     * @param data The brotli-compressed data
     * @return The decompressed data
     * @throws Error if decompression fails
     */
    private func decompressBrotli(_ data: Data) throws -> Data {
        let bufferSize = 64 * 1024 // 64KB buffer for streaming

        var decompressedData = Data()
        var index = 0
        let count = data.count

        // Create decompression stream
        var stream = data.withUnsafeBytes { (rawBufferPointer: UnsafeRawBufferPointer) -> compression_stream in
            var streamPtr = compression_stream()
            compression_stream_init(&streamPtr, COMPRESSION_STREAM_DECODE, COMPRESSION_BROTLI)
            return streamPtr
        }
        defer {
            compression_stream_destroy(&stream)
        }

        // Allocate output buffer
        let outputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer {
            outputBuffer.deallocate()
        }

        // Process data in chunks
        data.withUnsafeBytes { (rawBufferPointer: UnsafeRawBufferPointer) in
            guard let baseAddress = rawBufferPointer.baseAddress else {
                return
            }

            stream.src_ptr = baseAddress.assumingMemoryBound(to: UInt8.self)
            stream.src_size = count

            var status: compression_status
            repeat {
                stream.dst_ptr = outputBuffer
                stream.dst_size = bufferSize

                status = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE))

                switch status {
                case COMPRESSION_STATUS_OK, COMPRESSION_STATUS_END:
                    let outputSize = bufferSize - stream.dst_size
                    decompressedData.append(outputBuffer, count: outputSize)

                case COMPRESSION_STATUS_ERROR:
                    break

                default:
                    break
                }
            } while status == COMPRESSION_STATUS_OK
        }

        // Check if decompression was successful
        if decompressedData.isEmpty && !data.isEmpty {
            throw NSError(
                domain: "TarBrotliUnzipService",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "Brotli decompression produced no output"]
            )
        }

        return decompressedData
    }

    /**
     * Extracts a single tar entry to the destination directory.
     * Includes path traversal protection.
     * @param entry The tar entry to extract
     * @param destination The destination directory (must be canonical path)
     * @throws Error if extraction fails or path traversal is detected
     */
    private func extractTarEntry(_ entry: TarEntry, to destination: String) throws {
        // Get entry info
        guard let entryInfo = entry.info else {
            NSLog("[TarBrotliUnzipService] Skipping entry with no info")
            return
        }

        let entryName = entryInfo.name

        // Skip entries that are just markers (e.g., "./" or empty)
        if entryName.isEmpty || entryName == "./" || entryName == "." {
            return
        }

        // Construct target path
        let targetURL = URL(fileURLWithPath: destination).appendingPathComponent(entryName)
        let targetPath = targetURL.standardized.path

        // Path traversal protection: ensure target is within destination
        if !targetPath.hasPrefix(destination) {
            throw NSError(
                domain: "TarBrotliUnzipService",
                code: 4,
                userInfo: [
                    NSLocalizedDescriptionKey: "Path traversal detected",
                    "entry": entryName,
                    "targetPath": targetPath,
                    "destination": destination
                ]
            )
        }

        let fileManager = FileManager.default

        // Handle different entry types
        switch entryInfo.type {
        case .directory:
            // Create directory
            if !fileManager.fileExists(atPath: targetPath) {
                try fileManager.createDirectory(
                    atPath: targetPath,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
            }
            NSLog("[TarBrotliUnzipService] Created directory: \(entryName)")

        case .regular, .normal:
            // Create parent directory if needed
            let parentPath = targetURL.deletingLastPathComponent().path
            if !fileManager.fileExists(atPath: parentPath) {
                try fileManager.createDirectory(
                    atPath: parentPath,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
            }

            // Write file data
            if let data = entry.data {
                try data.write(to: targetURL, options: .atomic)
                NSLog("[TarBrotliUnzipService] Extracted file: \(entryName) (\(data.count) bytes)")
            } else {
                NSLog("[TarBrotliUnzipService] Warning: No data for file entry: \(entryName)")
            }

        case .symbolicLink:
            // Skip symbolic links for security
            NSLog("[TarBrotliUnzipService] Skipping symbolic link: \(entryName)")

        default:
            // Skip other types (block devices, character devices, fifos, etc.)
            NSLog("[TarBrotliUnzipService] Skipping unsupported entry type: \(entryName)")
        }
    }
}
