package com.bear27570.app.ui;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import javax.swing.*;
import java.awt.*;
import java.awt.event.MouseEvent;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

public class CustomTitleBarDragTest {

    @Test
    public void testDragCalculatesScreenDeltaAccuratelyWithoutGlitch() throws Exception {
        Assumptions.assumeFalse(GraphicsEnvironment.isHeadless(), "Swing titlebar drag test requires non-headless display");
        AtomicReference<Throwable> failure = new AtomicReference<>();

        SwingUtilities.invokeAndWait(() -> {
            JFrame frame = new JFrame("Drag Test");
            try {
                frame.setUndecorated(true);
                frame.setSize(1000, 600);
                frame.setLocation(100, 100);

                CustomTitleBar titleBar = new CustomTitleBar(frame);
                frame.getContentPane().add(titleBar, BorderLayout.NORTH);
                frame.doLayout();

                Component centerComp = null;
                for (Component comp : titleBar.getComponents()) {
                    if (comp instanceof JPanel && ((BorderLayout) titleBar.getLayout()).getConstraints(comp).equals(BorderLayout.CENTER)) {
                        centerComp = comp;
                        break;
                    }
                }
                assertThat(centerComp).isNotNull();

                MouseEvent pressEvent = new MouseEvent(
                        centerComp,
                        MouseEvent.MOUSE_PRESSED,
                        System.currentTimeMillis(),
                        0,
                        50, 15,
                        400, 120,
                        1,
                        false,
                        MouseEvent.BUTTON1
                );
                centerComp.getMouseListeners()[0].mousePressed(pressEvent);

                MouseEvent dragEvent = new MouseEvent(
                        centerComp,
                        MouseEvent.MOUSE_DRAGGED,
                        System.currentTimeMillis(),
                        0,
                        110, 40,
                        460, 145,
                        0,
                        false,
                        MouseEvent.NOBUTTON
                );
                centerComp.getMouseMotionListeners()[0].mouseDragged(dragEvent);

                Point newLocation = frame.getLocation();
                assertThat(newLocation.x).isEqualTo(160);
                assertThat(newLocation.y).isEqualTo(125);
            } catch (Throwable t) {
                failure.set(t);
            } finally {
                frame.dispose();
            }
        });

        if (failure.get() != null) {
            throw new AssertionError(failure.get());
        }
    }

    @Test
    public void testDraggingMaximizedWindowRestoresWithCorrectRelativeOffset() throws Exception {
        Assumptions.assumeFalse(GraphicsEnvironment.isHeadless(), "Swing titlebar drag test requires non-headless display");
        AtomicReference<Throwable> failure = new AtomicReference<>();

        SwingUtilities.invokeAndWait(() -> {
            JFrame frame = new JFrame("Maximized Drag Test");
            try {
                frame.setUndecorated(true);
                frame.setSize(800, 600);
                frame.setLocation(1920, 0);
                frame.setExtendedState(JFrame.MAXIMIZED_BOTH);

                CustomTitleBar titleBar = new CustomTitleBar(frame);
                frame.getContentPane().add(titleBar, BorderLayout.NORTH);
                frame.doLayout();

                Component centerComp = null;
                for (Component comp : titleBar.getComponents()) {
                    if (comp instanceof JPanel && ((BorderLayout) titleBar.getLayout()).getConstraints(comp).equals(BorderLayout.CENTER)) {
                        centerComp = comp;
                        break;
                    }
                }
                assertThat(centerComp).isNotNull();

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

                assertThat((frame.getExtendedState() & JFrame.MAXIMIZED_BOTH)).isEqualTo(0);
                Point loc = frame.getLocation();
                assertThat(loc.x).isGreaterThanOrEqualTo(1900).isLessThanOrEqualTo(2350);
            } catch (Throwable t) {
                failure.set(t);
            } finally {
                frame.dispose();
            }
        });

        if (failure.get() != null) {
            throw new AssertionError(failure.get());
        }
    }

    @Test
    public void testDraggingOnBrandBadgeAreaMovesWindow() throws Exception {
        Assumptions.assumeFalse(GraphicsEnvironment.isHeadless(), "Swing titlebar drag test requires non-headless display");
        AtomicReference<Throwable> failure = new AtomicReference<>();

        SwingUtilities.invokeAndWait(() -> {
            JFrame frame = new JFrame("Badge Drag Test");
            try {
                frame.setUndecorated(true);
                frame.setSize(800, 600);
                frame.setLocation(200, 200);

                CustomTitleBar titleBar = new CustomTitleBar(frame);
                frame.getContentPane().add(titleBar, BorderLayout.NORTH);
                frame.doLayout();

                Component leftComp = ((BorderLayout) titleBar.getLayout()).getLayoutComponent(BorderLayout.WEST);
                assertThat(leftComp).isNotNull();

                java.util.List<Component> brandComponents = new java.util.ArrayList<>();
                brandComponents.add(leftComp);
                collectBrandComponents((Container) leftComp, brandComponents);

                assertThat(brandComponents).isNotEmpty();

                for (Component comp : brandComponents) {
                    assertThat(comp.getMouseListeners().length)
                            .as("Component %s should have mouse listener", comp.getClass().getSimpleName())
                            .isGreaterThan(0);
                    assertThat(comp.getMouseMotionListeners().length)
                            .as("Component %s should have mouse motion listener", comp.getClass().getSimpleName())
                            .isGreaterThan(0);
                }

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

                Point newLoc = frame.getLocation();
                assertThat(newLoc.x).isEqualTo(240);
                assertThat(newLoc.y).isEqualTo(230);
            } catch (Throwable t) {
                failure.set(t);
            } finally {
                frame.dispose();
            }
        });

        if (failure.get() != null) {
            throw new AssertionError(failure.get());
        }
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
