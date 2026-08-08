package com.bear27570.app;

import javax.imageio.ImageIO;
import javax.swing.*;
import java.awt.*;
import java.awt.geom.Line2D;
import java.awt.geom.RoundRectangle2D;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;

/**
 * Splash screen shown while the app initializes.
 *
 * Visual language matches the main app's theme (see frontend/src/assets/main.css):
 *   background : #000000 (pure black)
 *   accent     : #39ff14 (fluorescent green)
 *   foreground : #f1f5f9
 *   muted text : #a3a3a3
 *   border     : #262626
 *   font       : Segoe UI / Helvetica Neue / Arial
 *
 * Title + credit are stacked and centered as one tight group:
 *
 *              ScoutingPro27
 *          Led by 27570 [logo]
 *
 * Minimalist "hacker" look: no gradients, no gloss, no shine sweep — just
 * solid black and a single glowing green progress line.
 *
 * Guarantees at least MIN_VISIBLE_MS on screen regardless of how fast
 * initialization actually finishes (see closeSmoothly()).
 *
 * Usage (unchanged):
 *   SplashScreen splash = new SplashScreen();
 *   SwingUtilities.invokeLater(() -> splash.setVisible(true));
 *   ... background thread: splash.updateProgress(percent, "message") ...
 *   splash.closeSmoothly(() -> mainFrame.setVisible(true));
 *
 * Drop the team logo here (transparent PNG). Source image should be at least
 * ~300px tall so it stays crisp — it's drawn at ~58px display height but
 * Swing scales the whole window for HiDPI, so a low-res source will blur on
 * 4K/Retina screens:
 *   Backend/src/main/resources/assets/logo-bear.png    (27570 B.E.A.R)
 * Missing file is silently skipped, no crash — the caption text still shows.
 */
public class SplashScreen extends JWindow {

    private static final long MIN_VISIBLE_MS = 3000; // hard floor: always show for at least 3s
    private static final long ENTRANCE_MS = 650;

    // ------- theme, matches frontend/src/assets/main.css tokens -------
    private static final Color BG_BLACK = new Color(0x00, 0x00, 0x00);
    private static final Color BORDER = new Color(0x26, 0x26, 0x26);
    private static final Color TEXT_PRIMARY = new Color(0xf1, 0xf5, 0xf9);
    private static final Color TEXT_MUTED = new Color(0xa3, 0xa3, 0xa3);
    private static final Color GREEN = new Color(0x39, 0xff, 0x14); // --primary / --accent

    private static final String FONT_FAMILY = "Segoe UI";

    private final ContentPanel contentPanel = new ContentPanel();
    private final long startTime = System.currentTimeMillis();

    private volatile int targetProgress = 0;
    private volatile String statusText = "Initializing...";
    private float displayedProgress = 0f; // eased toward targetProgress each frame, for a smooth fill

    private final BufferedImage bearLogo;

    public SplashScreen() {
        setSize(560, 380); // wide enough to comfortably fit label + logo
        setLocationRelativeTo(null);
        setBackground(BG_BLACK); // solid black window, no transparency needed
        setLayout(new BorderLayout());

        bearLogo = loadImage("/assets/logo-bear.png");

        add(contentPanel, BorderLayout.CENTER);

        Timer animTimer = new Timer(16, e -> {
            displayedProgress += (targetProgress - displayedProgress) * 0.08f;
            if (Math.abs(targetProgress - displayedProgress) < 0.1f) {
                displayedProgress = targetProgress;
            }
            contentPanel.repaint();
        });
        animTimer.start();
    }

    private BufferedImage loadImage(String classpathResource) {
        try (InputStream in = SplashScreen.class.getResourceAsStream(classpathResource)) {
            if (in == null) {
                System.err.println("Logo resource not found: " + classpathResource + " (skipping)");
                return null;
            }
            return ImageIO.read(in);
        } catch (IOException e) {
            System.err.println("Failed to load logo: " + classpathResource + " - " + e.getMessage());
            return null;
        }
    }

