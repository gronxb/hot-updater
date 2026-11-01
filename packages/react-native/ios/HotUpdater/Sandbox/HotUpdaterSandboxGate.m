// The sandbox's start gate. One chokepoint: the deepest
// -[RCTRootViewFactory viewWithModuleName:...], which every supported host reaches
// and inside which React Native starts JavaScript. A root requested before a person
// answers the first screen gets a stable container, and the real call waits. On a
// host without that method, the gate stays off and the app starts as usual.
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

#import "HotUpdaterSandboxEntryPoints.h"

extern BOOL HotUpdaterPerformRecoveryReload(void);

// What this file calls in the sandbox's Swift. Declared here, since the generated
// Swift header imports React, whose C++ headers a plain Objective-C file can't read
// when React Native is a prebuilt framework.
@interface HotUpdaterSandboxBridge : NSObject
+ (void)configureWithRelease:(void (^)(void))release reload:(BOOL (^)(void))reload isReleased:(BOOL (^)(void))isReleased;
+ (void)presentScreenIn:(nullable UIWindowScene *)scene;
+ (void)receiveLink:(NSURL *)url scene:(nullable UIWindowScene *)scene;
+ (void)hideScreen;
+ (void)keepKeyWindow:(UIWindow *)window;
@end

@interface HotUpdaterSandboxLaunchPolicy : NSObject
+ (BOOL)isForTheAppWithOptionKeys:(NSArray<NSString *> *)optionKeys urlScheme:(nullable NSString *)urlScheme;
+ (NSArray<NSString *> *)keysOfLink;
+ (BOOL)isSandboxScheme:(nullable NSString *)scheme;
@end

#define HULog(format, ...) NSLog(@"[HotUpdaterSandbox] " format, ##__VA_ARGS__)

/// How long a background root waits for a foreground or an entry point it knows.
static const NSTimeInterval kAmbiguousBackgroundSeconds = 2.0;
/// How long a silent push the host has no handler for keeps the app running.
static const NSTimeInterval kUnhandledPushSeconds = 20.0;
/// How long a launch still in the background keeps running once React Native started.
static const NSTimeInterval kBackgroundRunSeconds = 20.0;

static NSMutableArray<dispatch_block_t> *gHeld;
static BOOL gReleased;
static BOOL gScreenRequested;
/// The app's own link that arrived while held, handed to the held calls.
static NSURL *gOwnLinkWhileHeld;
/// What named the app when it released: a root held earlier is the one that
/// creates React Native's host, which keeps its launch options for `Linking`.
static NSDictionary *gOptionsThatReleased;

static BOOL IsSandboxLink(NSURL *url) {
  return url != nil && [HotUpdaterSandboxLaunchPolicy isSandboxScheme:url.scheme];
}

/// A launch in the background gets about half a second, and a root that waits there
/// would never get to the fallback below. This keeps the launch running, and ends as
/// soon as the app is in the foreground.
static UIBackgroundTaskIdentifier gHoldTask;
static BOOL gHasHoldTask;

static void EndHoldTask(void) {
  if (!gHasHoldTask) return;
  gHasHoldTask = NO;
  [UIApplication.sharedApplication endBackgroundTask:gHoldTask];
}

static void ReleaseReactNative(NSString *reason) {
  if (gReleased) return;
  gReleased = YES;
  HULog(@"released: %@, %lu held", reason, (unsigned long)gHeld.count);
  NSArray<dispatch_block_t> *held = gHeld;
  gHeld = nil;
  for (dispatch_block_t start in held) start();
  [HotUpdaterSandboxBridge hideScreen];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kBackgroundRunSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    EndHoldTask();
  });
}

/// A view a React Native host can hold on to as its root before one exists. It
/// stays what the host holds, so its constraints, overlays and references stay
/// valid: the real root goes inside, under whatever the host added. A host that
/// uses it as a root before then gets that real root, not a crash.
@interface HotUpdaterSandboxPlaceholderView : UIView
@property (nonatomic, strong, nullable) UIView *reactRoot;
@end

@implementation HotUpdaterSandboxPlaceholderView

