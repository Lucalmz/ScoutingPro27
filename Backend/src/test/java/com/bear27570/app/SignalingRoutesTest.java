package com.bear27570.app;

import com.bear27570.app.routes.SignalingRoutes;
import io.javalin.Javalin;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SignalingRoutesTest {

    @Test
    void testSignalingRoutesRegistration() {
        SignalingRoutes signalingRoutes = new SignalingRoutes();
        Javalin app = Javalin.create(config -> {
            signalingRoutes.register(config.routes);
        });

        assertThat(app).isNotNull();
        assertThat(signalingRoutes.getActiveRoomCount()).isEqualTo(0);
        assertThat(signalingRoutes.getPeerCount("test-room")).isEqualTo(0);
    }
}
