#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

struct UpdateFailureClassifierTests {
    @Test
    func classifiesTransferErrors() {
        let failures: [(Error, UpdateFailure)] = [
            (DownloadError.httpStatus(404), .http(status: 404)),
            (DownloadError.httpStatus(403, originCode: "AccessDenied"), .http(status: 403, originCode: "AccessDenied")),
            (URLError(.notConnectedToInternet), .network(transport: .offline)),
            (URLError(.timedOut), .network(transport: .timeout)),
            (URLError(.networkConnectionLost), .network(transport: .connection)),
            (NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotFindHost), .network(transport: .dns)),
            (URLError(.badServerResponse), .network),
            (DownloadError.incompleteDownload(expected: 10, actual: 4), .network),
            (URLError(.unsupportedURL), .invalidResponse),
            (URLError(.cannotWriteToFile), .storage),
            (CocoaError(.fileWriteOutOfSpace), .storage),
            (NSError(domain: "Unexpected", code: 1), .unknown(.download)),
        ]
        for (underlying, expected) in failures {
            #expect(classify(BundleStorageError.downloadFailed(underlying)) == expected)
        }
        // A response arrived, so an incomplete body names no transport.
        #expect(classify(BundleStorageError.incompleteDownload(expected: 10, actual: 4)) == .network)
        #expect(classify(BundleStorageError.incompleteDownload(expected: 10, actual: 4))?.transport == nil)
    }

    @Test
    func mapsURLErrorCodesToTransports() {
        let transports: [(URLError.Code, UpdateFailureTransport?)] = [
            (.timedOut, .timeout),
            (.cannotFindHost, .dns),
            (.dnsLookupFailed, .dns),
            (.secureConnectionFailed, .tls),
            (.serverCertificateHasBadDate, .tls),
            (.serverCertificateUntrusted, .tls),
            (.serverCertificateHasUnknownRoot, .tls),
            (.serverCertificateNotYetValid, .tls),
            (.clientCertificateRejected, .tls),
            (.clientCertificateRequired, .tls),
            (.cannotConnectToHost, .connection),
            (.networkConnectionLost, .connection),
            (.notConnectedToInternet, .offline),
            (.dataNotAllowed, .offline),
            (.internationalRoamingOff, .offline),
            (.cancelled, .cancelled),
            (.badServerResponse, nil),
            (.unknown, nil),
        ]
        for (code, expected) in transports {
            #expect(UpdateFailureTransport(code) == expected, "\(code.rawValue)")
            let failure = classify(BundleStorageError.downloadFailed(URLError(code)))
            #expect(failure?.reason == .network)
            #expect(failure?.transport == expected)
        }
    }

    @Test
    func downloadServiceRejectsStatusesOutsideSuccessRange() throws {
        let url = try #require(URL(string: "https://example.com/manifest.json"))
        func response(_ status: Int) -> HTTPURLResponse? {
            HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)
        }

        #expect(DownloadError.httpStatusError(for: response(200), body: nil) == nil)
        #expect(DownloadError.httpStatusError(for: response(206), body: nil) == nil)
        #expect(DownloadError.httpStatusError(for: response(304), body: nil) == .httpStatus(304))
        #expect(DownloadError.httpStatusError(for: response(404), body: nil) == .httpStatus(404))
        #expect(DownloadError.httpStatusError(for: response(500), body: nil) == .httpStatus(500))
        let fileResponse = URLResponse(
            url: URL(fileURLWithPath: "/tmp/manifest.json"),
            mimeType: nil,
            expectedContentLength: 0,
            textEncodingName: nil
        )
        #expect(DownloadError.httpStatusError(for: fileResponse, body: nil) == nil)
        #expect(DownloadError.httpStatusError(for: nil, body: nil) == nil)
    }

    @Test
    func readsTheStorageOriginCodeFromTheErrorBody() throws {
        let url = try #require(URL(string: "https://bucket.example.com/manifest.json"))
        let body = FileManager.default.temporaryDirectory
            .appendingPathComponent("origin-error-\(UUID().uuidString).xml")
        defer { try? FileManager.default.removeItem(at: body) }
        try Data("""
            <?xml version="1.0" encoding="UTF-8"?>
            <Error><Code>AccessDenied</Code><Message>Access Denied</Message><Key>secret/path.json</Key><Resource>/bucket</Resource></Error>
            """.utf8).write(to: body)
        let response = HTTPURLResponse(url: url, statusCode: 403, httpVersion: "HTTP/1.1", headerFields: nil)

        let error = DownloadError.httpStatusError(for: response, body: body)
        #expect(error == .httpStatus(403, originCode: "AccessDenied"))
        #expect(DownloadError.httpStatusError(for: response, body: body.appendingPathExtension("missing"))
            == .httpStatus(403))
        let failure = classify(BundleStorageError.downloadFailed(try #require(error)))
        #expect(failure == .http(status: 403, originCode: "AccessDenied"))
        #expect(failure?.userInfo[UpdateFailure.originCodeKey] as? String == "AccessDenied")

        // Only the first 4 KB of the saved body is read.
        let paddedBody = body.appendingPathExtension("padded")
        defer { try? FileManager.default.removeItem(at: paddedBody) }
        var padded = Data(repeating: 0x20, count: DownloadError.maximumErrorBodyPrefixByteCount)
        padded.append(Data("<Error><Code>AccessDenied</Code></Error>".utf8))
        try padded.write(to: paddedBody)
        #expect(DownloadError.httpStatusError(for: response, body: paddedBody) == .httpStatus(403))
    }

    @Test
    func keepsOnlyAValidOriginCodeFromTheFirstFourKilobytes() {
        func code(_ body: String) -> String? {
            DownloadError.storageOriginErrorCode(in: Data(body.utf8))
        }
        #expect(code("<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>") == "NoSuchKey")
        #expect(code("<?xml version='1.0'?><Error xmlns=\"urn:example\"><Code>\n  Slow.Down_2-x \n</Code></Error>") == "Slow.Down_2-x")
        #expect(code("<Error><Code>\(String(repeating: "A", count: 64))</Code></Error>") == String(repeating: "A", count: 64))
        #expect(code("<Error><Code>\(String(repeating: "A", count: 65))</Code></Error>") == nil)
        #expect(code("<Error><Code></Code></Error>") == nil)
        #expect(code("<Error><Code>   </Code></Error>") == nil)
        #expect(code("<Error><Code>Access Denied</Code></Error>") == nil)
        #expect(code("<Error><Code>Denied<Key>x</Key></Code></Error>") == nil)
        #expect(code("<Error><Code>Access\u{00E9}</Code></Error>") == nil)
        #expect(code("<Error><Code>Unterminated") == nil)
        #expect(code("<Code>NotAnError</Code>") == nil)
        #expect(code("<html><body>Not Found</body></html>") == nil)

        let padding = String(repeating: " ", count: DownloadError.maximumErrorBodyPrefixByteCount)
        #expect(code(padding + "<Error><Code>TooLate</Code></Error>") == nil)
        // The closing tag ends exactly at the limit; one more byte cuts it off.
        let fitting = "<Error><Code>InTime</Code>"
        let fittingPadding = String(
            repeating: " ",
            count: DownloadError.maximumErrorBodyPrefixByteCount - fitting.utf8.count
        )
        #expect(code(fittingPadding + fitting) == "InTime")
        #expect(code(fittingPadding + " " + fitting) == nil)
    }

    @Test
    func classifiesHashMismatchByStep() {
        let mismatch = BundleStorageError.signatureVerificationFailed(.fileHashMismatch)
        #expect(classify(mismatch, .transfer) == .hashMismatch)
        #expect(classify(mismatch, .verification) == .hashMismatch)
        #expect(classify(mismatch, .storage) == .hashMismatch)
        #expect(classify(mismatch, .patch) == .patch)
        #expect(classify(mismatch, .extraction) == .extract)
    }

    @Test
    func classifiesSignatureErrorsInEveryStep() {
        let signatureErrors: [SignatureVerificationError] = [
            .publicKeyNotConfigured,
            .invalidPublicKeyFormat,
            .invalidSignatureFormat,
            .signatureVerificationFailed,
            .unsignedNotAllowed,
            .securityFrameworkError(-1),
        ]
        for error in signatureErrors {
            #expect(classify(BundleStorageError.signatureVerificationFailed(error), .verification) == .signature)
            #expect(classify(BundleStorageError.signatureVerificationFailed(error), .extraction) == .signature)
            #expect(classify(error, .patch) == .signature)
        }
        #expect(classify(BundleStorageError.signatureVerificationFailed(.fileReadFailed), .verification) == .storage)
        #expect(classify(SignatureVerificationError.missingFileHash, .verification) == .invalidResponse)
    }

    @Test
    func classifiesInvalidManifestsAndBundles() {
        #expect(classify(BundleStorageError.invalidBundle, .manifest) == .invalidResponse)
        // A downloaded bundle without its platform file fails after staging.
        #expect(classify(BundleStorageError.invalidBundle, .storage) == .invalidResponse)
        // JSONSerialization reports malformed JSON as a Cocoa error.
        let malformedJSON = NSError(
            domain: NSCocoaErrorDomain,
            code: CocoaError.propertyListReadCorrupt.rawValue
        )
        #expect(classify(malformedJSON, .manifest) == .invalidResponse)
        let unsafePath = NSError(domain: "FileUtilities", code: 2)
        #expect(classify(unsafePath, .manifest) == .invalidResponse)
    }

    @Test
    func classifiesInstallErrors() {
        #expect(classify(NSError(domain: "TarArchiveExtractor", code: 17), .extraction) == .extract)
        #expect(classify(NSError(domain: "BrotliFileDecompressor", code: 4), .extraction) == .extract)
        #expect(classify(NSError(domain: "HotUpdater.Bsdiff", code: 1), .patch) == .patch)
        #expect(classify(BundleStorageError.directoryCreationFailed, .transfer) == .storage)
        #expect(classify(BundleStorageError.moveOperationFailed(CocoaError(.fileWriteNoPermission))) == .storage)
        #expect(classify(FileSystemError.fileOperationFailed("/tmp/file", CocoaError(.fileNoSuchFile)), .extraction) == .storage)
        #expect(classify(CocoaError(.fileWriteOutOfSpace), .extraction) == .storage)
        #expect(classify(NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC)), .patch) == .storage)
    }

    @Test
    func unexpectedErrorsKeepTheirStage() {
        #expect(classify(BundleStorageError.unknown(nil), .transfer) == .unknown(.download))
        #expect(classify(BundleStorageError.unknown(nil), .verification) == .unknown(.download))
        #expect(classify(BundleStorageError.unknown(nil), .storage) == .unknown(.install))
        #expect(classify(NSError(domain: "Unexpected", code: 1), .storage) == .unknown(.install))
        #expect(classify(PreferencesError.setItemError("HotUpdaterBundleURL"), .storage) == .unknown(.install))
        #expect(classify(BundleStorageError.unknown(CocoaError(.fileWriteOutOfSpace)), .storage) == .storage)
    }

    @Test
    func skipsRejectionsThatAreNotUpdateFailures() {
        let crashed = BundleStorageError.bundleInCrashedHistory("bundle")
        let stale = BundleStorageError.unknown(StaleReleaseSelectionError())
        #expect(classify(crashed) == nil)
        #expect(classify(stale) == nil)
        #expect(classify(StaleReleaseSelectionError()) == nil)

        for error in [crashed, stale] as [Error] {
            #expect(UpdateFailureError.classifying(error, during: .storage) is BundleStorageError)
            let rejection = UpdateFailureError.rejectionError(for: error)
            #expect(rejection.userInfo[UpdateFailure.stageKey] == nil)
            #expect(rejection.userInfo[UpdateFailure.reasonKey] == nil)
        }
        let staleRejection = StaleReleaseSelectionError() as NSError
        #expect(staleRejection.domain == "HotUpdater")
        #expect(staleRejection.localizedDescription == "Release catalog selection is stale")
    }

    @Test
    func keepsTheInnermostClassification() throws {
        let classified = UpdateFailureError(
            underlying: BundleStorageError.invalidBundle,
            failure: .hashMismatch
        )
        let reclassified = try #require(
            UpdateFailureError.classifying(classified, during: .storage) as? UpdateFailureError
        )
        #expect(reclassified.failure == .hashMismatch)
        #expect(UpdateFailureError.unwrap(reclassified) is BundleStorageError)

        // An outer step only adds a resource the inner one did not name.
        let archived = try #require(
            UpdateFailureError.classifying(classified, during: .storage, resource: .archive)
                as? UpdateFailureError
        )
        #expect(archived.failure == UpdateFailure.hashMismatch.with(resource: .archive))
        let patched = UpdateFailureError(
            underlying: BundleStorageError.invalidBundle,
            failure: UpdateFailure.patch.with(resource: .patch)
        )
        let rewrapped = try #require(
            UpdateFailureError.classifying(patched, during: .storage, resource: .file)
                as? UpdateFailureError
        )
        #expect(rewrapped.failure.resource == .patch)

        #expect(duringFailure(.patch) { throw classified } == .hashMismatch)
        #expect(duringFailure(.patch) {
            throw BundleStorageError.signatureVerificationFailed(.fileHashMismatch)
        } == .patch)
        #expect(duringFailure(.extraction) {
            throw NSError(domain: "BrotliFileDecompressor", code: 3)
        } == .extract)
    }

    @Test
    func rejectionErrorAddsJSONSafeClassification() throws {
        let underlying = BundleStorageError.downloadFailed(
            DownloadError.httpStatus(503, originCode: "SlowDown")
        )
        let rejection = UpdateFailureError.rejectionError(
            for: UpdateFailureError.classifying(underlying, during: .transfer, resource: .manifest)
        )
        let original = underlying as NSError

        #expect(rejection.domain == original.domain)
        #expect(rejection.code == original.code)
        #expect(rejection.localizedDescription == original.localizedDescription)
        #expect(rejection.userInfo[NSLocalizedDescriptionKey] as? String == original.localizedDescription)
        #expect(rejection.userInfo[NSUnderlyingErrorKey] is NSError)
        #expect(rejection.userInfo[UpdateFailure.stageKey] as? String == "download")
        #expect(rejection.userInfo[UpdateFailure.reasonKey] as? String == "http")
        #expect(rejection.userInfo[UpdateFailure.resourceKey] as? String == "manifest")
        #expect(rejection.userInfo[UpdateFailure.originCodeKey] as? String == "SlowDown")
        #expect(rejection.userInfo[UpdateFailure.transportKey] == nil)
        let status = try #require(rejection.userInfo[UpdateFailure.httpStatusKey] as? NSNumber)
        #expect(status.intValue == 503)
        // React Native turns a boolean NSNumber into a JS boolean.
        #expect(CFGetTypeID(status) == CFNumberGetTypeID())
        let classificationKeys = [
            UpdateFailure.stageKey,
            UpdateFailure.reasonKey,
            UpdateFailure.resourceKey,
            UpdateFailure.httpStatusKey,
            UpdateFailure.transportKey,
            UpdateFailure.originCodeKey,
        ]
        let classification = rejection.userInfo.filter { classificationKeys.contains($0.key) }
        #expect(classification.count == 5)
        #expect(JSONSerialization.isValidJSONObject(classification))

        let offline = UpdateFailureError.rejectionError(
            for: UpdateFailureError.classifying(
                BundleStorageError.downloadFailed(URLError(.notConnectedToInternet)),
                during: .transfer,
                resource: .file
            )
        )
        #expect(offline.userInfo[UpdateFailure.reasonKey] as? String == "network")
        #expect(offline.userInfo[UpdateFailure.transportKey] as? String == "offline")
        #expect(offline.userInfo[UpdateFailure.resourceKey] as? String == "file")
        #expect(offline.userInfo[UpdateFailure.httpStatusKey] == nil)
        #expect(offline.userInfo[UpdateFailure.originCodeKey] == nil)
        #expect(JSONSerialization.isValidJSONObject(
            offline.userInfo.filter { classificationKeys.contains($0.key) }
        ))
    }

    @Test
    func rejectionErrorKeepsUnderlyingDomainAndOmitsHTTPStatus() {
        let underlying = NSError(
            domain: "TarArchiveExtractor",
            code: 8,
            userInfo: [NSLocalizedDescriptionKey: "TAR entry size does not match the manifest"]
        )
        let rejection = UpdateFailureError.rejectionError(
            for: UpdateFailureError.classifying(underlying, during: .extraction)
        )

        #expect(rejection.domain == "TarArchiveExtractor")
        #expect(rejection.code == 8)
        #expect(rejection.localizedDescription == "TAR entry size does not match the manifest")
        #expect(rejection.userInfo[UpdateFailure.stageKey] as? String == "install")
        #expect(rejection.userInfo[UpdateFailure.reasonKey] as? String == "extract")
        #expect(rejection.userInfo[UpdateFailure.resourceKey] == nil)
        #expect(rejection.userInfo[UpdateFailure.httpStatusKey] == nil)
        #expect(rejection.userInfo[UpdateFailure.transportKey] == nil)
        #expect(rejection.userInfo[UpdateFailure.originCodeKey] == nil)
    }

    @Test
    func parameterErrorsAreInvalidResponses() {
        let error = UpdateFailure.invalidResponse.error(description: "Missing or empty 'bundleId'")

        #expect(error.domain == "HotUpdater")
        #expect(error.code == 0)
        #expect(error.localizedDescription == "Missing or empty 'bundleId'")
        #expect(error.userInfo[UpdateFailure.stageKey] as? String == "download")
        #expect(error.userInfo[UpdateFailure.reasonKey] as? String == "invalid_response")
        #expect(error.userInfo[UpdateFailure.resourceKey] == nil)
        #expect(error.userInfo[UpdateFailure.httpStatusKey] == nil)
        #expect(JSONSerialization.isValidJSONObject(error.userInfo))

        let archiveURLError = UpdateFailure.invalidResponse.with(resource: .archive)
            .error(description: "Invalid 'archiveUrl' provided: ")
        #expect(archiveURLError.userInfo[UpdateFailure.resourceKey] as? String == "archive")
    }

    private func classify(_ error: Error, _ phase: UpdatePhase = .storage) -> UpdateFailure? {
        UpdateFailureClassifier.classify(error, during: phase)
    }

    private func duringFailure(
        _ phase: UpdatePhase,
        _ body: () throws -> Void
    ) -> UpdateFailure? {
        do {
            try UpdateFailureError.during(phase, body)
            return nil
        } catch {
            return (error as? UpdateFailureError)?.failure
        }
    }
}
#endif
