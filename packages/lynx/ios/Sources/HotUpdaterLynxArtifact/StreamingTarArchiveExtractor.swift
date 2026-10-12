import Compression
import Foundation

public enum StreamingTarArchiveExtractor {
    private static let bufferSize = 64 * 1024
    public static func decompressBrotliFile(
        from sourcePath: String,
        to outputPath: String,
        maximumOutputBytes: UInt64
    ) throws {
        try decompressBrotliArchive(
            from: sourcePath,
            to: outputPath,
            strict: true,
            maximumOutputBytes: maximumOutputBytes,
            progressHandler: { _ in }
        )
    }

    private static func decompressBrotliArchive(
        from sourcePath: String,
        to outputPath: String,
        strict: Bool = false,
        maximumOutputBytes: UInt64 = ArchiveLimits.tarStream,
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
                    finalize: true,
                    strict: strict,
                    maximumOutputBytes: maximumOutputBytes
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
                        finalize: false,
                        strict: strict,
                        maximumOutputBytes: maximumOutputBytes
                    )
                }
            }

            if totalSourceSize > 0 {
                let progress = min(Double(processedSourceBytes) / Double(totalSourceSize), 1.0)
                progressHandler(progress)
            }

            if streamStatus == COMPRESSION_STATUS_END {
                guard stream.src_size == 0,
                      try ArchiveExtractionUtilities.readUpToCount(from: inputHandle, count: 1)?.isEmpty != false else {
                    throw NSError(
                        domain: "StreamingTarArchiveExtractor",
                        code: 10,
                        userInfo: [NSLocalizedDescriptionKey: "Brotli stream contains trailing compressed bytes"]
                    )
                }
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
        finalize: Bool,
        strict: Bool = false,
        maximumOutputBytes: UInt64 = ArchiveLimits.tarStream
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
                    if strict { try ArchiveLimits.checkOutput(outputHandle, adding: producedBytes, maximumBytes: maximumOutputBytes) }
                    try outputHandle.write(contentsOf:
                        Data(bytes: outputBuffer, count: producedBytes)
                    )
                }

                if lastStatus == COMPRESSION_STATUS_END { return lastStatus }

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
