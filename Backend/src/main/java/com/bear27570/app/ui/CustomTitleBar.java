package com.bear27570.app.ui;

import javax.imageio.ImageIO;
import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;
import java.awt.event.*;
import java.awt.image.BufferedImage;
import java.io.InputStream;

/**
 * Custom Cyberpunk Window Title Bar for ScoutingPro27.
 * Replaces the system default title bar with custom SP27 branding and window controls.
 */
public class CustomTitleBar extends JPanel {
    private static final int TITLE_BAR_HEIGHT = 36;
    private static final Color BG_COLOR = new Color(10, 10, 10);
    private static final Color BORDER_COLOR = new Color(38, 38, 38);
    private static final Color TEXT_COLOR = new Color(241, 245, 249);
    private static final Color NEON_GREEN = new Color(57, 255, 20);
    private static final Color HOVER_BG = new Color(38, 38, 38);
    private static final Color CLOSE_HOVER_BG = new Color(239, 68, 68);

    private final JFrame frame;
    private Point initialClick;
    private JButton maximizeButton;

    public CustomTitleBar(JFrame frame) {
        this.frame = frame;
        setPreferredSize(new Dimension(0, TITLE_BAR_HEIGHT));
        setBackground(BG_COLOR);
        setLayout(new BorderLayout());

        // 1. Left side: Icon + Title + Cyberpunk Badge
        JPanel leftPanel = new JPanel(new FlowLayout(FlowLayout.LEFT, 10, 0));
        leftPanel.setOpaque(false);
        leftPanel.setBorder(new EmptyBorder(6, 12, 6, 0));

        BufferedImage logoImg = loadLogoImage();
        if (logoImg != null) {
            Image scaledLogo = logoImg.getScaledInstance(20, 20, Image.SCALE_SMOOTH);
            JLabel iconLabel = new JLabel(new ImageIcon(scaledLogo));
            leftPanel.add(iconLabel);
        }

        JLabel titleLabel = new JLabel("ScoutingPro 27");
        titleLabel.setFont(new Font("Segoe UI", Font.BOLD, 13));
        titleLabel.setForeground(TEXT_COLOR);
        leftPanel.add(titleLabel);

        // Cyberpunk Badge
        JLabel badgeLabel = new JLabel(" FTC 27570 B.E.A.R. ");
        badgeLabel.setFont(new Font("Segoe UI", Font.PLAIN, 10));
        badgeLabel.setForeground(NEON_GREEN);
        badgeLabel.setBorder(BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(new Color(57, 255, 20, 100), 1, true),
            new EmptyBorder(1, 4, 1, 4)
        ));
        leftPanel.add(badgeLabel);

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

        // Dragging and double-click maximize setup
        setupDragListeners(this);
        setupDragListeners(leftPanel);
        setupDragListeners(titleLabel);
        setupDragListeners(centerPanel);

        frame.getRootPane().setBorder(BorderFactory.createLineBorder(BORDER_COLOR, 1));

        // Window state listener to repaint maximize/restore button icon and toggle border
        frame.addWindowStateListener(e -> {
            boolean isMax = (frame.getExtendedState() & JFrame.MAXIMIZED_BOTH) != 0;
            frame.getRootPane().setBorder(isMax ? null : BorderFactory.createLineBorder(BORDER_COLOR, 1));
            if (maximizeButton != null) {
                maximizeButton.repaint();
            }
        });
    }

    private BufferedImage loadLogoImage() {
        String[] possiblePaths = { "/icon.png", "/logo.png", "/assets/logo-bear.png" };
        for (String path : possiblePaths) {
            try (InputStream in = getClass().getResourceAsStream(path)) {
                if (in != null) {
                    return ImageIO.read(in);
                }
            } catch (Exception ignored) {}
        }
        return null;
    }

    private void setupDragListeners(Component comp) {
        comp.addMouseListener(new MouseAdapter() {
            @Override
            public void mousePressed(MouseEvent e) {
                initialClick = e.getPoint();
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
                if (initialClick == null) return;
                if ((frame.getExtendedState() & JFrame.MAXIMIZED_BOTH) != 0) {
                    // Restore on drag if maximized
                    toggleMaximize();
                }
                Point current = e.getLocationOnScreen();
                frame.setLocation(current.x - initialClick.x, current.y - initialClick.y);
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
        if (maximizeButton != null) {
            maximizeButton.repaint();
        }
    }

    private JButton createControlButton(String type) {
        JButton btn = new JButton() {
            @Override
            protected void paintComponent(Graphics g) {
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);

                int w = getWidth();
                int h = getHeight();

                // Background
                if (getModel().isPressed()) {
                    g2.setColor("close".equals(type) ? new Color(185, 28, 28) : new Color(50, 50, 50));
                    g2.fillRect(0, 0, w, h);
                } else if (getModel().isRollover()) {
                    g2.setColor("close".equals(type) ? CLOSE_HOVER_BG : HOVER_BG);
                    g2.fillRect(0, 0, w, h);
                }

                // Vector Icon
                g2.setColor(getModel().isRollover() && "close".equals(type) ? Color.WHITE : TEXT_COLOR);
                g2.setStroke(new BasicStroke(1.2f));

                int cx = w / 2;
                int cy = h / 2;

                if ("min".equals(type)) {
                    // Minimize horizontal line
                    g2.drawLine(cx - 5, cy + 3, cx + 5, cy + 3);
                } else if ("max".equals(type)) {
                    boolean isMax = (frame.getExtendedState() & JFrame.MAXIMIZED_BOTH) != 0;
                    if (isMax) {
                        // Restore: 2 overlapping squares
                        g2.drawRect(cx - 3, cy - 5, 7, 7);
                        g2.drawLine(cx - 5, cy - 3, cx - 5, cy + 3);
                        g2.drawLine(cx - 5, cy + 3, cx + 1, cy + 3);
                        g2.drawLine(cx + 1, cy + 3, cx + 1, cy + 1);
                    } else {
                        // Maximize: 1 square
                        g2.drawRect(cx - 5, cy - 5, 9, 9);
                    }
                } else if ("close".equals(type)) {
                    // Close: X
                    g2.drawLine(cx - 5, cy - 5, cx + 5, cy + 5);
                    g2.drawLine(cx + 5, cy - 5, cx - 5, cy + 5);
                }

                g2.dispose();
            }
        };

        btn.setPreferredSize(new Dimension(46, TITLE_BAR_HEIGHT));
        btn.setFocusable(false);
        btn.setBorderPainted(false);
        btn.setContentAreaFilled(false);
        btn.setOpaque(false);
        btn.setCursor(Cursor.getPredefinedCursor(Cursor.DEFAULT_CURSOR));

        if ("min".equals(type)) {
            btn.addActionListener(e -> frame.setExtendedState(frame.getExtendedState() | JFrame.ICONIFIED));
        } else if ("max".equals(type)) {
            btn.addActionListener(e -> toggleMaximize());
        } else if ("close".equals(type)) {
            btn.addActionListener(e -> frame.dispatchEvent(new WindowEvent(frame, WindowEvent.WINDOW_CLOSING)));
        }

        return btn;
    }

    @Override
    protected void paintComponent(Graphics g) {
        super.paintComponent(g);
        // Bottom border line
        g.setColor(BORDER_COLOR);
        g.drawLine(0, getHeight() - 1, getWidth(), getHeight() - 1);
    }
}
