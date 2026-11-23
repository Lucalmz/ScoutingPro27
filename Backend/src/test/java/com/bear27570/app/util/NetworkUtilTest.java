package com.bear27570.app.util;

import org.junit.jupiter.api.Test;

import java.net.InetAddress;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class NetworkUtilTest {

    @Test
    void testGetLanIpv4Info() {
        NetworkUtil.NetworkInfo info = NetworkUtil.getLanIpv4Info();
        assertThat(info).isNotNull();
        assertThat(info.primaryIp()).isNotBlank();
        assertThat(info.allIps()).isNotNull();

        // If any site-local IPs were discovered, verify none is 127.0.0.1
        for (String ip : info.allIps()) {
            assertThat(ip).isNotEqualTo("127.0.0.1");
            assertThat(ip).doesNotContain(":"); // IPv4 only
        }
    }

    @Test
    void testGetCompleteNetworkInfo() {
        NetworkUtil.NetworkInfo info = NetworkUtil.getCompleteNetworkInfo();
        assertThat(info).isNotNull();
        assertThat(info.primaryIp()).isNotBlank();
        assertThat(info.allIps()).isNotNull();
        assertThat(info.allIpv6s()).isNotNull();

        for (String ip6 : info.allIpv6s()) {
            assertThat(ip6).contains(":");
            assertThat(ip6).doesNotContain("%"); // Scope ID must be cleanly stripped
        }
    }

    @Test
    void testIsGlobalUnicastIpv6() throws Exception {
        // Valid Global Unicast Addresses (2000::/3)
        assertThat(NetworkUtil.isGlobalUnicastIpv6(InetAddress.getByName("240e:398:3241:880:c0de::1"))).isTrue();
        assertThat(NetworkUtil.isGlobalUnicastIpv6(InetAddress.getByName("2408:8207:7852:12::1"))).isTrue();
        assertThat(NetworkUtil.isGlobalUnicastIpv6(InetAddress.getByName("2409:8a00:1000::1"))).isTrue();
        assertThat(NetworkUtil.isGlobalUnicastIpv6(InetAddress.getByName("2606:4700:49::1"))).isTrue();

        // Disallowed / special / local addresses
        assertThat(NetworkUtil.isGlobalUnicastIpv6(InetAddress.getByName("::1"))).isFalse();
        assertThat(NetworkUtil.isGlobalUnicastIpv6(InetAddress.getByName("fe80::1ff:fe00:3a60"))).isFalse();
        assertThat(NetworkUtil.isGlobalUnicastIpv6(InetAddress.getByName("ff02::1"))).isFalse();
        assertThat(NetworkUtil.isGlobalUnicastIpv6(InetAddress.getByName("2001:db8:85a3::8a2e:370:7334"))).isFalse();
        assertThat(NetworkUtil.isGlobalUnicastIpv6(InetAddress.getByName("2001:0:4136:e378:8000:63bf:3fff:fdd2"))).isFalse();
        assertThat(NetworkUtil.isGlobalUnicastIpv6(InetAddress.getByName("2002:cb00:7100:1::1"))).isFalse();
        assertThat(NetworkUtil.isGlobalUnicastIpv6(InetAddress.getByName("192.168.1.1"))).isFalse();
    }

    @Test
    void testGetCleanIpv6HostAddress() throws Exception {
        InetAddress addr = InetAddress.getByName("240e:398::1");
        String clean = NetworkUtil.getCleanIpv6HostAddress(addr);
        assertThat(clean).isNotBlank();
        assertThat(clean).doesNotContain("%");
        assertThat(InetAddress.getByName(clean)).isEqualTo(addr);
    }

    @Test
    void testGetFirewallCommand() {
        String cmd = NetworkUtil.getFirewallCommand(8080);
        assertThat(cmd).contains("netsh advfirewall firewall add rule");
        assertThat(cmd).contains("localport=8080");
        assertThat(cmd).contains("protocol=TCP");
        assertThat(cmd).contains("dir=in action=allow");
    }

    /**
     * 回归守卫：防火墙提权脚本只允许改 ScoutingPro27 自身防火墙规则。
     * 1. 历史版本曾修改 WeakHost / InterfaceMetric / 增删 TUN 与 Loopback 路由，导致 Clash/Mihomo TUN 模式全部节点不可用。
     * 2. 历史版本曾扫描 Get-NetFirewallApplicationFilter 并按 'java|jcef|scoutingpro' 跨应用删除第三方防火墙规则，
     *    且添加无 program= 过滤的全局 UDP 1024-65535 放行规则。
     */
    @Test
    void testFirewallScriptNeverTouchesRoutesOrInterfaces() {
        String javaExe = NetworkUtil.resolveCurrentJavaExe();
        String script = NetworkUtil.buildWindowsNetworkAndFirewallSetupScript(8080);
        assertThat(script).contains("localport=8080");
        for (String forbidden : new String[]{
                "New-NetRoute", "Remove-NetRoute", "Set-NetRoute",
                "Set-NetIPInterface", "WeakHost", "InterfaceMetric",
                "Remove-NetIPAddress", "New-NetIPAddress", "Set-NetIPAddress",
                "Disable-NetAdapter", "Set-NetAdapter", "route add", "route delete",
                "netsh interface",
                "Get-NetFirewallApplicationFilter", "java|jcef|scoutingpro"
        }) {
            assertThat(script).as("firewall script must not contain '%s'", forbidden).doesNotContainIgnoringCase(forbidden);
        }

        // Remove-NetFirewallRule must only be piped from Get-NetFirewallRule -DisplayName 'ScoutingPro27*'
        if (script.contains("Remove-NetFirewallRule")) {
            assertThat(script).contains("Get-NetFirewallRule -DisplayName 'ScoutingPro27*'");
        }

        // Idempotent delete-before-add for ScoutingPro27 rules
        assertThat(script).contains("delete rule name=\"ScoutingPro27 Inbound (8080)\"");
        assertThat(script).contains("delete rule name=\"ScoutingPro27 WebRTC UDP\"");
        assertThat(script).contains("delete rule name=\"ScoutingPro27 WebRTC UDP v2\"");
        assertThat(script).contains("delete rule name=\"ScoutingPro27 App Java\"");
        assertThat(script).contains("delete rule name=\"ScoutingPro27 App JCEF\"");

        // When javaExe is known, both TCP and WebRTC UDP rules must be scoped with program="<javaExe>"
        if (!javaExe.isEmpty()) {
            assertThat(script).contains("name=\"ScoutingPro27 WebRTC UDP v2\" dir=in action=allow protocol=UDP localport=1024-65535 program=\"" + javaExe + "\"");
            assertThat(script).contains("name=\"ScoutingPro27 Inbound (8080)\" dir=in action=allow protocol=TCP localport=8080 program=\"" + javaExe + "\"");
        }
    }

    @Test
    void testFirewallScriptLeastPrivilegeScoping() {
        String customJava = "C:\\Program Files\\Java\\jdk-21\\bin\\java.exe";
        String customJcef = "C:\\Users\\test\\.scoutingpro27\\jcef-bundle\\jcef_helper.exe";
        String scopedScript = NetworkUtil.buildWindowsNetworkAndFirewallSetupScript(8080, customJava, customJcef);

        assertThat(scopedScript)
                .contains("name=\"ScoutingPro27 WebRTC UDP v2\" dir=in action=allow protocol=UDP localport=1024-65535 program=\"" + customJava + "\" profile=any edge=yes")
                .contains("name=\"ScoutingPro27 Inbound (8080)\" dir=in action=allow protocol=TCP localport=8080 program=\"" + customJava + "\" profile=any")
                .contains("name=\"ScoutingPro27 App Java\" dir=in action=allow program=\"" + customJava + "\" profile=any edge=yes")
                .contains("name=\"ScoutingPro27 App JCEF\" dir=in action=allow program=\"" + customJcef + "\" profile=any edge=yes")
                .doesNotContainIgnoringCase("Get-NetFirewallApplicationFilter")
                .doesNotContainIgnoringCase("java|jcef|scoutingpro");

        // When javaExe is unknown/empty, never emit a global unscoped UDP 1024-65535 rule for every process on Windows
        String noJavaScript = NetworkUtil.buildWindowsNetworkAndFirewallSetupScript(8080, "", "");
        assertThat(noJavaScript)
                .doesNotContain("add rule name=\"ScoutingPro27 WebRTC UDP v2\"")
                .doesNotContain("add rule name=\"ScoutingPro27 App Java\"")
                .contains("name=\"ScoutingPro27 Inbound (8080)\" dir=in action=allow protocol=TCP localport=8080 profile=any");
    }

    @Test
    void testNetshOutputMatchesNonAsciiJavaPathAcrossNativeAndUtf8Charsets() throws Exception {
        String nonAsciiJava = "C:\\Users\\测试用户\\jdk-21\\bin\\java.exe";
        java.nio.charset.Charset nativeCs = NetworkUtil.resolveWindowsConsoleCharsets().get(0);
        if (nativeCs.newEncoder().canEncode(nonAsciiJava)) {
            byte[] nativeBytes = ("Program: " + nonAsciiJava + "\r\n").getBytes(nativeCs);
            assertThat(NetworkUtil.matchesJavaExeInNetshOutput(nativeBytes, nonAsciiJava)).isTrue();
        }
        String prevStdoutEnc = System.getProperty("sun.stdout.encoding");
        String prevNativeEnc = System.getProperty("native.encoding");
        try {
            System.setProperty("sun.stdout.encoding", "GBK");
            System.setProperty("native.encoding", "GBK");
            byte[] gbkBytes = ("Program: " + nonAsciiJava + "\r\n").getBytes("GBK");
            assertThat(NetworkUtil.matchesJavaExeInNetshOutput(gbkBytes, nonAsciiJava)).isTrue();
        } finally {
            if (prevStdoutEnc == null) {
                System.clearProperty("sun.stdout.encoding");
            } else {
                System.setProperty("sun.stdout.encoding", prevStdoutEnc);
            }
            if (prevNativeEnc == null) {
                System.clearProperty("native.encoding");
            } else {
                System.setProperty("native.encoding", prevNativeEnc);
            }
        }
        byte[] utf8Bytes = ("Program: " + nonAsciiJava + "\r\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);

        assertThat(NetworkUtil.matchesJavaExeInNetshOutput(utf8Bytes, nonAsciiJava)).isTrue();
        assertThat(NetworkUtil.matchesJavaExeInNetshOutput("Program: C:\\Other\\java.exe\r\n".getBytes(java.nio.charset.StandardCharsets.UTF_8), nonAsciiJava)).isFalse();
        assertThat(NetworkUtil.matchesJavaExeInNetshOutput(new byte[0], nonAsciiJava)).isFalse();

        // Verify InetAddress.isSiteLocalAddress() already excludes 28.0.0.0/8 Fake-IP addresses
        assertThat(java.net.InetAddress.getByName("28.0.0.1").isSiteLocalAddress()).isFalse();
    }

    @Test
    void testHasHeadlessArgNormalization() {
        assertThat(NetworkUtil.hasHeadlessArg(new String[]{"--headless"})).isTrue();
        assertThat(NetworkUtil.hasHeadlessArg(new String[]{"--port=8080", "\"--headless\""})).isTrue();
        assertThat(NetworkUtil.hasHeadlessArg(new String[]{"  --headless  "})).isTrue();
        assertThat(NetworkUtil.hasHeadlessArg(new String[]{" \"--headless\" "})).isTrue();

        assertThat(NetworkUtil.hasHeadlessArg(null)).isFalse();
        assertThat(NetworkUtil.hasHeadlessArg(new String[0])).isFalse();
        assertThat(NetworkUtil.hasHeadlessArg(new String[]{null, "--port=8080", "--headless-mode"})).isFalse();
    }

    @Test
    void testShouldSkipFirewallCheckFlagsAndHeadlessAlone() {
        Map<String, String> empty = Collections.emptyMap();

        // --headless alone WITHOUT SKIP_FIREWALL_CHECK / ENABLE_TEST_CLEANUP must NOT skip
        assertThat(NetworkUtil.shouldSkipFirewallCheck(new String[]{"--headless"}, empty::get, empty::get)).isFalse();
        assertThat(NetworkUtil.shouldSkipFirewallCheck(new String[]{"\"--headless\""}, empty::get, empty::get)).isFalse();
        assertThat(NetworkUtil.shouldSkipFirewallCheck(new String[0], empty::get, empty::get)).isFalse();
        assertThat(NetworkUtil.shouldSkipFirewallCheck(null, empty::get, empty::get)).isFalse();

        // ENABLE_TEST_CLEANUP / SKIP_FIREWALL_CHECK via envLookup (case-insensitive, trimmed)
        for (String val : new String[]{"true", "TRUE", "TrUe", " true "}) {
            assertThat(NetworkUtil.shouldSkipFirewallCheck(
                    new String[0], Map.of("ENABLE_TEST_CLEANUP", val)::get, empty::get)).isTrue();
            assertThat(NetworkUtil.shouldSkipFirewallCheck(
                    new String[0], Map.of("SKIP_FIREWALL_CHECK", val)::get, empty::get)).isTrue();
            assertThat(NetworkUtil.shouldSkipFirewallCheck(
                    new String[0], empty::get, Map.of("ENABLE_TEST_CLEANUP", val)::get)).isTrue();
            assertThat(NetworkUtil.shouldSkipFirewallCheck(
                    new String[0], empty::get, Map.of("SKIP_FIREWALL_CHECK", val)::get)).isTrue();
        }

        // Negative flag values
        for (String val : new String[]{"false", "0", "1", "yes", ""}) {
            assertThat(NetworkUtil.shouldSkipFirewallCheck(
                    new String[]{"--headless"}, Map.of("ENABLE_TEST_CLEANUP", val)::get, empty::get)).isFalse();
            assertThat(NetworkUtil.shouldSkipFirewallCheck(
                    new String[]{"--headless"}, empty::get, Map.of("SKIP_FIREWALL_CHECK", val)::get)).isFalse();
        }

        // Real System property checks with try/finally cleanup
        String prevCleanup = System.getProperty("ENABLE_TEST_CLEANUP");
        String prevSkip = System.getProperty("SKIP_FIREWALL_CHECK");
        try {
            System.clearProperty("ENABLE_TEST_CLEANUP");
            System.clearProperty("SKIP_FIREWALL_CHECK");
            boolean envActive = "true".equalsIgnoreCase(String.valueOf(System.getenv("ENABLE_TEST_CLEANUP")).trim())
                    || "true".equalsIgnoreCase(String.valueOf(System.getenv("SKIP_FIREWALL_CHECK")).trim());
            if (!envActive) {
                assertThat(NetworkUtil.shouldSkipFirewallCheck(new String[]{"--headless"})).isFalse();
                assertThat(NetworkUtil.shouldSkipFirewallCheck()).isFalse();
            }

            System.setProperty("ENABLE_TEST_CLEANUP", " TrUe ");
            assertThat(NetworkUtil.shouldSkipFirewallCheck()).isTrue();
            assertThat(NetworkUtil.shouldSkipFirewallCheck(new String[0])).isTrue();

            System.clearProperty("ENABLE_TEST_CLEANUP");
            System.setProperty("SKIP_FIREWALL_CHECK", "TRUE");
            assertThat(NetworkUtil.shouldSkipFirewallCheck()).isTrue();
            assertThat(NetworkUtil.shouldSkipFirewallCheck(new String[0])).isTrue();
        } finally {
            if (prevCleanup == null) {
                System.clearProperty("ENABLE_TEST_CLEANUP");
            } else {
                System.setProperty("ENABLE_TEST_CLEANUP", prevCleanup);
            }
            if (prevSkip == null) {
                System.clearProperty("SKIP_FIREWALL_CHECK");
            } else {
                System.setProperty("SKIP_FIREWALL_CHECK", prevSkip);
            }
        }
    }

    @Test
    void testEnsureWindowsFirewallPortAndPromptSkipWithoutUac() {
        String prevCleanup = System.getProperty("ENABLE_TEST_CLEANUP");
        String prevSkip = System.getProperty("SKIP_FIREWALL_CHECK");
        try {
            System.clearProperty("ENABLE_TEST_CLEANUP");
            System.setProperty("SKIP_FIREWALL_CHECK", "true");

            boolean executedWithSkipFlag = NetworkUtil.ensureWindowsFirewallPort(18080, port -> {
                throw new AssertionError("Firewall action must be skipped when SKIP_FIREWALL_CHECK=true!");
            });
            assertThat(executedWithSkipFlag).isFalse();
            NetworkUtil.ensureWindowsFirewallPort(18080);
            assertThat(NetworkUtil.openWindowsFirewallPrompt(18080)).isFalse();

            System.clearProperty("SKIP_FIREWALL_CHECK");
            System.setProperty("ENABLE_TEST_CLEANUP", "TrUe");

            boolean executedWithCleanupFlag = NetworkUtil.ensureWindowsFirewallPort(18080, port -> {
                throw new AssertionError("Firewall action must be skipped when ENABLE_TEST_CLEANUP=true!");
            });
            assertThat(executedWithCleanupFlag).isFalse();
            NetworkUtil.ensureWindowsFirewallPort(18080);
            assertThat(NetworkUtil.openWindowsFirewallPrompt(18080)).isFalse();

            // When flags are cleared (and env doesn't force skip), ensureWindowsFirewallPort delegates to applyAction
            System.clearProperty("ENABLE_TEST_CLEANUP");
            System.clearProperty("SKIP_FIREWALL_CHECK");
            if (!NetworkUtil.shouldSkipFirewallCheck()) {
                AtomicInteger invokedPort = new AtomicInteger(-1);
                boolean executedWithoutFlags = NetworkUtil.ensureWindowsFirewallPort(18080, invokedPort::set);
                assertThat(executedWithoutFlags).isTrue();
                assertThat(invokedPort.get()).isEqualTo(18080);
            }
        } finally {
            if (prevCleanup == null) {
                System.clearProperty("ENABLE_TEST_CLEANUP");
            } else {
                System.setProperty("ENABLE_TEST_CLEANUP", prevCleanup);
            }
            if (prevSkip == null) {
                System.clearProperty("SKIP_FIREWALL_CHECK");
            } else {
                System.setProperty("SKIP_FIREWALL_CHECK", prevSkip);
            }
        }
    }
}

