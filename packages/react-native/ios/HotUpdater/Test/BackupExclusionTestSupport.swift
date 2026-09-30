#if canImport(Testing)
import Foundation

/// Reads the flag from disk: a new URL has no cached resource values. The
/// value is also true for an item inside an excluded directory.
func isExcludedFromBackup(_ url: URL) -> Bool {
    let freshURL = URL(fileURLWithPath: url.path)
    return (try? freshURL.resourceValues(forKeys: [.isExcludedFromBackupKey]))?
        .isExcludedFromBackup == true
}

func setExcludedFromBackup(_ url: URL, _ excluded: Bool) throws {
    var freshURL = URL(fileURLWithPath: url.path)
    var values = URLResourceValues()
    values.isExcludedFromBackup = excluded
    try freshURL.setResourceValues(values)
}
#endif
