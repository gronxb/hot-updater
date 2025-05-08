// SSZipArchiveUnzipService.swift
import Foundation
import SSZipArchive

protocol UnzipService {
    func unzip(file: String, to destination: String) throws
}

class SSZipArchiveUnzipService: UnzipService {
    func unzip(file: String, to destination: String) throws {
        var success = false
        var error: Error?
        
        do {
            success = SSZipArchive.unzipFile(atPath: file, toDestination: destination, overwrite: true, password: nil)
            if !success {
                throw NSError(domain: "UnzipError", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to unzip file"])
            }
        } catch let caughtError {
            error = caughtError
            throw error!
        }
    }
}