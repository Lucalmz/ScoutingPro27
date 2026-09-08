package com.bear27570.app.ui;

import javax.swing.*;
import java.awt.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;

/**
 * Enables smooth border resizing for undecorated Swing JFrames.
 */
public class WindowResizer extends MouseAdapter {
    private static final int BORDER_DRAG_THICKNESS = 6;
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
        WindowResizer resizer = new WindowResizer(frame);
        frame.addMouseListener(resizer);
        frame.addMouseMotionListener(resizer);
        if (frame.getContentPane() != null) {
            frame.getContentPane().addMouseListener(resizer);
            frame.getContentPane().addMouseMotionListener(resizer);
        }
    }

    private boolean isMaximized() {
        return (frame.getExtendedState() & JFrame.MAXIMIZED_BOTH) != 0;
    }

    private int calculateDirection(Point p) {
        if (isMaximized()) return 0;
        int dir = 0;
        int w = frame.getWidth();
        int h = frame.getHeight();

        if (p.y <= BORDER_DRAG_THICKNESS) dir |= NORTH;
        else if (p.y >= h - BORDER_DRAG_THICKNESS) dir |= SOUTH;

        if (p.x <= BORDER_DRAG_THICKNESS) dir |= WEST;
        else if (p.x >= w - BORDER_DRAG_THICKNESS) dir |= EAST;

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
        Point p = SwingUtilities.convertPoint(e.getComponent(), e.getPoint(), frame);
        cursorDirection = calculateDirection(p);
        frame.setCursor(Cursor.getPredefinedCursor(getCursorForDirection(cursorDirection)));
    }

    @Override
    public void mousePressed(MouseEvent e) {
        if (isMaximized()) return;
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
        frame.setCursor(Cursor.getPredefinedCursor(Cursor.DEFAULT_CURSOR));
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
            int proposedW = initialBounds.width - dx;
            if (proposedW >= MIN_WIDTH) {
                newX = initialBounds.x + dx;
                newW = proposedW;
            }
        } else if ((cursorDirection & EAST) != 0) {
            newW = Math.max(MIN_WIDTH, initialBounds.width + dx);
        }

        if ((cursorDirection & NORTH) != 0) {
            int proposedH = initialBounds.height - dy;
            if (proposedH >= MIN_HEIGHT) {
                newY = initialBounds.y + dy;
                newH = proposedH;
            }
        } else if ((cursorDirection & SOUTH) != 0) {
            newH = Math.max(MIN_HEIGHT, initialBounds.height + dy);
        }

        frame.setBounds(newX, newY, newW, newH);
        frame.validate();
    }
}