- (void)adoptRoot:(UIView *)root {
  self.reactRoot = root;
  root.frame = self.bounds;
  root.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  [self insertSubview:root atIndex:0];
}

static BOOL IsReactRootClass(Class cls) {
  NSString *name = NSStringFromClass(cls);
  return [name isEqualToString:@"RCTRootView"] || [name isEqualToString:@"RCTSurfaceHostingProxyRootView"] ||
         [name isEqualToString:@"RCTSurfaceHostingView"];
}

- (BOOL)isKindOfClass:(Class)cls {
  return [super isKindOfClass:cls] || IsReactRootClass(cls);
}

- (BOOL)respondsToSelector:(SEL)selector {
  if ([super respondsToSelector:selector]) return YES;
  if (self.reactRoot) return [self.reactRoot respondsToSelector:selector];
  for (NSString *name in @[ @"RCTRootView", @"RCTSurfaceHostingProxyRootView", @"RCTSurfaceHostingView" ]) {
    Class cls = NSClassFromString(name);
    if (cls && [cls instancesRespondToSelector:selector]) return YES;
  }
  return NO;
}

- (id)forwardingTargetForSelector:(SEL)selector {
  if (!self.reactRoot && !gReleased) {
    HULog(@"the host used a held root as React Native's (%@): starting now", NSStringFromSelector(selector));
    ReleaseReactNative(@"host needs a real root");
  }
  return [self.reactRoot respondsToSelector:selector] ? self.reactRoot : [super forwardingTargetForSelector:selector];
}

@end

static UIWindowScene *ForegroundScene(void) {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if ([scene isKindOfClass:UIWindowScene.class] && scene.activationState != UISceneActivationStateBackground &&
        scene.activationState != UISceneActivationStateUnattached) {
      return (UIWindowScene *)scene;
    }
  }
  return nil;
}

/// A launch reports the background state even when it ends in the foreground, as
/// scene hosts do in willConnect and didFinishLaunching, so the screen waits for
/// the first foreground signal. Background work the gate knows releases on its
/// way in; anything else still in the background after a moment fails open.
static void RequestScreen(void) {
  if (gScreenRequested) return;
  gScreenRequested = YES;
  gHasHoldTask = YES;
  gHoldTask = [UIApplication.sharedApplication beginBackgroundTaskWithName:@"HotUpdaterSandboxHold"
                                                        expirationHandler:^{
                                                          EndHoldTask();
                                                        }];
  void (^attempt)(NSNotification *) = ^(NSNotification *note) {
    EndHoldTask();
    if (gReleased) return;
    UIWindowScene *scene = [note.object isKindOfClass:UIWindowScene.class] ? note.object : ForegroundScene();
    [HotUpdaterSandboxBridge presentScreenIn:scene];
  };
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  [center addObserverForName:UISceneWillEnterForegroundNotification object:nil queue:nil usingBlock:attempt];
  [center addObserverForName:UIApplicationDidBecomeActiveNotification object:nil queue:nil usingBlock:attempt];
  [center addObserverForName:UIWindowDidBecomeKeyNotification
                      object:nil
                       queue:nil
                  usingBlock:^(NSNotification *note) {
                    [HotUpdaterSandboxBridge keepKeyWindow:note.object];
                  }];
  if (ForegroundScene()) {
    [HotUpdaterSandboxBridge presentScreenIn:ForegroundScene()];
  } else if (UIApplication.sharedApplication.applicationState == UIApplicationStateInactive) {
    [HotUpdaterSandboxBridge presentScreenIn:nil];
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kAmbiguousBackgroundSeconds * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   if (!gReleased && UIApplication.sharedApplication.applicationState == UIApplicationStateBackground &&
                       !ForegroundScene()) {
                     ReleaseReactNative(@"ambiguous background launch");
                   }
                 });
}

