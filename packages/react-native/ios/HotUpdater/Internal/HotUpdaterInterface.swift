#if SWIFT_PACKAGE
import Foundation
import HotUpdaterInterface

// Swift Package Manager only: the Objective-C++ module reaches these classes
// through the protocols in HotUpdaterInterface.h, and these conformances make
// the compiler check that the classes still match them.
extension HotUpdaterImpl: HotUpdaterImplInterface {}

extension HotUpdaterConfig: HotUpdaterConfigInterface {}

@_cdecl("HotUpdaterMakeImpl")
public func hotUpdaterMakeImpl() -> HotUpdaterImplInterface {
    HotUpdaterImpl()
}

@_cdecl("HotUpdaterAppVersion")
public func hotUpdaterAppVersion() -> NSString? {
    HotUpdaterImpl.appVersion as NSString?
}

@_cdecl("HotUpdaterSharedConfig")
public func hotUpdaterSharedConfig() -> HotUpdaterConfigInterface {
    HotUpdaterConfig.shared
}
#endif
