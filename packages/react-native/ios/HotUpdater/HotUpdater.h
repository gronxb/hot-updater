#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <Foundation/Foundation.h>

// Declare the Objective-C++ module class which inherits from RCTEventEmitter
@interface HotUpdater : RCTEventEmitter <RCTBridgeModule>

/**
 * Returns the currently active bundle URL.
 * Callable from Objective-C (e.g., AppDelegate).
 * This is implemented in HotUpdater.mm and calls the Swift static method.
 */
+ (NSURL *)bundleURL;

// No need to declare the exported methods (setChannel, reload, etc.) here
// as RCT_EXPORT_METHOD handles their exposure to JavaScript.
// We also don't need to declare supportedEvents or requiresMainQueueSetup here
// as they are implemented in the .mm file (calling Swift).

@end