package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NativeConfigUtilsTest {
    @Test
    fun `coerces typed manifest metadata to strings`() {
        assertEquals("123", NativeConfigUtils.coerceManifestMetaDataString(123))
        assertEquals("true", NativeConfigUtils.coerceManifestMetaDataString(true))
        assertEquals("-16711936", NativeConfigUtils.coerceManifestMetaDataString(-16711936))
    }

    @Test
    fun `ignores missing and empty manifest metadata`() {
        assertNull(NativeConfigUtils.coerceManifestMetaDataString(null))
        assertNull(NativeConfigUtils.coerceManifestMetaDataString(""))
    }
}