/// What React Native sees: never a sandbox link, and the app's own that arrived while held.
static NSDictionary *CleanOptions(NSDictionary *options) {
  NSMutableDictionary *clean = [NSMutableDictionary new];
  [clean addEntriesFromDictionary:options ?: @{}];
  if (IsSandboxLink(clean[UIApplicationLaunchOptionsURLKey])) {
    [clean removeObjectsForKeys:[HotUpdaterSandboxLaunchPolicy keysOfLink]];
  }
  [clean addEntriesFromDictionary:gOptionsThatReleased ?: @{}];
  if (gOwnLinkWhileHeld && !clean[UIApplicationLaunchOptionsURLKey]) {
    clean[UIApplicationLaunchOptionsURLKey] = gOwnLinkWhileHeld;
  }
  return clean;
}

static UIView *Hold(NSDictionary *options, UIView * (^start)(NSDictionary *)) {
  NSURL *url = options[UIApplicationLaunchOptionsURLKey];
  if (IsSandboxLink(url)) {
    HULog(@"launch link kept from the app");
    [HotUpdaterSandboxBridge receiveLink:url scene:ForegroundScene()];
  }
  if (!gReleased && [HotUpdaterSandboxLaunchPolicy isForTheAppWithOptionKeys:options.allKeys ?: @[] urlScheme:url.scheme]) {
    gOptionsThatReleased = options;
    ReleaseReactNative(@"launch options name the app");
  }
  if (gReleased) return start(CleanOptions(options));
  HotUpdaterSandboxPlaceholderView *placeholder = [HotUpdaterSandboxPlaceholderView new];
  placeholder.backgroundColor = UIColor.systemBackgroundColor;
  if (!gHeld) gHeld = [NSMutableArray new];
  [gHeld addObject:^{
    [placeholder adoptRoot:start(CleanOptions(options))];
  }];
  RequestScreen();
  return placeholder;
}

typedef UIView * (*View5)(id, SEL, NSString *, NSDictionary *, NSDictionary *, id, id);
typedef UIView * (*View3)(id, SEL, NSString *, NSDictionary *, NSDictionary *);
static View5 gView5;
static View3 gView3;

static UIView *GatedView5(id self, SEL cmd, NSString *name, NSDictionary *props, NSDictionary *options, id bundle, id devMenu) {
  return Hold(options, ^UIView *(NSDictionary *clean) {
    return gView5(self, cmd, name, props, clean, bundle, devMenu);
  });
}

static UIView *GatedView3(id self, SEL cmd, NSString *name, NSDictionary *props, NSDictionary *options) {
  return Hold(options, ^UIView *(NSDictionary *clean) {
    return gView3(self, cmd, name, props, clean);
  });
}

// MARK: - Entry points

/// Background work starts React Native before the host's handler runs. In the
/// foreground the first screen is what a person is looking at, so a silent push
/// that arrives then leaves it up: the host's handler runs, and the app waits.
static void EnterForBackgroundWork(NSString *reason) {
  HULog(@"entry point: %@, state=%ld", reason, (long)UIApplication.sharedApplication.applicationState);
  if (UIApplication.sharedApplication.applicationState == UIApplicationStateBackground) {
    ReleaseReactNative(reason);
  }
}

static void ReceiveOwnLinkWhileHeld(NSURL *url) {
  if (gReleased) return;
  gOwnLinkWhileHeld = url;
  ReleaseReactNative(@"the app's own link");
}

/// What a class answers with now, inherited or its own, or NULL.
static IMP OriginalOf(Class cls, SEL selector) {
  Method method = class_getInstanceMethod(cls, selector);
  return method ? method_getImplementation(method) : NULL;
}

static NSMutableSet<Class> *gWrapped;

