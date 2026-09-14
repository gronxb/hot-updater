@testable import HotUpdaterLynxSparklingCore
import XCTest

final class SparklingManagedNavigationTests: XCTestCase {
    private let pages: Set<String> = [
        "detail.lynx.bundle", "main.lynx.bundle",
    ]

    func testCanonicalRoutePreservesOrderedParameters() throws {
        let route = try HotUpdaterSparklingRouteParser.parse(
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&message=hello+world&emoji=%F0%9F%8C%9F",
            allowlistedEntries: pages
        )
        XCTAssertEqual(route.entry, "detail.lynx.bundle")
        XCTAssertEqual(route.parameters, [
            .init(name: "message", value: "hello world"),
            .init(name: "emoji", value: "🌟"),
        ])
    }

    func testRouteRejectsUnknownReservedDuplicateAndNoncanonicalInput() {
        let rejectedRoutes = [
            "hybrid://lynxview_page?bundle=missing.lynx.bundle",
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&url=x",
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&x=1&x=2",
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&x=%2f",
            "HYBRID://lynxview_page?bundle=detail.lynx.bundle",
            "hybrid://lynxview_page/path?bundle=detail.lynx.bundle",
            "hybrid://lynxview_page?bundle=detail.lynx.bundle#fragment",
        ]
        for raw in rejectedRoutes {
            XCTAssertThrowsError(try HotUpdaterSparklingRouteParser.parse(
                raw,
                allowlistedEntries: pages
            ), raw)
        }
    }

    func testRawRouteByteLimitAcceptsExactMaximumAndRejectsOneMore() throws {
        let prefix = "hybrid://lynxview_page?bundle=detail.lynx.bundle&a="
            + String(repeating: "%C3%A9", count: 512)
            + "&b="
        let exact = prefix + String(
            repeating: "x",
            count: HotUpdaterSparklingRouteParser.maximumRawRouteBytes
                - prefix.utf8.count
        )
        XCTAssertEqual(
            exact.utf8.count,
            HotUpdaterSparklingRouteParser.maximumRawRouteBytes
        )
        XCTAssertNoThrow(try HotUpdaterSparklingRouteParser.parse(
            exact,
            allowlistedEntries: pages
        ))
        XCTAssertThrowsError(try HotUpdaterSparklingRouteParser.parse(
            exact + "x",
            allowlistedEntries: pages
        ))
    }

    func testCustomParameterCountAccepts32AndRejects33() throws {
        let base = "hybrid://lynxview_page?bundle=detail.lynx.bundle"
        let parameters = (0..<33).map { "p\($0)=x" }
        XCTAssertNoThrow(try HotUpdaterSparklingRouteParser.parse(
            base + "&" + parameters.prefix(32).joined(separator: "&"),
            allowlistedEntries: pages
        ))
        XCTAssertThrowsError(try HotUpdaterSparklingRouteParser.parse(
            base + "&" + parameters.joined(separator: "&"),
            allowlistedEntries: pages
        ))
    }

    func testDecodedKeyValueAndAggregateByteLimits() throws {
        let base = "hybrid://lynxview_page?bundle=detail.lynx.bundle"
        let exactKey = String(repeating: "k", count: 128)
        XCTAssertNoThrow(try HotUpdaterSparklingRouteParser.parse(
            base + "&" + exactKey + "=x",
            allowlistedEntries: pages
        ))
        XCTAssertThrowsError(try HotUpdaterSparklingRouteParser.parse(
            base + "&" + exactKey + "k=x",
            allowlistedEntries: pages
        ))

        let exactValue = String(repeating: "x", count: 1_024)
        XCTAssertNoThrow(try HotUpdaterSparklingRouteParser.parse(
            base + "&value=" + exactValue,
            allowlistedEntries: pages
        ))
        XCTAssertThrowsError(try HotUpdaterSparklingRouteParser.parse(
            base + "&value=" + exactValue + "x",
            allowlistedEntries: pages
        ))
        XCTAssertNoThrow(try HotUpdaterSparklingRouteParser.parse(
            base + "&emoji=" + String(repeating: "%F0%9F%8C%9F", count: 256),
            allowlistedEntries: pages
        ))
        XCTAssertThrowsError(try HotUpdaterSparklingRouteParser.parse(
            base + "&emoji=" + String(repeating: "%F0%9F%8C%9F", count: 257),
            allowlistedEntries: pages
        ))

        let exactAggregate = base
            + "&x=" + String(repeating: "x", count: 1_024)
            + "&y=" + String(repeating: "y", count: 998)
        XCTAssertNoThrow(try HotUpdaterSparklingRouteParser.parse(
            exactAggregate,
            allowlistedEntries: pages
        ))
        XCTAssertThrowsError(try HotUpdaterSparklingRouteParser.parse(
            exactAggregate + "y",
            allowlistedEntries: pages
        ))
    }

