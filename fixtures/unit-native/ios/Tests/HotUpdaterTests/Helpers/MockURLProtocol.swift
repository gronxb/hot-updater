import Foundation

/// Mock URLProtocol for intercepting network requests in tests
final class MockURLProtocol: URLProtocol {

    // MARK: - Types

    enum MockError: Error {
        case networkError
        case noMockData
    }

    struct MockResponse {
        let data: Data
        let statusCode: Int
        let headers: [String: String]?

        init(data: Data, statusCode: Int = 200, headers: [String: String]? = nil) {
            self.data = data
            self.statusCode = statusCode
            self.headers = headers
        }
    }

    // MARK: - Static Properties

    private static var mockResponses: [String: MockResponse] = [:]
    private static var shouldSimulateNetworkError = false
    private static var progressHandler: ((Double) -> Void)?

    // MARK: - Configuration

    /// Register a mock response for a given URL
    static func registerMockResponse(url: String, response: MockResponse) {
        mockResponses[url] = response
    }

    /// Register a mock response from a file
    static func registerMockResponseFromFile(url: String, filePath: String, statusCode: Int = 200) throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: filePath))
        let response = MockResponse(data: data, statusCode: statusCode)
        mockResponses[url] = response
    }

    /// Simulate network error for all requests
    static func simulateNetworkError(_ shouldSimulate: Bool) {
        shouldSimulateNetworkError = shouldSimulate
    }

    /// Set progress handler for download tracking
    static func setProgressHandler(_ handler: ((Double) -> Void)?) {
        progressHandler = handler
    }

    /// Reset all mocks
    static func reset() {
        mockResponses.removeAll()
        shouldSimulateNetworkError = false
        progressHandler = nil
    }

    // MARK: - URLProtocol Override

    override class func canInit(with request: URLRequest) -> Bool {
        // Intercept all HTTP/HTTPS requests
        guard let url = request.url else { return false }
        return url.scheme == "http" || url.scheme == "https"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        return request
    }

    override func startLoading() {
        guard let url = request.url?.absoluteString else {
            client?.urlProtocol(self, didFailWithError: MockError.noMockData)
            return
        }

        // Simulate network error if configured
        if Self.shouldSimulateNetworkError {
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
                self.client?.urlProtocol(self, didFailWithError: MockError.networkError)
            }
            return
        }

        // Get mock response
        guard let mockResponse = Self.mockResponses[url] else {
            client?.urlProtocol(self, didFailWithError: MockError.noMockData)
            return
        }

        // Simulate response
        let httpResponse = HTTPURLResponse(
            url: request.url!,
            statusCode: mockResponse.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: mockResponse.headers
        )!

        // Simulate progress if handler is set
        if let progressHandler = Self.progressHandler {
            let totalBytes = Int64(mockResponse.data.count)
            let chunkSize = max(1, totalBytes / 10) // 10 progress updates

            DispatchQueue.global().async {
                self.client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)

                var sentBytes: Int64 = 0
                while sentBytes < totalBytes {
                    let endIndex = min(sentBytes + chunkSize, totalBytes)
                    let chunk = mockResponse.data[Int(sentBytes)..<Int(endIndex)]

                    self.client?.urlProtocol(self, didLoad: chunk)
                    sentBytes = endIndex

                    let progress = Double(sentBytes) / Double(totalBytes)
                    DispatchQueue.main.async {
                        progressHandler(progress)
                    }

                    // Small delay to simulate network
                    Thread.sleep(forTimeInterval: 0.01)
                }

                self.client?.urlProtocolDidFinishLoading(self)
            }
        } else {
            // No progress tracking - send all data at once
            DispatchQueue.global().async {
                self.client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
                self.client?.urlProtocol(self, didLoad: mockResponse.data)
                self.client?.urlProtocolDidFinishLoading(self)
            }
        }
    }

    override func stopLoading() {
        // Nothing to do
    }
}

// MARK: - URLSessionConfiguration Extension

extension URLSessionConfiguration {
    /// Create a configuration that uses MockURLProtocol
    static var mockConfiguration: URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return config
    }
}
