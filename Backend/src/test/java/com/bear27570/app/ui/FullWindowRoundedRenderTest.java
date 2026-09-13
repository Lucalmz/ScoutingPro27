package com.bear27570.app.ui;

import com.bear27570.app.Main;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import javax.swing.*;
import java.awt.*;
import java.awt.geom.RoundRectangle2D;
import java.awt.image.BufferedImage;
import java.io.File;

import static org.assertj.core.api.Assertions.assertThat;

public class FullWindowRoundedRenderTest {

    @Test
    public void testFullWindowRoundedCornersRender() throws Exception {
        SwingUtilities.invokeAndWait(() -> {
            int w = 700;
            int h = 450;
            JFrame frame = new JFrame("ScoutingPro27");
            frame.setUndecorated(true);
            frame.setSize(w, h);

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

            JPanel mainArea = new JPanel() {
                @Override
                protected void paintComponent(Graphics g) {
                    g.setColor(new Color(13, 14, 18));
                    g.fillRect(0, 0, getWidth(), getHeight());
                }
            };
            frame.getContentPane().add(mainArea, BorderLayout.CENTER);

            Main.updateWindowShape(frame);
            assertThat(frame.getShape()).isNotNull();
            assertThat(frame.getShape()).isInstanceOf(Shape.class);
            assertThat(frame.getShape().getBounds()).isEqualTo(new Rectangle(0, 0, w, h));

            // Verify when maximized, shape resets to null (sharp full screen)
            frame.setExtendedState(JFrame.MAXIMIZED_BOTH);
            Main.updateWindowShape(frame);
            assertThat(frame.getShape()).isNull();

            // Restore normal state
            frame.setExtendedState(JFrame.NORMAL);
            Main.updateWindowShape(frame);
            assertThat(frame.getShape()).isNotNull();
            assertThat(frame.getShape().getBounds()).isEqualTo(new Rectangle(0, 0, w, h));

            frame.addNotify();
            frame.setSize(w, h);
            frame.validate();
            frame.doLayout();

            // Render to image with rounded corners clip applied
            BufferedImage image = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
            Graphics2D g2 = image.createGraphics();
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);

            // Apply the same 24px rounded rectangle shape clip
            RoundRectangle2D clipShape = new RoundRectangle2D.Float(0, 0, w, h, Main.WINDOW_CORNER_RADIUS, Main.WINDOW_CORNER_RADIUS);
            g2.setClip(clipShape);

            // Fill window background
            g2.setColor(windowBg);
            g2.fill(clipShape);

            frame.getContentPane().printAll(g2);
            g2.dispose();

            File outDir = new File(System.getProperty("java.io.tmpdir"), "sp27-tests");
            outDir.mkdirs();
            File outFile = new File(outDir, "full_window_rounded_render.png");
            try {
                ImageIO.write(image, "png", outFile);
            } catch (Exception ignored) {}

            // Verify corner is transparent outside clip (e.g., at (0, 0))
            int cornerPixel = image.getRGB(0, 0);
            int alpha = (cornerPixel >> 24) & 0xFF;
            assertThat(alpha).isEqualTo(0); // Transparent outside rounded corner

            // Verify inside title bar is fully opaque
            int titlePixel = image.getRGB(50, 20);
            int titleAlpha = (titlePixel >> 24) & 0xFF;
            assertThat(titleAlpha).isEqualTo(255);

            // Verify inside main body is fully opaque
            int bodyPixel = image.getRGB(50, 100);
            int bodyAlpha = (bodyPixel >> 24) & 0xFF;
            assertThat(bodyAlpha).isEqualTo(255);

            frame.dispose();
        });
    }
}