/// Wraps what a delegate's class answers, before the system first asks it.
static void WrapApplicationDelegate(Class cls) {
  if (!gWrapped) gWrapped = [NSMutableSet new];
  if ([gWrapped containsObject:cls]) return;
  [gWrapped addObject:cls];

  // Warm links: a sandbox link stops here, the app's own passes through.
  SEL openURL = @selector(application:openURL:options:);
  BOOL (*originalOpenURL)(id, SEL, UIApplication *, NSURL *, NSDictionary *) = (void *)OriginalOf(cls, openURL);
  class_replaceMethod(
      cls, openURL,
      imp_implementationWithBlock(^BOOL(id self, UIApplication *app, NSURL *url, NSDictionary *options) {
    if (IsSandboxLink(url)) {
      [HotUpdaterSandboxBridge receiveLink:url scene:ForegroundScene()];
      return YES;
    }
    ReceiveOwnLinkWhileHeld(url);
    return originalOpenURL ? originalOpenURL(self, openURL, app, url, options) : NO;
  }),
      "B@:@@@");

  // An activity or a shortcut is for the app. Its JavaScript must be there.
  SEL continueActivity = @selector(application:continueUserActivity:restorationHandler:);
  BOOL (*originalContinue)(id, SEL, UIApplication *, NSUserActivity *, id) = (void *)OriginalOf(cls, continueActivity);
  class_replaceMethod(
      cls, continueActivity,
      imp_implementationWithBlock(^BOOL(id self, UIApplication *app, NSUserActivity *activity, id handler) {
    ReleaseReactNative(@"user activity");
    return originalContinue ? originalContinue(self, continueActivity, app, activity, handler) : NO;
  }),
      "B@:@@@?");

  SEL shortcut = @selector(application:performActionForShortcutItem:completionHandler:);
  void (*originalShortcut)(id, SEL, UIApplication *, UIApplicationShortcutItem *, id) = (void *)OriginalOf(cls, shortcut);
  class_replaceMethod(
      cls, shortcut,
      imp_implementationWithBlock(^(id self, UIApplication *app, UIApplicationShortcutItem *item, void (^done)(BOOL)) {
    ReleaseReactNative(@"shortcut");
    if (originalShortcut) {
      originalShortcut(self, shortcut, app, item, done);
    } else {
      done(NO);
    }
  }),
      "v@:@@@?");

  HotUpdaterSandboxWrapBackgroundEntryPoints(cls, ^(NSString *reason) {
    EnterForBackgroundWork(reason);
  }, kUnhandledPushSeconds);
}

/// A scene's cold connection, and its warm links, activities and shortcuts.
static void WrapSceneDelegate(Class cls) {
  if (!gWrapped) gWrapped = [NSMutableSet new];
  if ([gWrapped containsObject:cls]) return;
  [gWrapped addObject:cls];

  SEL willConnect = @selector(scene:willConnectToSession:options:);
  void (*originalConnect)(id, SEL, UIScene *, UISceneSession *, UISceneConnectionOptions *) = (void *)OriginalOf(cls, willConnect);
  class_replaceMethod(
      cls, willConnect,
      imp_implementationWithBlock(^(id self, UIScene *scene, UISceneSession *session, UISceneConnectionOptions *options) {
    BOOL forTheApp = options.userActivities.count > 0 || options.notificationResponse != nil || options.shortcutItem != nil;
    for (UIOpenURLContext *context in options.URLContexts) {
      if (IsSandboxLink(context.URL)) {
        [HotUpdaterSandboxBridge receiveLink:context.URL scene:(UIWindowScene *)scene];
      } else {
        gOwnLinkWhileHeld = context.URL;
        forTheApp = YES;
      }
    }
    if (forTheApp) ReleaseReactNative(@"scene connection names the app");
    if (originalConnect) originalConnect(self, willConnect, scene, session, options);
  }),
      "v@:@@@");

  SEL openContexts = @selector(scene:openURLContexts:);
  void (*originalOpen)(id, SEL, UIScene *, NSSet<UIOpenURLContext *> *) = (void *)OriginalOf(cls, openContexts);
  class_replaceMethod(
      cls, openContexts,
      imp_implementationWithBlock(^(id self, UIScene *scene, NSSet<UIOpenURLContext *> *contexts) {
    NSMutableSet<UIOpenURLContext *> *others = [NSMutableSet new];
    for (UIOpenURLContext *context in contexts) {
      if (IsSandboxLink(context.URL)) {
        [HotUpdaterSandboxBridge receiveLink:context.URL scene:(UIWindowScene *)scene];
      } else {
        [others addObject:context];
        ReceiveOwnLinkWhileHeld(context.URL);
      }
    }
    if (others.count > 0 && originalOpen) originalOpen(self, openContexts, scene, others);
  }),
      "v@:@@");

  SEL continueActivity = @selector(scene:continueUserActivity:);
  void (*originalContinue)(id, SEL, UIScene *, NSUserActivity *) = (void *)OriginalOf(cls, continueActivity);
  class_replaceMethod(
      cls, continueActivity,
      imp_implementationWithBlock(^(id self, UIScene *scene, NSUserActivity *activity) {
    ReleaseReactNative(@"user activity");
    if (originalContinue) originalContinue(self, continueActivity, scene, activity);
  }),
      "v@:@@");

  SEL shortcut = @selector(windowScene:performActionForShortcutItem:completionHandler:);
  void (*originalShortcut)(id, SEL, UIWindowScene *, UIApplicationShortcutItem *, id) = (void *)OriginalOf(cls, shortcut);
  class_replaceMethod(
      cls, shortcut,
      imp_implementationWithBlock(^(id self, UIWindowScene *scene, UIApplicationShortcutItem *item, void (^done)(BOOL)) {
    ReleaseReactNative(@"shortcut");
    if (originalShortcut) {
      originalShortcut(self, shortcut, scene, item, done);
    } else {
      done(NO);
    }
  }),
      "v@:@@@?");
}