    func testOptionsPermitOnlyPushAndAnimation() throws {
        XCTAssertTrue(try HotUpdaterSparklingOpenOptions(animated: true).animated)
        XCTAssertThrowsError(try HotUpdaterSparklingOpenOptions(replace: true))
        XCTAssertThrowsError(try HotUpdaterSparklingOpenOptions(
            useSystemBrowser: true
        ))
        XCTAssertThrowsError(try HotUpdaterSparklingOpenOptions(
            unknownKeys: ["futureOption"]
        ))
    }

    func testStackReconstructionAndTopAuthorizationAreExact() throws {
        let stack = [
            HotUpdaterSparklingLogicalPage(entry: "main.lynx.bundle"),
            HotUpdaterSparklingLogicalPage(
                entry: "detail.lynx.bundle",
                parameters: [.init(name: "id", value: "42")]
            ),
        ]
        XCTAssertNoThrow(try HotUpdaterSparklingStackContract
            .validateReconstruction(stack, allowlistedEntries: pages))
        XCTAssertThrowsError(try HotUpdaterSparklingStackContract
            .validateReconstruction(
                stack + [.init(entry: "removed.lynx.bundle")],
                allowlistedEntries: pages
            ))
        XCTAssertNoThrow(try HotUpdaterSparklingStackContract.authorizeTop(
            sourceContextId: "detail-context",
            requestedContainerId: "detail-container",
            topContextId: "detail-context",
            topContainerId: "detail-container"
        ))
        XCTAssertThrowsError(try HotUpdaterSparklingStackContract.authorizeTop(
            sourceContextId: "main-context",
            requestedContainerId: nil,
            topContextId: "detail-context",
            topContainerId: "detail-container"
        ))
    }

    func testStackLimitRejectsBeforeCallerStackOrJournalMutation() throws {
        var stack = (0..<HotUpdaterSparklingStackContract.maximumPageCount)
            .map { index in
                HotUpdaterSparklingLogicalPage(
                    entry: index == 0
                        ? "main.lynx.bundle"
                        : "detail.lynx.bundle"
                )
            }
        let journal = SparklingGenerationEventJournal()
        XCTAssertNoThrow(try HotUpdaterSparklingStackContract
            .validateReconstruction(stack, allowlistedEntries: pages))

        func append(_ rawRoute: String) throws {
            let route = try HotUpdaterSparklingRouteParser.parse(
                rawRoute,
                allowlistedEntries: pages
            )
            try HotUpdaterSparklingStackContract.validatePageCount(
                stack.count + 1
            )
            stack.append(.init(
                entry: route.entry,
                parameters: route.parameters
            ))
            XCTAssertTrue(journal.append(name: "pageOpened", details: [:]))
        }

        let validRoute = "hybrid://lynxview_page?bundle=detail.lynx.bundle"
        XCTAssertThrowsError(try append(validRoute))
        XCTAssertEqual(
            stack.count,
            HotUpdaterSparklingStackContract.maximumPageCount
        )
        XCTAssertEqual(
            (try journal.snapshot()["events"] as? [[String: Any]])?.count,
            0
        )

        let oversizedRoute = validRoute + String(repeating: "x", count: 4_097)
        XCTAssertThrowsError(try append(oversizedRoute))
        XCTAssertEqual(
            stack.count,
            HotUpdaterSparklingStackContract.maximumPageCount
        )
        XCTAssertEqual(
            (try journal.snapshot()["events"] as? [[String: Any]])?.count,
            0
        )
    }

    func testPageAdmissionRequiresEverySignalAndTerminatesOnce() {
        let admission = HotUpdaterSparklingPageAdmission(
            requiredResources: ["detail.lynx.bundle", "assets/detail.png"]
        )
        XCTAssertFalse(admission.observeAppReady())
        XCTAssertFalse(admission.observeResource("detail.lynx.bundle"))
        XCTAssertFalse(admission.observeFirstContent())
        XCTAssertTrue(admission.observeResource("assets/detail.png"))
        XCTAssertEqual(admission.terminal, .admitted)
        XCTAssertFalse(admission.finish(.fatal))

        let cancelled = HotUpdaterSparklingPageAdmission(
            requiredResources: ["detail.lynx.bundle"]
        )
        XCTAssertTrue(cancelled.finish(.cancelled))
        XCTAssertFalse(cancelled.observeAppReady())
        XCTAssertEqual(cancelled.terminal, .cancelled)
    }
}
