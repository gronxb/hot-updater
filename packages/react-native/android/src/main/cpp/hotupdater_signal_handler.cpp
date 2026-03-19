#include <jni.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static char g_marker_path[512];
static struct sigaction g_previous_handlers[32];

static void write_crash_marker_json(int signal_value) {
  int fd = open(g_marker_path, O_CREAT | O_WRONLY | O_TRUNC, 0600);
  if (fd >= 0) {
    char json[512];
    int len = snprintf(
      json,
      sizeof(json),
      "{\"signal\":%d,\"crashLog\":\"signal=%d\\n\"}",
      signal_value,
      signal_value
    );
    if (len > 0 && len < (int)sizeof(json)) {
      (void)write(fd, json, len);
    }
    close(fd);
  }
}

static void hotupdater_signal_handler(int sig, siginfo_t *info, void *context) {
  write_crash_marker_json(sig);

  if (sig >= 0 && sig < 32) {
    struct sigaction *prev = &g_previous_handlers[sig];
    if (prev->sa_handler != SIG_DFL && prev->sa_handler != SIG_IGN && prev->sa_handler != NULL) {
      if (prev->sa_sigaction != hotupdater_signal_handler) {
        if (prev->sa_flags & SA_SIGINFO) {
          prev->sa_sigaction(sig, info, context);
        } else if (prev->sa_handler != SIG_DFL && prev->sa_handler != SIG_IGN) {
          prev->sa_handler(sig);
        }
      }
    }
  }

  signal(sig, SIG_DFL);
  raise(sig);
}

extern "C"
JNIEXPORT void JNICALL
Java_com_hotupdater_HotUpdaterCrashHandler_initNativeSignalHandler(
  JNIEnv *env,
  jclass,
  jstring markerPath
) {
  const char *path = env->GetStringUTFChars(markerPath, nullptr);
  snprintf(g_marker_path, sizeof(g_marker_path), "%s", path);
  env->ReleaseStringUTFChars(markerPath, path);

  struct sigaction action;
  sigemptyset(&action.sa_mask);
  action.sa_flags = SA_SIGINFO;
  action.sa_sigaction = hotupdater_signal_handler;

  int signals[] = {SIGABRT, SIGSEGV, SIGILL, SIGBUS, SIGFPE};
  int signal_count = sizeof(signals) / sizeof(signals[0]);

  for (int i = 0; i < signal_count; i++) {
    int sig = signals[i];
    sigaction(sig, NULL, &g_previous_handlers[sig]);
    sigaction(sig, &action, NULL);
  }
}
