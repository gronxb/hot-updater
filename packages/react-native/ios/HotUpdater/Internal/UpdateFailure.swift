import Foundation

/// Where an update failed: `download` covers transferring the update's files
/// and verifying the downloaded bytes, and `install` covers producing the
/// bundle on disk (patching, extracting, and moving files into place).
enum UpdateFailureStage: String {
    case download
    case install
}

/// Why an update failed.
enum UpdateFailureReason: String {
    case network
    case http
    case invalidResponse = "invalid_response"
    case hashMismatch = "hash_mismatch"
    case signature
    case patch
    case extract
    case storage
    case unknown
}

/// What was being fetched or applied when an update failed.
enum UpdateFailureResource: String {
    case manifest
    case file
    case patch
    case archive
}

/// How a transfer failed when no HTTP response arrived.
enum UpdateFailureTransport: String {
    case timeout
    case dns
    case tls
    case connection
    case offline
    case cancelled

    /// Returns nil for codes that do not name a transport failure.
    init?(_ code: URLError.Code) {
        switch code {
        case .timedOut:
            self = .timeout
        case .cannotFindHost, .dnsLookupFailed:
            self = .dns
        case .secureConnectionFailed,
             .serverCertificateHasBadDate,
             .serverCertificateUntrusted,
             .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid,
             .clientCertificateRejected,
             .clientCertificateRequired:
            self = .tls
        case .cannotConnectToHost, .networkConnectionLost:
            self = .connection
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff:
            self = .offline
        case .cancelled:
            self = .cancelled
        default:
            return nil
        }
    }
}

/// The classification an `updateBundle` rejection carries in its userInfo.
struct UpdateFailure: Equatable {
    static let stageKey = "stage"
    static let reasonKey = "reason"
    static let resourceKey = "resource"
    static let httpStatusKey = "httpStatus"
    static let transportKey = "transport"
    static let originCodeKey = "originCode"

    static let network = UpdateFailure(stage: .download, reason: .network)
    static let invalidResponse = UpdateFailure(stage: .download, reason: .invalidResponse)
    static let hashMismatch = UpdateFailure(stage: .download, reason: .hashMismatch)
    static let signature = UpdateFailure(stage: .download, reason: .signature)
    static let patch = UpdateFailure(stage: .install, reason: .patch)
    static let extract = UpdateFailure(stage: .install, reason: .extract)
    static let storage = UpdateFailure(stage: .install, reason: .storage)

    static func network(transport: UpdateFailureTransport?) -> UpdateFailure {
        UpdateFailure(stage: .download, reason: .network, transport: transport)
    }

    static func http(status: Int, originCode: String? = nil) -> UpdateFailure {
        UpdateFailure(
            stage: .download,
            reason: .http,
            httpStatus: status,
            originCode: originCode
        )
    }

    static func unknown(_ stage: UpdateFailureStage) -> UpdateFailure {
        UpdateFailure(stage: stage, reason: .unknown)
    }

    let stage: UpdateFailureStage
    let reason: UpdateFailureReason
    /// What was being fetched or applied, when the failure concerns one.
    private(set) var resource: UpdateFailureResource?
    /// The response status; only set when `reason` is `.http`.
    let httpStatus: Int?
    /// Only set when `reason` is `.network` and no response arrived.
    let transport: UpdateFailureTransport?
    /// The storage origin's XML error code; only set when `reason` is `.http`.
    let originCode: String?

    private init(
        stage: UpdateFailureStage,
        reason: UpdateFailureReason,
        httpStatus: Int? = nil,
        transport: UpdateFailureTransport? = nil,
        originCode: String? = nil
    ) {
        self.stage = stage
        self.reason = reason
        self.httpStatus = httpStatus
        self.transport = transport
        self.originCode = originCode
    }

    /// This failure, attributed to `resource` unless it already names one.
    func with(resource: UpdateFailureResource?) -> UpdateFailure {
        guard self.resource == nil, let resource else {
            return self
        }
        var failure = self
        failure.resource = resource
        return failure
    }

