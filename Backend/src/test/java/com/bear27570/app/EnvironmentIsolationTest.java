package com.bear27570.app;

import com.bear27570.app.db.AppConfig;
import com.bear27570.app.db.JdbiConfig;
import com.bear27570.app.util.AESUtil;
import com.bear27570.app.util.JwtUtil;
import com.bear27570.app.util.SimulateScouting;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

public class EnvironmentIsolationTest {

    private String prevDataDir;
    private String prevScoutingEnv;
    private String prevAppEnv;

    @BeforeEach
    void saveAndClearEnv() {
        prevDataDir = System.getProperty("scouting.data.dir");
        prevScoutingEnv = System.getProperty("scouting.env");
        prevAppEnv = System.getProperty("app.env");
        System.clearProperty("scouting.data.dir");
        System.clearProperty("scouting.env");
        System.clearProperty("app.env");
        AppConfig.clearEnvironmentOverride();
    }

    @AfterEach
    void restoreEnv() {
        AppConfig.clearEnvironmentOverride();
        restoreProp("scouting.data.dir", prevDataDir);
        restoreProp("scouting.env", prevScoutingEnv);
        restoreProp("app.env", prevAppEnv);
    }

    private static void restoreProp(String key, String value) {
        if (value == null) {
            System.clearProperty(key);
        } else {
            System.setProperty(key, value);
        }
    }

    @Test
    void testDevEnvironmentIsolation() {
        AppConfig.setEnvironmentOverride(AppConfig.Environment.DEV);

        assertThat(AppConfig.isDev()).isTrue();
        assertThat(AppConfig.isProd()).isFalse();

        File rootDir = AppConfig.findProjectRootDir();
        assertThat(rootDir).isNotNull();
        Path projectRoot = rootDir.toPath().toAbsolutePath().normalize();

        File dbFile = AppConfig.resolveAppDbFile();
        File jwtFile = AppConfig.resolveJwtSecretFile();
        File masterKeyFile = AppConfig.resolveMasterKeyFile();

        // 验证开发环境资产均保存在工程工作区的 app_data/ 隔离目录下
        Path baseDataDir = AppConfig.resolveBaseDataDir().toPath().toAbsolutePath().normalize();
        Path normalizedDbPath = dbFile.toPath().toAbsolutePath().normalize();
        assertThat(baseDataDir).isEqualTo(projectRoot.resolve("app_data"));
        assertThat(normalizedDbPath).isEqualTo(projectRoot.resolve("app_data").resolve("app_data"));
        assertThat(normalizedDbPath).isNotEqualTo(projectRoot.resolve("app_data"));
        assertThat(normalizedDbPath.getParent()).isEqualTo(baseDataDir);
        assertThat(dbFile.getAbsolutePath()).doesNotContain(".scoutingpro27");
        assertThat(dbFile.getName()).isEqualTo("app_data");
        String envDbUrl = System.getenv("DB_URL");
        if (envDbUrl == null || envDbUrl.isBlank()) {
            assertThat(AppConfig.resolveAppDbUrl())
                    .contains(normalizedDbPath.toString().replace('\\', '/'));
        }

        assertThat(jwtFile.toPath().toAbsolutePath().normalize()).startsWith(projectRoot);
        assertThat(jwtFile.getAbsolutePath()).doesNotContain(".scoutingpro27");
        assertThat(jwtFile.getName()).isEqualTo("jwt.secret");

        assertThat(masterKeyFile.toPath().toAbsolutePath().normalize()).startsWith(projectRoot);
        assertThat(masterKeyFile.getAbsolutePath()).doesNotContain(".scoutingpro27");
        assertThat(masterKeyFile.getName()).isEqualTo("master.key");

        // 验证 JdbiConfig, JwtUtil, AESUtil 与 AppConfig 保持绝对单一真相来源
        assertThat(JdbiConfig.resolveAppDbFile().getAbsolutePath()).isEqualTo(dbFile.getAbsolutePath());
        assertThat(JwtUtil.getSecretFile().getAbsolutePath()).isEqualTo(jwtFile.getAbsolutePath());
        assertThat(AESUtil.getMasterKeyFile().getAbsolutePath()).isEqualTo(masterKeyFile.getAbsolutePath());
    }

    @Test
    void testProdEnvironmentIsolation() {
        AppConfig.setEnvironmentOverride(AppConfig.Environment.PROD);

        assertThat(AppConfig.isProd()).isTrue();
        assertThat(AppConfig.isDev()).isFalse();

        File dbFile = AppConfig.resolveAppDbFile();
        File jwtFile = AppConfig.resolveJwtSecretFile();
        File masterKeyFile = AppConfig.resolveMasterKeyFile();

        // 验证生产环境资产均保存在用户主目录 ~/.scoutingpro27 下
        assertThat(dbFile.getAbsolutePath()).contains(".scoutingpro27");
        assertThat(jwtFile.getAbsolutePath()).contains(".scoutingpro27");
        assertThat(masterKeyFile.getAbsolutePath()).contains(".scoutingpro27");

        // 验证开发环境与生产环境路径无交叠、物理完全隔离
        AppConfig.setEnvironmentOverride(AppConfig.Environment.DEV);
        File devDb = AppConfig.resolveAppDbFile();
        File devJwt = AppConfig.resolveJwtSecretFile();
        File devKey = AppConfig.resolveMasterKeyFile();

        assertThat(dbFile.getAbsolutePath()).isNotEqualTo(devDb.getAbsolutePath());
        assertThat(jwtFile.getAbsolutePath()).isNotEqualTo(devJwt.getAbsolutePath());
        assertThat(masterKeyFile.getAbsolutePath()).isNotEqualTo(devKey.getAbsolutePath());
    }

    @Test
    void testSimulatorBlockedInProductionMode() {
        AppConfig.setEnvironmentOverride(AppConfig.Environment.PROD);

        // 验证当处于生产模式时，调用模拟器且未提供 --force-production 将被强行熔断
        assertThatThrownBy(() -> SimulateScouting.main(new String[]{"TEST_EVENT"}))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("SimulateScouting blocked: Refusing to wipe/mock production database");
    }

    @Test
    void testProjectRootResolution() {
        File root = AppConfig.findProjectRootDir();
        assertThat(root).isNotNull();
        assertThat(new File(root, "Backend/pom.xml")).exists();
    }
}
