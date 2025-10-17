import Foundation
import SSZipArchive

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