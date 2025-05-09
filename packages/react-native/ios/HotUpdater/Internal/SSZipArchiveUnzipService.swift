import Foundation
import SSZipArchive

protocol UnzipService {
    /**
     * Unzips a file to a destination directory.
     * @param file Path to the zip file
     * @param destination Directory to extract to
     * @throws Error if unzipping fails
     */
    func unzip(file: String, to destination: String) throws
}

class SSZipArchiveUnzipService: UnzipService {
    func unzip(file: String, to destination: String) throws {
        var error: Error?
        
        do {
            try SSZipArchive.unzipFile(atPath: file, toDestination: destination, overwrite: true, password: nil)
        } catch let caughtError {
            error = caughtError
            throw error!
        }
    }
}