    /** Called from the background init thread, percent: 0-100 */
    public void updateProgress(int percent, String text) {
        this.targetProgress = Math.max(0, Math.min(100, percent));
        this.statusText = text;
    }

    /**
     * Waits out the minimum visible time (3s floor, regardless of how fast init
     * actually finished), fades out, then hands off to the main window.
     * Call on the EDT.
     */
    public void closeSmoothly(Runnable onClosed) {
        long elapsed = System.currentTimeMillis() - startTime;
        long remaining = Math.max(0, MIN_VISIBLE_MS - elapsed);

        Timer delay = new Timer((int) remaining, e -> fadeOutAndClose(onClosed));
        delay.setRepeats(false);
        delay.start();
    }

    private void fadeOutAndClose(Runnable onClosed) {
        final float[] opacity = {1f};
        Timer fade = new Timer(15, null);
        fade.addActionListener(e -> {
            opacity[0] -= 0.07f;
            if (opacity[0] <= 0f) {
                fade.stop();
                dispose();
                if (onClosed != null) onClosed.run();
            } else {
                setOpacity(Math.max(0f, opacity[0]));
            }
        });
        fade.start();
    }

    private float entranceProgress() {
        long elapsed = System.currentTimeMillis() - startTime;
        float t = Math.min(1f, elapsed / (float) ENTRANCE_MS);
        return 1 - (float) Math.pow(1 - t, 3);
    }

    private class ContentPanel extends JPanel {

        ContentPanel() {
            setOpaque(true);
            setBackground(BG_BLACK);
        }

        @Override
        protected void paintComponent(Graphics g) {
            super.paintComponent(g);
            Graphics2D g2 = (Graphics2D) g.create();

            // Full quality-rendering hint set — the text-specific hints are what
            // actually fixes blurry glyphs in custom-painted Swing components.
            // LCD_HRGB gives ClearType-style subpixel rendering.
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_LCD_HRGB);
            g2.setRenderingHint(RenderingHints.KEY_FRACTIONALMETRICS, RenderingHints.VALUE_FRACTIONALMETRICS_ON);
            g2.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
            g2.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
            g2.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            g2.setRenderingHint(RenderingHints.KEY_ALPHA_INTERPOLATION, RenderingHints.VALUE_ALPHA_INTERPOLATION_QUALITY);
            g2.setRenderingHint(RenderingHints.KEY_COLOR_RENDERING, RenderingHints.VALUE_COLOR_RENDER_QUALITY);

            int w = getWidth();
            int h = getHeight();

            g2.setColor(BG_BLACK);
            g2.fillRect(0, 0, w, h);

            // thin, quiet border for edge definition — no glow, no color, matches --border token
            g2.setColor(BORDER);
            g2.setStroke(new BasicStroke(1f));
            g2.draw(new RoundRectangle2D.Double(0.5, 0.5, w - 1, h - 1, 8, 8));

            float entrance = entranceProgress();
            int slideOffset = (int) ((1 - entrance) * 16);

            Composite oldComposite = g2.getComposite();

            // ---------- title + credit line, stacked and centered as one tight group ----------
            int groupTop = 110 - slideOffset;

            // app title, with a soft green text-glow (matches .text-glow in main.css)
            g2.setFont(new Font(FONT_FAMILY, Font.BOLD, 32));
            String title = "ScoutingPro27";
            FontMetrics tfm = g2.getFontMetrics();
            int titleX = (w - tfm.stringWidth(title)) / 2;
            int titleY = groupTop + tfm.getAscent();
            drawGlowText(g2, title, titleX, titleY);

            // credit line directly underneath, close spacing, centered as a unit: "Led by 27570" + logo
            // logo area 4x the previous size => linear dimensions 2x (50 -> 100)
            int logoH = 100;
            int gap = 14;
            int creditGapFromTitle = 18;