    /// JSON-safe entries React Native copies into the JS error's `userInfo`.
    var userInfo: [String: Any] {
        var userInfo: [String: Any] = [
            Self.stageKey: stage.rawValue,
            Self.reasonKey: reason.rawValue,
        ]
        if let resource {
            userInfo[Self.resourceKey] = resource.rawValue
        }
        if let httpStatus {
            userInfo[Self.httpStatusKey] = NSNumber(value: httpStatus)
        }
        if let transport {
            userInfo[Self.transportKey] = transport.rawValue
        }
        if let originCode {
            userInfo[Self.originCodeKey] = originCode
        }
        return userInfo
    }

    /// An error carrying this classification, for rejections raised before
    /// the update pipeline starts, such as invalid `updateBundle` parameters.
    func error(description: String) -> NSError {
        var userInfo = self.userInfo
        userInfo[NSLocalizedDescriptionKey] = description
        return NSError(domain: "HotUpdater", code: 0, userInfo: userInfo)
    }
}

/// The update step an error came from. It classifies the errors whose type
/// does not: a hash mismatch is a download failure after a transfer but a
/// patch failure after patching, and an unexpected error keeps the stage.
enum UpdatePhase {
    /// Transferring manifest, archive, asset, or patch bytes.
    case transfer
    /// Checking downloaded bytes against the manifest.
    case verification
    /// Parsing and validating the manifest against the update parameters.
    case manifest
    /// Applying a bsdiff patch and checking its output.
    case patch
    /// Decoding brotli or tar data and checking the extracted files.
    case extraction
    /// Creating directories and copying, moving, or writing files.
    case storage
}

/// An update pipeline error and its classification. `underlying` still
/// decides the rejection code, so classifying an error never changes it.
struct UpdateFailureError: Error {
    let underlying: Error
    let failure: UpdateFailure

    /// Classifies `error` as raised during `phase` while fetching or applying
    /// `resource`. An error that is already classified keeps its
    /// classification and only gains a missing resource. Returns `error`
    /// unchanged when it is not an update failure.
    static func classifying(
        _ error: Error,
        during phase: UpdatePhase,
        resource: UpdateFailureResource? = nil
    ) -> Error {
        if let classified = error as? UpdateFailureError {
            return UpdateFailureError(
                underlying: classified.underlying,
                failure: classified.failure.with(resource: resource)
            )
        }
        guard let failure = UpdateFailureClassifier.classify(error, during: phase) else {
            return error
        }
        return UpdateFailureError(underlying: error, failure: failure.with(resource: resource))
    }

    /// Runs `body`, classifying what it throws as raised during `phase`.
    static func during<T>(
        _ phase: UpdatePhase,
        resource: UpdateFailureResource? = nil,
        _ body: () throws -> T
    ) throws -> T {
        do {
            return try body()
        } catch {
            throw classifying(error, during: phase, resource: resource)
        }
    }

    /// The error that decides the rejection code.
    static func unwrap(_ error: Error) -> Error {
        (error as? UpdateFailureError)?.underlying ?? error
    }

    /// The error `updateBundle` rejects with: the underlying error's domain,
    /// code, and userInfo, plus the classification entries.
    static func rejectionError(for error: Error) -> NSError {
        guard let classified = error as? UpdateFailureError else {
            return error as NSError
        }
        let underlying = classified.underlying as NSError
        var userInfo = underlying.userInfo
        userInfo[NSLocalizedDescriptionKey] = underlying.localizedDescription
        userInfo.merge(classified.failure.userInfo) { _, classification in classification }
        return NSError(domain: underlying.domain, code: underlying.code, userInfo: userInfo)
    }
}

extension UpdateFailureError: LocalizedError {
    var errorDescription: String? {
        underlying.localizedDescription
    }
}

