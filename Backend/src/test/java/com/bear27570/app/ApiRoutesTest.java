package com.bear27570.app;

import com.bear27570.app.routes.ApiRoutes;
import io.javalin.Javalin;
import io.javalin.testtools.JavalinTest;
import org.flywaydb.core.Flyway;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ApiRoutesTest {

    private Jdbi jdbi;
    private Javalin app;

    @BeforeEach
    void setUp() {
        String url = "jdbc:h2:mem:test_api_" + System.nanoTime() + ";DB_CLOSE_DELAY=-1";
        
        Flyway.configure()
            .dataSource(url, "sa", "")
            .locations("classpath:db")
            .load()
            .migrate();

        jdbi = Jdbi.create(url, "sa", "");
        jdbi.installPlugin(new SqlObjectPlugin());

        app = Javalin.create(config -> {
            new ApiRoutes(jdbi).register(config.routes);
        });
    }

    @Test
    void testLogin() {
        JavalinTest.test(app, (server, client) -> {
            var response = client.post("/api/user/login", "{\"username\":\"alice\", \"password\":\"secret\"}");
            assertThat(response.code()).isEqualTo(200);
            assertThat(response.body().string()).contains("alice");
        });
    }

    @Test
    void testCreateEvent() {
        JavalinTest.test(app, (server, client) -> {
            var response = client.post("/api/events", "{\"name\":\"Championship\"}");
            assertThat(response.code()).isEqualTo(200);
            assertThat(response.body().string()).contains("inviteCode");
        });
    }
}
