package com.hotupdater

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class StrictJsonTest {
    @Test
    fun `deep nesting parses as JSON parse accepts it`() {
        fun nested(depth: Int) = "[".repeat(depth) + "]".repeat(depth)
        assertNotNull(StrictJson.parse(nested(60_000)))
        assertNotNull(StrictJson.parse("{\"a\":".repeat(60_000) + "1" + "}".repeat(60_000)))
        assertNull(StrictJson.parse("[".repeat(60_000) + "1," + "]".repeat(60_000)))
    }

    @Test
    fun `accepts what JSON parse accepts`() {
        listOf(
            "{}",
            "[]",
            " {\"a\": [1, -2.5e+3, true, false, null, \"\\u00e9\\n\"]} \n",
            "0",
            "\"x\"",
            "[[[[]]]]",
        ).forEach { assertTrue(it, StrictJson.isValid(it)) }
    }

    @Test
    fun `rejects what JSON parse rejects`() {
        listOf(
            "",
            "{",
            "{\"a\":1,}",
            "[1,]",
            "{'a':1}",
            "{a:1}",
            "/* c */{}",
            "{} // c",
            "01",
            "0x1",
            "NaN",
            "+1",
            "1.",
            ".5",
            "\"a\tb\"",
            "\"\\x\"",
            "\uFEFF{}",
            "{} {}",
            "[".repeat(200_000),
        ).forEach { assertFalse(it.take(40), StrictJson.isValid(it)) }
    }

    @Test
    fun `parses values as JSON parse does`() {
        val value =
            StrictJson.parse(
                "{\"a\": [1, -2.5e+3, true, null, \"\\u00e9\\n\\ud800\"], \"a2\": {}, \"k\": 1, \"k\": 2}",
            ) as JSONObject
        val array = value.get("a") as JSONArray
        assertEquals(1.0, array.get(0))
        assertEquals(-2500.0, array.get(1))
        assertEquals(true, array.get(2))
        assertSame(JSONObject.NULL, array.get(3))
        // An unpaired surrogate is kept, as in JavaScript.
        assertEquals("\u00e9\n\ud800", array.get(4))
        assertEquals(0, (value.get("a2") as JSONObject).length())
        // The last duplicate key wins.
        assertEquals(2.0, value.get("k"))
        assertNull(StrictJson.parse("{\"a\":1,}"))
    }

    @Test
    fun `keeps an overflowing number out of JSONObject`() {
        // Android's JSONObject rejects an infinite number; JSON.parse accepts it.
        val value = StrictJson.parse("{\"extra\": 1e400, \"low\": -1e400}") as JSONObject
        assertSame(StrictJson.NonFiniteNumber, value.get("extra"))
        assertSame(StrictJson.NonFiniteNumber, value.get("low"))
    }
}
