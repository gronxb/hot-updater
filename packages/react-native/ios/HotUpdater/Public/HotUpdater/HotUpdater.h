// Swift Package Manager only: the Objective-C++ target is HotUpdaterObjC there
// (see Package.swift), so this keeps `#import <HotUpdater/HotUpdater.h>`, the
// import CocoaPods builds use, working for Objective-C apps.
#import "../HotUpdater.h"
