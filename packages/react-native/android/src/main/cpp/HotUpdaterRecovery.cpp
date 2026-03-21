#include <jni.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <cstring>
#include <limits.h>

namespace {
constexpr size_t kMaxBundleIdLength = 128;
constexpr int kSignals[] = {SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP};

char gCrashMarkerPath[PATH_MAX] = {0};
char gBundleId[kMaxBundleIdLength] = {0};
volatile sig_atomic_t gShouldRollback = 0;
struct sigaction gPreviousActions[NSIG];

void signalHandler(int signum, siginfo_t *info, void *context);

size_t safeStringLength(const char *value, size_t maxLength) {
  size_t length = 0;
  while (length < maxLength && value[length] != '\0') {
    ++length;
  }
  return length;
}

void safeCopy(char *destination, size_t destinationSize, const char *source) {
  if (destinationSize == 0) {
    return;
  }

  size_t index = 0;
  while (index + 1 < destinationSize && source[index] != '\0') {
    destination[index] = source[index];
    ++index;
  }
  destination[index] = '\0';
}

void safeCopyJString(JNIEnv *env, jstring source, char *destination, size_t destinationSize) {
  if (source == nullptr) {
    destination[0] = '\0';
    return;
  }

  const char *utfChars = env->GetStringUTFChars(source, nullptr);
  if (utfChars == nullptr) {
    destination[0] = '\0';
    return;
  }

  safeCopy(destination, destinationSize, utfChars);
  env->ReleaseStringUTFChars(source, utfChars);
}

void writeCrashMarker() {
  if (gCrashMarkerPath[0] == '\0') {
    return;
  }

  const int fd = open(gCrashMarkerPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    return;
  }

  constexpr char prefix[] = "{\"bundleId\":\"";
  constexpr char middle[] = "\",\"shouldRollback\":";
  constexpr char trueLiteral[] = "true";
  constexpr char falseLiteral[] = "false";
  constexpr char suffix[] = "}\n";

  write(fd, prefix, sizeof(prefix) - 1);
  if (gBundleId[0] != '\0') {
    write(fd, gBundleId, safeStringLength(gBundleId, kMaxBundleIdLength));
  }
  write(fd, middle, sizeof(middle) - 1);
  if (gShouldRollback != 0) {
    write(fd, trueLiteral, sizeof(trueLiteral) - 1);
  } else {
    write(fd, falseLiteral, sizeof(falseLiteral) - 1);
  }
  write(fd, suffix, sizeof(suffix) - 1);
  close(fd);
}

void forwardToPreviousHandler(int signum, siginfo_t *info, void *context) {
  const struct sigaction &previousAction = gPreviousActions[signum];

  if ((previousAction.sa_flags & SA_SIGINFO) != 0 && previousAction.sa_sigaction != nullptr &&
      previousAction.sa_sigaction != signalHandler) {
    previousAction.sa_sigaction(signum, info, context);
    return;
  }

  if (previousAction.sa_handler == SIG_IGN) {
    return;
  }

  if (previousAction.sa_handler != nullptr && previousAction.sa_handler != SIG_DFL &&
      previousAction.sa_handler != SIG_ERR) {
    previousAction.sa_handler(signum);
    return;
  }

  struct sigaction defaultAction {};
  defaultAction.sa_handler = SIG_DFL;
  sigemptyset(&defaultAction.sa_mask);
  sigaction(signum, &defaultAction, nullptr);
  raise(signum);
}

void signalHandler(int signum, siginfo_t *info, void *context) {
  writeCrashMarker();
  forwardToPreviousHandler(signum, info, context);
}
} // namespace

extern "C" JNIEXPORT void JNICALL
Java_com_hotupdater_HotUpdaterRecoveryManager_nativeInstallSignalHandler(
    JNIEnv *env,
    jobject /* this */,
    jstring crashMarkerPath) {
  safeCopyJString(env, crashMarkerPath, gCrashMarkerPath, sizeof(gCrashMarkerPath));

  struct sigaction action {};
  action.sa_sigaction = signalHandler;
  action.sa_flags = SA_SIGINFO | SA_ONSTACK;
  sigemptyset(&action.sa_mask);

  for (const int signum : kSignals) {
    sigaction(signum, &action, &gPreviousActions[signum]);
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_hotupdater_HotUpdaterRecoveryManager_nativeUpdateLaunchState(
    JNIEnv *env,
    jobject /* this */,
    jstring bundleId,
    jboolean shouldRollback) {
  safeCopyJString(env, bundleId, gBundleId, sizeof(gBundleId));
  gShouldRollback = shouldRollback ? 1 : 0;
}
