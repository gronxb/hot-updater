import Foundation
import Lynx
import XCTest
@testable import HotUpdaterLynxSparkling

final class ManagedFontResourceProviderTests: XCTestCase {
    private let canonical = "https://hot-updater-font.invalid/assets/probe.ttf?hot-updater-generation=2"

    func testMalformedOwnedURLsFailOnceWithoutDelegationOrCancellation() {
        let delegate = RecordingProvider()
        let provider = ManagedFontResourceProvider(delegate: delegate) { raw, _ in
            delegate.rejections.append(raw)
        }
        for raw in [
            " \n" + canonical + "\t",
            canonical.replacingOccurrences(of: "probe.ttf", with: "my font.ttf"),
            canonical.replacingOccurrences(of: "hot-updater-font", with: "hot-updater-\nfont"),
            canonical.replacingOccurrences(of: "hot-updater-font", with: "hot-updater-\rfont"),
            canonical.replacingOccurrences(of: "hot-updater-font", with: "hot-updater-\r\nfont"),
            canonical.replacingOccurrences(of: ".invalid/", with: ".invalid:bad/"),
            canonical.replacingOccurrences(of: ".invalid/", with: ".invalid:443/"),
            canonical.replacingOccurrences(of: ".invalid/", with: ".invalid./"),
            canonical.replacingOccurrences(of: "https://", with: "https://user@"),
            canonical.replacingOccurrences(of: "https://", with: "https:/"),
            canonical.replacingOccurrences(of: "https://", with: "https:\\\\"),
            canonical.replacingOccurrences(of: "https://", with: "http://"),
            canonical.replacingOccurrences(of: "https:", with: ""),
            canonical.replacingOccurrences(of: "https:", with: "")
                .replacingOccurrences(of: ".invalid/", with: ".invalid:bad/"),
            canonical.replacingOccurrences(of: "https://", with: "\\\\"),
            canonical.replacingOccurrences(of: "hot-updater-font", with: "%68ot-updater-font"),
            canonical.replacingOccurrences(of: "hot-updater-font", with: "ｈot-updater-font"),
            canonical.replacingOccurrences(of: ".invalid", with: "。invalid"),
            canonical.replacingOccurrences(of: "/assets/", with: "/../assets/"),
            canonical.replacingOccurrences(of: "probe.ttf", with: "%70robe.ttf"),
            canonical.replacingOccurrences(of: "=2", with: "=0"),
            String(canonical.prefix { $0 != "?" }),
            canonical + "#fragment",
        ] {
            let request = LynxResourceRequest(url: raw)
            var responses: [LynxResourceResponse] = []
            provider.request(request) {
                XCTAssertEqual(delegate.rejections.last, raw)
                responses.append($0)
            }
            XCTAssertEqual(responses.count, 1, raw)
            XCTAssertNotNil(responses.first?.error, raw)
            XCTAssertNil(responses.first?.data as? Data, raw)
            XCTAssertEqual(responses.first?.success(), false, raw)
            provider.cancel(request)
            XCTAssertEqual(delegate.rejections.filter { $0 == raw }.count, 1)
        }
        XCTAssertTrue(delegate.requests.isEmpty)
        XCTAssertTrue(delegate.cancellations.isEmpty)
    }

    func testAcceptedRequestsPreserveIdentityParametersAndCompletion() {
        let delegate = RecordingProvider()
        let provider = ManagedFontResourceProvider(delegate: delegate) { _, _ in
            XCTFail("Accepted requests must not report a synthetic failure")
        }
        for raw in [
            canonical,
            "https://hot-updater-font.invalid/assets/%ED%95%9C%EA%B8%80%20caf%C3%A9.ttf?hot-updater-generation=2",
            "https://example.test/font.ttf",
            "https://hot-updater-font.invalid.example/font.ttf",
            "https://hot-updater-font.invalid@example.test/font.ttf",
            "//hot-updater-font.invalid@example.test/font.ttf",
            "assets/hot-updater-font.invalid/font.ttf",
            "file:///ordinary/font.ttf",
            " ordinary input left for the original provider ",
        ] {
            let parameters = NSObject()
            let request = LynxResourceRequest(url: raw, andRequestParams: parameters)
            var responses: [LynxResourceResponse] = []
            provider.request(request) { responses.append($0) }
            XCTAssertTrue(responses.isEmpty, raw)
            XCTAssertTrue(delegate.requests.last === request, raw)
            XCTAssertTrue(delegate.requests.last?.requestParams as? NSObject === parameters, raw)
            let response = LynxResourceResponse(data: Data([1, 2, 3]))
            delegate.completeLast(response)
            XCTAssertEqual(responses.count, 1, raw)
            XCTAssertTrue(responses.first === response, raw)
        }
    }

    func testDelegateErrorAndCancellationAreForwardedUnchanged() {
        let delegate = RecordingProvider()
        let provider = ManagedFontResourceProvider(delegate: delegate) { _, _ in
            XCTFail("Delegate errors must not report a second failure")
        }
        for raw in [canonical, "https://example.test/font.ttf"] {
            let request = LynxResourceRequest(url: raw)
            var responses: [LynxResourceResponse] = []
            provider.request(request) { responses.append($0) }
            provider.cancel(request)
            XCTAssertTrue(delegate.cancellations.last === request)
            XCTAssertTrue(responses.isEmpty)
            let response = LynxResourceResponse(
                error: NSError(domain: "OriginalProvider", code: 42), code: 42
            )
            delegate.completeLast(response)
            XCTAssertEqual(responses.count, 1)
            XCTAssertTrue(responses.first === response)
        }
    }

    func testRejectedRequestDoesNotDisturbPendingOrdinaryRequest() {
        let delegate = RecordingProvider()
        let provider = ManagedFontResourceProvider(delegate: delegate) { raw, _ in
            delegate.rejections.append(raw)
        }
        let ordinary = LynxResourceRequest(url: "https://example.test/font.ttf")
        var responses: [LynxResourceResponse] = []
        provider.request(ordinary) { responses.append($0) }
        let rejected = LynxResourceRequest(url: " " + canonical)
        provider.request(rejected) { XCTAssertNotNil($0.error) }
        provider.cancel(rejected)
        XCTAssertEqual(delegate.rejections, [rejected.url])
        XCTAssertEqual(delegate.requests.count, 1)
        XCTAssertTrue(delegate.requests.first === ordinary)
        XCTAssertTrue(delegate.cancellations.isEmpty)
        let response = LynxResourceResponse(data: Data([1]))
        delegate.completeLast(response)
        XCTAssertEqual(responses.count, 1)
        XCTAssertTrue(responses.first === response)
    }
}

private final class RecordingProvider: NSObject, LynxResourceProvider {
    var requests: [LynxResourceRequest] = []
    var cancellations: [LynxResourceRequest] = []
    var rejections: [String] = []
    private var completions: [LynxResourceLoadBlock] = []

    func request(_ request: LynxResourceRequest, onComplete callback: @escaping LynxResourceLoadBlock) {
        requests.append(request)
        completions.append(callback)
    }

    func cancel(_ request: LynxResourceRequest) {
        cancellations.append(request)
    }

    func completeLast(_ response: LynxResourceResponse) {
        completions.removeLast()(response)
    }
}
