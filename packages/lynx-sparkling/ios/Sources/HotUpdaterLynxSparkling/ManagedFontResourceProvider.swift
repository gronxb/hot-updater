import Foundation
import HotUpdaterLynxArtifact
import Lynx

/// Validate the raw font request before Sparkling can trim or repair its URL.
final class ManagedFontResourceProvider: NSObject, LynxResourceProvider {
    private let delegate: LynxResourceProvider
    private let rejected: (String, Error) -> Void

    init(delegate: LynxResourceProvider, rejected: @escaping (String, Error) -> Void) {
        self.delegate = delegate
        self.rejected = rejected
    }

    func request(_ request: LynxResourceRequest, onComplete callback: @escaping LynxResourceLoadBlock) {
        do {
            try validate(request)
        } catch {
            rejected(request.url, error)
            let error = error as NSError
            callback(LynxResourceResponse(error: error, code: error.code))
            return
        }
        delegate.request(request, onComplete: callback)
    }

    func cancel(_ request: LynxResourceRequest) {
        do {
            try validate(request)
        } catch {
            // Rejected requests never belong to the delegate's task map.
            return
        }
        delegate.cancel(request)
    }

    private func validate(_ request: LynxResourceRequest) throws {
        if LynxManagedFontURL.owns(request.url) {
            _ = try LynxManagedFontURL.relativePath(request.url)
        }
    }
}
