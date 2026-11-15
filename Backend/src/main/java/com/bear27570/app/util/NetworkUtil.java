package com.bear27570.app.util;

import java.io.File;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 局域网与公网双栈网络探测工具类。
 * 智能过滤回环网卡、虚拟网卡（WSL, VMware, VirtualBox, Docker, Hyper-V 等），
 * 提取宿主机真实的活动 Site-Local IPv4 与全球单播公网 IPv6 (2000::/3) 地址，
 * 赋能手机端与电脑间跨公网 P2P 及 HTTP 直连。
 */
public class NetworkUtil {

    public record NetworkInfo(
            String primaryIp,
            List<String> allIps,
            String primaryIpv6,
            List<String> allIpv6s
    ) {
        public NetworkInfo(String primaryIp, List<String> allIps) {
            this(primaryIp, allIps, null, Collections.emptyList());
        }
    }

    public static boolean isVirtualOrIgnoredInterface(NetworkInterface iface) {
        String name = (iface.getName() + " " + iface.getDisplayName()).toLowerCase();
        // 关键特例：Windows 移动热点 / Wi-Fi 直连网卡 (Microsoft Wi-Fi Direct Virtual Adapter)
        // 手机连接电脑热点时正依赖此网卡，绝对不能当作虚拟机网卡丢弃！
        if (name.contains("wi-fi direct") || name.contains("wifi direct") || name.contains("hostednetwork")) {
            return false;
        }
        if (iface.isVirtual()) return true;
        return name.contains("virtualbox") ||
               name.contains("vmware") ||
               name.contains("vbox") ||
               name.contains("docker") ||
               name.contains("wsl") ||
               name.contains("hyper-v") ||
               name.contains("vethernet") ||
               name.contains("loopback") ||
               name.contains("teredo") ||
               name.contains("isatap") ||
               name.contains("6to4") ||
               name.contains("pseudo") ||
               name.contains("meta") ||
               name.contains("mihomo") ||
               name.contains("wintun") ||
               name.contains("sing-tun") ||
               name.contains("clash") ||
               name.contains("flclash") ||
               name.contains("wireguard") ||
               name.contains("tailscale") ||
               name.contains("zerotier") ||
               name.contains("openvpn") ||
               name.contains("tap-") ||
               name.contains("tap0") ||
               name.contains("tun0");
    }

    /**
     * 校验是否为合法的公网全球单播 IPv6 地址 (Global Unicast Address, 2000::/3)
     */
    public static boolean isGlobalUnicastIpv6(InetAddress addr) {
        if (!(addr instanceof Inet6Address ip6)) return false;
        if (ip6.isLoopbackAddress() || ip6.isLinkLocalAddress() || ip6.isSiteLocalAddress() || ip6.isMulticastAddress() || ip6.isAnyLocalAddress()) {
            return false;
        }
        if (ip6.isIPv4CompatibleAddress()) return false;
        byte[] b = ip6.getAddress();
        if (b == null || b.length != 16) return false;

        // 全球单播前缀 2000::/3 (高 3 位为 001，第一字节在 0x20 到 0x3F 之间)
        int firstByte = b[0] & 0xFF;
        if (firstByte < 0x20 || firstByte > 0x3F) {
            return false;
        }

        // 排除文档保留段 2001:db8::/32
        if (b[0] == 0x20 && b[1] == 0x01 && (b[2] & 0xFF) == 0x0D && (b[3] & 0xFF) == 0xB8) {
            return false;
        }
        // 排除 Teredo 隧道 2001:0000::/32
        if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x00 && b[3] == 0x00) {
            return false;
        }
        // 排除 6to4 隧道 2002::/16
        if (b[0] == 0x20 && b[1] == 0x02) {
            return false;
        }

