package com.bear27570.app;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class MainLocalUrlTest {

    @Test
    void appendsDesktopShellQueryWhenCustomTitleBarIsMounted() {
        assertThat(Main.buildLocalAppUrl(8080, true))
                .isEqualTo("http://localhost:8080/index.html?shell=desktop");
    }

    @Test
    void keepsPlainUrlWhenCustomTitleBarIsNotMounted() {
        assertThat(Main.buildLocalAppUrl(8080, false))
                .isEqualTo("http://localhost:8080/index.html");
    }
}
