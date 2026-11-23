package com.bear27570.app;

import com.bear27570.app.db.AppConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;

public class TimestampedFileLoggingTest {

    private static final Logger logger = LoggerFactory.getLogger(TimestampedFileLoggingTest.class);

    @TempDir
    Path tempDir;

    private String prevDataDir;

    @BeforeEach
    void setUp() {
        prevDataDir = System.getProperty("scouting.data.dir");
        System.setProperty("scouting.data.dir", tempDir.toAbsolutePath().toString());
        AppConfig.resetLogFileForTest();
    }

    @AfterEach
    void tearDown() {
        AppConfig.resetLogFileForTest();
        if (prevDataDir == null) {
            System.clearProperty("scouting.data.dir");
        } else {
            System.setProperty("scouting.data.dir", prevDataDir);
        }
    }

    @Test
    void testResolveLogFileNamePatternAndRunIsolation() throws Exception {
        File logFile1 = null;
        File logFile2 = null;
        try {
            logFile1 = AppConfig.resolveLogFile();
            assertNotNull(logFile1);
            assertTrue(logFile1.toPath().toAbsolutePath().normalize().startsWith(tempDir.toAbsolutePath().normalize()),
                    "Log file must reside in isolated tempDir: " + logFile1.getAbsolutePath());
            String name1 = logFile1.getName();

            Pattern pattern = Pattern.compile("^scoutingpro_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}(_\\d+)?\\.log$");
            assertTrue(pattern.matcher(name1).matches(), "Log file name should match timestamped pattern: " + name1);

            File logFileAgain = AppConfig.resolveLogFile();
            assertEquals(logFile1.getAbsolutePath(), logFileAgain.getAbsolutePath(), "Same run must reuse the same log file");

            Files.writeString(logFile1.toPath(), "Test Run 1 Content\n", StandardCharsets.UTF_8);
            assertTrue(logFile1.exists());
            assertTrue(logFile1.length() > 0);

            AppConfig.resetLogFileForTest();
            logFile2 = AppConfig.resolveLogFile();
            assertNotNull(logFile2);
            assertTrue(logFile2.toPath().toAbsolutePath().normalize().startsWith(tempDir.toAbsolutePath().normalize()));

            assertNotEquals(logFile1.getAbsolutePath(), logFile2.getAbsolutePath(),
                    "Subsequent run should not collide with an existing non-empty log file");

            Files.writeString(logFile2.toPath(), "Test Run 2 Content\n", StandardCharsets.UTF_8);
            assertEquals("Test Run 1 Content\n", Files.readString(logFile1.toPath(), StandardCharsets.UTF_8));
            assertEquals("Test Run 2 Content\n", Files.readString(logFile2.toPath(), StandardCharsets.UTF_8));
        } finally {
            if (logFile1 != null) Files.deleteIfExists(logFile1.toPath());
            if (logFile2 != null) Files.deleteIfExists(logFile2.toPath());
        }
    }

    @Test
    void testConcurrentDualStreamAndFilesWriteString() throws Exception {
        File logFile = AppConfig.resolveLogFile();
        assertNotNull(logFile);
        assertTrue(logFile.toPath().toAbsolutePath().normalize().startsWith(tempDir.toAbsolutePath().normalize()));

        try {
            try (FileOutputStream fos = new FileOutputStream(logFile, true)) {
                fos.write("[2026-09-19 18:00:00.001] Stream log line 1\n".getBytes(StandardCharsets.UTF_8));
                fos.flush();

                Files.writeString(
                        logFile.toPath(),
                        "[2026-09-19 18:00:00.002] [RemoteClient-127.0.0.1] Hello from client\n",
                        StandardCharsets.UTF_8,
                        java.nio.file.StandardOpenOption.CREATE,
                        java.nio.file.StandardOpenOption.APPEND
                );

                fos.write("[2026-09-19 18:00:00.003] Stream log line 2\n".getBytes(StandardCharsets.UTF_8));
                fos.flush();
            }

            String allContent = Files.readString(logFile.toPath(), StandardCharsets.UTF_8);
            assertTrue(allContent.contains("Stream log line 1"));
            assertTrue(allContent.contains("RemoteClient-127.0.0.1"));
            assertTrue(allContent.contains("Stream log line 2"));
        } finally {
            Files.deleteIfExists(logFile.toPath());
        }
    }

    @Test
    void testSlf4jTimestampConfiguration() {
        java.io.ByteArrayOutputStream errCapture = new java.io.ByteArrayOutputStream();
        java.io.PrintStream originalErr = System.err;
        try {
            System.setErr(new java.io.PrintStream(errCapture, true, StandardCharsets.UTF_8));
            logger.info("Verifying SLF4J logger output with timestamp format");
            String output = errCapture.toString(StandardCharsets.UTF_8);
            Pattern timestampPattern = Pattern.compile("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3}");
            assertTrue(timestampPattern.matcher(output).find(), "SLF4J output must include millisecond timestamp: " + output);
            assertTrue(output.contains("Verifying SLF4J logger output with timestamp format"));
        } finally {
            System.setErr(originalErr);
        }
    }
}
