package com.bear27570.app;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import javax.swing.*;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

public class SplashScreenVisualRenderTest {

    @Test
    public void testSplashScreenStateTransitionsAndOffscreenRender() throws Exception {
        Assumptions.assumeFalse(GraphicsEnvironment.isHeadless(), "Swing SplashScreen test requires non-headless display");
        AtomicReference<Throwable> failure = new AtomicReference<>();

        SwingUtilities.invokeAndWait(() -> {
            SplashScreen splash = new SplashScreen();
            try {
                assertThat(splash.getWidth()).isEqualTo(560);
                assertThat(splash.getHeight()).isEqualTo(380);
                assertThat(splash.getBackground()).isEqualTo(SplashScreen.BG_GRAPHITE_900);

                // Clock must stay at 0ms while SplashScreen is not yet shown on screen
                Thread.sleep(60L);
                assertThat(splash.currentElapsedMs()).isEqualTo(0L);

                splash.doLayout();
                splash.validate();

                // 0. Clock must stay anchored at 0ms before actual display, and typewriter starts delayed
                assertThat(splash.currentElapsedMs()).isEqualTo(0L);
                assertThat(SplashScreen.computeTitleTypedLength(0L)).isEqualTo(0);
                assertThat(SplashScreen.computeTitleTypedLength(SplashScreen.TITLE_START_MS - 1L)).isEqualTo(0);
                assertThat(SplashScreen.computeTitleTypedLength(SplashScreen.TITLE_START_MS)).isEqualTo(1);
                assertThat(SplashScreen.computeTitleTypedLength(SplashScreen.TITLE_PREFIX_DONE_MS)).isEqualTo(11);
                assertThat(SplashScreen.computeTitleTypedLength(SplashScreen.TITLE_SUFFIX_START_MS - 1L)).isEqualTo(11);
                assertThat(SplashScreen.computeTitleTypedLength(SplashScreen.TITLE_SUFFIX_START_MS)).isEqualTo(12);
                assertThat(SplashScreen.computeTitleTypedLength(SplashScreen.TITLE_COMPLETE_MS)).isEqualTo(13);

                splash.setRenderStateForTest(0L, 0f, "Initializing...", false);
                BufferedImage initialImg = renderSplashToImage(splash);
                assertHasPaintedContent(initialImg);

                // 1. Mid-progress & mid-typing loading state
                splash.updateProgress(62, "Starting local server...");
                assertThat(splash.isFailed()).isFalse();
                assertThat(splash.getTargetProgress()).isEqualTo(62);
                assertThat(splash.getStatusText()).isEqualTo("Starting local server...");

                splash.setRenderStateForTest(1600L, 62f, "Starting local server...", false);
                BufferedImage midImg = renderSplashToImage(splash);
                assertHasPaintedContent(midImg);
                assertImagesDiffer(initialImg, midImg);

                // 2. Ready 100% state (clamped to [0, 100]) after full entrance + typewriter + subtitle
                splash.updateProgress(130, "Ready");
                assertThat(splash.getTargetProgress()).isEqualTo(100);
                assertThat(splash.getStatusText()).isEqualTo("Ready");

                splash.setRenderStateForTest(3500L, 100f, "Ready", false);
                BufferedImage readyImg = renderSplashToImage(splash);
                assertHasPaintedContent(readyImg);
                assertImagesDiffer(midImg, readyImg);

                // 3. Failure state truncation, prefixing, and sticky latch against subsequent updateProgress
                splash.showFailure("   A very long initialization error message exceeding forty-four characters   ");
                assertThat(splash.isFailed()).isTrue();
                assertThat(splash.getStatusText()).startsWith("Startup failed: ");
                assertThat(splash.getStatusText()).endsWith("...");

                String lockedFailureText = splash.getStatusText();
                splash.updateProgress(99, "Should be ignored");
                assertThat(splash.getStatusText()).isEqualTo(lockedFailureText);

                BufferedImage failImg = renderSplashToImage(splash);
                assertHasPaintedContent(failImg);
            } catch (Throwable t) {
                failure.set(t);
            } finally {
                splash.dispose();
            }
        });

        if (failure.get() != null) {
            throw new AssertionError("SplashScreen test failed", failure.get());
        }
    }

    @Test
    public void testVisibleLifecycleHonorsMinDurationAndProgressRamp() throws Exception {
        Assumptions.assumeFalse(GraphicsEnvironment.isHeadless(), "Swing SplashScreen test requires non-headless display");
        java.util.concurrent.CountDownLatch closedLatch = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicLong shownAtMs = new java.util.concurrent.atomic.AtomicLong();
        java.util.concurrent.atomic.AtomicLong closedAtMs = new java.util.concurrent.atomic.AtomicLong();
        AtomicReference<SplashScreen> ref = new AtomicReference<>();

        SwingUtilities.invokeAndWait(() -> {
            SplashScreen splash = new SplashScreen();
            ref.set(splash);
            shownAtMs.set(System.currentTimeMillis());
            splash.setVisible(true);
            splash.updateProgress(100, "Ready");
            splash.closeSmoothly(() -> {
                closedAtMs.set(System.currentTimeMillis());
                closedLatch.countDown();
            });
        });

        try {
            boolean completed = closedLatch.await(10, java.util.concurrent.TimeUnit.SECONDS);
            assertThat(completed).as("SplashScreen should complete fade-out and invoke callback").isTrue();
            long visibleDurationMs = closedAtMs.get() - shownAtMs.get();
            assertThat(visibleDurationMs).isGreaterThanOrEqualTo(SplashScreen.MIN_VISIBLE_MS);
        } finally {
            SplashScreen splash = ref.get();
            if (splash != null) {
                SwingUtilities.invokeAndWait(splash::dispose);
            }
        }
    }

    private static void assertHasPaintedContent(BufferedImage img) {
        int bgRgb = SplashScreen.BG_GRAPHITE_900.getRGB() & 0xFFFFFF;
        int nonBgPixels = 0;
        for (int y = 0; y < img.getHeight(); y += 4) {
            for (int x = 0; x < img.getWidth(); x += 4) {
                if ((img.getRGB(x, y) & 0xFFFFFF) != bgRgb) {
                    nonBgPixels++;
                }
            }
        }
        assertThat(nonBgPixels).isGreaterThan(0);
    }

    private static void assertImagesDiffer(BufferedImage a, BufferedImage b) {
        int diffPixels = 0;
        for (int y = 0; y < a.getHeight(); y += 2) {
            for (int x = 0; x < a.getWidth(); x += 2) {
                if (a.getRGB(x, y) != b.getRGB(x, y)) {
                    diffPixels++;
                }
            }
        }
        assertThat(diffPixels).isGreaterThan(0);
    }

    private static BufferedImage renderSplashToImage(SplashScreen splash) {
        int w = splash.getWidth();
        int h = splash.getHeight();
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g2 = img.createGraphics();
        splash.getContentPane().setSize(w, h);
        splash.getContentPane().doLayout();
        for (Component c : splash.getContentPane().getComponents()) {
            c.setSize(w, h);
            c.printAll(g2);
        }
        g2.dispose();
        return img;
    }
}
