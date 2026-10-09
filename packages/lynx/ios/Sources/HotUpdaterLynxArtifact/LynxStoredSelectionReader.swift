import Foundation

/// Reads eligible committed selections without consuming foreground recovery records.
enum LynxStoredSelectionReader {
    static func copy(state original: LynxControllerState, scope: LynxNativeScope,
                     configuration config: LynxControllerConfiguration,
                     installer: LynxArtifactInstaller, cold: Bool,
                     processToken: String) throws -> LynxBackgroundSnapshot {
        var state = original
        if cold {
            var interrupted = (state.pendingPages ?? []).map(\.selection)
            if let pending = state.pending {
                let managedId = state.managedTransition?.transitionId
                let benign = try interrupted.isEmpty && pending.failed != true && managedId != nil
                    && (pending.transitionId == nil || pending.transitionId == managedId)
                    && LynxController.sameIdentity(pending.selection.policy, state.confirmed?.policy)
                if !benign { interrupted.append(pending.selection) }
            }
            for selected in interrupted {
                let receipt = try selected.policy
                if let id = receipt.releaseId, !state.unconfirmedReleaseIds.contains(id) {
                    state.unconfirmedReleaseIds.append(id)
                    state.interruptedReleases?.removeValue(forKey: id)
                }
                if receipt.bundleId == config.embeddedBundleId,
                   state.pendingPages?.isEmpty == false {
                    state.retainEmbeddedFailure(selected)
                }
            }
        }
        let cohort = try LynxCatalogPolicy.normalizedCohort(state.selectionCohort ?? config.cohort)
        for candidate in [state.next, state.confirmed, scope.builtin].compactMap({ $0 }) {
            let receipt = try candidate.policy
            let snapshot = LynxPolicySnapshot(
                revision: state.revision, platform: "ios", appVersion: config.appVersion,
                channel: receipt.channel, embeddedBundleId: config.embeddedBundleId,
                minimumBundleId: config.minimumBundleId, cohort: cohort,
                runningSelection: receipt, nextSelection: nil,
                crashedBundleIds: state.crashedBundleIds,
                unconfirmedReleaseIds: state.effectiveUnconfirmed(processToken: processToken),
                fingerprintHash: config.fingerprintHash
            )
            guard !snapshot.crashedBundleIds.contains(receipt.bundleId),
                  !snapshot.unconfirmedReleaseIds.contains(receipt.releaseId ?? ""),
                  LynxController.storedEligible(candidate, state: state, snapshot: snapshot) else { continue }
            let artifact: LynxInstalledArtifact
            if receipt.bundleId == config.embeddedBundleId {
                artifact = scope.embeddedArtifact
            } else {
                guard let installed = try? installer.inspectInstalled(
                    bundleId: receipt.bundleId, expectedManifestDigest: candidate.manifestDigest
                ) else { continue }
                artifact = installed
            }
            guard let entry = artifact.backgroundEntry, let hash = artifact.files[entry] else {
                throw LynxArtifactError.invalid("Selected Lynx artifact has no background entry")
            }
            let source = try LynxBackgroundScript.read(root: artifact.directory, entry: entry, expectedHash: hash)
            return LynxBackgroundSnapshot(selection: receipt, stored: candidate, entry: entry, source: source)
        }
        throw LynxArtifactError.invalid("No eligible Lynx background selection")
    }
}
