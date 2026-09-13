package com.bear27570.app.ui;

import com.bear27570.app.Main;

import javax.imageio.ImageIO;
import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;
import java.awt.event.*;
import java.awt.geom.*;
import java.awt.image.BufferedImage;
import java.io.InputStream;

/**
 * Custom Cyberpunk / Fluent Window Title Bar for ScoutingPro27.
 * Replaces the system default title bar with custom SP27 branding and window controls.
 */
public class CustomTitleBar extends JPanel {
    private static final int TITLE_BAR_HEIGHT = 38;
    private static final Color BG_COLOR = Color.BLACK; // Pure black #000000
    private static final Color BORDER_COLOR = new Color(20, 20, 24);
    private static final Color TEXT_COLOR = new Color(241, 245, 249);
    private static final Color NEON_GREEN = new Color(57, 255, 20);

    private final JFrame frame;
    private Point mouseClickScreen;
    private Point frameStartLocation;
    private JButton maximizeButton;

    public CustomTitleBar(JFrame frame) {
        this.frame = frame;
        setPreferredSize(new Dimension(0, TITLE_BAR_HEIGHT));
        setBackground(BG_COLOR);
        setLayout(new BorderLayout());

        // 1. Left side: Icon + Title + Cyberpunk Badge
        JPanel leftPanel = new JPanel(new FlowLayout(FlowLayout.LEFT, 10, 0));
        leftPanel.setOpaque(false);
        leftPanel.setBorder(new EmptyBorder(4, 14, 4, 0));

        BufferedImage logoImg = loadLogoImage();
        if (logoImg != null) {
            HighResLogoComponent logoComponent = new HighResLogoComponent(logoImg, 30);
            setupDragListeners(logoComponent);
            leftPanel.add(logoComponent);
        }

        JLabel titleLabel = new JLabel("ScoutingPro 27") {
            @Override
            protected void paintComponent(Graphics g) {
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_LCD_HRGB);
                g2.setRenderingHint(RenderingHints.KEY_FRACTIONALMETRICS, RenderingHints.VALUE_FRACTIONALMETRICS_ON);
                super.paintComponent(g2);
                g2.dispose();
            }
        };
        titleLabel.setFont(new Font("Segoe UI", Font.BOLD, 13));
        titleLabel.setForeground(TEXT_COLOR);
        leftPanel.add(titleLabel);

