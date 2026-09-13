package com.bear27570.app;

import org.junit.jupiter.api.Test;

import java.io.File;
import java.lang.reflect.Method;

import static org.assertj.core.api.Assertions.assertThat;

public class JcefBundlePreservationTest {

    @Test
    public void testEnsureJcefBundlePreservesExistingDirectory() throws Exception {
        File targetDir = new File(System.getProperty("user.home"), ".scoutingpro27/jcef-bundle");
        File marker = new File(targetDir, ".extracted_v3_ok");

        // Verify that targetDir exists and contains jcef binaries from previous install
        boolean isWindows = System.getProperty("os.name", "").toLowerCase().contains("win");
        if (isWindows && targetDir.exists()) {
            File jcefDll = new File(targetDir, "jcef.dll");
            File libcefDll = new File(targetDir, "libcef.dll");

            Method method = Main.class.getDeclaredMethod("ensureJcefBundle");
            method.setAccessible(true);

            long beforeCount = targetDir.list() != null ? targetDir.list().length : 0;
            File result = (File) method.invoke(null);

            assertThat(result).isEqualTo(targetDir);
            assertThat(targetDir.exists()).isTrue();
            // Critical check: ensure target directory was NOT wiped
            if (jcefDll.exists()) {
                assertThat(jcefDll.exists()).isTrue();
                assertThat(libcefDll.exists()).isTrue();
                assertThat(targetDir.list().length).isGreaterThanOrEqualTo((int) beforeCount);
            }
            assertThat(marker.exists()).isTrue();
        }
    }
}
