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

                splash.doLayout();
                splash.validate();

                // 1. Mid-progress loading state
                splash.updateProgress(62, "Starting local server...");
                assertThat(splash.isFailed()).isFalse();
                assertThat(splash.getTargetProgress()).isEqualTo(62);
                assertThat(splash.getStatusText()).isEqualTo("Starting local server...");

                splash.setRenderStateForTest(1600L, 62f, "Starting local server...", false);
                BufferedImage midImg = renderSplashToImage(splash);
                assertHasPaintedContent(midImg);

                // 2. Ready 100% state (clamped to [0, 100])
                splash.updateProgress(130, "Ready");
                assertThat(splash.getTargetProgress()).isEqualTo(100);
                assertThat(splash.getStatusText()).isEqualTo("Ready");

                splash.setRenderStateForTest(3000L, 100f, "Ready", false);
                BufferedImage readyImg = renderSplashToImage(splash);
                assertHasPaintedContent(readyImg);

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
