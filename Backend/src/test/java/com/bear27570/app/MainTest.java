package com.bear27570.app;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.swing.*;
import java.awt.*;
import java.awt.geom.RoundRectangle2D;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

class MainTest {

    @Test
    void testLoadAppIconsGeneratesMultiResHiDpiHierarchy() {
        List<Image> icons = Main.loadAppIcons();
        assertThat(icons).as("App icons list should not be empty").isNotEmpty();

        int[] requiredSizes = { 16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512 };
        for (int req : requiredSizes) {
            boolean hasSize = icons.stream()
                    .anyMatch(img -> img.getWidth(null) == req && img.getHeight(null) == req);
            assertThat(hasSize).as("Should contain an icon of exact size " + req + "x" + req).isTrue();
        }
    }

    @Test
    void appendsDesktopShellQueryWhenCustomTitleBarIsMounted() {
        assertThat(Main.buildLocalAppUrl(8080, true))
                .isEqualTo("http://localhost:8080/index.html?shell=desktop");
    }

    @Test
    void keepsPlainUrlWhenCustomTitleBarIsNotMounted() {
        assertThat(Main.buildLocalAppUrl(8080, false))
                .isEqualTo("http://localhost:8080/index.html");
    }

    @Test
    void ensureJcefBundlePreservesExistingBinariesAndWritesMarker(@TempDir Path tempDir) throws Exception {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        if (os.contains("win")) {
            Files.writeString(tempDir.resolve("jcef.dll"), "stub");
            Files.writeString(tempDir.resolve("libcef.dll"), "stub");
        } else if (os.contains("mac")) {
            Files.writeString(tempDir.resolve("libjcef.dylib"), "stub");
        } else {
            Files.writeString(tempDir.resolve("libjcef.so"), "stub");
        }
        Path sentinel = tempDir.resolve("existing-user-cache.txt");
        Files.writeString(sentinel, "keep-me");
        Path marker = tempDir.resolve(".extracted_v3_ok");
        assertThat(Files.exists(marker)).isFalse();

        File result = Main.ensureJcefBundle(tempDir.toFile());

        assertThat(result).isEqualTo(tempDir.toFile());
        assertThat(Files.exists(sentinel)).isTrue();
        assertThat(Files.readString(sentinel)).isEqualTo("keep-me");
        assertThat(Files.exists(marker)).isTrue();
    }

    @Test
    void updateWindowShapeAppliesRoundedCornersOnlyOnWindowsNormalState() throws Exception {
        Assumptions.assumeFalse(GraphicsEnvironment.isHeadless(), "Swing JFrame test requires non-headless display");
        boolean isWindows = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
        AtomicReference<Throwable> failure = new AtomicReference<>();

        SwingUtilities.invokeAndWait(() -> {
            JFrame frame = new JFrame("ScoutingPro27");
            try {
                int w = 700;
                int h = 450;
                frame.setUndecorated(true);
                frame.setSize(w, h);

                Main.updateWindowShape(frame);
                if (!isWindows) {
                    assertThat(frame.getShape()).isNull();
                    return;
                }

                assertThat(frame.getShape()).isNotNull();
                assertThat(frame.getShape().getBounds()).isEqualTo(new Rectangle(0, 0, w, h));
                assertThat(frame.getShape().contains(1.0, 1.0)).isFalse();
                assertThat(frame.getShape().contains(w / 2.0, h / 2.0)).isTrue();

                frame.setExtendedState(JFrame.MAXIMIZED_BOTH);
                Main.updateWindowShape(frame);
                assertThat(frame.getShape()).isNull();

                frame.setExtendedState(JFrame.NORMAL);
                Main.updateWindowShape(frame);
                assertThat(frame.getShape()).isNotNull();
                assertThat(frame.getShape().getBounds()).isEqualTo(new Rectangle(0, 0, w, h));
                assertThat(frame.getShape().contains(1.0, 1.0)).isFalse();
                assertThat(frame.getShape().contains(w / 2.0, h / 2.0)).isTrue();
            } catch (Throwable t) {
                failure.set(t);
            } finally {
                frame.dispose();
            }
        });

        if (failure.get() != null) {
            throw new AssertionError("Swing updateWindowShape check failed", failure.get());
        }
    }
}
