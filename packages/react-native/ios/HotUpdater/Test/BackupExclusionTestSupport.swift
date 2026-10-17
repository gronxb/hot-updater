#if canImport(Testing)
import Foundation

/// The extended attribute behind `URLResourceValues.isExcludedFromBackup`.
private let backupExclusionAttribute = "com.apple.metadata:com_apple_backup_excludeItem"

/// Whether `url` carries its own backup exclusion, read from disk. Unlike
/// `URLResourceValues.isExcludedFromBackup`, an item inside an excluded
/// directory does not count, so a file's own flag is checked as is.
func isExcludedFromBackup(_ url: URL) -> Bool {
    getxattr(url.path, backupExclusionAttribute, nil, 0, 0, XATTR_NOFOLLOW) >= 0
}

/// Removes the flag from `url` synchronously. Clearing it through
/// `setResourceValues` would also queue an asynchronous Spotlight update in
/// CoreServices that can remove the flag again after the code under test
/// sets it.
func clearExcludedFromBackup(_ url: URL) throws {
    guard removexattr(url.path, backupExclusionAttribute, XATTR_NOFOLLOW) == 0
        || errno == ENOATTR
    else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}
#endif