            g2.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, entrance));

            Font capFont = new Font(FONT_FAMILY, Font.PLAIN, 19);
            g2.setFont(capFont);
            FontMetrics capFm = g2.getFontMetrics();
            String creditText = "Led by 27570";
            int textW = capFm.stringWidth(creditText);
            int logoW = bearLogo != null ? scaledWidth(bearLogo, logoH) : 0;
            int groupW = textW + (bearLogo != null ? gap + logoW : 0);

            int rowTop = titleY + creditGapFromTitle;
            int rowCenterY = rowTop + logoH / 2;
            int rowX = (w - groupW) / 2;

            int capBaseline = rowCenterY + (capFm.getAscent() - capFm.getDescent()) / 2;
            g2.setColor(TEXT_MUTED);
            g2.drawString(creditText, rowX, capBaseline);
            if (bearLogo != null) {
                g2.drawImage(bearLogo, rowX + textW + gap, rowTop, logoW, logoH, null);
            }

            g2.setComposite(oldComposite);

            // ---------- progress: a single glowing green line ----------
            int barX = 44;
            int barY = h - 62;
            int barW = w - 88;
            drawGlowLine(g2, barX, barY, barW, displayedProgress / 100f);

            g2.setColor(TEXT_MUTED);
            g2.setFont(new Font(FONT_FAMILY, Font.PLAIN, 12));
            g2.drawString(statusText, barX, barY - 12);

            // ---------- engine credit ----------
            g2.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, entrance * 0.65f));
            g2.setColor(TEXT_MUTED);
            g2.setFont(new Font(FONT_FAMILY, Font.ITALIC, 11));
            String poweredBy = "Powered by Chromium";
            FontMetrics pfm = g2.getFontMetrics();
            g2.drawString(poweredBy, w - pfm.stringWidth(poweredBy) - 24, h - 18);
            g2.setComposite(oldComposite);

            g2.dispose();
        }

        /**
         * Draws the title with a tight, subtle green halo underneath (1px offsets
         * only, so it reads as a soft glow rather than smearing the glyph edges),
         * then a fully crisp copy on top.
         */
        private void drawGlowText(Graphics2D g2, String text, int x, int y) {
            g2.setColor(new Color(GREEN.getRed(), GREEN.getGreen(), GREEN.getBlue(), 90));
            int[][] offsets = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
            for (int[] o : offsets) {
                g2.drawString(text, x + o[0], y + o[1]);
            }
            g2.setColor(TEXT_PRIMARY);
            g2.drawString(text, x, y);
        }

        /**
         * A single flat green line representing progress, with a soft outer glow
         * built from a few wider, more transparent strokes layered underneath —
         * no gradient fill, no gloss, no animated sweep.
         */
        private void drawGlowLine(Graphics2D g2, int x, int y, int w, float ratio) {
            // faint track for the full width, so the line still reads as a progress bar
            g2.setStroke(new BasicStroke(2f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
            g2.setColor(BORDER);
            g2.draw(new Line2D.Double(x, y, x + w, y));

            float fillW = w * ratio;
            if (fillW <= 0.5f) return;

            Line2D line = new Line2D.Double(x, y, x + fillW, y);

            // layered glow: wide + faint, then narrower + brighter, then the crisp core
            g2.setStroke(new BasicStroke(10f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
            g2.setColor(new Color(GREEN.getRed(), GREEN.getGreen(), GREEN.getBlue(), 25));
            g2.draw(line);

            g2.setStroke(new BasicStroke(6f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
            g2.setColor(new Color(GREEN.getRed(), GREEN.getGreen(), GREEN.getBlue(), 60));
            g2.draw(line);

            g2.setStroke(new BasicStroke(2.5f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
            g2.setColor(GREEN);
            g2.draw(line);
        }

        private int scaledWidth(BufferedImage img, int targetH) {
            double ratio = (double) img.getWidth() / img.getHeight();
            return (int) Math.round(targetH * ratio);
        }
    }
}