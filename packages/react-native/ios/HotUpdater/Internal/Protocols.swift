import Foundation

protocol UnzipService {
    /**
     * Unzips a file to a destination directory.
     * @param file Path to the zip file
     * @param destination Directory to extract to
     * @throws Error if unzipping fails
     */
    func unzip(file: String, to destination: String) throws
}
