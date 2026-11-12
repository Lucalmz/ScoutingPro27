package com.bear27570.app;

import javax.imageio.ImageIO;
import javax.swing.*;
import java.awt.*;
import java.awt.geom.Point2D;
import java.awt.geom.Rectangle2D;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;

/**
 * Splash screen shown while the app initializes.
 *
 * Deliberately minimal:
 *   - flat black window, no border, no decoration
 *   - the title and credit line are written out by a typewriter animation
 *     (with a blinking fluorescent-green cursor), then the team logo fades in
 *   - progress is a single borderless fluorescent-green bar (#39ff14) whose
 *     left and right ends fade out to transparent
 *
 *   foreground : #f0efe9
 *   muted text : #9e9d95
 *   accent     : #39ff14
 *   font       : Segoe UI
 *
 * Title + credit are stacked and centered as one tight group:
 *
 *              ScoutingPro27
 *          Led by 27570 [logo]
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

    // ------- typewriter timeline (ms since the splash was created) -------
    private static final String TITLE = "ScoutingPro27";
    private static final String CREDIT = "Led by 27570";
    private static final long TITLE_START_MS = 300;
    private static final long TITLE_CHAR_MS = 85;
    private static final long CREDIT_START_MS = TITLE_START_MS + TITLE.length() * TITLE_CHAR_MS + 180;
    private static final long CREDIT_CHAR_MS = 55;
    private static final long LOGO_FADE_START_MS = CREDIT_START_MS + CREDIT.length() * CREDIT_CHAR_MS;
    private static final long LOGO_FADE_MS = 450;
    private static final long CURSOR_BLINK_MS = 530;

    // ------- theme -------
    private static final Color BG_BLACK = new Color(0x00, 0x00, 0x00);
    private static final Color TEXT_PRIMARY = new Color(0xf0, 0xef, 0xe9);
    private static final Color TEXT_MUTED = new Color(0x9e, 0x9d, 0x95);
    private static final Color GREEN = new Color(0x39, 0xff, 0x14); // --primary / --accent
    private static final Color GREEN_CLEAR = new Color(0x39, 0xff, 0x14, 0);

    private static final String FONT_RESOURCE = "/assets/Orbitron-VariableFont_wght-CYB_IVAf.ttf";
    private static final String FONT_FALLBACK_FAMILY = "Segoe UI";

    private static final int BAR_HEIGHT = 2;
    private static final float BAR_FADE_PX = 12f;

    private final Font titleFont;
    private final Font capFont;

    private final ContentPanel contentPanel = new ContentPanel();
    private final long startTime = System.currentTimeMillis();

    private volatile int targetProgress = 0;
    private volatile String statusText = "Initializing...";
    private float displayedProgress = 0f; // eased toward targetProgress each frame, for a smooth fill

    private final BufferedImage bearLogo;
    private final Timer animTimer;

    public SplashScreen() {
        setSize(560, 380); // wide enough to comfortably fit label + logo
        setLocationRelativeTo(null);
        setBackground(BG_BLACK); // solid black window, no transparency needed
        setLayout(new BorderLayout());

        titleFont = loadFont(FONT_RESOURCE, Font.BOLD, 32f);
        capFont = loadFont(FONT_RESOURCE, Font.PLAIN, 15f);

        bearLogo = loadImage("/assets/logo-bear.png");

        add(contentPanel, BorderLayout.CENTER);

        animTimer = new Timer(16, e -> {
            displayedProgress += (targetProgress - displayedProgress) * 0.08f;
            if (Math.abs(targetProgress - displayedProgress) < 0.1f) {
                displayedProgress = targetProgress;
            }
            contentPanel.repaint();
        });
        animTimer.start();
    }

    private Font loadFont(String classpathResource, int style, float size) {
        try (InputStream in = SplashScreen.class.getResourceAsStream(classpathResource)) {
            if (in != null) {
                Font base = Font.createFont(Font.TRUETYPE_FONT, in);
                GraphicsEnvironment.getLocalGraphicsEnvironment().registerFont(base);
                return base.deriveFont(style, size);
            }
        } catch (Exception e) {
            System.err.println("Could not load font " + classpathResource + ": " + e.getMessage() + ", falling back to " + FONT_FALLBACK_FAMILY);
        }
        return new Font(FONT_FALLBACK_FAMILY, style, (int) size);
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
                if (animTimer != null && animTimer.isRunning()) {
                    animTimer.stop();
                }
                dispose();
                if (onClosed != null) onClosed.run();
            } else {
                setOpacity(Math.max(0f, opacity[0]));
            }
        });
        fade.start();
    }

    @Override
    public void dispose() {
        if (animTimer != null && animTimer.isRunning()) {
            animTimer.stop();
        }
        super.dispose();
    }

    /** Number of characters of {@code text} revealed at {@code elapsedMs}. */
    private static int typedChars(String text, long elapsedMs, long startMs, long charMs) {
        if (elapsedMs < startMs) return 0;
        return (int) Math.min(text.length(), (elapsedMs - startMs) / charMs + 1);
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
            long elapsed = System.currentTimeMillis() - startTime;
            Composite oldComposite = g2.getComposite();

            g2.setColor(BG_BLACK);
            g2.fillRect(0, 0, w, h);

            int titleTyped = typedChars(TITLE, elapsed, TITLE_START_MS, TITLE_CHAR_MS);
            int creditTyped = typedChars(CREDIT, elapsed, CREDIT_START_MS, CREDIT_CHAR_MS);

            // ---------- title: positions are computed from the FULL string so that the
            // text stays put while it is being typed (no re-centering jitter) ----------
            g2.setFont(titleFont);
            FontMetrics tfm = g2.getFontMetrics();
            int titleX = (w - tfm.stringWidth(TITLE)) / 2;
            int groupTop = 100;
            int titleY = groupTop + tfm.getAscent();

            g2.setColor(TEXT_PRIMARY);
            g2.drawString(TITLE.substring(0, titleTyped), titleX, titleY);
            int titleEndX = titleX + tfm.stringWidth(TITLE.substring(0, titleTyped));

            // ---------- credit line: "Led by 27570" + logo ----------
            int logoH = 80;
            int gap = 12;
            int creditGapFromTitle = 18;

            g2.setFont(capFont);
            FontMetrics capFm = g2.getFontMetrics();
            int textW = capFm.stringWidth(CREDIT);
            int logoW = bearLogo != null ? scaledWidth(bearLogo, logoH) : 0;
            int groupW = textW + (bearLogo != null ? gap + logoW : 0);

            int rowTop = titleY + creditGapFromTitle;
            int rowCenterY = rowTop + logoH / 2;
            int rowX = (w - groupW) / 2;
            int capBaseline = rowCenterY + (capFm.getAscent() - capFm.getDescent()) / 2;

            if (creditTyped > 0) {
                g2.setColor(TEXT_MUTED);
                g2.drawString(CREDIT.substring(0, creditTyped), rowX, capBaseline);
            }
            int creditEndX = rowX + capFm.stringWidth(CREDIT.substring(0, creditTyped));

            if (bearLogo != null && elapsed >= LOGO_FADE_START_MS) {
                float a = Math.min(1f, (elapsed - LOGO_FADE_START_MS) / (float) LOGO_FADE_MS);
                g2.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, a));
                g2.drawImage(bearLogo, rowX + textW + gap, rowTop, logoW, logoH, null);
                g2.setComposite(oldComposite);
            }

            // ---------- blinking block cursor at the end of whatever is being typed ----------
            boolean titleDone = titleTyped >= TITLE.length();
            boolean creditActive = creditTyped > 0;
            boolean blinkOn = (elapsed / CURSOR_BLINK_MS) % 2 == 0;
            boolean typingNow = (!titleDone) || (creditActive && creditTyped < CREDIT.length());
            if (typingNow || blinkOn) {
                g2.setColor(GREEN);
                if (creditActive) {
                    int ch = capFm.getAscent();
                    g2.fillRect(creditEndX + 3, capBaseline - ch + 2, 2, ch);
                } else {
                    int ch = tfm.getAscent();
                    g2.fillRect(titleEndX + 3, titleY - ch + 4, 3, ch);
                }
            }

            // ---------- progress: one borderless green bar, both ends faded ----------
            int barMargin = 80;
            int barX = barMargin;
            int barW = w - barMargin * 2;
            int barY = h - 64;
            drawFadedBar(g2, barX, barY, barW, displayedProgress / 100f);

            g2.dispose();
        }

        /**
         * A single flat fluorescent-green line, no border and no track. The filled
         * part fades to transparent at both its left and right ends.
         */
        private void drawFadedBar(Graphics2D g2, int x, int y, int w, float ratio) {
            float fillW = w * ratio;
            if (fillW < 4f) return;

            float fadePx = Math.min(BAR_FADE_PX, fillW * 0.25f);
            float f = fadePx / fillW;
            LinearGradientPaint paint = new LinearGradientPaint(
                    new Point2D.Float(x, 0),
                    new Point2D.Float(x + fillW, 0),
                    new float[]{0f, f, 1f - f, 1f},
                    new Color[]{GREEN_CLEAR, GREEN, GREEN, GREEN_CLEAR});
            g2.setPaint(paint);
            g2.fill(new Rectangle2D.Float(x, y, fillW, BAR_HEIGHT));
        }

        private int scaledWidth(BufferedImage img, int targetH) {
            double ratio = (double) img.getWidth() / img.getHeight();
            return (int) Math.round(targetH * ratio);
        }
    }
}
