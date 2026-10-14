package com.hotupdater

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StrictJsonTest {
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
}
