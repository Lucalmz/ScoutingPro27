package com.bear27570.app;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

public class JcefMultiInstanceProfileTest {

    @TempDir
    Path tempDir;

    private String prevDataDir;

    @BeforeEach
    void setUp() {
        prevDataDir = System.getProperty("scouting.data.dir");
        System.setProperty("scouting.data.dir", tempDir.toAbsolutePath().toString());
        Main.releaseProfileLock();
    }

    @AfterEach
    void tearDown() {
        Main.releaseProfileLock();
        if (prevDataDir == null) {
            System.clearProperty("scouting.data.dir");
        } else {
            System.setProperty("scouting.data.dir", prevDataDir);
        }
    }

    @Test
    void testPrimaryInstanceAcquiresProfileAndSecondInstanceIsIsolated() throws Exception {
        File profile1 = Main.resolveJcefProfileDir();
        assertThat(profile1).isNotNull();
        assertThat(profile1.exists()).isTrue();
        assertThat(profile1.toPath().toAbsolutePath().normalize())
                .startsWith(tempDir.toAbsolutePath().normalize());
        assertThat(profile1.getName()).isEqualTo("jcef_profile");

        // While Instance 1 holds .instance.lock, acquiring the same profile must return false
        assertThat(Main.tryAcquireProfileLock(profile1)).isFalse();

        // Simulate an external Chromium lock on primary profile -> resolveJcefProfileDir falls back to jcef_profile_2
        Main.releaseProfileLock();
        File primaryCefLock = new File(profile1, "lockfile");
        assertThat(primaryCefLock.createNewFile()).isTrue();
        try (FileOutputStream fos = new FileOutputStream(primaryCefLock);
             FileLock externalLock = fos.getChannel().lock()) {
            assertThat(externalLock).isNotNull();
            File profile2 = Main.resolveJcefProfileDir();
            assertThat(profile2.toPath().toAbsolutePath().normalize())
                    .startsWith(tempDir.toAbsolutePath().normalize());
            assertThat(profile2.getName()).isEqualTo("jcef_profile_2");
        }
    }

    @Test
    void testDetectsChromiumExclusiveLockfile() throws Exception {
        File lockDir = tempDir.resolve("cef_locked_profile").toFile();
        assertThat(lockDir.mkdirs()).isTrue();

        File fakeCefLock = new File(lockDir, "lockfile");
        assertThat(fakeCefLock.createNewFile()).isTrue();

        try (FileOutputStream fos = new FileOutputStream(fakeCefLock);
             FileChannel ch = fos.getChannel();
             FileLock exclusiveLock = ch.lock()) {
            assertThat(exclusiveLock).isNotNull();
            assertThat(Main.tryAcquireProfileLock(lockDir)).isFalse();
        }

        // Also ensure held .instance.lock directly prevents re-locking via FileChannel
        File instanceLockFile = new File(lockDir, ".instance.lock");
        try (FileChannel ch = FileChannel.open(instanceLockFile.toPath(), StandardOpenOption.CREATE, StandardOpenOption.WRITE);
             FileLock lock = ch.tryLock()) {
            assertThat(lock).isNotNull();
            assertThat(Main.tryAcquireProfileLock(lockDir)).isFalse();
        }
    }

    public static class LockHolderMain {
        public static void main(String[] args) throws Exception {
            Path lockPath = Path.of(args[0]);
            boolean tryOnce = args.length > 1 && "--try-once".equals(args[1]);
            try (FileChannel ch = FileChannel.open(lockPath, StandardOpenOption.CREATE, StandardOpenOption.WRITE);
                 FileLock lock = tryOnce ? ch.tryLock() : ch.lock()) {
                if (lock != null && lock.isValid()) {
                    System.out.println("LOCKED");
                    System.out.flush();
                    if (!tryOnce) {
                        while (System.in.read() != -1) {
                            // Hold lock until parent closes stdin
                        }
                    }
                } else {
                    System.out.println("CONTENDED");
                    System.out.flush();
                }
            }
        }
    }

