package com.hotupdaterexample.launcharguments;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import java.util.HashMap;
import java.util.Map;

/**
 * Exposes the string extras of the intent that started the current activity,
 * as `am start --es KEY value` passes them, as the constant `value`.
 */
public class E2ELaunchArgumentsModule extends ReactContextBaseJavaModule {
    private static final long ACTIVITY_WAIT_INTERVAL_MS = 100L;
    private static final int ACTIVITY_WAIT_TRIES = 200;

    E2ELaunchArgumentsModule(ReactApplicationContext context) {
        super(context);
    }

    @NonNull
    @Override
    public String getName() {
        return "E2ELaunchArguments";
    }

    @Nullable
    @Override
    public Map<String, Object> getConstants() {
        Map<String, Object> values = new HashMap<>();
        Activity activity = waitForActivity();
        Intent intent = activity == null ? null : activity.getIntent();
        Bundle extras = intent == null ? null : intent.getExtras();
        if (extras != null) {
            for (String key : extras.keySet()) {
                Object value = extras.get(key);
                if (value instanceof String) {
                    values.put(key, value);
                }
            }
        }
        Map<String, Object> constants = new HashMap<>();
        constants.put("value", values);
        return constants;
    }

    // Without a method, React Native leaves a module of only constants out of
    // NativeModules.
    @ReactMethod
    public void noop() {}

    // The module can load before the activity that carries the extras starts.
    @Nullable
    private Activity waitForActivity() {
        for (int tries = 0; tries < ACTIVITY_WAIT_TRIES; tries += 1) {
            Activity activity = getCurrentActivity();
            if (activity != null) {
                return activity;
            }
            try {
                Thread.sleep(ACTIVITY_WAIT_INTERVAL_MS);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return null;
            }
        }
        return null;
    }
}
