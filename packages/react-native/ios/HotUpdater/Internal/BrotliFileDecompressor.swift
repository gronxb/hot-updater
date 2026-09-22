import Compression
import Foundation

enum BrotliFileDecompressor {
    private static let bufferSize = 64 * 1024

    static func decompress(
        from sourcePath: String,
        to outputPath: String,
        expectedOutputByteSize: Int64? = nil
    ) throws {
        if let expectedOutputByteSize, expectedOutputByteSize < 0 {
            throw error(6, "Invalid expected Brotli output size")
        }
        let fileManager = FileManager.default
        let parentDirectory = (outputPath as NSString).deletingLastPathComponent
        try fileManager.createDirectory(
            atPath: parentDirectory,
            withIntermediateDirectories: true
        )
        if fileManager.fileExists(atPath: outputPath) {
            try fileManager.removeItem(atPath: outputPath)
        }
        guard fileManager.createFile(atPath: outputPath, contents: nil) else {
            throw error(1, "Failed to create Brotli output file")
        }

        let input = try FileHandle(forReadingFrom: URL(fileURLWithPath: sourcePath))
        let output = try FileHandle(forWritingTo: URL(fileURLWithPath: outputPath))
        defer {
            try? input.close()
            try? output.close()
        }

        var stream = compression_stream(
            dst_ptr: UnsafeMutablePointer<UInt8>(bitPattern: 1)!,
            dst_size: 0,
            src_ptr: UnsafePointer<UInt8>(bitPattern: 1)!,
            src_size: 0,
            state: nil
        )
        guard compression_stream_init(
            &stream,
            COMPRESSION_STREAM_DECODE,
            COMPRESSION_BROTLI
        ) == COMPRESSION_STATUS_OK else {
            throw error(2, "Failed to initialize Brotli decompression")
        }
        defer { compression_stream_destroy(&stream) }

        let outputBuffer = UnsafeMutablePointer<UInt8>.allocate(
            capacity: bufferSize
        )
        defer { outputBuffer.deallocate() }

        var reachedEnd = false
        var totalOutputByteSize: UInt64 = 0
        let maximumOutputByteSize = expectedOutputByteSize.map(UInt64.init)
        while !reachedEnd {
            let chunk = try FileUtilities.readUpToCount(
                from: input,
                count: bufferSize
            ) ?? Data()
            let status: compression_status
            if chunk.isEmpty {
                stream.src_ptr = UnsafePointer<UInt8>(bitPattern: 1)!
                stream.src_size = 0
                status = try process(
                    &stream,
                    output: output,
                    outputBuffer: outputBuffer,
                    finalize: true,
                    totalOutputByteSize: &totalOutputByteSize,
                    maximumOutputByteSize: maximumOutputByteSize
                )
            } else {
                status = try chunk.withUnsafeBytes { bytes in
                    guard let source = bytes.baseAddress?
                        .assumingMemoryBound(to: UInt8.self) else {
                        return COMPRESSION_STATUS_OK
                    }
                    stream.src_ptr = source
                    stream.src_size = chunk.count
                    return try process(
                        &stream,
                        output: output,
                        outputBuffer: outputBuffer,
                        finalize: false,
                        totalOutputByteSize: &totalOutputByteSize,
                        maximumOutputByteSize: maximumOutputByteSize
                    )
                }
            }

            if status == COMPRESSION_STATUS_END {
                guard stream.src_size == 0 else {
                    throw error(7, "Brotli stream contains trailing compressed bytes")
                }
                let trailing = try FileUtilities.readUpToCount(from: input, count: 1)
                guard trailing?.isEmpty != false else {
                    throw error(7, "Brotli stream contains trailing compressed bytes")
                }
                reachedEnd = true
            } else if chunk.isEmpty {
                throw error(3, "Brotli input ended before the stream completed")
            }
        }

        if let maximumOutputByteSize,
           totalOutputByteSize != maximumOutputByteSize {
            throw error(
                8,
                "Brotli output size mismatch: expected \(maximumOutputByteSize), got \(totalOutputByteSize)"
            )
        }
    }

    private static func process(
        _ stream: inout compression_stream,
        output: FileHandle,
        outputBuffer: UnsafeMutablePointer<UInt8>,
        finalize: Bool,
        totalOutputByteSize: inout UInt64,
        maximumOutputByteSize: UInt64?
    ) throws -> compression_status {
        let flags = finalize ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
        var status = COMPRESSION_STATUS_OK
        repeat {
            let previousSourceSize = stream.src_size
            stream.dst_ptr = outputBuffer
            stream.dst_size = bufferSize
            status = compression_stream_process(&stream, flags)

            guard status == COMPRESSION_STATUS_OK ||
                    status == COMPRESSION_STATUS_END else {
                throw error(4, "Brotli decompression failed")
            }
            let produced = bufferSize - stream.dst_size
            if produced > 0 {
                let (nextOutputByteSize, overflowed) = totalOutputByteSize
                    .addingReportingOverflow(UInt64(produced))
                guard !overflowed,
                      maximumOutputByteSize.map({ nextOutputByteSize <= $0 }) ?? true else {
                    throw error(6, "Brotli output exceeds expected size")
                }
                output.write(Data(bytes: outputBuffer, count: produced))
                totalOutputByteSize = nextOutputByteSize
            }
            if finalize,
               status == COMPRESSION_STATUS_OK,
               produced == 0,
               previousSourceSize == stream.src_size {
                throw error(5, "Brotli decompression stalled")
            }
        } while stream.src_size > 0 || stream.dst_size == 0 ||
            (finalize && status == COMPRESSION_STATUS_OK)
        return status
    }

    private static func error(_ code: Int, _ message: String) -> NSError {
        NSError(
            domain: "BrotliFileDecompressor",
            code: code,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }
}