    @Test
    void testNonNormalizedPathsDoNotBypassGuardOrDropOsLock() throws Exception {
        File profile1 = Main.resolveJcefProfileDir();
        assertThat(profile1).isNotNull();
        assertThat(profile1.getName()).isEqualTo("jcef_profile");

        // Non-normalized aliases to the same profile directory must return false
        File dotAlias = new File(profile1, ".");
        File parentTraversalAlias = new File(profile1.getParentFile(), "jcef_profile/../jcef_profile");
        assertThat(Main.tryAcquireProfileLock(dotAlias)).isFalse();
        assertThat(Main.tryAcquireProfileLock(parentTraversalAlias)).isFalse();

        // Verify the underlying OS lock on profile1/.instance.lock remained intact (a child JVM cannot acquire it)
        File instanceLockFile = new File(profile1, ".instance.lock");
        assertThat(runChildTryLockProbe(instanceLockFile)).isEqualTo("CONTENDED");

        // After releasing in parent, child JVM must be able to acquire the lock cleanly (proving the probe is effective)
        Main.releaseProfileLock();
        assertThat(runChildTryLockProbe(instanceLockFile)).isEqualTo("LOCKED");
    }

    private static String runChildTryLockProbe(File instanceLockFile) throws Exception {
        String javaBin = Paths.get(
                System.getProperty("java.home"),
                "bin",
                System.getProperty("os.name", "").toLowerCase().contains("win") ? "java.exe" : "java"
        ).toString();

        ProcessBuilder pb = new ProcessBuilder(
                javaBin,
                "-cp",
                System.getProperty("java.class.path"),
                LockHolderMain.class.getName(),
                instanceLockFile.getAbsolutePath(),
                "--try-once"
        );
        pb.redirectErrorStream(true);
        Process child = pb.start();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8))) {
            String line = reader.readLine();
            assertThat(child.waitFor(5, TimeUnit.SECONDS)).isTrue();
            assertThat(child.exitValue()).isZero();
            return line;
        } finally {
            if (child.isAlive()) {
                child.destroyForcibly();
                child.waitFor(5, TimeUnit.SECONDS);
            }
        }
    }

    @Test
    void testCrossProcessFileLockContentionFallsBackToSecondaryProfile() throws Exception {
        File primaryDir = tempDir.resolve("jcef_profile").toFile();
        assertThat(primaryDir.mkdirs()).isTrue();
        File instanceLockFile = new File(primaryDir, ".instance.lock");

        String javaBin = Paths.get(
                System.getProperty("java.home"),
                "bin",
                System.getProperty("os.name", "").toLowerCase().contains("win") ? "java.exe" : "java"
        ).toString();

        ProcessBuilder pb = new ProcessBuilder(
                javaBin,
                "-cp",
                System.getProperty("java.class.path"),
                LockHolderMain.class.getName(),
                instanceLockFile.getAbsolutePath()
        );
        pb.redirectErrorStream(true);
        Process child = pb.start();
        try {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8))) {
                String line = reader.readLine();
                assertThat(line).isEqualTo("LOCKED");

                // Real cross-process contention: tryLock() returns null in parent JVM
                assertThat(Main.tryAcquireProfileLock(primaryDir)).isFalse();

                File fallback = Main.resolveJcefProfileDir();
                assertThat(fallback.getName()).isEqualTo("jcef_profile_2");
                assertThat(fallback.toPath().toAbsolutePath().normalize())
                        .startsWith(tempDir.toAbsolutePath().normalize());
                Main.releaseProfileLock();
            }
        } finally {
            try {
                child.getOutputStream().close();
            } catch (Exception ignored) {
            }
            if (!child.waitFor(5, TimeUnit.SECONDS)) {
                child.destroyForcibly();
                child.waitFor(5, TimeUnit.SECONDS);
            }
        }

        // Once child process exits and releases OS FileLock, primary profile can be acquired again
        assertThat(Main.tryAcquireProfileLock(primaryDir)).isTrue();
    }
}
