package com.bear27570.app;

import com.bear27570.app.db.AppConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;

public class TimestampedFileLoggingTest {

    private static final Logger logger = LoggerFactory.getLogger(TimestampedFileLoggingTest.class);

    @BeforeEach
    void setUp() {
        AppConfig.resetLogFileForTest();
    }

    @AfterEach
    void tearDown() {
        AppConfig.resetLogFileForTest();
    }

    @Test
    void testResolveLogFileNamePatternAndRunIsolation() throws Exception {
        File logFile1 = AppConfig.resolveLogFile();
        assertNotNull(logFile1);
        String name1 = logFile1.getName();

        // 验证文件名规范：scoutingpro_yyyy-MM-dd_HH-mm-ss(_suffix)?.log
        Pattern pattern = Pattern.compile("^scoutingpro_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}(_\\d+)?\\.log$");
        assertTrue(pattern.matcher(name1).matches(), "Log file name should match timestamped pattern: " + name1);

        // 验证在同一运行实例中多次调用，返回同一个日志文件
        File logFileAgain = AppConfig.resolveLogFile();
        assertEquals(logFile1.getAbsolutePath(), logFileAgain.getAbsolutePath(), "Same run must reuse the same log file");

        // 真实写入内容到 logFile1
        Files.writeString(logFile1.toPath(), "Test Run 1 Content\n", StandardCharsets.UTF_8);
        assertTrue(logFile1.exists());
        assertTrue(logFile1.length() > 0);

        // 模拟下一次运行（resetLogFileForTest）
        AppConfig.resetLogFileForTest();
        File logFile2 = AppConfig.resolveLogFile();
        assertNotNull(logFile2);

        // 验证如果时间戳恰好在同一秒且原文件非空，会自动生成独立后缀（防覆盖）
        if (logFile1.getName().equals(logFile2.getName())) {
            fail("Subsequent run should not collide with an existing non-empty log file");
        } else {
            // 正常跨秒或者不同文件名
            assertNotEquals(logFile1.getAbsolutePath(), logFile2.getAbsolutePath());
        }

        // 验证文件在 Windows 真实环境下可正常读写
        Files.writeString(logFile2.toPath(), "Test Run 2 Content\n", StandardCharsets.UTF_8);
        String content1 = Files.readString(logFile1.toPath(), StandardCharsets.UTF_8);
        String content2 = Files.readString(logFile2.toPath(), StandardCharsets.UTF_8);
        assertEquals("Test Run 1 Content\n", content1);
        assertEquals("Test Run 2 Content\n", content2);

        // 清理测试生成的文件
        logFile1.delete();
        logFile2.delete();
    }

    @Test
    void testConcurrentDualStreamAndFilesWriteString() throws Exception {
        File logFile = AppConfig.resolveLogFile();
        assertNotNull(logFile);

        // 模拟 Main.java setupFileLogging 中的 FileOutputStream 持续持有
        try (FileOutputStream fos = new FileOutputStream(logFile, true)) {
            fos.write("[2026-09-19 18:00:00.001] Stream log line 1\n".getBytes(StandardCharsets.UTF_8));
            fos.flush();

            // 模拟 SystemRoutes.java 中的 Files.writeString 追加写入（Windows 文件锁与共享访问安全验证）
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

        logFile.delete();
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
