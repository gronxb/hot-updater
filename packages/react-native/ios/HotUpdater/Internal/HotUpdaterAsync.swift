#if SWIFT_PACKAGE
// Swift Package Manager: this file is the `HotUpdater` module apps import. It
// re-exports the Objective-C++ module and the Swift implementation, such as
// `HotUpdaterInstance`, so `import HotUpdater` reaches both.
@_exported import HotUpdaterObjC
@_exported import HotUpdaterSwift
#endif
