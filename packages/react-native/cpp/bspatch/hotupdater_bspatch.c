#include "hotupdater_bspatch.h"

#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static const char k_patch_magic[] = "ENDSLEY/BSDIFF43";
static const size_t k_patch_magic_len = 16;
static const size_t k_patch_header_len = 24;

static void set_error(
    char *error_message,
    size_t error_message_len,
    const char *fmt,
    ...) {
  if (!error_message || error_message_len == 0) {
    return;
  }

  va_list args;
  va_start(args, fmt);
  vsnprintf(error_message, error_message_len, fmt, args);
  va_end(args);
}

static int64_t decode_signed_int64(const uint8_t buf[8]) {
  int64_t y;

  y = (int64_t)buf[7] & 0x7f;
  y = y * 256 + (int64_t)buf[6];
  y = y * 256 + (int64_t)buf[5];
  y = y * 256 + (int64_t)buf[4];
  y = y * 256 + (int64_t)buf[3];
  y = y * 256 + (int64_t)buf[2];
  y = y * 256 + (int64_t)buf[1];
  y = y * 256 + (int64_t)buf[0];

  if (buf[7] & 0x80) {
    y = -y;
  }

  return y;
}

static int read_file_fully(
    const char *path,
    uint8_t **bytes,
    size_t *size,
    char *error_message,
    size_t error_message_len) {
  struct stat st;
  FILE *file = NULL;
  uint8_t *buffer = NULL;
  size_t read_total = 0;

  if (!path || !bytes || !size) {
    set_error(error_message, error_message_len, "Invalid read_file arguments");
    return -1;
  }

  if (stat(path, &st) != 0) {
    set_error(
        error_message,
        error_message_len,
        "Failed to stat file '%s': %s",
        path,
        strerror(errno));
    return -1;
  }

  if (st.st_size < 0) {
    set_error(error_message, error_message_len, "Negative file size for '%s'", path);
    return -1;
  }

  if ((uintmax_t)st.st_size > SIZE_MAX) {
    set_error(error_message, error_message_len, "File too large '%s'", path);
    return -1;
  }

  *size = (size_t)st.st_size;
  buffer = (uint8_t *)malloc(*size > 0 ? *size : 1);
  if (!buffer) {
    set_error(error_message, error_message_len, "Out of memory while reading '%s'", path);
    return -1;
  }

  file = fopen(path, "rb");
  if (!file) {
    set_error(
        error_message,
        error_message_len,
        "Failed to open file '%s': %s",
        path,
        strerror(errno));
    free(buffer);
    return -1;
  }

  while (read_total < *size) {
    size_t chunk = fread(buffer + read_total, 1, *size - read_total, file);
    if (chunk == 0) {
      if (ferror(file)) {
        set_error(error_message, error_message_len, "Failed to read '%s'", path);
      } else {
        set_error(error_message, error_message_len, "Unexpected EOF while reading '%s'", path);
      }
      fclose(file);
      free(buffer);
      return -1;
    }
    read_total += chunk;
  }

  if (fclose(file) != 0) {
    set_error(error_message, error_message_len, "Failed to close '%s'", path);
    free(buffer);
    return -1;
  }

  *bytes = buffer;
  return 0;
}

static int write_file_fully(
    const char *path,
    const uint8_t *bytes,
    size_t size,
    mode_t mode,
    char *error_message,
    size_t error_message_len) {
  FILE *file = NULL;
  size_t written = 0;

  if (!path || (!bytes && size > 0)) {
    set_error(error_message, error_message_len, "Invalid write_file arguments");
    return -1;
  }

  file = fopen(path, "wb");
  if (!file) {
    set_error(
        error_message,
        error_message_len,
        "Failed to open output '%s': %s",
        path,
        strerror(errno));
    return -1;
  }

  while (written < size) {
    size_t chunk = fwrite(bytes + written, 1, size - written, file);
    if (chunk == 0) {
      set_error(error_message, error_message_len, "Failed to write output '%s'", path);
      fclose(file);
      return -1;
    }
    written += chunk;
  }

  if (fclose(file) != 0) {
    set_error(error_message, error_message_len, "Failed to close output '%s'", path);
    return -1;
  }

  if (chmod(path, mode) != 0) {
    set_error(
        error_message,
        error_message_len,
        "Failed to set output mode for '%s': %s",
        path,
        strerror(errno));
    return -1;
  }

  return 0;
}

