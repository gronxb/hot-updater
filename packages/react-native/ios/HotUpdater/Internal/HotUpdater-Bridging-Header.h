#ifndef HotUpdater_Bridging_Header_h
#define HotUpdater_Bridging_Header_h

#import "React/RCTBridgeModule.h"
#import "React/RCTEventEmitter.h"
#import "React/RCTAssert.h"
#import "React/RCTConstants.h"
#import "React/RCTRootView.h"
#import "React/RCTUtils.h" // Needed for RCTPromiseResolveBlock/RejectBlock in Swift
#import <SSZipArchive/SSZipArchive.h>

@interface HotUpdaterRecoverySignalBridge : NSObject
+ (void)installSignalHandlers:(NSString *)crashMarkerPath;
+ (void)updateLaunchState:(NSString * _Nullable)bundleId shouldRollback:(BOOL)shouldRollback;
@end
#endif /* HotUpdater_Bridging_Header_h */
