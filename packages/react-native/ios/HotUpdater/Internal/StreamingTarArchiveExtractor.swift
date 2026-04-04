import Compression
import Foundation
import zlib

enum CompressedTarAlgorithm {
    case gzip
    case brotli
}

enum StreamingTarArchiveExtractor {
    private static let bufferSize = 64 * 1024
    private static let decompressionProgressWeight = 0.45

    static func extractCompressedTar(
        file: String,
        to destination: String,
        algorithm: CompressedTarAlgorithm,
        progressHandler: @escaping (Double) -> Void
    ) throws {
        try withTemporaryTarFile { temporaryTarURL in
            switch algorithm {
            case .gzip:
                try decompressGzipArchive(
                    from: file,
                    to: temporaryTarURL.path,
                    progressHandler: { progress in
                        progressHandler(progress * decompressionProgressWeight)
                    }
                )
            case .brotli:
                try decompressBrotliArchive(
                    from: file,
                    to: temporaryTarURL.path,
                    progressHandler: { progress in
                        progressHandler(progress * decompressionProgressWeight)
                    }
                )
            }

            try extractTarArchive(
                from: temporaryTarURL.path,
                to: destination,
                progressHandler: { progress in
                    let extractionStart = decompressionProgressWeight
                    let extractionWeight = 1.0 - decompressionProgressWeight
                    progressHandler(extractionStart + (progress * extractionWeight))
                }
            )
        }
    }

    static func containsTarEntries(file: String, algorithm: CompressedTarAlgorithm) -> Bool {
        do {
            return try withTemporaryTarFile { temporaryTarURL in
                switch algorithm {
                case .gzip:
                    try decompressGzipArchive(
                        from: file,
                        to: temporaryTarURL.path,
                        progressHandler: { _ in }
                    )
                case .brotli:
                    try decompressBrotliArchive(
                        from: file,
                        to: temporaryTarURL.path,
                        progressHandler: { _ in }
                    )
                }

                return try tarArchiveHasEntries(at: temporaryTarURL.path)
            }
        } catch {
            NSLog("[TarStreamExtractor] Validation failed: \(error.localizedDescription)")
            return false
        }
    }

    private static func withTemporaryTarFile<T>(
        perform: (URL) throws -> T
    ) throws -> T {
        let temporaryTarURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("hot-updater-\(UUID().uuidString)")
            .appendingPathExtension("tar")

        defer {
            try? FileManager.default.removeItem(at: temporaryTarURL)
        }

        return try perform(temporaryTarURL)
    }

    private static func tarArchiveHasEntries(at tarPath: String) throws -> Bool {
        try TarArchiveExtractor.containsEntries(at: tarPath)
    }

    private static func extractTarArchive(
        from tarPath: String,
        to destination: String,
        progressHandler: @escaping (Double) -> Void
    ) throws {
        try TarArchiveExtractor.extract(
            from: tarPath,
            to: destination,
            progressHandler: progressHandler
        )
    }

    private static func decompressGzipArchive(
        from sourcePath: String,
        to outputPath: String,
        progressHandler: @escaping (Double) -> Void
    ) throws {
        let totalSourceSize = try fileSize(atPath: sourcePath)
        try prepareEmptyFile(at: outputPath)

        let outputHandle = try FileHandle(forWritingTo: URL(fileURLWithPath: outputPath))

        defer {
            try? outputHandle.close()
        }

        guard let gzipFile = sourcePath.withCString({ pathPointer in
            "rb".withCString { modePointer in
                gzopen(pathPointer, modePointer)
            }
        }) else {
            throw NSError(
                domain: "StreamingTarArchiveExtractor",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "Failed to open gzip archive"]
            )
        }

        defer {
            gzclose(gzipFile)
        }

        var buffer = [UInt8](repeating: 0, count: bufferSize)

