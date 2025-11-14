import Foundation
import SWCompression
#if canImport(Compression)
import Compression
#endif

/**
 * Strategy for handling TAR+Brotli compressed files
 */
class TarBrDecompressionStrategy: DecompressionStrategy {
    private static let MIN_FILE_SIZE: UInt64 = 10

    func isValid(file: String) -> Bool {
        guard FileManager.default.fileExists(atPath: file) else {
            NSLog("[TarBrStrategy] Invalid file: doesn't exist")
            return false
        }

        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: file)
            guard let fileSize = attributes[.size] as? UInt64, fileSize >= Self.MIN_FILE_SIZE else {
                NSLog("[TarBrStrategy] Invalid file: too small")
                return false
            }
        } catch {
            NSLog("[TarBrStrategy] Invalid file: cannot read attributes - \(error.localizedDescription)")
            return false
        }

        // Brotli has no standard magic bytes, check file extension
        let lowercasedPath = file.lowercased()
        let isBrotli = lowercasedPath.hasSuffix(".tar.br") || lowercasedPath.hasSuffix(".br")

        if !isBrotli {
            NSLog("[TarBrStrategy] Invalid file: not a .tar.br or .br file")
        }

        return isBrotli
    }

    func decompress(file: String, to destination: String, progressHandler: @escaping (Double) -> Void) throws {
        NSLog("[TarBrStrategy] Starting extraction of \(file) to \(destination)")

        guard let compressedData = try? Data(contentsOf: URL(fileURLWithPath: file)) else {
            throw NSError(
                domain: "TarBrDecompressionStrategy",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to read tar.br file at: \(file)"]
            )
        }

        progressHandler(0.3)
        let decompressedData: Data
        do {
            decompressedData = try decompressBrotli(compressedData)
            NSLog("[TarBrStrategy] Brotli decompression successful, size: \(decompressedData.count) bytes")
            progressHandler(0.6)
        } catch {
            throw NSError(
                domain: "TarBrDecompressionStrategy",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Brotli decompression failed: \(error.localizedDescription)"]
            )
        }

        let tarEntries: [TarEntry]
        do {
            tarEntries = try TarContainer.open(container: decompressedData)
            NSLog("[TarBrStrategy] Tar extraction successful, found \(tarEntries.count) entries")
        } catch {
            throw NSError(
                domain: "TarBrDecompressionStrategy",
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

        NSLog("[TarBrStrategy] Successfully extracted all entries")
    }

    private func decompressBrotli(_ data: Data) throws -> Data {
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

        let status = compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_BROTLI)

        guard status == COMPRESSION_STATUS_OK else {
            throw NSError(
                domain: "TarBrDecompressionStrategy",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "Failed to initialize brotli decompression stream"]
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

                let flags = (stream.src_size == 0) ? Int32(bitPattern: COMPRESSION_STREAM_FINALIZE.rawValue) : Int32(0)
                processStatus = compression_stream_process(&stream, flags)

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
                domain: "TarBrDecompressionStrategy",
                code: 6,
                userInfo: [NSLocalizedDescriptionKey: "Brotli decompression produced no output"]
            )
        }

        return decompressedData
    }

    private func extractTarEntry(_ entry: TarEntry, to destination: String) throws {
        let entryInfo = entry.info
        let entryName = entryInfo.name

        if entryName.isEmpty || entryName == "./" || entryName == "." {
            return
        }

        let targetURL = URL(fileURLWithPath: destination).appendingPathComponent(entryName)
        let targetPath = targetURL.standardized.path

        if !targetPath.hasPrefix(destination) {
            throw NSError(
                domain: "TarBrDecompressionStrategy",
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

        switch entryInfo.type {
        case .directory:
            if !fileManager.fileExists(atPath: targetPath) {
                try fileManager.createDirectory(
                    atPath: targetPath,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
            }
            NSLog("[TarBrStrategy] Created directory: \(entryName)")

        case .regular:
            let parentPath = targetURL.deletingLastPathComponent().path
            if !fileManager.fileExists(atPath: parentPath) {
                try fileManager.createDirectory(
                    atPath: parentPath,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
            }

            if let data = entry.data {
                try data.write(to: targetURL, options: .atomic)
                NSLog("[TarBrStrategy] Extracted file: \(entryName) (\(data.count) bytes)")
            } else {
                NSLog("[TarBrStrategy] Warning: No data for file entry: \(entryName)")
            }

        case .symbolicLink:
            NSLog("[TarBrStrategy] Skipping symbolic link: \(entryName)")

        default:
            NSLog("[TarBrStrategy] Skipping unsupported entry type: \(entryName)")
        }
    }
}
