import Foundation
import SWCompression

/**
 * UnzipService implementation for tar+gzip compressed files.
 * Uses SWCompression library for both gzip decompression and tar extraction.
 */
class TarGzipUnzipService: UnzipService {

    /**
     * Unzips a tar.gz file to a destination directory.
     * @param file Path to the tar.gz file
     * @param destination Directory to extract to
     * @throws Error if unzipping fails or path traversal is detected
     */
    func unzip(file: String, to destination: String) throws {
        NSLog("[TarGzipUnzipService] Starting extraction of \(file) to \(destination)")

        // Read the compressed file
        guard let compressedData = try? Data(contentsOf: URL(fileURLWithPath: file)) else {
            throw NSError(
                domain: "TarGzipUnzipService",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to read tar.gz file at: \(file)"]
            )
        }

        // Decompress gzip
        let decompressedData: Data
        do {
            decompressedData = try GzipArchive.unarchive(archive: compressedData)
            NSLog("[TarGzipUnzipService] Gzip decompression successful, size: \(decompressedData.count) bytes")
        } catch {
            throw NSError(
                domain: "TarGzipUnzipService",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Gzip decompression failed: \(error.localizedDescription)"]
            )
        }

        // Extract tar entries
        let tarEntries: [TarEntry]
        do {
            tarEntries = try TarContainer.open(container: decompressedData)
            NSLog("[TarGzipUnzipService] Tar extraction successful, found \(tarEntries.count) entries")
        } catch {
            throw NSError(
                domain: "TarGzipUnzipService",
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

        NSLog("[TarGzipUnzipService] Successfully extracted all entries")
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
            NSLog("[TarGzipUnzipService] Skipping entry with no info")
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
                domain: "TarGzipUnzipService",
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
            NSLog("[TarGzipUnzipService] Created directory: \(entryName)")

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
                NSLog("[TarGzipUnzipService] Extracted file: \(entryName) (\(data.count) bytes)")
            } else {
                NSLog("[TarGzipUnzipService] Warning: No data for file entry: \(entryName)")
            }

        case .symbolicLink:
            // Skip symbolic links for security
            NSLog("[TarGzipUnzipService] Skipping symbolic link: \(entryName)")

        default:
            // Skip other types (block devices, character devices, fifos, etc.)
            NSLog("[TarGzipUnzipService] Skipping unsupported entry type: \(entryName)")
        }
    }
}
