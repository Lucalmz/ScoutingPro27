package com.bear27570.app;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;

import static org.assertj.core.api.Assertions.assertThat;

public class JcefMultiInstanceProfileTest {

    @AfterEach
    public void tearDown() throws Exception {
        Method releaseMethod = Main.class.getDeclaredMethod("releaseProfileLock");
        releaseMethod.setAccessible(true);
        releaseMethod.invoke(null);
    }

    @Test
    public void testPrimaryInstanceAcquiresProfileAndSecondInstanceIsIsolated() throws Exception {
        Method resolveMethod = Main.class.getDeclaredMethod("resolveJcefProfileDir");
        resolveMethod.setAccessible(true);

        // Instance 1 resolves and locks its profile
        File profile1 = (File) resolveMethod.invoke(null);
        assertThat(profile1).isNotNull();
        assertThat(profile1.exists()).isTrue();

        // While Instance 1 holds the lock, simulate Instance 2 calling tryAcquireProfileLock on profile1
        Method tryLockMethod = Main.class.getDeclaredMethod("tryAcquireProfileLock", File.class);
        tryLockMethod.setAccessible(true);

        boolean canAcquireSameDirAgain = (boolean) tryLockMethod.invoke(null, profile1);
        // Should be false because .instance.lock is held by instance 1
        assertThat(canAcquireSameDirAgain).isFalse();
    }

    @Test
    public void testDetectsChromiumExclusiveLockfile() throws Exception {
        Method tryLockMethod = Main.class.getDeclaredMethod("tryAcquireProfileLock", File.class);
        tryLockMethod.setAccessible(true);

        File tempDir = new File(System.getProperty("java.io.tmpdir"), "test-jcef-lock-" + System.currentTimeMillis());
        tempDir.mkdirs();

        File fakeCefLock = new File(tempDir, "lockfile");
        fakeCefLock.createNewFile();

        // Simulate Chromium holding an exclusive lock on lockfile
        try (FileOutputStream fos = new FileOutputStream(fakeCefLock)) {
            java.nio.channels.FileLock exclusiveLock = fos.getChannel().lock();
            try {
                // When exclusive lock is held on lockfile, acquisition must fail
                boolean acquired = (boolean) tryLockMethod.invoke(null, tempDir);
                assertThat(acquired).isFalse();
            } finally {
                exclusiveLock.release();
            }
        } finally {
            fakeCefLock.delete();
            new File(tempDir, ".instance.lock").delete();
            tempDir.delete();
        }
    }
}
