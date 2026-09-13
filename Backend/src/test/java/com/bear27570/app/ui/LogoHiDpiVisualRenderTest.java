package com.bear27570.app.ui;

import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import javax.swing.*;
import java.awt.*;
import java.awt.geom.AffineTransform;
import java.awt.image.BufferedImage;
import java.io.File;

import static org.assertj.core.api.Assertions.assertThat;

public class LogoHiDpiVisualRenderTest {

    @Test
    public void testRenderAtMultipleDpiScales() throws Exception {
        SwingUtilities.invokeAndWait(() -> {
            JFrame frame = new JFrame("SP27 Dpi Test");
            frame.setUndecorated(true);
            frame.setSize(800, 500);

            Color windowBg = new Color(10, 10, 10);
            frame.setBackground(windowBg);

            CustomTitleBar titleBar = new CustomTitleBar(frame);
            frame.getContentPane().setLayout(new BorderLayout());
            frame.getContentPane().add(titleBar, BorderLayout.NORTH);

            frame.addNotify();
            frame.setSize(800, 500);
            frame.validate();
            frame.doLayout();

            double[] scales = { 1.0, 1.25, 1.5, 2.0 };
            File outDir = new File(System.getProperty("java.io.tmpdir"), "sp27-tests");
            outDir.mkdirs();

            for (double scale : scales) {
                int w = (int) Math.round(500 * scale);
                int h = (int) Math.round(38 * scale);
                BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
                Graphics2D g2 = img.createGraphics();

                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                g2.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
                g2.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
                g2.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);

                AffineTransform at = AffineTransform.getScaleInstance(scale, scale);
                g2.setTransform(at);

                titleBar.printAll(g2);
                g2.dispose();

                File outFile = new File(outDir, "titlebar_dpi_" + scale + "x.png");
                try {
                    ImageIO.write(img, "png", outFile);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            }

            frame.dispose();
        });
    }
}