        while true {
            let bytesRead = gzread(gzipFile, &buffer, UInt32(buffer.count))

            if bytesRead > 0 {
                outputHandle.write(Data(buffer[0..<Int(bytesRead)]))

                if totalSourceSize > 0 {
                    let compressedOffset = max(Int64(gzoffset(gzipFile)), 0)
                    let progress = min(Double(compressedOffset) / Double(totalSourceSize), 1.0)
                    progressHandler(progress)
                }

                continue
            }

            if bytesRead == 0 {
                progressHandler(1.0)
                return
            }

            var errorCode: Int32 = 0
            let messagePointer = gzerror(gzipFile, &errorCode)
            let message = messagePointer.map { String(cString: $0) } ?? "Unknown gzip error"

            throw NSError(
                domain: "StreamingTarArchiveExtractor",
                code: Int(errorCode),
                userInfo: [NSLocalizedDescriptionKey: "GZIP decompression failed: \(message)"]
            )
        }
    }

    private static func decompressBrotliArchive(
        from sourcePath: String,
        to outputPath: String,
        progressHandler: @escaping (Double) -> Void
    ) throws {
        let totalSourceSize = try fileSize(atPath: sourcePath)
        try prepareEmptyFile(at: outputPath)

        let inputHandle = try FileHandle(forReadingFrom: URL(fileURLWithPath: sourcePath))
        let outputHandle = try FileHandle(forWritingTo: URL(fileURLWithPath: outputPath))

        defer {
            try? inputHandle.close()
            try? outputHandle.close()
        }

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
                domain: "StreamingTarArchiveExtractor",
                code: 6,
                userInfo: [NSLocalizedDescriptionKey: "Failed to initialize Brotli decompression stream"]
            )
        }

        defer {
            compression_stream_destroy(&stream)
        }

        let outputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)

        defer {
            outputBuffer.deallocate()
        }

        var processedSourceBytes: UInt64 = 0
        var reachedStreamEnd = false

        while !reachedStreamEnd {
            let chunk = try ArchiveExtractionUtilities.readUpToCount(
                from: inputHandle,
                count: bufferSize
            ) ?? Data()
            processedSourceBytes += UInt64(chunk.count)

            let streamStatus: compression_status
            if chunk.isEmpty {
                stream.src_ptr = UnsafePointer<UInt8>(bitPattern: 1)!
                stream.src_size = 0
                streamStatus = try flushCompressionStream(
                    &stream,
                    into: outputHandle,
                    outputBuffer: outputBuffer,
                    finalize: true
                )
            } else {
                streamStatus = try chunk.withUnsafeBytes { rawBuffer in
                    guard let baseAddress = rawBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                        return COMPRESSION_STATUS_OK
                    }

                    stream.src_ptr = baseAddress
                    stream.src_size = chunk.count

                    return try flushCompressionStream(
                        &stream,
                        into: outputHandle,
                        outputBuffer: outputBuffer,
                        finalize: false
                    )
                }
            }

            if totalSourceSize > 0 {
                let progress = min(Double(processedSourceBytes) / Double(totalSourceSize), 1.0)
                progressHandler(progress)
            }

            if streamStatus == COMPRESSION_STATUS_END {
                reachedStreamEnd = true
            } else if chunk.isEmpty {
                throw NSError(
                    domain: "StreamingTarArchiveExtractor",
                    code: 7,
                    userInfo: [NSLocalizedDescriptionKey: "Brotli decompression ended before reaching the end of stream"]
                )
            }
        }

        progressHandler(1.0)
    }

    private static func flushCompressionStream(
        _ stream: inout compression_stream,
        into outputHandle: FileHandle,
        outputBuffer: UnsafeMutablePointer<UInt8>,
        finalize: Bool
    ) throws -> compression_status {
        let flags = finalize ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
        var lastStatus = COMPRESSION_STATUS_OK

        repeat {
            let previousSourceSize = stream.src_size

            stream.dst_ptr = outputBuffer
            stream.dst_size = bufferSize

            lastStatus = compression_stream_process(&stream, flags)

            switch lastStatus {
            case COMPRESSION_STATUS_OK, COMPRESSION_STATUS_END:
                let producedBytes = bufferSize - stream.dst_size
                if producedBytes > 0 {
                    outputHandle.write(
                        Data(bytes: outputBuffer, count: producedBytes)
                    )
                }

                if finalize,
                   lastStatus == COMPRESSION_STATUS_OK,
                   producedBytes == 0,
                   previousSourceSize == stream.src_size {
                    throw NSError(
                        domain: "StreamingTarArchiveExtractor",
                        code: 8,
                        userInfo: [NSLocalizedDescriptionKey: "Brotli decompression stalled before reaching the end of stream"]
                    )
                }

            default:
                throw NSError(
                    domain: "StreamingTarArchiveExtractor",
                    code: 9,
                    userInfo: [NSLocalizedDescriptionKey: "Brotli decompression failed"]
                )
            }
        } while stream.src_size > 0 || stream.dst_size == 0 || (finalize && lastStatus == COMPRESSION_STATUS_OK)

        return lastStatus
    }

    private static func prepareEmptyFile(at path: String) throws {
        let fileManager = FileManager.default
        let parentDirectory = (path as NSString).deletingLastPathComponent

        if !fileManager.fileExists(atPath: parentDirectory) {
            try fileManager.createDirectory(
                atPath: parentDirectory,
                withIntermediateDirectories: true,
                attributes: nil
            )
        }

        if fileManager.fileExists(atPath: path) {
            try fileManager.removeItem(atPath: path)
        }

        guard fileManager.createFile(atPath: path, contents: nil) else {
            throw NSError(
                domain: "StreamingTarArchiveExtractor",
                code: 10,
                userInfo: [NSLocalizedDescriptionKey: "Failed to create temporary archive file"]
            )
        }
    }

    private static func fileSize(atPath path: String) throws -> UInt64 {
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        if let value = attributes[.size] as? NSNumber {
            return value.uint64Value
        }

        if let value = attributes[.size] as? UInt64 {
            return value
        }

        return 0
    }

}
