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

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

public class EnvironmentIsolationTest {

    @BeforeEach
    @AfterEach
    void resetEnvironment() {
        AppConfig.clearEnvironmentOverride();
    }

    @Test
    void testDevEnvironmentIsolation() {
        AppConfig.setEnvironmentOverride(AppConfig.Environment.DEV);

        assertThat(AppConfig.isDev()).isTrue();
        assertThat(AppConfig.isProd()).isFalse();

        File dbFile = AppConfig.resolveAppDbFile();
        File jwtFile = AppConfig.resolveJwtSecretFile();
        File masterKeyFile = AppConfig.resolveMasterKeyFile();

        // 验证开发环境资产均保存在工程工作区内
        assertThat(dbFile.getAbsolutePath()).contains("ScoutingPro27");
        assertThat(dbFile.getAbsolutePath()).doesNotContain(".scoutingpro27");
        assertThat(dbFile.getName()).isEqualTo("app_data");

        assertThat(jwtFile.getAbsolutePath()).contains("ScoutingPro27");
        assertThat(jwtFile.getAbsolutePath()).doesNotContain(".scoutingpro27");
        assertThat(jwtFile.getName()).isEqualTo("jwt.secret");

        assertThat(masterKeyFile.getAbsolutePath()).contains("ScoutingPro27");
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
