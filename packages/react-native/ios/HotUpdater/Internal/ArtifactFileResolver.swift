import Foundation

/// A download URL the server signed for one manifest file.
public struct ResolvedArtifactFile: Equatable {
    public let url: URL
    public let compression: String?

    public init(url: URL, compression: String?) {
        self.url = url
        self.compression = compression
    }
}

/// Artifact protocol v2: the server signs only the files an install
/// downloads one by one, after reusing local files and choosing the archive.
public protocol ArtifactFileResolver {
    /// Download URLs for `paths`, at most `artifactFilesRequestLimit`.
    func resolve(paths: [String]) throws -> [String: ResolvedArtifactFile]
}

/// `ARTIFACT_FILES_REQUEST_LIMIT` in @hot-updater/protocol.
public let artifactFilesRequestLimit = 100

enum ArtifactFileResolverError: Error {
    case invalidResponse
}

/// POSTs `{ paths }` to the files URL the SDK composed, with the update
/// check's headers and request timeout. `onResponse` receives each
/// response's status and body, or a nil body when it could not be read.
final class HTTPArtifactFileResolver: ArtifactFileResolver {
    /// The SDK's request timeout when the app sets none.
    static let defaultTimeout: TimeInterval = 5

    private let filesUrl: URL
    private let headers: [String: String]
    private let timeout: TimeInterval
    private let protocolClasses: [AnyClass]?
    private let onResponse: ((Int, String?) -> Void)?

    /// `protocolClasses` replaces the session's URL protocols; tests stub
    /// the network with it.
    init(
        filesUrl: URL,
        headers: [String: String],
        timeout: TimeInterval = defaultTimeout,
        protocolClasses: [AnyClass]? = nil,
        onResponse: ((Int, String?) -> Void)? = nil
    ) {
        self.filesUrl = filesUrl
        self.headers = headers
        self.timeout = timeout
        self.protocolClasses = protocolClasses
        self.onResponse = onResponse
    }

    func resolve(paths: [String]) throws -> [String: ResolvedArtifactFile] {
        var request = URLRequest(url: filesUrl, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["paths": paths])

        // The resource timeout bounds the whole request, as Android's call
        // timeout does; the request's own interval only bounds idle time.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        if let protocolClasses {
            configuration.protocolClasses = protocolClasses
        }
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }

        let finished = DispatchSemaphore(value: 0)
        var result: Result<Data, Error> = .failure(ArtifactFileResolverError.invalidResponse)
        let onResponse = self.onResponse
        let task = session.dataTask(with: request) { data, response, error in
            defer { finished.signal() }
            if let error {
                // The status arrived but the body broke: still reported.
                if let httpResponse = response as? HTTPURLResponse {
                    onResponse?(httpResponse.statusCode, nil)
                }
                result = .failure(error)
                return
            }
            guard let httpResponse = response as? HTTPURLResponse else { return }
            onResponse?(httpResponse.statusCode, data.flatMap { String(data: $0, encoding: .utf8) } ?? "")
            guard (200..<300).contains(httpResponse.statusCode) else {
                result = .failure(DownloadError.httpStatus(httpResponse.statusCode))
                return
            }
            result = .success(data ?? Data())
        }
        task.resume()
        finished.wait()

        guard let json = try JSONSerialization.jsonObject(with: result.get()) as? [String: Any],
              let files = json["files"] as? [String: [String: Any]] else {
            throw ArtifactFileResolverError.invalidResponse
        }
        return try paths.reduce(into: [:]) { resolved, path in
            guard let file = files[path],
                  let urlString = file["url"] as? String,
                  let url = URL(string: urlString) else {
                throw ArtifactFileResolverError.invalidResponse
            }
            resolved[path] = ResolvedArtifactFile(url: url, compression: file["compression"] as? String)
        }
    }
}
