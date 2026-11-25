package com.bear27570.app;

import javax.imageio.ImageIO;
import javax.swing.*;
import java.awt.*;
import java.awt.font.TextAttribute;
import java.awt.geom.Point2D;
import java.awt.geom.Rectangle2D;
import java.awt.geom.RoundRectangle2D;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Pit Wall Splash Screen shown while ScoutingPro27 initializes.
 *
 * Design specification ("Pit Wall" 560 x 380):
 *   - Canvas background : #0B0E10 (--g-900)
 *   - 1px inner border  : #1B2126 (--g-750) + top 1px #39FF14 center fade highlight
 *   - Dot grid texture  : #151A1E (--g-800), 20px pitch, 300px radial fade
 *   - Header            : pulsing 6px #39FF14 dot (#FF5577 static on failure) + "SYSTEM BOOT" (#6E7A84) | "v1.1.1" (#4B5660)
 *   - Center brand      : 72px V6 SP27 logo (/assets/logo_transparent.png), Orbitron wordmark "ScoutingPro27"
 *                         ("ScoutingPro" #E6EBEE + "27" #39FF14, 45ms/char typewriter + #39FF14 cursor),
 *                         subtitle "FTC MATCH & PIT SCOUTING" (#6E7A84)
 *   - Status & progress : "▸ " (#39FF14 / #FF5577) + English statusText (#C3CBD1 / #39FF14 / #FF5577) | percent% (#97A2AB)
 *                         or "See log/ directory" (#97A2AB) on failure; 5-segment progress bar matching Main.java stages
 *   - Footer (y>320)    : #151A1E divider, "Led by 27570" (#6E7A84) + 36px true-alpha BEAR logo | "B.E.A.R ROBOTICS" (#4B5660)
 */
public class SplashScreen extends JWindow {

    private static final long MIN_VISIBLE_MS = 2200;

    // ------- typewriter & entrance timeline -------
    private static final String TITLE_FULL = "ScoutingPro27";
    private static final String TITLE_PREFIX = "ScoutingPro";
    private static final String SUBTITLE = "FTC MATCH & PIT SCOUTING";
    private static final String HEADER_LEFT = "SYSTEM BOOT";
    private static final String HEADER_VERSION = "v1.1.1";
    private static final String CREDIT_TEXT = "Led by 27570";
    private static final String FOOTER_RIGHT = "B.E.A.R ROBOTICS";
    private static final String FAILURE_HINT = "See log/ directory";

    private static final long LOGO_FADE_START_MS = 80;
    private static final long LOGO_FADE_MS = 360;
    private static final long TITLE_START_MS = 220;
    private static final long TITLE_CHAR_MS = 45;
    private static final long SUBTITLE_START_MS = TITLE_START_MS + TITLE_FULL.length() * TITLE_CHAR_MS + 60;
    private static final long SUBTITLE_FADE_MS = 240;
    private static final long CURSOR_BLINK_MS = 530;

    // ------- Pit Wall color palette -------
    public static final Color BG_GRAPHITE_900 = new Color(0x0B, 0x0E, 0x10);
    public static final Color DOT_GRAPHITE_800 = new Color(0x15, 0x1A, 0x1E);
    public static final Color BORDER_GRAPHITE_750 = new Color(0x1B, 0x21, 0x26);
    public static final Color TEXT_G500 = new Color(0x4B, 0x56, 0x60);
    public static final Color TEXT_G400 = new Color(0x6E, 0x7A, 0x84);
    public static final Color TEXT_G300 = new Color(0x97, 0xA2, 0xAB);
    public static final Color TEXT_G200 = new Color(0xC3, 0xCB, 0xD1);
    public static final Color TEXT_G100 = new Color(0xE6, 0xEB, 0xEE);

    public static final Color PRIMARY_GREEN = new Color(0x39, 0xFF, 0x14);
    public static final Color SIGNAL_200 = new Color(0xB8, 0xFF, 0xA3);
    public static final Color SIGNAL_700 = new Color(0x24, 0x66, 0x1A);

    public static final Color ERROR_ROSE = new Color(0xFF, 0x55, 0x77);
    public static final Color ERROR_BORDER = new Color(0x6E, 0x1F, 0x33);

    private static final String FONT_ORBITRON = "/assets/Orbitron-VariableFont_wght-CYB_IVAf.ttf";
    private static final String FONT_MANROPE = "/assets/Manrope-VariableFont_wght-0N3pECc_.ttf";
    private static final String FONT_FALLBACK = "Segoe UI";

    private static final float[] STAGE_BOUNDS = {0f, 10f, 35f, 55f, 70f, 100f};
    private static final int SEGMENT_COUNT = 5;
    private static final float SEGMENT_GAP = 6f;
    private static final float BAR_HEIGHT = 3f;
    private static final int CONTENT_MARGIN_X = 40;

    private final Font titleFont;
    private final Font subtitleFont;
    private final Font headerFont;
    private final Font versionFont;
    private final Font statusFont;
    private final Font percentFont;
    private final Font footerLeftFont;
    private final Font footerRightFont;

    private final ContentPanel contentPanel = new ContentPanel();
    private final long startTime = System.currentTimeMillis();
    private Long testElapsedOverrideMs = null;
    private long readyReachedAtMs = 0L;

    private volatile int targetProgress = 0;
    private volatile String statusText = "Initializing...";
    private volatile boolean failed = false;
    private float displayedProgress = 0f;

    private final BufferedImage sp27Logo;
    private final BufferedImage bearLogo;
    private final Timer animTimer;

    public SplashScreen() {
        setSize(560, 380);
        setLocationRelativeTo(null);
        setBackground(BG_GRAPHITE_900);
        setLayout(new BorderLayout());

        titleFont = withTracking(loadFont(FONT_ORBITRON, Font.BOLD, 27f), 0.02f);
        subtitleFont = withTracking(loadFont(FONT_MANROPE, Font.BOLD, 10.5f), 0.22f);
        headerFont = withTracking(loadFont(FONT_MANROPE, Font.BOLD, 10f), 0.18f);
        versionFont = withTracking(loadFont(FONT_MANROPE, Font.BOLD, 10.5f), 0.06f);
        statusFont = loadFont(FONT_MANROPE, Font.PLAIN, 13f);
        percentFont = loadFont(FONT_ORBITRON, Font.BOLD, 12f);
        footerLeftFont = loadFont(FONT_MANROPE, Font.PLAIN, 11.5f);
        footerRightFont = withTracking(loadFont(FONT_MANROPE, Font.BOLD, 10f), 0.15f);

        BufferedImage rawSp27 = loadFirstImage("/assets/logo_transparent.png", "/logo_transparent.png", "/public/logo_transparent.png");
        sp27Logo = rawSp27 != null ? scaleProgressive(rawSp27, 144, 144) : null;

        BufferedImage rawBear = loadFirstImage("/assets/logo-bear.png");
        if (rawBear != null) {
            int targetBearH = 72; // 2x HiDPI source for 36px display height
            int targetBearW = Math.max(1, (int) Math.round(targetBearH * ((double) rawBear.getWidth() / rawBear.getHeight())));
            bearLogo = scaleProgressive(rawBear, targetBearW, targetBearH);
        } else {
            bearLogo = null;
        }

        add(contentPanel, BorderLayout.CENTER);

        animTimer = new Timer(16, e -> {
            if (!failed) {
                displayedProgress += (targetProgress - displayedProgress) * 0.12f;
                if (Math.abs(targetProgress - displayedProgress) < 0.15f) {
                    displayedProgress = targetProgress;
                }
                if (displayedProgress >= 99.5f && readyReachedAtMs == 0L) {
                    readyReachedAtMs = currentElapsedMs();
                }
            }
            contentPanel.repaint();
        });
        animTimer.start();
    }

    private long currentElapsedMs() {
        if (testElapsedOverrideMs != null) {
            return testElapsedOverrideMs;
        }
        return System.currentTimeMillis() - startTime;
    }

    private static Font withTracking(Font base, float tracking) {
        Map<TextAttribute, Object> attrs = new HashMap<>();
        attrs.put(TextAttribute.TRACKING, tracking);
        return base.deriveFont(attrs);
    }

    private Font loadFont(String classpathResource, int style, float size) {
        try (InputStream in = SplashScreen.class.getResourceAsStream(classpathResource)) {
            if (in != null) {
                Font base = Font.createFont(Font.TRUETYPE_FONT, in);
                GraphicsEnvironment.getLocalGraphicsEnvironment().registerFont(base);
                return base.deriveFont(style, size);
            }
        } catch (Exception e) {
            System.err.println("Could not load font " + classpathResource + ": " + e.getMessage());
        }
        return new Font(FONT_FALLBACK, style, Math.round(size));
    }

    private BufferedImage loadFirstImage(String... classpathResources) {
        for (String path : classpathResources) {
            try (InputStream in = SplashScreen.class.getResourceAsStream(path)) {
                if (in != null) {
                    BufferedImage img = ImageIO.read(in);
                    if (img != null) return img;
                }
            } catch (IOException ignored) {}
        }
        return null;
    }

    private static BufferedImage scaleProgressive(BufferedImage src, int targetW, int targetH) {
        int w = src.getWidth();
        int h = src.getHeight();
        BufferedImage current = src;
        while (w > targetW * 2 || h > targetH * 2) {
            w = Math.max(targetW, w / 2);
            h = Math.max(targetH, h / 2);
            BufferedImage step = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
            Graphics2D g2 = step.createGraphics();
            g2.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
            g2.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.drawImage(current, 0, 0, w, h, null);
            g2.dispose();
            current = step;
        }
        if (w != targetW || h != targetH) {
            BufferedImage out = new BufferedImage(targetW, targetH, BufferedImage.TYPE_INT_ARGB);
            Graphics2D g2 = out.createGraphics();
            g2.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
            g2.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.drawImage(current, 0, 0, targetW, targetH, null);
            g2.dispose();
            return out;
        }
        return current;
    }

    /** Called from the background init thread, percent: 0-100 */
    public void updateProgress(int percent, String text) {
        if (this.failed) return;
        this.targetProgress = Math.max(0, Math.min(100, percent));
        if (text != null && !text.isEmpty()) {
            this.statusText = text;
        }
        if (this.targetProgress >= 100 && readyReachedAtMs == 0L) {
            readyReachedAtMs = currentElapsedMs();
        }
        contentPanel.repaint();
    }

    /**
     * Transitions the splash screen into its visible Pit Wall error state
     * instead of immediately closing on startup failure.
     */
    public void showFailure(String errorMessage) {
        this.failed = true;
        String detail = (errorMessage != null && !errorMessage.trim().isEmpty())
                ? errorMessage.trim()
                : "Unexpected initialization error";
        if (detail.length() > 44) {
            detail = detail.substring(0, 41) + "...";
        }
        if (!detail.toLowerCase().startsWith("startup failed")) {
            this.statusText = "Startup failed: " + detail;
        } else {
            this.statusText = detail;
        }
        this.displayedProgress = Math.max(this.displayedProgress, this.targetProgress);
        contentPanel.repaint();
    }

    public boolean isFailed() {
        return failed;
    }

    public String getStatusText() {
        return statusText;
    }

    public int getTargetProgress() {
        return targetProgress;
    }

    /**
     * Deterministic state setter for visual unit tests.
     */
    public void setRenderStateForTest(long simulatedElapsedMs, float progress, String text, boolean isFailed) {
        this.testElapsedOverrideMs = simulatedElapsedMs;
        this.failed = isFailed;
        this.targetProgress = Math.max(0, Math.min(100, Math.round(progress)));
        this.displayedProgress = Math.max(0f, Math.min(100f, progress));
        this.statusText = text != null ? text : "";
        if (this.displayedProgress >= 100f && !isFailed) {
            this.readyReachedAtMs = simulatedElapsedMs - 60L;
        } else {
            this.readyReachedAtMs = 0L;
        }
        contentPanel.repaint();
    }

    public void closeSmoothly(Runnable onClosed) {
        if (failed) return;
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
            opacity[0] -= 0.08f;
            if (opacity[0] <= 0f) {
                fade.stop();
                if (animTimer != null && animTimer.isRunning()) {
                    animTimer.stop();
                }
                dispose();
                if (onClosed != null) onClosed.run();
            } else {
                try {
                    setOpacity(Math.max(0f, opacity[0]));
                } catch (UnsupportedOperationException ignored) {}
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

    private static int typedChars(String text, long elapsedMs, long startMs, long charMs) {
        if (elapsedMs < startMs) return 0;
        return (int) Math.min(text.length(), (elapsedMs - startMs) / charMs + 1);
    }

    private class ContentPanel extends JPanel {

        ContentPanel() {
            setOpaque(true);
            setBackground(BG_GRAPHITE_900);
        }

        @Override
        protected void paintComponent(Graphics g) {
            super.paintComponent(g);
            Graphics2D g2 = (Graphics2D) g.create();

            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_LCD_HRGB);
            g2.setRenderingHint(RenderingHints.KEY_FRACTIONALMETRICS, RenderingHints.VALUE_FRACTIONALMETRICS_ON);
            g2.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
            g2.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
            g2.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            g2.setRenderingHint(RenderingHints.KEY_ALPHA_INTERPOLATION, RenderingHints.VALUE_ALPHA_INTERPOLATION_QUALITY);

            int w = getWidth();
            int h = getHeight();
            long elapsed = currentElapsedMs();
            Composite oldComposite = g2.getComposite();

            // 1. Cold Graphite #0B0E10 background
            g2.setColor(BG_GRAPHITE_900);
            g2.fillRect(0, 0, w, h);

            // 2. Subtle dot grid (#151A1E, 20px pitch, 300px radial fade around center-top)
            float cx = w * 0.5f;
            float cy = h * 0.40f;
            float maxR = 300f;
            for (int gy = 16; gy < h - 16; gy += 20) {
                for (int gx = 16; gx < w - 16; gx += 20) {
                    float dist = (float) Math.hypot(gx - cx, gy - cy);
                    if (dist < maxR) {
                        float alpha = (1f - dist / maxR) * 0.85f;
                        g2.setColor(new Color(0x15, 0x1A, 0x1E, Math.min(255, Math.round(alpha * 255f))));
                        g2.fill(new Rectangle2D.Float(gx - 0.75f, gy - 0.75f, 1.5f, 1.5f));
                    }
                }
            }

            // 3. Crisp 1px inner border (#1B2126) + top 1px #39FF14 center fade highlight
            g2.setColor(BORDER_GRAPHITE_750);
            g2.fillRect(0, 0, w, 1);
            g2.fillRect(0, h - 1, w, 1);
            g2.fillRect(0, 0, 1, h);
            g2.fillRect(w - 1, 0, 1, h);

            Paint oldPaint = g2.getPaint();
            Color topHighlight = failed ? new Color(0xFF, 0x55, 0x77, 155) : new Color(0x39, 0xFF, 0x14, 165);
            Color topClear = new Color(topHighlight.getRed(), topHighlight.getGreen(), topHighlight.getBlue(), 0);
            g2.setPaint(new LinearGradientPaint(
                    new Point2D.Float(36f, 0f),
                    new Point2D.Float(w - 36f, 0f),
                    new float[]{0f, 0.5f, 1f},
                    new Color[]{topClear, topHighlight, topClear}
            ));
            g2.fill(new Rectangle2D.Float(36f, 0f, w - 72f, 1.25f));
            g2.setPaint(oldPaint);

            // 4. Header row: pulsing status dot + "SYSTEM BOOT" | "v1.1.1"
            int headerY = 28;
            float dotX = 24f;
            float dotY = headerY - 7.5f;
            if (failed) {
                g2.setColor(ERROR_ROSE);
                g2.fill(new RoundRectangle2D.Float(dotX, dotY, 6f, 6f, 6f, 6f));
            } else {
                float pulse = 0.45f + 0.55f * (0.5f + 0.5f * (float) Math.cos((elapsed / 1200.0) * Math.PI * 2.0));
                g2.setColor(new Color(0x39, 0xFF, 0x14, Math.round(65 * pulse)));
                g2.fill(new RoundRectangle2D.Float(dotX - 3f, dotY - 3f, 12f, 12f, 12f, 12f));
                g2.setColor(new Color(0x39, 0xFF, 0x14, Math.min(255, Math.round(255 * pulse))));
                g2.fill(new RoundRectangle2D.Float(dotX, dotY, 6f, 6f, 6f, 6f));
            }

            g2.setFont(headerFont);
            g2.setColor(TEXT_G400);
            g2.drawString(HEADER_LEFT, 36, headerY);

            g2.setFont(versionFont);
            FontMetrics vfm = g2.getFontMetrics();
            g2.setColor(TEXT_G500);
            g2.drawString(HEADER_VERSION, w - 24 - vfm.stringWidth(HEADER_VERSION), headerY);

            // 5. Center SP27 Logo (72 x 72)
            int logoSize = 72;
            int logoX = (w - logoSize) / 2;
            int logoY = 58;
            if (sp27Logo != null && elapsed >= LOGO_FADE_START_MS) {
                float logoAlpha = Math.min(1f, (elapsed - LOGO_FADE_START_MS) / (float) LOGO_FADE_MS);
                g2.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, logoAlpha));
                g2.drawImage(sp27Logo, logoX, logoY, logoSize, logoSize, null);
                g2.setComposite(oldComposite);
            }

            // 6. Wordmark: "ScoutingPro" (#E6EBEE) + "27" (#39FF14) with 45ms/char typewriter
            int titleTyped = typedChars(TITLE_FULL, elapsed, TITLE_START_MS, TITLE_CHAR_MS);
            g2.setFont(titleFont);
            FontMetrics tfm = g2.getFontMetrics();
            int fullTitleW = tfm.stringWidth(TITLE_FULL);
            int titleX = (w - fullTitleW) / 2;
            int titleBaselineY = 176;

            int prefixCount = Math.min(titleTyped, TITLE_PREFIX.length());
            String typedPrefix = TITLE_FULL.substring(0, prefixCount);
            if (!typedPrefix.isEmpty()) {
                g2.setColor(TEXT_G100);
                g2.drawString(typedPrefix, titleX, titleBaselineY);
            }
            int prefixW = tfm.stringWidth(typedPrefix);
            int currentEndX = titleX + prefixW;

            if (titleTyped > TITLE_PREFIX.length()) {
                String typedSuffix = TITLE_FULL.substring(TITLE_PREFIX.length(), titleTyped);
                int fullPrefixW = tfm.stringWidth(TITLE_PREFIX);
                g2.setColor(PRIMARY_GREEN);
                g2.drawString(typedSuffix, titleX + fullPrefixW, titleBaselineY);
                currentEndX = titleX + fullPrefixW + tfm.stringWidth(typedSuffix);
            }

            // Typewriter block cursor (#39FF14)
            boolean typingTitle = titleTyped > 0 && titleTyped < TITLE_FULL.length();
            boolean blinkOn = (elapsed / CURSOR_BLINK_MS) % 2 == 0;
            if (!failed && (typingTitle || (titleTyped >= TITLE_FULL.length() && blinkOn))) {
                g2.setColor(PRIMARY_GREEN);
                int cursorH = 22;
                g2.fill(new Rectangle2D.Float(currentEndX + 4f, titleBaselineY - cursorH + 2f, 2.2f, cursorH));
            }

            // 7. Subtitle: "FTC MATCH & PIT SCOUTING"
            if (elapsed >= SUBTITLE_START_MS) {
                float subAlpha = Math.min(1f, (elapsed - SUBTITLE_START_MS) / (float) SUBTITLE_FADE_MS);
                g2.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, subAlpha));
                g2.setFont(subtitleFont);
                FontMetrics sfm = g2.getFontMetrics();
                g2.setColor(TEXT_G400);
                g2.drawString(SUBTITLE, (w - sfm.stringWidth(SUBTITLE)) / 2, 202);
                g2.setComposite(oldComposite);
            }

            // 8. Status line & 5-Segment Progress Bar
            int barX = CONTENT_MARGIN_X;
            int barW = w - CONTENT_MARGIN_X * 2;
            int statusBaselineY = 278;
            int barY = 292;

            boolean isReady = !failed && displayedProgress >= 99.5f;
            Color arrowColor = failed ? ERROR_ROSE : PRIMARY_GREEN;
            Color statusColor = failed ? ERROR_ROSE : (isReady ? PRIMARY_GREEN : TEXT_G200);

            g2.setFont(statusFont);
            g2.setColor(arrowColor);
            java.awt.geom.Path2D.Float tri = new java.awt.geom.Path2D.Float();
            float triY = statusBaselineY - 4.5f;
            tri.moveTo(barX, triY - 3.5f);
            tri.lineTo(barX + 5.5f, triY);
            tri.lineTo(barX, triY + 3.5f);
            tri.closePath();
            g2.fill(tri);
            int arrowW = 12;

            g2.setColor(statusColor);
            String displayStatus = statusText != null ? statusText : "";
            g2.drawString(displayStatus, barX + arrowW, statusBaselineY);

            if (failed) {
                g2.setFont(footerLeftFont);
                FontMetrics hfm = g2.getFontMetrics();
                g2.setColor(TEXT_G300);
                g2.drawString(FAILURE_HINT, barX + barW - hfm.stringWidth(FAILURE_HINT), statusBaselineY);
            } else {
                g2.setFont(percentFont);
                FontMetrics pfm = g2.getFontMetrics();
                String pctStr = Math.max(0, Math.min(100, Math.round(displayedProgress))) + "%";
                g2.setColor(isReady ? PRIMARY_GREEN : TEXT_G300);
                g2.drawString(pctStr, barX + barW - pfm.stringWidth(pctStr), statusBaselineY);
            }

            drawFiveSegmentBar(g2, barX, barY, barW, displayedProgress, elapsed, isReady);

            // 9. Divider & Footer
            int dividerY = 318;
            g2.setColor(DOT_GRAPHITE_800);
            g2.fillRect(barX, dividerY, barW, 1);

            int footerCenterY = 348;
            g2.setFont(footerLeftFont);
            FontMetrics flFm = g2.getFontMetrics();
            int flBaseline = footerCenterY + (flFm.getAscent() - flFm.getDescent()) / 2;
            g2.setColor(TEXT_G400);
            g2.drawString(CREDIT_TEXT, barX, flBaseline);

            if (bearLogo != null) {
                int bearH = 36;
                int bearW = Math.max(1, (int) Math.round(bearH * ((double) bearLogo.getWidth() / bearLogo.getHeight())));
                int bearX = barX + flFm.stringWidth(CREDIT_TEXT) + 10;
                int bearY = footerCenterY - bearH / 2;
                g2.drawImage(bearLogo, bearX, bearY, bearW, bearH, null);
            }

            g2.setFont(footerRightFont);
            FontMetrics frFm = g2.getFontMetrics();
            int frBaseline = footerCenterY + (frFm.getAscent() - frFm.getDescent()) / 2;
            g2.setColor(TEXT_G500);
            g2.drawString(FOOTER_RIGHT, barX + barW - frFm.stringWidth(FOOTER_RIGHT), frBaseline);

            g2.dispose();
        }

        private void drawFiveSegmentBar(Graphics2D g2, int x, int y, int totalW, float progress, long elapsedMs, boolean isReady) {
            float segW = (totalW - (SEGMENT_COUNT - 1) * SEGMENT_GAP) / (float) SEGMENT_COUNT;

            int failedSegmentIndex = -1;
            if (failed) {
                for (int i = 0; i < SEGMENT_COUNT; i++) {
                    if (progress < STAGE_BOUNDS[i + 1] || i == SEGMENT_COUNT - 1) {
                        failedSegmentIndex = i;
                        break;
                    }
                }
            }

            boolean flashActive = isReady && readyReachedAtMs > 0L && (elapsedMs - readyReachedAtMs) <= 220L;

            for (int i = 0; i < SEGMENT_COUNT; i++) {
                float sx = x + i * (segW + SEGMENT_GAP);
                float lo = STAGE_BOUNDS[i];
                float hi = STAGE_BOUNDS[i + 1];
                float ratio = Math.max(0f, Math.min(1f, (progress - lo) / (hi - lo)));

                RoundRectangle2D.Float trackShape = new RoundRectangle2D.Float(sx, y, segW, BAR_HEIGHT, BAR_HEIGHT, BAR_HEIGHT);

                if (failed) {
                    if (i < failedSegmentIndex) {
                        g2.setColor(PRIMARY_GREEN);
                        g2.fill(trackShape);
                    } else if (i == failedSegmentIndex) {
                        g2.setColor(ERROR_BORDER);
                        g2.fill(trackShape);
                        float errFillW = segW * Math.max(0.38f, ratio);
                        g2.setColor(ERROR_ROSE);
                        g2.fill(new RoundRectangle2D.Float(sx, y, errFillW, BAR_HEIGHT, BAR_HEIGHT, BAR_HEIGHT));
                    } else {
                        g2.setColor(BORDER_GRAPHITE_750);
                        g2.fill(trackShape);
                    }
                    continue;
                }

                if (ratio <= 0f) {
                    g2.setColor(BORDER_GRAPHITE_750);
                    g2.fill(trackShape);
                } else if (ratio < 1f) {
                    g2.setColor(SIGNAL_700);
                    g2.fill(trackShape);

                    float fillW = Math.max(3f, segW * ratio);
                    RoundRectangle2D.Float fillShape = new RoundRectangle2D.Float(sx, y, fillW, BAR_HEIGHT, BAR_HEIGHT, BAR_HEIGHT);
                    g2.setColor(PRIMARY_GREEN);
                    g2.fill(fillShape);

                    // Sweeping #B8FFA3 shimmer highlight on active segment
                    Shape oldClip = g2.getClip();
                    g2.setClip(fillShape);
                    float shimmerPhase = (elapsedMs % 1100L) / 1100f;
                    float shimmerX = sx - 36f + shimmerPhase * (segW + 72f);
                    Paint prevPaint = g2.getPaint();
                    Color sClear = new Color(0xB8, 0xFF, 0xA3, 0);
                    Color sPeak = new Color(0xB8, 0xFF, 0xA3, 190);
                    g2.setPaint(new LinearGradientPaint(
                            new Point2D.Float(shimmerX, y),
                            new Point2D.Float(shimmerX + 36f, y),
                            new float[]{0f, 0.5f, 1f},
                            new Color[]{sClear, sPeak, sClear}
                    ));
                    g2.fill(new Rectangle2D.Float(shimmerX, y, 36f, BAR_HEIGHT));
                    g2.setPaint(prevPaint);
                    g2.setClip(oldClip);
                } else {
                    if (flashActive) {
                        g2.setColor(new Color(0x39, 0xFF, 0x14, 75));
                        g2.fill(new RoundRectangle2D.Float(sx - 1.5f, y - 2f, segW + 3f, BAR_HEIGHT + 4f, 4f, 4f));
                    }
                    g2.setColor(PRIMARY_GREEN);
                    g2.fill(trackShape);
                }
            }
        }
    }
}