/// The Release selection an install was staged for changed before the bundle
/// was activated. The rejection is not an update failure.
struct StaleReleaseSelectionError: Error, CustomNSError {
    static var errorDomain: String {
        "HotUpdater"
    }

    var errorCode: Int {
        0
    }

    var errorUserInfo: [String: Any] {
        [NSLocalizedDescriptionKey: "Release catalog selection is stale"]
    }
}

enum UpdateFailureClassifier {
    /// Classifies an error raised during `phase`, or returns nil when the
    /// error is not an update failure.
    static func classify(_ error: Error, during phase: UpdatePhase) -> UpdateFailure? {
        switch error {
        case let error as UpdateFailureError:
            return error.failure
        case is StaleReleaseSelectionError:
            return nil
        case let error as BundleStorageError:
            return classifyStorageError(error, during: phase)
        case let error as SignatureVerificationError:
            return classifySignatureError(error, during: phase)
        case let error as DownloadError:
            return classifyDownloadError(error)
        case let error as URLError:
            return classifyURLError(error)
        default:
            return isFileSystemError(error) ? .storage : fallback(during: phase)
        }
    }

    private static func classifyStorageError(
        _ error: BundleStorageError,
        during phase: UpdatePhase
    ) -> UpdateFailure? {
        switch error {
        case .directoryCreationFailed, .moveOperationFailed:
            return .storage
        case .downloadFailed(let underlying):
            return classify(underlying, during: .transfer)
        case .incompleteDownload:
            return .network
        case .invalidBundle:
            return .invalidResponse
        case .signatureVerificationFailed(let underlying):
            return classifySignatureError(underlying, during: phase)
        case .bundleInCrashedHistory:
            return nil
        case .unknown(.some(let underlying)):
            return classify(underlying, during: phase)
        case .unknown(.none):
            return fallback(during: phase)
        }
    }

    private static func classifySignatureError(
        _ error: SignatureVerificationError,
        during phase: UpdatePhase
    ) -> UpdateFailure {
        switch error {
        case .fileHashMismatch:
            switch phase {
            case .patch:
                return .patch
            case .extraction:
                return .extract
            case .transfer, .verification, .manifest, .storage:
                return .hashMismatch
            }
        case .fileReadFailed:
            return .storage
        case .missingFileHash:
            return .invalidResponse
        case .publicKeyNotConfigured,
             .invalidPublicKeyFormat,
             .invalidSignatureFormat,
             .signatureVerificationFailed,
             .unsignedNotAllowed,
             .securityFrameworkError:
            return .signature
        }
    }

    private static func classifyDownloadError(_ error: DownloadError) -> UpdateFailure {
        switch error {
        case .httpStatus(let status, let originCode):
            return .http(status: status, originCode: originCode)
        case .incompleteDownload, .invalidContentLength:
            // A response arrived, so the failure names no transport.
            return .network
        }
    }

    private static func classifyURLError(_ error: URLError) -> UpdateFailure {
        switch error.code {
        case .badURL, .unsupportedURL:
            return .invalidResponse
        case .cannotCreateFile,
             .cannotOpenFile,
             .cannotCloseFile,
             .cannotWriteToFile,
             .cannotRemoveFile,
             .cannotMoveFile:
            return .storage
        default:
            return .network(transport: UpdateFailureTransport(error.code))
        }
    }

    private static func isFileSystemError(_ error: Error) -> Bool {
        if error is FileSystemError {
            return true
        }
        if let cocoaError = error as? CocoaError {
            return cocoaError.isFileError
        }
        return (error as NSError).domain == NSPOSIXErrorDomain
    }

    private static func fallback(during phase: UpdatePhase) -> UpdateFailure {
        switch phase {
        case .transfer, .verification:
            return .unknown(.download)
        case .manifest:
            return .invalidResponse
        case .patch:
            return .patch
        case .extraction:
            return .extract
        case .storage:
            return .unknown(.install)
        }
    }
}
