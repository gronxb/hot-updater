package com.hotupdater.brownfieldhost

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import androidx.appcompat.app.AppCompatActivity

/**
 * The host's own first screen, a plain Android layout. Its button starts
 * [ReactNativeActivity]; React Native's `popToNative()` finishes that activity
 * and returns here.
 */
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        findViewById<Button>(R.id.open_react_native).setOnClickListener {
            startActivity(Intent(this, ReactNativeActivity::class.java))
        }
    }
}
