package com.hotupdater

import android.content.Context
import android.content.SharedPreferences
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class VersionedPreferencesServiceTest {
  private lateinit var mockContext: Context
  private lateinit var mockSharedPreferences: SharedPreferences
  private lateinit var mockEditor: SharedPreferences.Editor
  private lateinit var service: VersionedPreferencesService

  private val testIsolationKey = "test-isolation-key"
  private val preferences = mutableMapOf<String, String?>()

  @BeforeEach
  fun setUp() {
    preferences.clear()

    mockContext = mockk()
    mockSharedPreferences = mockk()
    mockEditor = mockk(relaxed = true)

    // Mock SharedPreferences behavior
    every { mockContext.getSharedPreferences(any(), any()) } returns mockSharedPreferences
    every { mockSharedPreferences.edit() } returns mockEditor
    every { mockEditor.putString(any(), any()) } answers {
      val key = firstArg<String>()
      val value = secondArg<String?>()
      preferences[key] = value
      mockEditor
    }
    every { mockEditor.remove(any()) } answers {
      val key = firstArg<String>()
      preferences.remove(key)
      mockEditor
    }
    every { mockSharedPreferences.getString(any(), any()) } answers {
      val key = firstArg<String>()
      val defaultValue = secondArg<String?>()
      preferences[key] ?: defaultValue
    }

    service = VersionedPreferencesService(mockContext, testIsolationKey)
  }

  @Test
  fun `setItem and getItem should work correctly`() {
    val key = "test-key"
    val value = "test-value"

    service.setItem(key, value)
    val retrievedValue = service.getItem(key)

    assertEquals(value, retrievedValue, "Retrieved value should match set value")
  }

  @Test
  fun `getItem should return null for non-existent key`() {
    val key = "non-existent-key"
    val retrievedValue = service.getItem(key)

    assertNull(retrievedValue, "Non-existent key should return null")
  }

  @Test
  fun `setItem should overwrite existing value`() {
    val key = "test-key"
    val firstValue = "first-value"
    val secondValue = "second-value"

    service.setItem(key, firstValue)
    service.setItem(key, secondValue)

    val retrievedValue = service.getItem(key)

    assertEquals(secondValue, retrievedValue, "Second value should overwrite first value")
  }

  @Test
  fun `isolation key should prevent key collision`() {
    val key = "test-key"
    val value1 = "value1"
    val value2 = "value2"

    // Create services with different isolation keys
    val service1 = VersionedPreferencesService(mockContext, "isolation-1")
    val service2 = VersionedPreferencesService(mockContext, "isolation-2")

    service1.setItem(key, value1)
    service2.setItem(key, value2)

    val retrievedValue1 = service1.getItem(key)
    val retrievedValue2 = service2.getItem(key)

    assertEquals(value1, retrievedValue1, "Value from isolation-1 should be preserved")
    assertEquals(value2, retrievedValue2, "Value from isolation-2 should be preserved")
  }

  @Test
  fun `setItem should use correct storage key format`() {
    val key = "test-key"
    val value = "test-value"

    service.setItem(key, value)

    val expectedStorageKey = "$testIsolationKey:$key"
    verify { mockEditor.putString(expectedStorageKey, value) }
  }
}
