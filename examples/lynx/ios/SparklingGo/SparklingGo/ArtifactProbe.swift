// Private G2 HTTP probe. No catalog authorization or public updater API is implied.
import Darwin
import Foundation
import HotUpdaterLynxArtifact

final class ArtifactProbe {
    private static let lock = NSLock()
    private static var stores: [String: LynxArtifactInstaller] = [:]
    // Task-owned QA key is compiled into the binary, never supplied by an artifact request.
    private static let testPublicKey = """
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA27kuqGkHVtg4wUR7jKzy
kdk7Bj71AhgqpBRhIVn5ih6296b3N37AVvwb0e9a7raVOPB61VcoSWeL1odHGWEd
R+HyhgOmuF50cmdXP/hjjFF6bXM2cOM4+6zSWdideMprFv+4WFBBzNO/DwxK/sUU
9Xix7H2oRFho6EZ9Mlj0WyJCYl5qLnjpsZ9lcOAeMS2LBSm5pz6+GIncHLYguopx
d5qC8eRWTh/MwaDF2ImUgG+QArriZj9ELNd7B/Z+EwzdgyqlCG3JdvfsHUokG10L
Lg7DmUvMYCYs/KLZzsR0Tjkl6drzp7wfNIg5ocAF0AstjZ+khAI5cl54Qv2P2OjN
mwIDAQAB
-----END PUBLIC KEY-----
"""
    static func installer(_ mode: String, home: URL) throws -> LynxArtifactInstaller {
        guard ["signed", "unsigned"].contains(mode) else { throw SpikeAdmissionError.invalid("Unknown native artifact store") }
        lock.lock(); defer { lock.unlock() }
        if let current = stores[mode] { return current }
        let value = try LynxArtifactInstaller(root: home.appendingPathComponent("artifact-store-\(mode)"), configuration: .init(runtimeId: SpikeArtifact.runtimeId, publicKeyPEM: mode == "signed" ? testPublicKey : nil))
        stores[mode] = value
        return value
    }
    static func startIfRequested() {
        guard let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--artifact-url=") }),
              let url = URL(string: String(argument.dropFirst("--artifact-url=".count))) else { return }
        let launch = SpikeLaunch.shared
        let revision = launch.journal?.state.selectionRevision ?? -1
        Task {
            do {
                let (data, response) = try await URLSession.shared.data(from: url)
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let receipt = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let releaseId = receipt["releaseId"] as? String, UUID(uuidString: releaseId) != nil,
                      let framework = receipt["framework"] as? String, ["react", "vue", "octane"].contains(framework) else { throw SpikeAdmissionError.invalid("Invalid private HTTP receipt") }
                let request = try JSONDecoder().decode(LynxArtifactRequest.self, from: data)
                let mode = ProcessInfo.processInfo.arguments.contains("--artifact-signed") ? "signed" : "unsigned"
                let store = try installer(mode, home: launch.home)
                launch.record("artifactDownloadStarted", ["candidateBundleId": request.bundleId, "signedConfiguration": mode == "signed"])
                let prepared = try await store.prepare(request)
                launch.record("artifactPrepared", ["candidateBundleId": prepared.bundleId, "preparedId": prepared.id])
                if ProcessInfo.processInfo.arguments.contains("--artifact-hold") {
                    try await Task.sleep(nanoseconds: 300_000_000_000)
                    try store.discard(prepared)
                    return
                }
                var selection = ["release": "\(framework)/\(request.bundleId)", "bundleId": request.bundleId,
                                 "releaseId": releaseId, "entry": prepared.entry, "embedded": "false",
                                 "scope": "g1-\(framework)", "artifactStore": mode]
                try launch.finalizeArtifact(candidate: selection, expectedRevision: revision) {
                    _ = try store.commit(prepared) { publish in
                        let installed = try publish()
                        selection["manifestFileHash"] = installed.manifestDigest
                        selection["requiredResources"] = String(data: try JSONSerialization.data(withJSONObject: ["assets/probe.png", "assets/probe.ttf", "assets/bootstrap.js"].filter { installed.files[$0] != nil }), encoding: .utf8)!
                        let bytes = try JSONSerialization.data(withJSONObject: selection, options: [.sortedKeys])
                        try bytes.write(to: launch.home.appendingPathComponent("launch.json"), options: .atomic)
                        let handle = try FileHandle(forWritingTo: launch.home.appendingPathComponent("launch.json"))
                        try handle.synchronize(); try handle.close()
                        let directory = Darwin.open(launch.home.path, O_RDONLY)
                        guard directory >= 0 else { throw SpikeAdmissionError.invalid("Cannot synchronize selection directory") }
                        defer { Darwin.close(directory) }
                        guard fsync(directory) == 0 else { throw SpikeAdmissionError.invalid("Cannot synchronize next selection") }
                    }
                }
                launch.record("artifactStaged", ["candidateBundleId": request.bundleId, "nextReleaseId": releaseId, "activeReleaseId": launch.info["releaseId"]!])
            } catch { launch.record("artifactRejected", ["error": error.localizedDescription]) }
        }
    }
}
