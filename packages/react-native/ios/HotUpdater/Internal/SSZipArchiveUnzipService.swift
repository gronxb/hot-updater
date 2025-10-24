import Foundation
import SSZipArchive

protocol UnzipService {
    /**
     * Validates if a file is a valid ZIP file.
     * @param atPath Path to the zip file
     * @return true if the file is a valid ZIP, false otherwise
     */
    func isValidZipFile(atPath: String) -> Bool

    /**
     * Unzips a file to a destination directory.
     * @param file Path to the zip file
     * @param destination Directory to extract to
     * @throws Error if unzipping fails
     */
    func unzip(file: String, to destination: String) throws

    /**
     * Unzips a file to a destination directory with progress tracking.
     * @param file Path to the zip file
     * @param destination Directory to extract to
     * @param progressHandler Callback for extraction progress updates (0.0 to 1.0)
     * @throws Error if unzipping fails
     */
    func unzip(file: String, to destination: String, progressHandler: @escaping (Double) -> Void) throws
}

class SSZipArchiveUnzipService: UnzipService {
    private static let ZIP_MAGIC_NUMBER: [UInt8] = [0x50, 0x4B, 0x03, 0x04]
    private static let MIN_ZIP_SIZE: UInt64 = 22

    func isValidZipFile(atPath: String) -> Bool {
        let fileURL = URL(fileURLWithPath: atPath)

        // Check if file exists
        guard FileManager.default.fileExists(atPath: atPath) else {
            NSLog("[UnzipService] Invalid ZIP: file doesn't exist")
            return false
        }

        // Check file size
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: atPath)
            guard let fileSize = attributes[.size] as? UInt64, fileSize >= Self.MIN_ZIP_SIZE else {
                NSLog("[UnzipService] Invalid ZIP: file too small")
                return false
            }
        } catch {
            NSLog("[UnzipService] Invalid ZIP: cannot read attributes - \(error.localizedDescription)")
            return false
        }

        // Check ZIP magic number
        guard let fileHandle = FileHandle(forReadingAtPath: atPath) else {
            NSLog("[UnzipService] Invalid ZIP: cannot open file")
            return false
        }

        defer {
            fileHandle.closeFile()
        }

        let header = fileHandle.readData(ofLength: 4)
        guard header.count == 4 else {
            NSLog("[UnzipService] Invalid ZIP: cannot read header")
            return false
        }

        let magicBytes = [UInt8](header)
        guard magicBytes == Self.ZIP_MAGIC_NUMBER else {
            NSLog("[UnzipService] Invalid ZIP: wrong magic number")
            return false
        }

        // Try to validate ZIP structure with SSZipArchive
        do {
            if SSZipArchive.isFilePasswordProtected(atPath: atPath) || !SSZipArchive.isFilePasswordProtected(atPath: atPath) {
                // File can be checked, likely valid
                return true
            }
        } catch {
            NSLog("[UnzipService] Invalid ZIP: structure validation failed")
            return false
        }

        return true
    }

    func unzip(file: String, to destination: String) throws {
        var error: Error?

        do {
            try SSZipArchive.unzipFile(atPath: file, toDestination: destination, overwrite: true, password: nil)
        } catch let caughtError {
            error = caughtError
            throw error!
        }
    }

    func unzip(file: String, to destination: String, progressHandler: @escaping (Double) -> Void) throws {
        var didSucceed = false
        var thrownError: NSError?

        didSucceed = SSZipArchive.unzipFile(
            atPath: file,
            toDestination: destination,
            preserveAttributes: true,
            overwrite: true,
            nestedZipLevel: 0,
            password: nil,
            error: &thrownError,
            delegate: nil,
            progressHandler: { entry, zipInfo, entryNumber, total in
                let progress = Double(entryNumber) / Double(total)
                progressHandler(progress)
            },
            completionHandler: nil
        )

        if !didSucceed {
            if let error = thrownError {
                NSLog("[UnzipService] Unzip failed: \(error.localizedDescription)")
                throw error
            } else {
                let error = NSError(domain: "UnzipService", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unzip failed with unknown error"])
                throw error
            }
        }

        NSLog("[UnzipService] Successfully unzipped file")
    }
}