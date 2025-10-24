import Foundation
import SWCompression
import Compression

/**
 * UnzipService implementation for tar+brotli compressed files.
 * Uses Apple's native Compression framework for brotli decompression
 * and SWCompression for tar extraction.
 * Requires iOS 11.0 or later for native brotli support.
 */
class TarBrUnzipService: UnzipService {
    private static let MIN_FILE_SIZE: UInt64 = 10

    func isValidZipFile(atPath: String) -> Bool {
        // Check if file exists
        guard FileManager.default.fileExists(atPath: atPath) else {
            NSLog("[TarBrUnzipService] Invalid file: doesn't exist")
            return false
        }

        // Check file size
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: atPath)
            guard let fileSize = attributes[.size] as? UInt64, fileSize >= Self.MIN_FILE_SIZE else {
                NSLog("[TarBrUnzipService] Invalid file: too small")
                return false
            }
        } catch {
            NSLog("[TarBrUnzipService] Invalid file: cannot read attributes - \(error.localizedDescription)")
            return false
        }

        // For tar.br files, we can validate by attempting to decompress a small portion
        guard let compressedData = try? Data(contentsOf: URL(fileURLWithPath: atPath)) else {
            NSLog("[TarBrUnzipService] Invalid file: cannot read file")
            return false
        }

        // Attempt to decompress a small portion to validate
        do {
            let testData = compressedData.prefix(1024)
            _ = try decompressBrotli(testData)
            return true
        } catch {
            // If decompression fails, it's likely not a valid Brotli file
            NSLog("[TarBrUnzipService] Invalid file: not a valid Brotli compressed file")
            return false
        }
    }

    func unzip(file: String, to destination: String) throws {
        try unzip(file: file, to: destination, progressHandler: { _ in })
    }

    func unzip(file: String, to destination: String, progressHandler: @escaping (Double) -> Void) throws {
        NSLog("[TarBrUnzipService] Starting extraction of \(file) to \(destination)")

        // Read the compressed file
        guard let compressedData = try? Data(contentsOf: URL(fileURLWithPath: file)) else {
            throw NSError(
                domain: "TarBrUnzipService",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to read tar.br file at: \(file)"]
            )
        }

        // Decompress brotli using native Compression framework
        progressHandler(0.3)
        let decompressedData: Data
        do {
            decompressedData = try decompressBrotli(compressedData)
            NSLog("[TarBrUnzipService] Brotli decompression successful, size: \(decompressedData.count) bytes")
            progressHandler(0.6)
        } catch {
            throw NSError(
                domain: "TarBrUnzipService",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Brotli decompression failed: \(error.localizedDescription)"]
            )
        }

        // Extract tar entries
        let tarEntries: [TarEntry]
        do {
            tarEntries = try TarContainer.open(container: decompressedData)
            NSLog("[TarBrUnzipService] Tar extraction successful, found \(tarEntries.count) entries")
        } catch {
            throw NSError(
                domain: "TarBrUnzipService",
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
        let totalEntries = Double(tarEntries.count)
        for (index, entry) in tarEntries.enumerated() {
            try extractTarEntry(entry, to: canonicalDestination)
            // Map extract progress from 0.6 to 1.0
            progressHandler(0.6 + (Double(index + 1) / totalEntries * 0.4))
        }

        NSLog("[TarBrUnzipService] Successfully extracted all entries")
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
        let count = data.count

        // Create and zero-initialize compression stream
        // Use bitPattern initializer to create null pointers for initialization
        var stream = compression_stream(
            dst_ptr: UnsafeMutablePointer<UInt8>(bitPattern: 0)!,
            dst_size: 0,
            src_ptr: UnsafePointer<UInt8>(bitPattern: 0)!,
            src_size: 0,
            state: nil
        )

        let status = compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_BROTLI)

        guard status == COMPRESSION_STATUS_OK else {
            throw NSError(
                domain: "TarBrUnzipService",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "Failed to initialize brotli decompression stream"]
            )
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

            var processStatus: compression_status
            repeat {
                stream.dst_ptr = outputBuffer
                stream.dst_size = bufferSize

                processStatus = compression_stream_process(&stream, Int32(bitPattern: COMPRESSION_STREAM_FINALIZE.rawValue))

                switch processStatus {
                case COMPRESSION_STATUS_OK, COMPRESSION_STATUS_END:
                    let outputSize = bufferSize - stream.dst_size
                    decompressedData.append(outputBuffer, count: outputSize)

                case COMPRESSION_STATUS_ERROR:
                    break

                default:
                    break
                }
            } while processStatus == COMPRESSION_STATUS_OK
        }

        // Check if decompression was successful
        if decompressedData.isEmpty && !data.isEmpty {
            throw NSError(
                domain: "TarBrUnzipService",
                code: 6,
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
        let entryInfo = entry.info
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
                domain: "TarBrUnzipService",
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
            NSLog("[TarBrUnzipService] Created directory: \(entryName)")

        case .regular:
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
                NSLog("[TarBrUnzipService] Extracted file: \(entryName) (\(data.count) bytes)")
            } else {
                NSLog("[TarBrUnzipService] Warning: No data for file entry: \(entryName)")
            }

        case .symbolicLink:
            // Skip symbolic links for security
            NSLog("[TarBrUnzipService] Skipping symbolic link: \(entryName)")

        default:
            // Skip other types (block devices, character devices, fifos, etc.)
            NSLog("[TarBrUnzipService] Skipping unsupported entry type: \(entryName)")
        }
    }
}
