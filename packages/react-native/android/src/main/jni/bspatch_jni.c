#include <jni.h>
#include <string.h>

#include "../../../../cpp/bspatch/hotupdater_bspatch.h"

JNIEXPORT jstring JNICALL
Java_com_hotupdater_BSPatchBridge_nativeApplyPatch(
    JNIEnv *env,
    jobject thiz,
    jstring old_path,
    jstring patch_path,
    jstring output_path) {
  const char *old_cstr = NULL;
  const char *patch_cstr = NULL;
  const char *output_cstr = NULL;
  char error_buffer[1024] = {0};
  int rc = -1;

  (void)thiz;

  if (!old_path || !patch_path || !output_path) {
    return (*env)->NewStringUTF(env, "Invalid native bspatch arguments");
  }

  old_cstr = (*env)->GetStringUTFChars(env, old_path, NULL);
  patch_cstr = (*env)->GetStringUTFChars(env, patch_path, NULL);
  output_cstr = (*env)->GetStringUTFChars(env, output_path, NULL);

  if (!old_cstr || !patch_cstr || !output_cstr) {
    if (old_cstr) {
      (*env)->ReleaseStringUTFChars(env, old_path, old_cstr);
    }
    if (patch_cstr) {
      (*env)->ReleaseStringUTFChars(env, patch_path, patch_cstr);
    }
    if (output_cstr) {
      (*env)->ReleaseStringUTFChars(env, output_path, output_cstr);
    }
    return (*env)->NewStringUTF(env, "Failed to read native path arguments");
  }

  rc = hotupdater_bspatch_file(
      old_cstr,
      patch_cstr,
      output_cstr,
      error_buffer,
      sizeof(error_buffer));

  (*env)->ReleaseStringUTFChars(env, old_path, old_cstr);
  (*env)->ReleaseStringUTFChars(env, patch_path, patch_cstr);
  (*env)->ReleaseStringUTFChars(env, output_path, output_cstr);

  if (rc == 0) {
    return NULL;
  }

  if (error_buffer[0] == '\0') {
    strncpy(error_buffer, "Unknown native bspatch failure", sizeof(error_buffer) - 1);
    error_buffer[sizeof(error_buffer) - 1] = '\0';
  }

  return (*env)->NewStringUTF(env, error_buffer);
}
