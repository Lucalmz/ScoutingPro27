package com.bear27570.app.ui;

import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import javax.swing.*;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.File;

import static org.assertj.core.api.Assertions.assertThat;

public class TitleBarVisualRenderTest {

    @Test
    public void testRenderTitleBarAndWindowEdge() throws Exception {
        SwingUtilities.invokeAndWait(() -> {
            JFrame frame = new JFrame("ScoutingPro27");
            frame.setUndecorated(true);
            frame.setSize(1024, 768);

            Color windowBg = new Color(10, 10, 10);
            frame.setBackground(windowBg);
            if (frame.getRootPane() != null) {
                frame.getRootPane().setBackground(windowBg);
                frame.getRootPane().setBorder(null);
            }
            if (frame.getContentPane() != null) {
                frame.getContentPane().setBackground(windowBg);
            }

            CustomTitleBar titleBar = new CustomTitleBar(frame);
            frame.getContentPane().setLayout(new BorderLayout());
            frame.getContentPane().add(titleBar, BorderLayout.NORTH);

            JPanel mockContent = new JPanel();
            mockContent.setBackground(new Color(10, 10, 10));
            frame.getContentPane().add(mockContent, BorderLayout.CENTER);

            // Lay out the full component tree
            frame.addNotify();
            frame.setSize(1024, 768);
            frame.validate();
            frame.doLayout();

            // Render titlebar (1024 x 38)
            int renderW = 1024;
            int renderH = 38;
            BufferedImage image = new BufferedImage(renderW, renderH, BufferedImage.TYPE_INT_ARGB);
            Graphics2D g2 = image.createGraphics();
            titleBar.printAll(g2);
            g2.dispose();

            File outDir = new File(System.getProperty("java.io.tmpdir"), "sp27-tests");
            outDir.mkdirs();
            File outFile = new File(outDir, "titlebar_visual_render.png");
            try {
                ImageIO.write(image, "png", outFile);
            } catch (Exception ignored) {}

            // Inspect the right edge (x from 1005 to 1023)
            // Verify there is NO column where brightness > 60 (which was the bug!)
            for (int y = 5; y < 35; y++) {
                int rgb = image.getRGB(1023, y);
                int r = (rgb >> 16) & 0xFF;
                int g = (rgb >> 8) & 0xFF;
                int b = rgb & 0xFF;
                int brightness = (r + g + b) / 3;
                assertThat(brightness).as("Brightness at right edge (1023, " + y + ")").isLessThan(60);
            }

            // Verify pure black background in center of title bar
            int centerRgb = image.getRGB(500, 19);
            int cr = (centerRgb >> 16) & 0xFF;
            int cg = (centerRgb >> 8) & 0xFF;
            int cb = centerRgb & 0xFF;
            assertThat(cr).as("Center red").isEqualTo(0);
            assertThat(cg).as("Center green").isEqualTo(0);
            assertThat(cb).as("Center blue").isEqualTo(0);

            frame.dispose();
        });
    }

