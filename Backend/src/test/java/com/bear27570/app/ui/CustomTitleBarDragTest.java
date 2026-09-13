package com.bear27570.app.ui;

import org.junit.jupiter.api.Test;

import javax.swing.*;
import java.awt.*;
import java.awt.event.MouseEvent;

import static org.assertj.core.api.Assertions.assertThat;

public class CustomTitleBarDragTest {

    @Test
    public void testDragCalculatesScreenDeltaAccuratelyWithoutGlitch() throws Exception {
        SwingUtilities.invokeAndWait(() -> {
            JFrame frame = new JFrame("Drag Test");
            frame.setUndecorated(true);
            frame.setSize(1000, 600);
            frame.setLocation(100, 100);

            CustomTitleBar titleBar = new CustomTitleBar(frame);
            frame.getContentPane().add(titleBar, BorderLayout.NORTH);
            frame.doLayout();

            // Find centerPanel
            Component centerComp = null;
            for (Component comp : titleBar.getComponents()) {
                if (comp instanceof JPanel && ((BorderLayout) titleBar.getLayout()).getConstraints(comp).equals(BorderLayout.CENTER)) {
                    centerComp = comp;
                    break;
                }
            }
            assertThat(centerComp).isNotNull();

            // Simulate pressing inside centerPanel at screen coordinates (400, 120)
            MouseEvent pressEvent = new MouseEvent(
                    centerComp,
                    MouseEvent.MOUSE_PRESSED,
                    System.currentTimeMillis(),
                    0,
                    50, 15, // Local component coordinates
                    400, 120, // Screen coordinates
                    1,
                    false,
                    MouseEvent.BUTTON1
            );
            centerComp.getMouseListeners()[0].mousePressed(pressEvent);

            // Drag mouse to screen coordinates (460, 145) -> delta is (+60, +25)
            MouseEvent dragEvent = new MouseEvent(
                    centerComp,
                    MouseEvent.MOUSE_DRAGGED,
                    System.currentTimeMillis(),
                    0,
                    110, 40, // Local coordinates moved
                    460, 145, // Screen coordinates moved
                    0,
                    false,
                    MouseEvent.NOBUTTON
            );
            centerComp.getMouseMotionListeners()[0].mouseDragged(dragEvent);

            Point newLocation = frame.getLocation();
            // Expected location: start (100, 100) + delta (60, 25) = (160, 125)
            assertThat(newLocation.x).isEqualTo(160);
            assertThat(newLocation.y).isEqualTo(125);

            frame.dispose();
        });
    }

    @Test
    public void testDraggingMaximizedWindowRestoresWithCorrectRelativeOffset() throws Exception {
        SwingUtilities.invokeAndWait(() -> {
            JFrame frame = new JFrame("Maximized Drag Test");
            frame.setUndecorated(true);
            frame.setSize(800, 600);
            // Simulate secondary monitor at x = 1920
            frame.setLocation(1920, 0);
            frame.setExtendedState(JFrame.MAXIMIZED_BOTH);

            CustomTitleBar titleBar = new CustomTitleBar(frame);
            frame.getContentPane().add(titleBar, BorderLayout.NORTH);
            frame.doLayout();

            // Find centerPanel
            Component centerComp = null;
            for (Component comp : titleBar.getComponents()) {
                if (comp instanceof JPanel && ((BorderLayout) titleBar.getLayout()).getConstraints(comp).equals(BorderLayout.CENTER)) {
                    centerComp = comp;
                    break;
                }
            }
            assertThat(centerComp).isNotNull();

            // Click at middle of screen 2: x = 1920 + 400 = 2320, y = 20
            MouseEvent press = new MouseEvent(
                    centerComp,
                    MouseEvent.MOUSE_PRESSED,
                    System.currentTimeMillis(),
                    0,
                    200, 10,
                    2320, 20,
                    1,
                    false,
                    MouseEvent.BUTTON1
            );
            centerComp.getMouseListeners()[0].mousePressed(press);

            // Drag mouse to (2330, 25)
            MouseEvent drag = new MouseEvent(
                    centerComp,
                    MouseEvent.MOUSE_DRAGGED,
                    System.currentTimeMillis(),
                    0,
                    210, 15,
                    2330, 25,
                    0,
                    false,
                    MouseEvent.NOBUTTON
            );
            centerComp.getMouseMotionListeners()[0].mouseDragged(drag);

            // The window should be restored to normal state
            assertThat((frame.getExtendedState() & JFrame.MAXIMIZED_BOTH)).isEqualTo(0);
            // Window should stay positioned close to the cursor on monitor 2, NOT jumping to monitor 1 or off-screen
            Point loc = frame.getLocation();
            assertThat(loc.x).isGreaterThanOrEqualTo(1900).isLessThanOrEqualTo(2350);

            frame.dispose();
        });
    }