static void (*gSetDelegate)(id, SEL, id);
static void SetDelegate(id self, SEL cmd, id delegate) {
  if (delegate) WrapApplicationDelegate(object_getClass(delegate));
  gSetDelegate(self, cmd, delegate);
}

@interface HotUpdaterSandboxGate : NSObject
@end

@implementation HotUpdaterSandboxGate

+ (void)load {
  Class factory = objc_getClass("RCTRootViewFactory");
  SEL five = NSSelectorFromString(@"viewWithModuleName:initialProperties:launchOptions:bundleConfiguration:devMenuConfiguration:");
  SEL three = NSSelectorFromString(@"viewWithModuleName:initialProperties:launchOptions:");
  Method method5 = factory ? class_getInstanceMethod(factory, five) : NULL;
  Method method3 = factory ? class_getInstanceMethod(factory, three) : NULL;
  if (method5) {
    gView5 = (View5)method_setImplementation(method5, (IMP)GatedView5);
  } else if (method3) {
    gView3 = (View3)method_setImplementation(method3, (IMP)GatedView3);
  } else {
    HULog(@"this host has no root view method to gate: the app starts as usual");
    return;
  }

  [HotUpdaterSandboxBridge
      configureWithRelease:^{
        ReleaseReactNative(@"the screen opened the app");
      }
      reload:^BOOL {
        return HotUpdaterPerformRecoveryReload();
      }
      isReleased:^BOOL {
        return gReleased;
      }];

  Method setDelegate = class_getInstanceMethod(UIApplication.class, @selector(setDelegate:));
  gSetDelegate = (void *)method_setImplementation(setDelegate, (IMP)SetDelegate);
  [NSNotificationCenter.defaultCenter addObserverForName:UISceneWillConnectNotification
                                                  object:nil
                                                   queue:nil
                                              usingBlock:^(NSNotification *note) {
                                                id delegate = ((UIScene *)note.object).delegate;
                                                if (delegate) WrapSceneDelegate(object_getClass(delegate));
                                              }];

  // A host can start React Native by a route this method isn't on, such as an Expo
  // delegate handler that returns its own root. Its app is already running by the
  // time it's active, so links come up over it.
  __block id activeObserver = [NSNotificationCenter.defaultCenter
      addObserverForName:UIApplicationDidBecomeActiveNotification
                  object:nil
                   queue:NSOperationQueue.mainQueue
              usingBlock:^(NSNotification *note) {
                [NSNotificationCenter.defaultCenter removeObserver:activeObserver];
                activeObserver = nil;
                if (!gReleased && !gScreenRequested) {
                  HULog(@"no root reached the gate: this host started React Native another way, so the app starts as usual");
                  gReleased = YES;
                }
              }];

  Class scheduler = objc_getClass("BGTaskScheduler");
  if (scheduler) {
    HotUpdaterSandboxWrapTaskRegistration(scheduler, ^(NSString *reason) {
      EnterForBackgroundWork(reason);
    });
  }
}

@end
