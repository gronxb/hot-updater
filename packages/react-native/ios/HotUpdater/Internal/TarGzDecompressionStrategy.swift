import Foundation
import SWCompression
import Compression

/**
 * Strategy for handling TAR+GZIP compressed files
 */
class TarGzDecompressionStrategy: DecompressionStrategy {
    private static let MIN_FILE_SIZE: UInt64 = 10

    func isValid(file: String) -> Bool {
        guard FileManager.default.fileExists(atPath: file) else {
            NSLog("[TarGzStrategy] Invalid file: doesn't exist")
            return false
        }

        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: file)
            guard let fileSize = attributes[.size] as? UInt64, fileSize >= Self.MIN_FILE_SIZE else {
                NSLog("[TarGzStrategy] Invalid file: too small")
                return false
            }
        } catch {
            NSLog("[TarGzStrategy] Invalid file: cannot read attributes - \(error.localizedDescription)")
            return false
        }

        guard let compressedData = try? Data(contentsOf: URL(fileURLWithPath: file)) else {
            NSLog("[TarGzStrategy] Invalid file: cannot read file")
            return false
        }

        do {
            let testData = compressedData.prefix(1024)
            _ = try decompressGzip(testData)
            return true
        } catch {
            NSLog("[TarGzStrategy] Invalid file: not a valid GZIP compressed file")
            return false
        }
    }

    func decompress(file: String, to destination: String, progressHandler: @escaping (Double) -> Void) throws {
        NSLog("[TarGzStrategy] Starting extraction of \(file) to \(destination)")

        guard let compressedData = try? Data(contentsOf: URL(fileURLWithPath: file)) else {
            throw NSError(
                domain: "TarGzDecompressionStrategy",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to read tar.gz file at: \(file)"]
            )
        }

        progressHandler(0.3)
        let decompressedData: Data
        do {
            decompressedData = try decompressGzip(compressedData)
            NSLog("[TarGzStrategy] GZIP decompression successful, size: \(decompressedData.count) bytes")
            progressHandler(0.6)
        } catch {
            throw NSError(
                domain: "TarGzDecompressionStrategy",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "GZIP decompression failed: \(error.localizedDescription)"]
            )
        }

        let tarEntries: [TarEntry]
        do {
            tarEntries = try TarContainer.open(container: decompressedData)
            NSLog("[TarGzStrategy] Tar extraction successful, found \(tarEntries.count) entries")
        } catch {
            throw NSError(
                domain: "TarGzDecompressionStrategy",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Tar extraction failed: \(error.localizedDescription)"]
            )
        }

        let destinationURL = URL(fileURLWithPath: destination)
        let canonicalDestination = destinationURL.standardized.path

        let fileManager = FileManager.default
        if !fileManager.fileExists(atPath: canonicalDestination) {
            try fileManager.createDirectory(
                atPath: canonicalDestination,
                withIntermediateDirectories: true,
                attributes: nil
            )
        }

        let totalEntries = Double(tarEntries.count)
        for (index, entry) in tarEntries.enumerated() {
            try extractTarEntry(entry, to: canonicalDestination)
            progressHandler(0.6 + (Double(index + 1) / totalEntries * 0.4))
        }

        NSLog("[TarGzStrategy] Successfully extracted all entries")
    }

    private func decompressGzip(_ data: Data) throws -> Data {
        let bufferSize = 64 * 1024
        var decompressedData = Data()
        let count = data.count

        var stream = compression_stream(
            dst_ptr: UnsafeMutablePointer<UInt8>(bitPattern: 1)!,
            dst_size: 0,
            src_ptr: UnsafePointer<UInt8>(bitPattern: 1)!,
            src_size: 0,
            state: nil
        )

        let status = compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB)

        guard status == COMPRESSION_STATUS_OK else {
            throw NSError(
                domain: "TarGzDecompressionStrategy",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "Failed to initialize gzip decompression stream"]
            )
        }

        defer {
            compression_stream_destroy(&stream)
        }

        let outputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer {
            outputBuffer.deallocate()
        }

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

                processStatus = compression_stream_process(&stream, 0)

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

        if decompressedData.isEmpty && !data.isEmpty {
            throw NSError(
                domain: "TarGzDecompressionStrategy",
                code: 6,
                userInfo: [NSLocalizedDescriptionKey: "GZIP decompression produced no output"]
            )
        }

        return decompressedData
    }

    private func extractTarEntry(_ entry: TarEntry, to destination: String) throws {
        let fileManager = FileManager.default
        let entryPath = entry.info.name.trimmingCharacters(in: .init(charactersIn: "/"))

        guard !entryPath.isEmpty,
              !entryPath.contains(".."),
              !entryPath.hasPrefix("/") else {
            NSLog("[TarGzStrategy] Skipping suspicious path: \(entry.info.name)")
            return
        }

        let fullPath = (destination as NSString).appendingPathComponent(entryPath)
        let fullURL = URL(fileURLWithPath: fullPath)
        let canonicalFullPath = fullURL.standardized.path
        let canonicalDestination = URL(fileURLWithPath: destination).standardized.path

        guard canonicalFullPath.hasPrefix(canonicalDestination + "/") ||
              canonicalFullPath == canonicalDestination else {
            throw NSError(
                domain: "TarGzDecompressionStrategy",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "Path traversal attempt detected: \(entry.info.name)"]
            )
        }

        if entry.info.type == .directory {
            if !fileManager.fileExists(atPath: canonicalFullPath) {
                try fileManager.createDirectory(
                    atPath: canonicalFullPath,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
            }
            return
        }

        if entry.info.type == .regular {
            let parentPath = (canonicalFullPath as NSString).deletingLastPathComponent
            if !fileManager.fileExists(atPath: parentPath) {
                try fileManager.createDirectory(
                    atPath: parentPath,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
            }

            guard let data = entry.data else {
                NSLog("[TarGzStrategy] Skipping file with no data: \(entry.info.name)")
                return
            }

            try data.write(to: URL(fileURLWithPath: canonicalFullPath))
            NSLog("[TarGzStrategy] Extracted: \(entryPath)")
        }
    }
}