static int apply_bsdiff43(
    const uint8_t *old_bytes,
    size_t old_size,
    const uint8_t *patch_bytes,
    size_t patch_size,
    uint8_t **new_bytes,
    size_t *new_size,
    char *error_message,
    size_t error_message_len) {
  int64_t target_size_i64;
  size_t cursor;
  int64_t old_pos;
  int64_t new_pos;
  uint8_t *output;

  if (!old_bytes || !patch_bytes || !new_bytes || !new_size) {
    set_error(error_message, error_message_len, "Invalid patch arguments");
    return -1;
  }

  if (patch_size < k_patch_header_len) {
    set_error(error_message, error_message_len, "Patch is too small");
    return -1;
  }

  if (memcmp(patch_bytes, k_patch_magic, k_patch_magic_len) != 0) {
    set_error(error_message, error_message_len, "Invalid patch magic (expected ENDSLEY/BSDIFF43)");
    return -1;
  }

  target_size_i64 = decode_signed_int64(patch_bytes + k_patch_magic_len);
  if (target_size_i64 < 0) {
    set_error(error_message, error_message_len, "Invalid target size in patch header");
    return -1;
  }

  if ((uintmax_t)target_size_i64 > SIZE_MAX) {
    set_error(error_message, error_message_len, "Target size is too large");
    return -1;
  }

  *new_size = (size_t)target_size_i64;
  output = (uint8_t *)malloc(*new_size > 0 ? *new_size : 1);
  if (!output) {
    set_error(error_message, error_message_len, "Out of memory while applying patch");
    return -1;
  }

  cursor = k_patch_header_len;
  old_pos = 0;
  new_pos = 0;

  while (new_pos < target_size_i64) {
    int64_t ctrl_add;
    int64_t ctrl_copy;
    int64_t ctrl_seek;
    int64_t i;

    if (cursor > patch_size || patch_size - cursor < 24) {
      set_error(error_message, error_message_len, "Patch truncated in control block");
      free(output);
      return -1;
    }

    ctrl_add = decode_signed_int64(patch_bytes + cursor);
    ctrl_copy = decode_signed_int64(patch_bytes + cursor + 8);
    ctrl_seek = decode_signed_int64(patch_bytes + cursor + 16);
    cursor += 24;

    if (ctrl_add < 0 || ctrl_copy < 0) {
      set_error(error_message, error_message_len, "Negative add/copy length in control block");
      free(output);
      return -1;
    }

    if (new_pos + ctrl_add > target_size_i64 || new_pos + ctrl_copy > target_size_i64 - ctrl_add) {
      set_error(error_message, error_message_len, "Patch output exceeds target size");
      free(output);
      return -1;
    }

    if (cursor > patch_size || (uintmax_t)ctrl_add > patch_size - cursor) {
      set_error(error_message, error_message_len, "Patch truncated in diff segment");
      free(output);
      return -1;
    }

    for (i = 0; i < ctrl_add; i++) {
      uint8_t value = patch_bytes[cursor + (size_t)i];
      int64_t source_index = old_pos + i;
      if (source_index >= 0 && (uintmax_t)source_index < old_size) {
        value = (uint8_t)(value + old_bytes[(size_t)source_index]);
      }
      output[(size_t)(new_pos + i)] = value;
    }

    cursor += (size_t)ctrl_add;
    new_pos += ctrl_add;
    old_pos += ctrl_add;

    if (cursor > patch_size || (uintmax_t)ctrl_copy > patch_size - cursor) {
      set_error(error_message, error_message_len, "Patch truncated in extra segment");
      free(output);
      return -1;
    }

    memcpy(output + (size_t)new_pos, patch_bytes + cursor, (size_t)ctrl_copy);

    cursor += (size_t)ctrl_copy;
    new_pos += ctrl_copy;
    old_pos += ctrl_seek;
  }

  *new_bytes = output;
  return 0;
}

int hotupdater_bspatch_file(
    const char *old_path,
    const char *patch_path,
    const char *new_path,
    char *error_message,
    size_t error_message_len) {
  uint8_t *old_bytes = NULL;
  size_t old_size = 0;
  uint8_t *patch_bytes = NULL;
  size_t patch_size = 0;
  uint8_t *new_bytes = NULL;
  size_t new_size = 0;
  struct stat old_stat;
  mode_t output_mode = 0644;
  int rc = -1;

  if (!old_path || !patch_path || !new_path) {
    set_error(error_message, error_message_len, "Invalid input/output paths");
    return -1;
  }

  if (stat(old_path, &old_stat) != 0) {
    set_error(
        error_message,
        error_message_len,
        "Failed to stat old file '%s': %s",
        old_path,
        strerror(errno));
    return -1;
  }

  output_mode = old_stat.st_mode & 0777;

  if (read_file_fully(old_path, &old_bytes, &old_size, error_message, error_message_len) != 0) {
    goto cleanup;
  }

  if (read_file_fully(
          patch_path,
          &patch_bytes,
          &patch_size,
          error_message,
          error_message_len) != 0) {
    goto cleanup;
  }

  if (apply_bsdiff43(
          old_bytes,
          old_size,
          patch_bytes,
          patch_size,
          &new_bytes,
          &new_size,
          error_message,
          error_message_len) != 0) {
    goto cleanup;
  }

  if (write_file_fully(
          new_path,
          new_bytes,
          new_size,
          output_mode,
          error_message,
          error_message_len) != 0) {
    goto cleanup;
  }

  rc = 0;

cleanup:
  free(old_bytes);
  free(patch_bytes);
  free(new_bytes);
  return rc;
}