        // Cyberpunk Capsule Pill Badge
        JPanel badgePanel = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 0)) {
            @Override
            protected void paintComponent(Graphics g) {
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                g2.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
                g2.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
                double w = getWidth();
                double h = getHeight();
                // Translucent glow background
                g2.setColor(new Color(57, 255, 20, 16));
                g2.fill(new RoundRectangle2D.Double(0.0, 0.0, w, h, 14.0, 14.0));
                // Soft neon border
                g2.setColor(new Color(57, 255, 20, 90));
                g2.setStroke(new BasicStroke(1.0f));
                g2.draw(new RoundRectangle2D.Double(0.5, 0.5, w - 1.0, h - 1.0, 14.0, 14.0));
                g2.dispose();
                super.paintComponent(g);
            }
        };
        badgePanel.setOpaque(false);
        badgePanel.setBorder(new EmptyBorder(2, 8, 2, 8));

        // Pulsing green beacon indicator
        JLabel dotLabel = new JLabel("●");
        dotLabel.setFont(new Font("Segoe UI", Font.PLAIN, 8));
        dotLabel.setForeground(NEON_GREEN);
        badgePanel.add(dotLabel);

        JLabel badgeLabel = new JLabel("FTC 27570 B.E.A.R.") {
            @Override
            protected void paintComponent(Graphics g) {
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_LCD_HRGB);
                g2.setRenderingHint(RenderingHints.KEY_FRACTIONALMETRICS, RenderingHints.VALUE_FRACTIONALMETRICS_ON);
                super.paintComponent(g2);
                g2.dispose();
            }
        };
        badgeLabel.setFont(new Font("Segoe UI", Font.BOLD, 10));
        badgeLabel.setForeground(NEON_GREEN);
        badgePanel.add(badgeLabel);

        leftPanel.add(badgePanel);
        add(leftPanel, BorderLayout.WEST);

        // 2. Center: Draggable Spacer
        JPanel centerPanel = new JPanel();
        centerPanel.setOpaque(false);
        add(centerPanel, BorderLayout.CENTER);

        // 3. Right: Window Control Buttons (Minimize, Maximize/Restore, Close)
        JPanel controlsPanel = new JPanel(new GridLayout(1, 3, 0, 0));
        controlsPanel.setOpaque(false);

        JButton minimizeButton = createControlButton("min");
        maximizeButton = createControlButton("max");
        JButton closeButton = createControlButton("close");

        controlsPanel.add(minimizeButton);
        controlsPanel.add(maximizeButton);
        controlsPanel.add(closeButton);

        add(controlsPanel, BorderLayout.EAST);

        // Setup drag listeners on all non-button title bar areas
        setupDragListeners(this);
        setupDragListeners(leftPanel);
        setupDragListeners(titleLabel);
        setupDragListeners(badgePanel);
        setupDragListeners(dotLabel);
        setupDragListeners(badgeLabel);
        setupDragListeners(centerPanel);

        // Repaint maximize button on window state changes
        frame.addWindowStateListener(e -> {
            if (maximizeButton != null) {
                maximizeButton.repaint();
            }
        });
    }

    private BufferedImage loadLogoImage() {
        String[] possiblePaths = {
            "/logo_transparent.png",
            "/logo.png",
            "/public/logo_transparent.png",
            "/public/logo.png",
            "/icon.png",
            "/app_icon.png",
            "/assets/logo-bear.png"
        };
        for (String path : possiblePaths) {
            try (InputStream in = getClass().getResourceAsStream(path)) {
                if (in != null) {
                    BufferedImage img = ImageIO.read(in);
                    if (img != null) {
                        return trimTransparentPadding(img);
                    }
                }
            } catch (Exception ignored) {}
        }
        return null;
    }

    private static BufferedImage trimTransparentPadding(BufferedImage src) {
        if (src == null) return null;
        int width = src.getWidth();
        int height = src.getHeight();
        int minX = width, minY = height, maxX = 0, maxY = 0;
        boolean hasContent = false;

        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int alpha = (src.getRGB(x, y) >>> 24);
                if (alpha > 15) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    hasContent = true;
                }
            }
        }

        if (!hasContent) return src;

        // Add small proportional breathing padding (~4%) so edge anti-aliasing isn't clipped
        int cropW = maxX - minX + 1;
        int cropH = maxY - minY + 1;
        int pad = Math.max(2, Math.max(cropW, cropH) / 25);
        int paddedX = Math.max(0, minX - pad);
        int paddedY = Math.max(0, minY - pad);
        int paddedW = Math.min(width - paddedX, cropW + (minX - paddedX) + pad);
        int paddedH = Math.min(height - paddedY, cropH + (minY - paddedY) + pad);

        return src.getSubimage(paddedX, paddedY, paddedW, paddedH);
    }

    /**
     * High-DPI aware logo component that preserves original master resolution
     * and performs smooth progressive multi-step downsampling directly to physical screen pixels,
     * prioritizing pixel-perfect pre-rendered Lanczos assets when available.
     */
    private static class HighResLogoComponent extends JComponent {
        private final BufferedImage masterImage;

        public HighResLogoComponent(BufferedImage image, int targetSize) {
            this.masterImage = image;
            setPreferredSize(new Dimension(targetSize, targetSize));
            setMinimumSize(new Dimension(targetSize, targetSize));
            setMaximumSize(new Dimension(targetSize, targetSize));
            setOpaque(false);
        }

        @Override
        protected void paintComponent(Graphics g) {
            super.paintComponent(g);
            if (masterImage == null) return;

            Graphics2D g2 = (Graphics2D) g.create();
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
            g2.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            g2.setRenderingHint(RenderingHints.KEY_ALPHA_INTERPOLATION, RenderingHints.VALUE_ALPHA_INTERPOLATION_QUALITY);
            g2.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);

            int compW = getWidth();
            int compH = getHeight();

            // Detect device DPI scaling factor (e.g. 1.0x, 1.25x, 1.5x, 2.0x on Windows)
            AffineTransform tx = g2.getTransform();
            double scaleX = (tx != null) ? tx.getScaleX() : 1.0;
            double scaleY = (tx != null) ? tx.getScaleY() : 1.0;

            int targetDevW = Math.max(1, (int) Math.round(compW * scaleX));
            int targetDevH = Math.max(1, (int) Math.round(compH * scaleY));

            // Load matching pre-rendered Lanczos asset or scale progressively with premultiplied alpha
            BufferedImage scaled = getBestScaledLogo(masterImage, targetDevW, targetDevH);

            int drawW = Math.max(1, (int) Math.round(scaled.getWidth() / scaleX));
            int drawH = Math.max(1, (int) Math.round(scaled.getHeight() / scaleY));
            int x = (compW - drawW) / 2;
            int y = (compH - drawH) / 2;

            g2.drawImage(scaled, x, y, drawW, drawH, null);
            g2.dispose();
        }

        private static BufferedImage getBestScaledLogo(BufferedImage master, int targetW, int targetH) {
            // First check if a pre-rendered pixel-perfect Lanczos asset is available in classpath
            int[] sizes = { 24, 28, 30, 36, 42, 48, 60, 64, 128 };
            int matched = -1;
            for (int s : sizes) {
                if (s >= Math.max(targetW, targetH)) {
                    matched = s;
                    break;
                }
            }
            if (matched > 0) {
                String resPath = "/logo_" + matched + ".png";
                try (InputStream in = HighResLogoComponent.class.getResourceAsStream(resPath)) {
                    if (in != null) {
                        BufferedImage img = ImageIO.read(in);
                        if (img != null) {
                            if (img.getWidth() == targetW && img.getHeight() == targetH) {
                                return img;
                            }
                            return getProgressiveScaledInstance(img, targetW, targetH);
                        }
                    }
                } catch (Exception ignored) {}
            }

            return getProgressiveScaledInstance(master, targetW, targetH);
        }

        private static BufferedImage getProgressiveScaledInstance(BufferedImage img, int targetW, int targetH) {
            int w = img.getWidth();
            int h = img.getHeight();

            if (w <= targetW && h <= targetH) {
                return img;
            }

            BufferedImage current = img;
            do {
                if (w > targetW) {
                    w = Math.max(targetW, w / 2);
                }
                if (h > targetH) {
                    h = Math.max(targetH, h / 2);
                }

                BufferedImage step = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB_PRE);
                Graphics2D gStep = step.createGraphics();
                gStep.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
                gStep.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
                gStep.setRenderingHint(RenderingHints.KEY_ALPHA_INTERPOLATION, RenderingHints.VALUE_ALPHA_INTERPOLATION_QUALITY);
                gStep.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                gStep.drawImage(current, 0, 0, w, h, null);
                gStep.dispose();

                current = step;
            } while (w > targetW || h > targetH);

            return current;
        }
    }

    private void setupDragListeners(Component comp) {
        comp.addMouseListener(new MouseAdapter() {
            @Override
            public void mousePressed(MouseEvent e) {
                if (SwingUtilities.isLeftMouseButton(e)) {
                    mouseClickScreen = e.getLocationOnScreen();
                    frameStartLocation = frame.getLocation();
                }
            }

            @Override
            public void mouseClicked(MouseEvent e) {
                if (e.getClickCount() == 2 && SwingUtilities.isLeftMouseButton(e)) {
                    toggleMaximize();
                }
            }
        });

        comp.addMouseMotionListener(new MouseMotionAdapter() {
            @Override
            public void mouseDragged(MouseEvent e) {
                if (mouseClickScreen == null || frameStartLocation == null) return;
                Point current = e.getLocationOnScreen();

                if ((frame.getExtendedState() & JFrame.MAXIMIZED_BOTH) != 0) {
                    // Restore smoothly around cursor when dragging a maximized window across single or multi-monitor setups
                    double percentX = Math.max(0.0, Math.min(1.0, (double) (mouseClickScreen.x - frame.getX()) / Math.max(1, frame.getWidth())));
                    toggleMaximize();
                    int newWidth = frame.getWidth();
                    int newX = (int) (current.x - percentX * newWidth);
                    int newY = Math.max(0, current.y - TITLE_BAR_HEIGHT / 2);
                    frame.setLocation(newX, newY);
                    frameStartLocation = new Point(newX, newY);
                    mouseClickScreen = current;
                    return;
                }

                int dx = current.x - mouseClickScreen.x;
                int dy = current.y - mouseClickScreen.y;
                frame.setLocation(frameStartLocation.x + dx, frameStartLocation.y + dy);
            }
        });
    }

    private void toggleMaximize() {
        if ((frame.getExtendedState() & JFrame.MAXIMIZED_BOTH) != 0) {
            frame.setExtendedState(JFrame.NORMAL);
        } else {
            GraphicsConfiguration gc = frame.getGraphicsConfiguration();
            Rectangle bounds = gc.getBounds();
            Insets insets = Toolkit.getDefaultToolkit().getScreenInsets(gc);
            Rectangle maxBounds = new Rectangle(
                bounds.x + insets.left,
                bounds.y + insets.top,
                bounds.width - insets.left - insets.right,
                bounds.height - insets.top - insets.bottom
            );
            frame.setMaximizedBounds(maxBounds);
            frame.setExtendedState(JFrame.MAXIMIZED_BOTH);
        }
        Main.updateWindowShape(frame);
        if (maximizeButton != null) {
            maximizeButton.repaint();
        }
    }

    private JButton createControlButton(String type) {
        Runnable action = null;
        if ("min".equals(type)) {
            action = () -> frame.setExtendedState(frame.getExtendedState() | JFrame.ICONIFIED);
        } else if ("max".equals(type)) {
            action = this::toggleMaximize;
        } else if ("close".equals(type)) {
            action = () -> frame.dispatchEvent(new WindowEvent(frame, WindowEvent.WINDOW_CLOSING));
        }
        return new AnimatedControlButton(type, frame, action);
    }

    /**
     * Modern Fluent animated control button with 60 FPS micro-motion
     * (smooth rotation, scale, line expansion, dynamic high-contrast acrylic highlights).
     */
    private static class AnimatedControlButton extends JButton {
        private final String type;
        private final JFrame frame;
        private float hoverProgress = 0.0f;
        private float pressProgress = 0.0f;
        private float targetHover = 0.0f;
        private float targetPress = 0.0f;
        private final Timer animTimer;

        public AnimatedControlButton(String type, JFrame frame, Runnable action) {
            this.type = type;
            this.frame = frame;
            setPreferredSize(new Dimension(46, TITLE_BAR_HEIGHT));
            setFocusable(false);
            setBorderPainted(false);
            setContentAreaFilled(false);
            setOpaque(false);
            setBorder(null);
            setCursor(Cursor.getPredefinedCursor(Cursor.DEFAULT_CURSOR));

            animTimer = new Timer(16, e -> {
                boolean changed = false;
                float dh = targetHover - hoverProgress;
                if (Math.abs(dh) > 0.005f) {
                    hoverProgress += dh * 0.25f;
                    changed = true;
                } else if (hoverProgress != targetHover) {
                    hoverProgress = targetHover;
                    changed = true;
                }

                float dp = targetPress - pressProgress;
                if (Math.abs(dp) > 0.005f) {
                    pressProgress += dp * 0.35f;
                    changed = true;
                } else if (pressProgress != targetPress) {
                    pressProgress = targetPress;
                    changed = true;
                }

                if (changed) {
                    repaint();
                } else {
                    ((Timer) e.getSource()).stop();
                }
            });

            addMouseListener(new MouseAdapter() {
                @Override
                public void mouseEntered(MouseEvent e) {
                    targetHover = 1.0f;
                    if (!animTimer.isRunning()) animTimer.start();
                }

                @Override
                public void mouseExited(MouseEvent e) {
                    targetHover = 0.0f;
                    targetPress = 0.0f;
                    if (!animTimer.isRunning()) animTimer.start();
                }

                @Override
                public void mousePressed(MouseEvent e) {
                    if (SwingUtilities.isLeftMouseButton(e)) {
                        targetPress = 1.0f;
                        if (!animTimer.isRunning()) animTimer.start();
                    }
                }

                @Override
                public void mouseReleased(MouseEvent e) {
                    if (SwingUtilities.isLeftMouseButton(e)) {
                        targetPress = 0.0f;
                        if (!animTimer.isRunning()) animTimer.start();
                    }
                }
            });

            if (action != null) {
                addActionListener(e -> action.run());
            }
        }

        @Override
        protected void paintComponent(Graphics g) {
            Graphics2D g2 = (Graphics2D) g.create();
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
            g2.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);

            int w = getWidth();
            int h = getHeight();
            boolean isClose = "close".equals(type);

            // 1. High-contrast Fluent background
            if (isClose) {
                if (hoverProgress > 0.001f) {
                    // Windows Red #E81123, deepening on press to #B80E1C
                    int r = Math.round(232 - 48 * pressProgress);
                    int gr = Math.round(17 - 3 * pressProgress);
                    int b = Math.round(35 - 7 * pressProgress);
                    int a = Math.min(255, Math.max(0, Math.round(255 * hoverProgress)));
                    g2.setColor(new Color(r, gr, b, a));
                    g2.fillRect(0, 0, w, h);
                }
            } else {
                if (hoverProgress > 0.001f || pressProgress > 0.001f) {
                    // Clear white highlight: hover ~19% opacity (#303030), press ~33% opacity
                    int alpha = Math.min(255, Math.round(48 * hoverProgress + 36 * pressProgress));
                    g2.setColor(new Color(255, 255, 255, alpha));
                    g2.fillRect(0, 0, w, h);
                }
            }

            // 2. Icon color
            Color iconColor;
            if (isClose) {
                // Idle: #CCCCCC, Hover: #FFFFFF
                int gray = Math.min(255, Math.round(204 + (255 - 204) * hoverProgress));
                iconColor = new Color(gray, gray, gray);
            } else {
                int gray = Math.min(255, Math.round(204 + (255 - 204) * hoverProgress));
                iconColor = new Color(gray, gray, gray);
            }
            g2.setColor(iconColor);

            // 3. Dynamic micro-motion transform
            double cx = w / 2.0;
            double cy = h / 2.0;
            g2.translate(cx, cy);

            // Interactive scale feedback: scales up on hover, compresses down on press
            double scale = (1.0 + 0.16 * hoverProgress) * (1.0 - 0.14 * pressProgress);
            g2.scale(scale, scale);

            if ("min".equals(type)) {
                // Minimize: line smoothly extends and thickens on hover
                double halfLen = 5.0 + 3.0 * hoverProgress;
                float strokeW = 1.35f + 0.65f * hoverProgress;
                g2.setStroke(new BasicStroke(strokeW, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
                g2.draw(new Line2D.Double(-halfLen, 1.5, halfLen, 1.5));
            } else if ("max".equals(type)) {
                boolean isMax = (frame.getExtendedState() & JFrame.MAXIMIZED_BOTH) != 0;
                float strokeW = 1.35f + 0.25f * hoverProgress;
                g2.setStroke(new BasicStroke(strokeW, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
                if (isMax) {
                    // Restore: 2 overlapping squares that shift smoothly
                    double offset = 2.0 + 0.5 * hoverProgress;
                    g2.draw(new RoundRectangle2D.Double(-4.5 + offset, -4.5 - offset, 8.0, 8.0, 1.0, 1.0));
                    g2.draw(new RoundRectangle2D.Double(-4.5, -4.5, 8.0, 8.0, 1.0, 1.0));
                } else {
                    // Maximize: clean crisp square
                    g2.draw(new RoundRectangle2D.Double(-5.0, -5.0, 10.0, 10.0, 1.2, 1.2));
                }
            } else if ("close".equals(type)) {
                // Close: spins 45 degrees on hover, snappy and distinct!
                g2.rotate(Math.toRadians(45.0 * hoverProgress));
                float strokeW = 1.4f + 0.35f * hoverProgress;
                g2.setStroke(new BasicStroke(strokeW, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
                double len = 4.8;
                g2.draw(new Line2D.Double(-len, -len, len, len));
                g2.draw(new Line2D.Double(len, -len, -len, len));
            }

            g2.dispose();
        }
    }

    @Override
    protected void paintComponent(Graphics g) {
        Graphics2D g2 = (Graphics2D) g.create();
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_LCD_HRGB);
        g2.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
        g2.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);

        // Pure black background for clean OLED/HiDPI look
        g2.setColor(BG_COLOR);
        g2.fillRect(0, 0, getWidth(), getHeight());

        // Subtle dark border line
        g2.setColor(BORDER_COLOR);
        g2.drawLine(0, getHeight() - 1, getWidth(), getHeight() - 1);
        g2.dispose();
    }
}