        return true;
    }

    /**
     * 提取干净的 IPv6 主机地址，安全剥离 Windows 特有的 %scope_id（如 %12、%eth0）
     */
    public static String getCleanIpv6HostAddress(InetAddress addr) {
        if (addr == null) return null;
        String ip = addr.getHostAddress();
        if (ip == null) return null;
        int pct = ip.indexOf('%');
        return pct >= 0 ? ip.substring(0, pct) : ip;
    }

    public static NetworkInfo getLanIpv4Info() {
        return getCompleteNetworkInfo();
    }

    public static NetworkInfo getCompleteNetworkInfo() {
        List<String> validIpv4s = new ArrayList<>();
        List<String> validIpv6s = new ArrayList<>();

        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces != null) {
                for (NetworkInterface iface : Collections.list(interfaces)) {
                    try {
                        if (!iface.isUp() || iface.isLoopback()) {
                            continue;
                        }
                        if (isVirtualOrIgnoredInterface(iface)) {
                            continue;
                        }
                        Enumeration<InetAddress> addrs = iface.getInetAddresses();
                        for (InetAddress addr : Collections.list(addrs)) {
                            if (addr instanceof Inet4Address && !addr.isLoopbackAddress() && addr.isSiteLocalAddress()) {
                                String ip = addr.getHostAddress();
                                if (ip != null && !ip.startsWith("198.18.") && !ip.startsWith("198.19.") && !validIpv4s.contains(ip)) {
                                    validIpv4s.add(ip);
                                }
                            } else if (isGlobalUnicastIpv6(addr)) {
                                String cleanIp6 = getCleanIpv6HostAddress(addr);
                                if (cleanIp6 != null && !validIpv6s.contains(cleanIp6)) {
                                    validIpv6s.add(cleanIp6);
                                }
                            }
                        }
                    } catch (SocketException ignored) {}
                }
            }
        } catch (SocketException e) {
            System.err.println("[NetworkUtil] Error enumerating network interfaces: " + e.getMessage());
        }

        // 挑选首选 IPv4：
        String primaryIpv4 = "127.0.0.1";
        if (!validIpv4s.isEmpty()) {
            primaryIpv4 = validIpv4s.stream()
                    .filter(ip -> ip.startsWith("192.168.137."))
                    .findFirst()
                    .orElseGet(() -> validIpv4s.stream()
                            .filter(ip -> ip.startsWith("192.168.43."))
                            .findFirst()
                            .orElseGet(() -> validIpv4s.stream()
                                    .filter(ip -> ip.startsWith("172.20.10."))
                                    .findFirst()
                                    .orElseGet(() -> validIpv4s.stream()
                                            .filter(ip -> ip.startsWith("192.168."))
                                            .findFirst()
                                            .orElseGet(() -> validIpv4s.stream()
                                                    .filter(ip -> ip.startsWith("172."))
                                                    .findFirst()
                                                    .orElseGet(() -> validIpv4s.stream()
                                                            .filter(ip -> ip.startsWith("10."))
                                                            .findFirst()
                                                            .orElse(validIpv4s.get(0)))))));
        }

        // 挑选首选公网 IPv6：
        // 优先中国电信 240e / 联通 2408 / 移动 2409 或任何合法的 GUA
        String primaryIpv6 = null;
        if (!validIpv6s.isEmpty()) {
            primaryIpv6 = validIpv6s.stream()
                    .filter(ip -> ip.startsWith("240e:") || ip.startsWith("2408:") || ip.startsWith("2409:"))
                    .findFirst()
                    .orElse(validIpv6s.get(0));
        }

        return new NetworkInfo(primaryIpv4, validIpv4s, primaryIpv6, validIpv6s);
    }

    /**
     * 获取操作系统类型标识 ("windows", "macos", "linux", "unknown")
     */
    public static String getOsType() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("win")) return "windows";
        if (os.contains("mac")) return "macos";
        if (os.contains("nix") || os.contains("nux") || os.contains("aix")) return "linux";
        return "unknown";
    }

    /**
     * 生成放行指定 TCP 端口的 Windows 防火墙标准命令行
     */
    public static String getFirewallCommand(int port) {
        return "netsh advfirewall firewall add rule name=\"ScoutingPro27 Inbound (" + port + ")\" dir=in action=allow protocol=TCP localport=" + port + " profile=any";
    }

    /**
     * 生成 macOS 终端排查与临时放行防火墙限制的标准命令行
     */
    public static String getMacFirewallCommand(int port) {
        return "sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off";
    }

    /**
     * 检查当前 Windows 防火墙是否已存在针对指定 TCP 端口的入站放行规则
     */
    public static boolean isWindowsFirewallPortAllowed(int port) {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (!os.contains("win")) {
            return true;
        }
        try {
            ProcessBuilder pb = new ProcessBuilder(
                    "netsh", "advfirewall", "firewall", "show", "rule",
                    "name=ScoutingPro27 Inbound (" + port + ")"
            );
            pb.redirectErrorStream(true);
            Process p = pb.start();
            p.getInputStream().readAllBytes();
            return p.waitFor() == 0;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 检查当前进程是否具备 Windows 管理员权限
     */
    public static boolean isCurrentProcessAdmin() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (!os.contains("win")) {
            return false;
        }
        try {
            Process p = new ProcessBuilder("net", "session").redirectErrorStream(true).start();
            p.getInputStream().readAllBytes();
            return p.waitFor() == 0;
        } catch (Exception e) {
            return false;
        }
    }

    static String resolveCurrentJavaExe() {
        String cmd = ProcessHandle.current().info().command().orElse("");
        if (!cmd.isBlank()) {
            return cmd.replace("\"", "").trim();
        }
        String javaHome = System.getProperty("java.home", "");
        if (!javaHome.isBlank()) {
            File javaBin = new File(javaHome, "bin\\java.exe");
            if (javaBin.exists()) {
                return javaBin.getAbsolutePath().replace("\"", "").trim();
            }
        }
        return "";
    }

    public static void ensureWindowsFirewallPort(int port) {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (!os.contains("win")) {
            return;
        }
        boolean tcpAllowed = isWindowsFirewallPortAllowed(port);
        boolean udpAllowed = isWindowsFirewallWebRtcUdpAllowed();
        boolean hasAppBlock = hasWindowsFirewallAppBlockRule();

        if (tcpAllowed && udpAllowed && !hasAppBlock) {
            System.out.println("[Firewall] Windows 防火墙规则 (TCP " + port + " & WebRTC UDP 1024-65535 edge=yes) 已就绪");
            return;
        }

        String psScript = buildWindowsNetworkAndFirewallSetupScript(port);
        String encodedCommand = java.util.Base64.getEncoder().encodeToString(
                psScript.getBytes(java.nio.charset.StandardCharsets.UTF_16LE)
        );

        try {
            // 仅当当前已是管理员进程时才直接执行，避免非管理员下白白耗时 25 秒失败后再弹 UAC
            if (isCurrentProcessAdmin()) {
                ProcessBuilder pb = new ProcessBuilder(
                        "powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand
                );
                pb.redirectErrorStream(true);
                Process p = pb.start();
                p.getInputStream().readAllBytes();
                int code = p.waitFor();
                if (code == 0 && isWindowsFirewallPortAllowed(port) && isWindowsFirewallWebRtcUdpAllowed()) {
                    System.out.println("[Firewall] 已在管理员权限下完成 Windows 防火墙放行配置");
                    return;
                }
            }
            System.out.println("[Firewall] 检测到防火墙规则需更新，正在唤起 UAC 管理员提权 (<1s)...");
            if (!openWindowsFirewallPrompt(port, encodedCommand)) {
                System.err.println("[Firewall] 警告：UAC 提权未完成或被拒绝，入站 WebRTC 直连可能受阻");
            }
        } catch (Exception e) {
            System.err.println("[Firewall] 配置 Windows 防火墙与 IPv6 路由异常: " + e.getMessage());
        }
    }

    static String buildWindowsNetworkAndFirewallSetupScript(int port) {
        String javaExe = resolveCurrentJavaExe();
        String jcefHelperExe = new java.io.File(
                System.getProperty("user.home"),
                ".scoutingpro27\\jcef-bundle\\jcef_helper.exe"
        ).getAbsolutePath();
        return buildWindowsNetworkAndFirewallSetupScript(port, javaExe, jcefHelperExe);
    }

    static String buildWindowsNetworkAndFirewallSetupScript(int port, String javaExe, String jcefHelperExe) {
        String cleanJavaExe = javaExe == null ? "" : javaExe.replace("\"", "").trim();
        String cleanJcefExe = jcefHelperExe == null ? "" : jcefHelperExe.replace("\"", "").trim();

        StringBuilder sb = new StringBuilder();
        sb.append("$ErrorActionPreference = 'SilentlyContinue'; ");

        // 1. 幂等清理并重建仅属于 ScoutingPro27 的防火墙规则（严禁扫描或删除第三方 Java/CEF 规则）
        sb.append("netsh advfirewall firewall delete rule name=\"ScoutingPro27 WebRTC UDP\" | Out-Null; ");
        sb.append("netsh advfirewall firewall delete rule name=\"ScoutingPro27 WebRTC UDP v2\" | Out-Null; ");
        sb.append("netsh advfirewall firewall delete rule name=\"ScoutingPro27 Inbound (").append(port).append(")\" | Out-Null; ");
        sb.append("netsh advfirewall firewall delete rule name=\"ScoutingPro27 App Java\" | Out-Null; ");
        sb.append("netsh advfirewall firewall delete rule name=\"ScoutingPro27 App JCEF\" | Out-Null; ");
        sb.append("Get-NetFirewallRule -DisplayName 'ScoutingPro27*' -ErrorAction SilentlyContinue | ")
          .append("Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | ")
          .append("Remove-NetFirewallRule -ErrorAction SilentlyContinue; ");

        // 2. 放行 TCP 服务端口（当 javaExe 可用时绑定到当前 Java 进程）
        sb.append("netsh advfirewall firewall add rule name=\"ScoutingPro27 Inbound (").append(port)
          .append(")\" dir=in action=allow protocol=TCP localport=").append(port);
        if (!cleanJavaExe.isEmpty()) {
            sb.append(" program=\"").append(cleanJavaExe).append("\"");
        }
        sb.append(" profile=any | Out-Null; ");

        // 3. 仅在已知当前 Java 进程路径时放行作用域限定的 WebRTC UDP 端口与 Java 应用规则，严禁为全系统进程全局开放 UDP 1024-65535
        if (!cleanJavaExe.isEmpty()) {
            sb.append("netsh advfirewall firewall add rule name=\"ScoutingPro27 WebRTC UDP v2\" dir=in action=allow protocol=UDP localport=1024-65535 program=\"")
              .append(cleanJavaExe).append("\" profile=any edge=yes | Out-Null; ");
            sb.append("netsh advfirewall firewall add rule name=\"ScoutingPro27 App Java\" dir=in action=allow program=\"")
              .append(cleanJavaExe).append("\" profile=any edge=yes | Out-Null; ");
        }

        // 4. 若存在内置 jcef_helper.exe，显式为其添加带 edge=yes 的应用程序级入站 Allow 规则
        if (!cleanJcefExe.isEmpty()) {
            sb.append("if (Test-Path '").append(cleanJcefExe.replace("'", "''")).append("') { ");
            sb.append("netsh advfirewall firewall add rule name=\"ScoutingPro27 App JCEF\" dir=in action=allow program=\"")
              .append(cleanJcefExe).append("\" profile=any edge=yes | Out-Null; ");
            sb.append("}; ");
        }

        // 注意：此脚本只允许修改 Windows 防火墙规则，严禁修改任何系统路由、接口跃点数 (InterfaceMetric)、
        // WeakHost 模型或 TUN/Loopback 上的路由与地址。历史版本曾对此进行“自愈”，会破坏 Clash/Mihomo 等
        // TUN 代理的自身路由与出站绑定，导致代理全部节点不可用。

        return sb.toString();
    }

    public static boolean openWindowsFirewallPrompt(int port) {
        String psScript = buildWindowsNetworkAndFirewallSetupScript(port);
        String encodedCommand = java.util.Base64.getEncoder().encodeToString(
                psScript.getBytes(java.nio.charset.StandardCharsets.UTF_16LE)
        );
        return openWindowsFirewallPrompt(port, encodedCommand);
    }

    private static boolean openWindowsFirewallPrompt(int port, String encodedCommand) {
        try {
            ProcessBuilder pb = new ProcessBuilder(
                    "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                    "Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','" +
                    encodedCommand + "' -Verb RunAs -Wait -WindowStyle Hidden"
            );
            pb.redirectErrorStream(true);
            Process p = pb.start();
            p.getInputStream().readAllBytes();
            int exitCode = p.waitFor();
            boolean bothAllowed = isWindowsFirewallPortAllowed(port) && isWindowsFirewallWebRtcUdpAllowed();
            if (exitCode == 0 && bothAllowed) {
                System.out.println("[Firewall] Windows 防火墙 (TCP " + port + " & UDP 1024-65535 edge=yes) 已通过管理员提权配置成功");
                return true;
            }
            System.err.println("[Firewall] UAC 提权执行结束，exitCode=" + exitCode + ", bothAllowed=" + bothAllowed);
            return bothAllowed;
        } catch (Exception e) {
            System.err.println("[Firewall] 唤起 Windows 防火墙提权执行异常: " + e.getMessage());
            return false;
        }
    }

    static List<Charset> resolveWindowsConsoleCharsets() {
        Set<Charset> charsets = new LinkedHashSet<>();
        for (String prop : new String[]{"sun.stdout.encoding", "native.encoding", "sun.jnu.encoding"}) {
            String name = System.getProperty(prop);
            if (name != null && !name.isBlank()) {
                try {
                    charsets.add(Charset.forName(name.trim()));
                } catch (Exception ignored) {}
            }
        }
        charsets.add(Charset.defaultCharset());
        charsets.add(StandardCharsets.UTF_8);
        return new ArrayList<>(charsets);
    }

    static boolean matchesJavaExeInNetshOutput(byte[] rawOutput, String javaExe) {
        if (rawOutput == null || rawOutput.length == 0 || javaExe == null || javaExe.isBlank()) {
            return false;
        }
        String needle = javaExe.toLowerCase(Locale.ROOT);
        for (Charset cs : resolveWindowsConsoleCharsets()) {
            String decoded = new String(rawOutput, cs).toLowerCase(Locale.ROOT);
            if (decoded.contains(needle)) {
                return true;
            }
        }
        return false;
    }

    private static boolean isWindowsFirewallWebRtcUdpAllowed() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (!os.contains("win")) {
            return true;
        }
        String javaExe = resolveCurrentJavaExe();
        if (javaExe.isEmpty()) {
            return true;
        }
        try {
            ProcessBuilder pb = new ProcessBuilder(
                    "netsh", "advfirewall", "firewall", "show", "rule",
                    "name=ScoutingPro27 WebRTC UDP v2", "verbose"
            );
            pb.redirectErrorStream(true);
            Process p = pb.start();
            byte[] rawOut = p.getInputStream().readAllBytes();
            int exitCode = p.waitFor();
            return exitCode == 0 && matchesJavaExeInNetshOutput(rawOut, javaExe);
        } catch (Exception e) {
            return false;
        }
    }

    public static boolean hasWindowsFirewallAppBlockRule() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (!os.contains("win")) {
            return false;
        }
        try {
            ProcessBuilder pb = new ProcessBuilder(
                    "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                    "Get-NetFirewallRule -DisplayName 'ScoutingPro27*' -ErrorAction SilentlyContinue | " +
                    "Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True' } | " +
                    "Select-Object -First 1 | ForEach-Object { Write-Output 'BLOCKED' }"
            );
            pb.redirectErrorStream(true);
            Process p = pb.start();
            String out = new String(p.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            p.waitFor();
            return out.contains("BLOCKED");
        } catch (Exception e) {
            return false;
        }
    }
}
