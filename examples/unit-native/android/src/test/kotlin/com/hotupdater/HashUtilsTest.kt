package com.hotupdater

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.io.File
import java.nio.file.Files

class HashUtilsTest {
  @Test
  fun `calculateSHA256 should return correct hash for valid data`() {
    val testData = "Hello, World!".toByteArray()
    val tempFile = createTempFile(testData)

    try {
      val hash = HashUtils.calculateSHA256(tempFile)

      // Expected SHA256 hash of "Hello, World!"
      val expectedHash = "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f"

      assertEquals(expectedHash, hash, "SHA256 hash should match expected value")
    } finally {
      tempFile.delete()
    }
  }

  @Test
  fun `calculateSHA256 should return correct hash for empty data`() {
    val testData = ByteArray(0)
    val tempFile = createTempFile(testData)

    try {
      val hash = HashUtils.calculateSHA256(tempFile)

      // Expected SHA256 hash of empty data
      val expectedHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

      assertEquals(expectedHash, hash, "SHA256 hash of empty data should match expected value")
    } finally {
      tempFile.delete()
    }
  }

  @Test
  fun `verifyHash should not throw exception with matching hash`() {
    val testData = "Hello, World!".toByteArray()
    val tempFile = createTempFile(testData)
    val expectedHash = "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f"

    try {
      // Should not throw exception
      HashUtils.verifyHash(tempFile, expectedHash)
    } finally {
      tempFile.delete()
    }
  }

  @Test
  fun `verifyHash should throw exception with mismatched hash`() {
    val testData = "Hello, World!".toByteArray()
    val tempFile = createTempFile(testData)
    val wrongHash = "0000000000000000000000000000000000000000000000000000000000000000"

    try {
      assertThrows(IllegalStateException::class.java) {
        HashUtils.verifyHash(tempFile, wrongHash)
      }
    } finally {
      tempFile.delete()
    }
  }

  private fun createTempFile(data: ByteArray): File {
    val tempFile = Files.createTempFile("test", ".tmp").toFile()
    tempFile.writeBytes(data)
    return tempFile
  }
}
