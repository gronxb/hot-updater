import Foundation
import SWCompression

class TarBrotliUnzipService: UnzipService {
    func isValidZipFile(atPath: String) -> Bool {
        let fileURL = URL(fileURLWithPath: atPath)

        // Check if file exists
        guard FileManager.default.fileExists(atPath: atPath) else {
            NSLog("[TarBrotliUnzipService] Invalid TAR.BR: file doesn't exist")
            return false
        }

        // Check file size
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: atPath)
            guard let fileSize = attributes[.size] as? UInt64, fileSize >= 10 else {
                NSLog("[TarBrotliUnzipService] Invalid TAR.BR: file too small")
                return false
            }
        } catch {
            NSLog("[TarBrotliUnzipService] Invalid TAR.BR: cannot read attributes - \(error.localizedDescription)")
            return false
        }

        // Try to decompress and read first TAR entry
        do {
            let compressedData = try Data(contentsOf: fileURL)
            let decompressedData = try BrotliArchive.unarchive(archive: compressedData)

            // Try to read first TAR entry
            _ = try TarContainer.open(container: decompressedData)
            return true
        } catch {
            NSLog("[TarBrotliUnzipService] Invalid TAR.BR: validation error - \(error.localizedDescription)")
            return false
        }
    }

    func unzip(file: String, to destination: String) throws {
        try unzip(file: file, to: destination, progressHandler: { _ in })
    }

    func unzip(file: String, to destination: String, progressHandler: @escaping (Double) -> Void) throws {
        let fileURL = URL(fileURLWithPath: file)
        let destinationURL = URL(fileURLWithPath: destination)

        NSLog("[TarBrotliUnzipService] Starting TAR.BR extraction")

        // 1) Read compressed file
        let compressedData = try Data(contentsOf: fileURL)
        NSLog("[TarBrotliUnzipService] Read compressed file: \(compressedData.count) bytes")

        // 2) Decompress with Brotli
        let decompressedData = try BrotliArchive.unarchive(archive: compressedData)
        NSLog("[TarBrotliUnzipService] Decompressed: \(decompressedData.count) bytes")

        // 3) Extract TAR entries
        let entries = try TarContainer.open(container: decompressedData)
        let totalEntries = entries.count
        NSLog("[TarBrotliUnzipService] Extracting \(totalEntries) entries")

        var extractedCount = 0

        for entry in entries {
            guard let info = entry.info else { continue }

            // Construct output path
            let entryPath = destinationURL.appendingPathComponent(info.name).path
            let entryURL = URL(fileURLWithPath: entryPath)

            // Validate path doesn't escape destination
            guard entryPath.hasPrefix(destination) else {
                NSLog("[TarBrotliUnzipService] Skipping potentially malicious entry: \(info.name)")
                continue
            }

            // Handle directory
            if info.type == .directory {
                try FileManager.default.createDirectory(at: entryURL, withIntermediateDirectories: true, attributes: nil)
            } else if info.type == .regular {
                // Ensure parent directory exists
                let parentURL = entryURL.deletingLastPathComponent()
                try FileManager.default.createDirectory(at: parentURL, withIntermediateDirectories: true, attributes: nil)

                // Extract file
                guard let data = entry.data else {
                    NSLog("[TarBrotliUnzipService] Warning: No data for entry \(info.name)")
                    continue
                }

                try data.write(to: entryURL)
                extractedCount += 1
            }

            // Update progress
            let progress = Double(extractedCount) / Double(totalEntries)
            progressHandler(progress)
        }

        if extractedCount == 0 {
            throw NSError(domain: "TarBrotliUnzipService", code: 1, userInfo: [NSLocalizedDescriptionKey: "No files extracted"])
        }

        NSLog("[TarBrotliUnzipService] Successfully extracted \(extractedCount) files")
        progressHandler(1.0)
    }
}
