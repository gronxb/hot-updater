package com.hotupdater.lynx.sparkling;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import android.graphics.Bitmap;
import android.graphics.drawable.Drawable;
import com.facebook.common.references.CloseableReference;
import com.facebook.fresco.animation.drawable.AnimatedDrawable2;
import com.facebook.fresco.animation.drawable.AnimationListener;
import com.facebook.imagepipeline.image.CloseableImage;
import com.facebook.imagepipeline.image.CloseableStaticBitmap;
import com.facebook.imagepipeline.image.ImmutableQualityInfo;
import com.lynx.service.image.FrescoReleasableImage;
import com.lynx.service.image.LynxImageService;
import com.lynx.tasm.image.model.ImageRequestInfo;
import com.lynx.tasm.image.model.ImageRequestInfoBuilder;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class FrescoCompatibilityTest {
  @Test
  public void bitmapSurvivesProducerReleaseUntilLynxReleasesItsReference() {
    Bitmap bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
    AtomicInteger released = new AtomicInteger();
    CloseableImage image = CloseableStaticBitmap.of(
        bitmap, ignored -> released.incrementAndGet(), ImmutableQualityInfo.FULL_QUALITY, 0);
    CloseableReference<CloseableImage> producer = CloseableReference.of(image);
    FrescoReleasableImage lynx = new FrescoReleasableImage(producer.clone());

    producer.close();
    assertSame(bitmap, lynx.getBitmap());
    assertFalse(image.isClosed());
    assertEquals(0, released.get());

    lynx.release();
    lynx.release();
    assertTrue(image.isClosed());
    assertEquals(1, released.get());
  }

  @Test
  public void frescoDrawableCallbacksReachLynxWithoutReportingStoppedLoops() throws Exception {
    RecordingDrawable drawable = new RecordingDrawable();
    List<String> callbacks = new ArrayList<>();
    com.lynx.tasm.image.model.AnimationListener listener =
        new com.lynx.tasm.image.model.AnimationListener() {
          @Override public void onAnimationStart(Drawable value) {
            assertSame(drawable, value);
            callbacks.add("start");
          }
          @Override public void onAnimationCurrentLoop(Drawable value) {
            assertSame(drawable, value);
            callbacks.add("loop");
          }
          @Override public void onAnimationFinalLoop(Drawable value) {
            assertSame(drawable, value);
            callbacks.add("final");
          }
        };
    ImageRequestInfo request = ImageRequestInfoBuilder.newBuilderWithSource("file:///image.gif")
        .setEnableAnimationAutoPlay(false).setLoopCount(2).build();
    // Exercise the actual generated adapter without a network request or native decoder.
    Method attach = LynxImageService.class.getDeclaredMethod(
        "handleImageAnimListener", ImageRequestInfo.class, Drawable.class,
        com.lynx.tasm.image.model.AnimationListener.class);
    attach.setAccessible(true);
    assertEquals(true, attach.invoke(LynxImageService.getInstance(), request, drawable, listener));

    drawable.running = true;
    drawable.listener.onAnimationStart(drawable);
    drawable.listener.onAnimationRepeat(drawable);
    drawable.listener.onAnimationStop(drawable);
    assertEquals(Arrays.asList("start", "loop", "loop", "final"), callbacks);

    drawable.running = false;
    drawable.listener.onAnimationRepeat(drawable);
    drawable.listener.onAnimationStop(drawable);
    assertEquals(4, callbacks.size());
  }

  private static final class RecordingDrawable extends AnimatedDrawable2 {
    private AnimationListener listener;
    private boolean running;

    @Override public void setAnimationListener(AnimationListener value) { listener = value; }
    @Override public boolean isRunning() { return running; }
  }
}
