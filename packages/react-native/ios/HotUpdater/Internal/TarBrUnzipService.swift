import Foundation
import Brotli

class TarBrUnzipService: UnzipService {
    private static let TAR_BR_HEADER: [UInt8] = [0x1F, 0x8B] // Brotli magic number
    private static let MIN_FILE_SIZE: UInt64 = 10

    func isValidZipFile(atPath: String) -> Bool {
        let fileURL = URL(fileURLWithPath: atPath)

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

        // For tar.br files, we can validate by attempting to read the header
        // Brotli-compressed files don't have a fixed magic number like ZIP
        // So we'll try to decompress a small portion
        guard let fileHandle = FileHandle(forReadingAtPath: atPath) else {
            NSLog("[TarBrUnzipService] Invalid file: cannot open file")
            return false
        }

        defer {
            fileHandle.closeFile()
        }

        let header = fileHandle.readData(ofLength: 100)
        guard header.count >= 10 else {
            NSLog("[TarBrUnzipService] Invalid file: cannot read header")
            return false
        }

        // Attempt to decompress a small portion to validate
        do {
            let testData = header.prefix(100)
            _ = try testData.brotliDecompressed()
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
        let fileURL = URL(fileURLWithPath: file)
        let destinationURL = URL(fileURLWithPath: destination)

        // Read the compressed file
        let compressedData = try Data(contentsOf: fileURL)

        // Decompress with Brotli
        progressHandler(0.3)
        let decompressedData = try compressedData.brotliDecompressed()
        progressHandler(0.6)

        // Extract tar archive
        try extractTar(data: decompressedData, to: destinationURL, progressHandler: { extractProgress in
            // Map extract progress from 0.6 to 1.0
            progressHandler(0.6 + (extractProgress * 0.4))
        })

        NSLog("[TarBrUnzipService] Successfully extracted tar.br file")
    }

    private func extractTar(data: Data, to destination: URL, progressHandler: @escaping (Double) -> Void) throws {
        // Create destination directory
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)

        // Parse TAR format
        var offset = 0
        var processedBytes = 0
        let totalBytes = data.count

        while offset < data.count {
            // TAR header is 512 bytes
            guard offset + 512 <= data.count else {
                break
            }

            let headerData = data.subdata(in: offset..<offset + 512)

            // Check for empty block (end of archive)
            if headerData.allSatisfy({ $0 == 0 }) {
                break
            }

            // Parse header
            guard let header = try? parseTarHeader(headerData, baseOffset: offset) else {
                throw NSError(
                    domain: "TarBrUnzipService",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Failed to parse TAR header"]
                )
            }

            offset += 512

            // Extract file/directory
            if header.isDirectory {
                let dirURL = destination.appendingPathComponent(header.name)
                try FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
            } else {
                let fileURL = destination.appendingPathComponent(header.name)

                // Validate path to prevent directory traversal
                guard fileURL.path.starts(with: destination.path) else {
                    NSLog("[TarBrUnzipService] Skipping potentially malicious entry: \(header.name)")
                    offset += header.size
                    continue
                }

                // Create parent directories
                try FileManager.default.createDirectory(
                    at: fileURL.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )

                // Write file data
                let fileData = data.subdata(in: offset..<min(offset + header.size, data.count))
                try fileData.write(to: fileURL)
            }

            // Move offset by file size (rounded up to 512 bytes)
            let paddedSize = ((header.size + 511) / 512) * 512
            offset += paddedSize

            // Update progress
            processedBytes += 512 + paddedSize
            progressHandler(Double(processedBytes) / Double(totalBytes))
        }

        progressHandler(1.0)
    }

    private struct TarHeader {
        let name: String
        let size: Int
        let isDirectory: Bool
    }

    private func parseTarHeader(_ data: Data, baseOffset: Int) throws -> TarHeader {
        // TAR header format (POSIX ustar)
        // 0-99: filename
        // 100-107: file mode
        // 108-115: owner user ID
        // 116-123: owner group ID
        // 124-135: file size in octal
        // 136-147: last modification time
        // 148-155: checksum
        // 156: link indicator (file type)
        // 157-256: link name
        // 257-262: ustar indicator
        // ... (rest of header)

        // Extract filename (0-99)
        let nameData = data.subdata(in: 0..<100)
        guard let name = String(data: nameData, encoding: .utf8)?.trimmingCharacters(in: CharacterSet(charactersIn: "\0")) else {
            throw NSError(
                domain: "TarBrUnzipService",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Failed to parse filename"]
            )
        }

        // Extract file size (124-135, octal string)
        let sizeData = data.subdata(in: 124..<136)
        guard let sizeString = String(data: sizeData, encoding: .utf8)?
            .trimmingCharacters(in: CharacterSet(charactersIn: " \0")) else {
            throw NSError(
                domain: "TarBrUnzipService",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "Failed to parse file size"]
            )
        }

        let size = Int(sizeString, radix: 8) ?? 0

        // Extract type flag (156)
        let typeFlagByte = data[156]
        let isDirectory = typeFlagByte == 0x35 // '5' = directory

        return TarHeader(name: name, size: size, isDirectory: isDirectory)
    }
}

// Extension for Brotli decompression
extension Data {
    func brotliDecompressed() throws -> Data {
        // Use Brotli library to decompress
        // This is a wrapper around the Brotli C library

        let inputBuffer = [UInt8](self)
        let maxOutputSize = self.count * 10 // Estimate decompressed size

        var outputBuffer = [UInt8](repeating: 0, count: maxOutputSize)
        var outputSize = maxOutputSize

        let result = inputBuffer.withUnsafeBytes { inputPtr in
            outputBuffer.withUnsafeMutableBytes { outputPtr in
                BrotliDecoderDecompress(
                    self.count,
                    inputPtr.baseAddress?.assumingMemoryBound(to: UInt8.self),
                    &outputSize,
                    outputPtr.baseAddress?.assumingMemoryBound(to: UInt8.self)
                )
            }
        }

        guard result == BROTLI_DECODER_RESULT_SUCCESS else {
            throw NSError(
                domain: "TarBrUnzipService",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Brotli decompression failed"]
            )
        }

        return Data(outputBuffer.prefix(outputSize))
    }
}
