package com.bear27570.app;

import org.junit.jupiter.api.Test;

import java.awt.*;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

public class AppIconMultiResTest {

    @Test
    public void testLoadAppIconsGeneratesMultiResHiDpiHierarchy() {
        List<Image> icons = Main.loadAppIcons();
        assertThat(icons).as("App icons list should not be empty").isNotEmpty();

        int[] requiredSizes = { 16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512 };
        for (int req : requiredSizes) {
            boolean hasSize = icons.stream()
                    .anyMatch(img -> img.getWidth(null) == req && img.getHeight(null) == req);
            assertThat(hasSize).as("Should contain an icon of exact size " + req + "x" + req).isTrue();
        }
    }
}