    @Test
    public void testDraggingOnBrandBadgeAreaMovesWindow() throws Exception {
        SwingUtilities.invokeAndWait(() -> {
            JFrame frame = new JFrame("Badge Drag Test");
            frame.setUndecorated(true);
            frame.setSize(800, 600);
            frame.setLocation(200, 200);

            CustomTitleBar titleBar = new CustomTitleBar(frame);
            frame.getContentPane().add(titleBar, BorderLayout.NORTH);
            frame.doLayout();

            // Locate leftPanel (BorderLayout.WEST) containing icon, title, and badge
            Component leftComp = ((BorderLayout) titleBar.getLayout()).getLayoutComponent(BorderLayout.WEST);
            assertThat(leftComp).isNotNull();

            // Collect all components in the left brand area
            java.util.List<Component> brandComponents = new java.util.ArrayList<>();
            brandComponents.add(leftComp);
            collectBrandComponents((Container) leftComp, brandComponents);

            assertThat(brandComponents).isNotEmpty();

            // Verify each brand component has drag listeners attached (no dead zones)
            for (Component comp : brandComponents) {
                assertThat(comp.getMouseListeners().length)
                        .as("Component %s should have mouse listener", comp.getClass().getSimpleName())
                        .isGreaterThan(0);
                assertThat(comp.getMouseMotionListeners().length)
                        .as("Component %s should have mouse motion listener", comp.getClass().getSimpleName())
                        .isGreaterThan(0);
            }

            // Pick the first brand component (e.g. title label or badge) and simulate dragging
            Component badgeComp = brandComponents.get(0);
            MouseEvent press = new MouseEvent(
                    badgeComp,
                    MouseEvent.MOUSE_PRESSED,
                    System.currentTimeMillis(),
                    0,
                    10, 10,
                    210, 210,
                    1,
                    false,
                    MouseEvent.BUTTON1
            );
            badgeComp.getMouseListeners()[0].mousePressed(press);

            MouseEvent drag = new MouseEvent(
                    badgeComp,
                    MouseEvent.MOUSE_DRAGGED,
                    System.currentTimeMillis(),
                    0,
                    50, 40,
                    250, 240,
                    0,
                    false,
                    MouseEvent.NOBUTTON
            );
            badgeComp.getMouseMotionListeners()[0].mouseDragged(drag);

            // The window should move from (200, 200) to (240, 230)
            Point newLoc = frame.getLocation();
            assertThat(newLoc.x).isEqualTo(240);
            assertThat(newLoc.y).isEqualTo(230);

            frame.dispose();
        });
    }

    private void collectBrandComponents(Container container, java.util.List<Component> list) {
        for (Component c : container.getComponents()) {
            if (c instanceof JLabel || (c instanceof JPanel && !(c instanceof JButton))) {
                list.add(c);
            }
            if (c instanceof Container) {
                collectBrandComponents((Container) c, list);
            }
        }
    }
}
