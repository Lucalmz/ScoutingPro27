package com.bear27570.app;

import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import javax.swing.*;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.File;

import static org.assertj.core.api.Assertions.assertThat;

public class SplashScreenVisualRenderTest {

    @Test
    public void testRenderSplashScreenLoadingReadyAndFailureStates() throws Exception {
        SwingUtilities.invokeAndWait(() -> {
            SplashScreen splash = new SplashScreen();
            try {
                assertThat(splash.getWidth()).isEqualTo(560);
                assertThat(splash.getHeight()).isEqualTo(380);
                assertThat(splash.getBackground()).isEqualTo(SplashScreen.BG_GRAPHITE_900);

                splash.doLayout();
                splash.validate();

                File outDir = new File(System.getProperty("java.io.tmpdir"), "sp27-tests");
                outDir.mkdirs();

                // 1. Mid-progress loading state (55%, "Starting local server...")
                splash.setRenderStateForTest(1600L, 62f, "Starting local server...", false);
                BufferedImage midImg = renderSplashToImage(splash);
                File midFile = new File(outDir, "splash_loading_mid.png");
                writePng(midImg, midFile);

                // Verify background is Pit Wall #0B0E10 and 1px inner border is #1B2126
                int bgRgb = midImg.getRGB(20, 120) & 0xFFFFFF;
                assertThat(bgRgb).isEqualTo(0x0B0E10);
                int borderRgb = midImg.getRGB(0, 120) & 0xFFFFFF;
                assertThat(borderRgb).isEqualTo(0x1B2126);

                // Verify completed segment #0 (x ~ 60, y = 293) is #39FF14
                int seg0Rgb = midImg.getRGB(60, 293) & 0xFFFFFF;
                assertThat(seg0Rgb).isEqualTo(0x39FF14);

                // Verify unstarted segment #4 (x ~ 480, y = 293) is #1B2126
                int seg4Rgb = midImg.getRGB(480, 293) & 0xFFFFFF;
                assertThat(seg4Rgb).isEqualTo(0x1B2126);

                // 2. Ready 100% state ("Ready")
                splash.setRenderStateForTest(3000L, 100f, "Ready", false);
                BufferedImage readyImg = renderSplashToImage(splash);
                File readyFile = new File(outDir, "splash_ready_100.png");
                writePng(readyImg, readyFile);

                // All 5 segments should be #39FF14 at 100%
                assertThat(readyImg.getRGB(60, 293) & 0xFFFFFF).isEqualTo(0x39FF14);
                assertThat(readyImg.getRGB(480, 293) & 0xFFFFFF).isEqualTo(0x39FF14);

                // 3. Failure state ("Startup failed: Browser engine init timeout")
                splash.setRenderStateForTest(2400L, 65f, "Building engine...", false);
                splash.showFailure("Browser engine init timeout");
                assertThat(splash.isFailed()).isTrue();
                assertThat(splash.getStatusText()).contains("Startup failed:");

                BufferedImage failImg = renderSplashToImage(splash);
                File failFile = new File(outDir, "splash_failure.png");
                writePng(failImg, failFile);

                // Verify failed header dot at (27, 23) is #FF5577
                int failDotRgb = failImg.getRGB(27, 23) & 0xFFFFFF;
                assertThat(failDotRgb).isEqualTo(0xFF5577);

                // Verify failed segment #3 fill (x ~ 335, y = 293) is #FF5577
                int failSegRgb = failImg.getRGB(335, 293) & 0xFFFFFF;
                assertThat(failSegRgb).isEqualTo(0xFF5577);
            } finally {
                splash.dispose();
            }
        });
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

    private static void writePng(BufferedImage img, File file) {
        try {
            ImageIO.write(img, "png", file);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
