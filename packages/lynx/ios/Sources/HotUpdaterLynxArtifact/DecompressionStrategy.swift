import Foundation

/**
 * Protocol for decompression strategies
 */
protocol DecompressionStrategy {
    /**
     * Validates if a file can be decompressed by this strategy
     * @param file Path to the file to validate
     * @return true if the file is valid for this strategy
     */
    func isValid(file: String) -> Bool

    /**
     * Decompresses a file to the destination directory
     * @param file Path to the compressed file
     * @param destination Path to the destination directory
     * @param progressHandler Callback for progress updates (0.0 - 1.0)
     * @throws Error if decompression fails
     */
    func decompress(file: String, to destination: String, progressHandler: @escaping (Double) -> Void) throws
}
