package com.bear27570.app.ui;

import com.bear27570.app.Main;

import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;

/**
 * Enables smooth border resizing for undecorated Swing JFrames.
 *
 * <p>Why a reserved border: the window content is a heavyweight JCEF canvas (plus the custom title bar) that
 * covers the frame edge-to-edge. A heavyweight AWT component swallows every mouse event inside its bounds, so
 * listeners on the JFrame / content pane never see the pointer near the window edge and the window could
 * only be maximized/restored, never dragged to a new size. We therefore reserve a thin
 * {@link #RESIZE_BORDER}px strip around the content pane that is <em>not</em> covered by any child. That strip is
 * painted by the (lightweight) content pane itself, receives the mouse events and acts as the resize grip.
 * While maximized the strip is removed so the page fills the whole screen.</p>
 */
public class WindowResizer extends MouseAdapter {
    /** Thickness (px) of the reserved, always-mouse-reachable resize strip around the window. */
    public static final int RESIZE_BORDER = 7;
    /** Along the strip, this many px from a window corner count as the diagonal (corner) grip. */
    private static final int CORNER_GRIP = 20;
    private static final int MIN_WIDTH = 800;
    private static final int MIN_HEIGHT = 600;

    private final JFrame frame;
    private int cursorDirection = 0;
    private Point dragStartPoint = null;
    private Rectangle initialBounds = null;

    private static final int NORTH = 1;
    private static final int SOUTH = 2;
    private static final int WEST = 4;
    private static final int EAST = 8;

    public WindowResizer(JFrame frame) {
        this.frame = frame;
    }

    public static void attach(JFrame frame) {
        Toolkit.getDefaultToolkit().setDynamicLayout(true);
        WindowResizer resizer = new WindowResizer(frame);
        frame.addMouseListener(resizer);
        frame.addMouseMotionListener(resizer);
        frame.setMinimumSize(new Dimension(MIN_WIDTH, MIN_HEIGHT));

        Container content = frame.getContentPane();
        content.addMouseListener(resizer);
        content.addMouseMotionListener(resizer);

        // Reserve the resize strip (removed while maximized).
        resizer.applyContentBorder();
        frame.addWindowStateListener(e -> resizer.applyContentBorder());
    }

    private void applyResizeCursor(Cursor cursor) {
        frame.setCursor(cursor);
        Container content = frame.getContentPane();
        if (content != null) {
            content.setCursor(cursor);
        }
    }

    private void applyContentBorder() {
        Container content = frame.getContentPane();
        if (!(content instanceof JComponent)) return;
        int b = isMaximized() ? 0 : RESIZE_BORDER;
        ((JComponent) content).setBorder(new EmptyBorder(b, b, b, b));
        content.revalidate();
        content.repaint();
    }

    private boolean isMaximized() {
        return (frame.getExtendedState() & JFrame.MAXIMIZED_BOTH) != 0;
    }

    /**
     * @param p pointer position in frame coordinates
     */
    int calculateDirection(Point p) {
        if (isMaximized()) return 0;
        int w = frame.getWidth();
        int h = frame.getHeight();

        boolean nearN = p.y < RESIZE_BORDER;
        boolean nearS = p.y >= h - RESIZE_BORDER;
        boolean nearW = p.x < RESIZE_BORDER;
        boolean nearE = p.x >= w - RESIZE_BORDER;
        if (!(nearN || nearS || nearW || nearE)) return 0;

        // Along an edge strip, the stretch next to a corner acts as the diagonal grip (easier to hit).
        if (nearN || nearS) {
            if (p.x < CORNER_GRIP) nearW = true;
            else if (p.x >= w - CORNER_GRIP) nearE = true;
        }
        if (nearW || nearE) {
            if (p.y < CORNER_GRIP) nearN = true;
            else if (p.y >= h - CORNER_GRIP) nearS = true;
        }

        int dir = 0;
        if (nearN) dir |= NORTH;
        else if (nearS) dir |= SOUTH;
        if (nearW) dir |= WEST;
        else if (nearE) dir |= EAST;
        return dir;
    }

    private int getCursorForDirection(int dir) {
        switch (dir) {
            case NORTH: return Cursor.N_RESIZE_CURSOR;
            case SOUTH: return Cursor.S_RESIZE_CURSOR;
            case WEST: return Cursor.W_RESIZE_CURSOR;
            case EAST: return Cursor.E_RESIZE_CURSOR;
            case NORTH | WEST: return Cursor.NW_RESIZE_CURSOR;
            case NORTH | EAST: return Cursor.NE_RESIZE_CURSOR;
            case SOUTH | WEST: return Cursor.SW_RESIZE_CURSOR;
            case SOUTH | EAST: return Cursor.SE_RESIZE_CURSOR;
            default: return Cursor.DEFAULT_CURSOR;
        }
    }

    @Override
    public void mouseMoved(MouseEvent e) {
        if (dragStartPoint != null) return;
        Point p = SwingUtilities.convertPoint(e.getComponent(), e.getPoint(), frame);
        cursorDirection = calculateDirection(p);
        applyResizeCursor(Cursor.getPredefinedCursor(getCursorForDirection(cursorDirection)));
    }

    @Override
    public void mouseExited(MouseEvent e) {
        // Leaving the strip (into the title bar / browser) must not leave a stale resize cursor behind.
        if (dragStartPoint == null) {
            cursorDirection = 0;
            applyResizeCursor(Cursor.getDefaultCursor());
        }
    }

    @Override
    public void mousePressed(MouseEvent e) {
        if (isMaximized() || !SwingUtilities.isLeftMouseButton(e)) return;
        Point p = SwingUtilities.convertPoint(e.getComponent(), e.getPoint(), frame);
        cursorDirection = calculateDirection(p);
        if (cursorDirection != 0) {
            dragStartPoint = e.getLocationOnScreen();
            initialBounds = frame.getBounds();
        }
    }

    @Override
    public void mouseReleased(MouseEvent e) {
        dragStartPoint = null;
        initialBounds = null;
        cursorDirection = 0;
        applyResizeCursor(Cursor.getDefaultCursor());
    }

    @Override
    public void mouseDragged(MouseEvent e) {
        if (dragStartPoint == null || initialBounds == null || isMaximized() || cursorDirection == 0) {
            return;
        }

        Point currentPoint = e.getLocationOnScreen();
        int dx = currentPoint.x - dragStartPoint.x;
        int dy = currentPoint.y - dragStartPoint.y;

        int newX = initialBounds.x;
        int newY = initialBounds.y;
        int newW = initialBounds.width;
        int newH = initialBounds.height;

        if ((cursorDirection & WEST) != 0) {
            // Right edge stays anchored; clamp so the window never drifts once the minimum is reached.
            newW = Math.max(MIN_WIDTH, initialBounds.width - dx);
            newX = initialBounds.x + (initialBounds.width - newW);
        } else if ((cursorDirection & EAST) != 0) {
            newW = Math.max(MIN_WIDTH, initialBounds.width + dx);
        }

        if ((cursorDirection & NORTH) != 0) {
            newH = Math.max(MIN_HEIGHT, initialBounds.height - dy);
            newY = initialBounds.y + (initialBounds.height - newH);
        } else if ((cursorDirection & SOUTH) != 0) {
            newH = Math.max(MIN_HEIGHT, initialBounds.height + dy);
        }

        frame.setBounds(newX, newY, newW, newH);
        frame.validate();
        Main.updateWindowShape(frame);
    }
}