    @Test
    public void testControlButtonsInteractiveHoverRendering() throws Exception {
        SwingUtilities.invokeAndWait(() -> {
            JFrame frame = new JFrame("HoverTest");
            frame.setUndecorated(true);
            frame.setSize(800, 600);
            CustomTitleBar titleBar = new CustomTitleBar(frame);
            frame.getContentPane().add(titleBar, BorderLayout.NORTH);
            frame.addNotify();
            frame.validate();

            // Find controls panel
            JPanel controlsPanel = (JPanel) ((BorderLayout) titleBar.getLayout()).getLayoutComponent(BorderLayout.EAST);
            assertThat(controlsPanel).isNotNull();
            assertThat(controlsPanel.getComponentCount()).isEqualTo(3);

            JButton minBtn = (JButton) controlsPanel.getComponent(0);
            JButton maxBtn = (JButton) controlsPanel.getComponent(1);
            JButton closeBtn = (JButton) controlsPanel.getComponent(2);

            File outDir = new File(System.getProperty("java.io.tmpdir"), "sp27-tests");
            outDir.mkdirs();

            // 1. Verify Close button hover animation
            triggerMouseEnter(closeBtn);
            tickAnimationToCompletion(closeBtn);

            BufferedImage closeHoverImg = new BufferedImage(46, 38, BufferedImage.TYPE_INT_ARGB);
            Graphics2D gClose = closeHoverImg.createGraphics();
            closeBtn.paint(gClose);
            gClose.dispose();
            try {
                ImageIO.write(closeHoverImg, "png", new File(outDir, "close_btn_hover.png"));
            } catch (Exception ignored) {}

            // Center of close button should have bright Windows red (R > 200, G < 30, B < 50)
            int closePixel = closeHoverImg.getRGB(5, 5); // background corner
            int closeR = (closePixel >> 16) & 0xFF;
            int closeG = (closePixel >> 8) & 0xFF;
            int closeB = closePixel & 0xFF;
            assertThat(closeR).as("Close hover red background").isGreaterThan(200);
            assertThat(closeG).as("Close hover green background").isLessThan(30);

            // 2. Verify Minimize button hover animation
            triggerMouseEnter(minBtn);
            tickAnimationToCompletion(minBtn);

            BufferedImage minHoverImg = new BufferedImage(46, 38, BufferedImage.TYPE_INT_ARGB);
            Graphics2D gMin = minHoverImg.createGraphics();
            minBtn.paint(gMin);
            gMin.dispose();
            try {
                ImageIO.write(minHoverImg, "png", new File(outDir, "min_btn_hover.png"));
            } catch (Exception ignored) {}

            // Background of min button should have distinct white highlight (R, G, B around 40-60)
            int minPixel = minHoverImg.getRGB(5, 5);
            int minR = (minPixel >> 16) & 0xFF;
            int minAlpha = (minPixel >> 24) & 0xFF;
            assertThat(minAlpha).as("Min hover alpha").isGreaterThan(35);
            assertThat(minR).as("Min hover white brightness").isGreaterThan(35);

            // 3. Verify Maximize button hover animation
            triggerMouseEnter(maxBtn);
            tickAnimationToCompletion(maxBtn);

            BufferedImage maxHoverImg = new BufferedImage(46, 38, BufferedImage.TYPE_INT_ARGB);
            Graphics2D gMax = maxHoverImg.createGraphics();
            maxBtn.paint(gMax);
            gMax.dispose();
            try {
                ImageIO.write(maxHoverImg, "png", new File(outDir, "max_btn_hover.png"));
            } catch (Exception ignored) {}

            int maxPixel = maxHoverImg.getRGB(5, 5);
            int maxAlpha = (maxPixel >> 24) & 0xFF;
            assertThat(maxAlpha).as("Max hover alpha").isGreaterThan(35);

            frame.dispose();
        });
    }

    private static void triggerMouseEnter(JButton btn) {
        for (var listener : btn.getMouseListeners()) {
            listener.mouseEntered(new java.awt.event.MouseEvent(
                btn, java.awt.event.MouseEvent.MOUSE_ENTERED,
                System.currentTimeMillis(), 0, 10, 10, 0, false
            ));
        }
    }

    private static void tickAnimationToCompletion(JButton btn) {
        try {
            java.lang.reflect.Field timerField = btn.getClass().getDeclaredField("animTimer");
            timerField.setAccessible(true);
            Timer timer = (Timer) timerField.get(btn);

            java.lang.reflect.Field hoverField = btn.getClass().getDeclaredField("hoverProgress");
            hoverField.setAccessible(true);
            java.lang.reflect.Field targetHoverField = btn.getClass().getDeclaredField("targetHover");
            targetHoverField.setAccessible(true);

            // Simulate frames until hover reaches target
            for (int i = 0; i < 40; i++) {
                for (var al : timer.getActionListeners()) {
                    al.actionPerformed(new java.awt.event.ActionEvent(timer, 0, "tick"));
                }
            }
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
