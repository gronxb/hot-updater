#import "AppDelegate.h"
#import <HotUpdater/HotUpdater.h>
#import <React/RCTBundleURLProvider.h>
#import <React/RCTLinkingManager.h>

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.moduleName = @"HotUpdaterExample";
  // E2E: a silent push launches the app in the background. Like React Native
  // Firebase, tell the root so it renders nothing for that launch.
  self.initialProps = @{@"isHeadless" : @(application.applicationState == UIApplicationStateBackground)};

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

// E2E: the scenarios drive the app through hotupdaterexample:// links.
- (BOOL)application:(UIApplication *)application
            openURL:(NSURL *)url
            options:(NSDictionary<UIApplicationOpenURLOptionsKey, id> *)options
{
  return [RCTLinkingManager application:application openURL:url options:options];
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  // This field
  return [HotUpdater bundleURL];
#endif
}

@end
