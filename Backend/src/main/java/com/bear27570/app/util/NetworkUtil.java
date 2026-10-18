package com.bear27570.app.util;

import java.io.File;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;

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
                        if (!iface.isUp() || iface.isLoopback() || isVirtualOrIgnoredInterface(iface)) {
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
            return p.waitFor() == 0;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 检查当前 Windows 防火墙是否已存在针对 WebRTC UDP 入站端口范围 (1024-65535, edge=yes) 的放行规则
     */
    public static boolean isWindowsFirewallWebRtcUdpAllowed() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (!os.contains("win")) {
            return true;
        }
        try {
            ProcessBuilder pb = new ProcessBuilder(
                    "netsh", "advfirewall", "firewall", "show", "rule",
                    "name=ScoutingPro27 WebRTC UDP v2"
            );
            pb.redirectErrorStream(true);
            Process p = pb.start();
            int exitCode = p.waitFor();
            return exitCode == 0;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 在 Windows 环境下尝试自动化配置入站防火墙放行规则（涵盖 TCP 服务端口、WebRTC UDP 1024-65535 edge=yes、Java/JCEF 程序级放行与物理网卡 IPv6 直连路由）
     */
    public static void ensureWindowsFirewallPort(int port) {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (!os.contains("win")) {
            return;
        }
        boolean tcpAllowed = isWindowsFirewallPortAllowed(port);
        boolean udpAllowed = isWindowsFirewallWebRtcUdpAllowed();
        boolean hasAppBlock = hasWindowsFirewallAppBlockRule();
        boolean ipv6DirectRoutesOk = isWindowsIpv6DirectRoutesConfigured();

        if (tcpAllowed && udpAllowed && !hasAppBlock && ipv6DirectRoutesOk) {
            System.out.println("[Firewall] Windows 防火墙规则 (TCP " + port + " & WebRTC UDP 1024-65535 edge=yes) 及物理网卡 IPv6 直连路由均已就绪");
            return;
        }

        String psScript = buildWindowsNetworkAndFirewallSetupScript(port);
        String encodedCommand = java.util.Base64.getEncoder().encodeToString(
                psScript.getBytes(java.nio.charset.StandardCharsets.UTF_16LE)
        );

        try {
            // 1. 先尝试在当前进程权限下直接执行（若当前已是管理员权限，无需弹窗即可静默完成）
            ProcessBuilder pb = new ProcessBuilder(
                    "powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand
            );
            pb.redirectErrorStream(true);
            Process p = pb.start();
            p.getInputStream().readAllBytes();
            int code = p.waitFor();
            if (code == 0 && isWindowsFirewallPortAllowed(port) && isWindowsFirewallWebRtcUdpAllowed() && !hasWindowsFirewallAppBlockRule()) {
                System.out.println("[Firewall] 已在当前权限下完成 Windows 防火墙放行 (UDP 1024-65535 edge=yes) 与 TUN 环境国内 IPv6 物理直连路由配置");
                return;
            }
            System.out.println("[Firewall] 检测到防火墙规则需更新或 TUN 抢占 IPv6 路由，正在唤起 UAC 管理员提权以配置 WebRTC IPv6 穿透环境...");
            if (!openWindowsFirewallPrompt(port, encodedCommand)) {
                System.err.println("[Firewall] 警告：UAC 提权未完成或被拒绝，TUN 环境下的跨网 IPv6 WebRTC 直连可能受阻");
            }
        } catch (Exception e) {
            System.err.println("[Firewall] 配置 Windows 防火墙与 IPv6 路由异常: " + e.getMessage());
        }
    }

    private static String buildWindowsNetworkAndFirewallSetupScript(int port) {
        String javaExe = ProcessHandle.current().info().command().orElse("");
        String jcefHelperExe = new java.io.File(
                System.getProperty("user.home"),
                ".scoutingpro27/jcef-bundle/jcef_helper.exe"
        ).getAbsolutePath();

        StringBuilder sb = new StringBuilder();
        // 1. 放行 TCP 端口与全范围 WebRTC UDP 端口 (1024-65535)，必须开启 edge=yes 以放行跨 /64 子网的公网 IPv6 UDP 入站打洞包
        sb.append("netsh advfirewall firewall delete rule name=\"ScoutingPro27 WebRTC UDP\" | Out-Null; ");
        sb.append("netsh advfirewall firewall delete rule name=\"ScoutingPro27 WebRTC UDP v2\" | Out-Null; ");
        sb.append("netsh advfirewall firewall add rule name=\"ScoutingPro27 Inbound (").append(port).append(")\" dir=in action=allow protocol=TCP localport=").append(port).append(" profile=any | Out-Null; ");
        sb.append("netsh advfirewall firewall add rule name=\"ScoutingPro27 WebRTC UDP v2\" dir=in action=allow protocol=UDP localport=1024-65535 profile=any edge=yes | Out-Null; ");

        // 2. 移除针对 java / jcef_helper / scoutingpro 的入站 Block 规则（Windows 防火墙中 Block 优先级高于端口 Allow）
        sb.append("Get-NetFirewallRule -Direction Inbound -Action Block -ErrorAction SilentlyContinue | ForEach-Object { ");
        sb.append("$app = $_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue; ");
        sb.append("if ($app -and ($app.Program -match 'java|jcef|scoutingpro')) { Remove-NetFirewallRule -Name $_.Name -ErrorAction SilentlyContinue } ");
        sb.append("}; ");

        // 3. 显式为当前 Java 进程和 jcef_helper.exe 添加带 edge=yes 的应用程序级入站 Allow 规则
        if (!javaExe.isEmpty()) {
            sb.append("netsh advfirewall firewall add rule name=\"ScoutingPro27 App Java\" dir=in action=allow program=\"")
              .append(javaExe.replace("\"", "")).append("\" profile=any edge=yes | Out-Null; ");
        }
        sb.append("if (Test-Path '").append(jcefHelperExe.replace("'", "''")).append("') { ");
        sb.append("netsh advfirewall firewall add rule name=\"ScoutingPro27 App JCEF\" dir=in action=allow program=\"")
          .append(jcefHelperExe.replace("\"", "")).append("\" profile=any edge=yes | Out-Null; ");
        sb.append("}; ");

        // 4. 核心破局：当开启 Clash/Mihomo/sing-box TUN 时，TUN 会注入 ::/1、8000::/1 或 2000::/3 劫持所有公网 IPv6 出站包。
        // 自动定位拥有 fe80:* 链路本地网关的物理网卡，为其注入 /16 国内运营商 IPv6 直连路由（/16 优先于 TUN 的 /3 和 /1），
        // 使 WebRTC 物理网卡 IPv6 打洞包 100% 走物理路由器直出，同时由强主机模型自动阻断 libwebrtc 内部 fdfe:: TUN 端口向外发包！
        sb.append("$physRoute = Get-NetRoute -AddressFamily IPv6 -DestinationPrefix '::/0' -ErrorAction SilentlyContinue | ")
          .append("Where-Object { $_.NextHop -like 'fe80:*' } | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1; ");
        sb.append("if ($physRoute) { ");
        sb.append("$ifIdx = $physRoute.InterfaceIndex; $nh = $physRoute.NextHop; ");
        sb.append("$cnPrefixes = @('2408::/16','2409::/16','240e::/16','240c::/16','2001:da8::/32','2001:250::/32'); ");
        sb.append("foreach ($pfx in $cnPrefixes) { ");
        sb.append("Remove-NetRoute -AddressFamily IPv6 -DestinationPrefix $pfx -Confirm:$false -ErrorAction SilentlyContinue; ");
        sb.append("New-NetRoute -AddressFamily IPv6 -DestinationPrefix $pfx -InterfaceIndex $ifIdx -NextHop $nh -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Out-Null; ");
        sb.append("} }");
        return sb.toString();
    }

    /**
     * 通过 UAC 管理员提权运行 PowerShell 脚本同时放行 TCP 服务端口、WebRTC UDP 1024-65535 edge=yes、
     * Java/JCEF 程序级放行与物理网卡 IPv6 直连路由
     */
    public static boolean openWindowsFirewallPrompt(int port) {
        String psScript = buildWindowsNetworkAndFirewallSetupScript(port);
        String encodedCommand = java.util.Base64.getEncoder().encodeToString(
                psScript.getBytes(java.nio.charset.StandardCharsets.UTF_16LE)
        );
        return openWindowsFirewallPrompt(port, encodedCommand);
    }

    private static boolean openWindowsFirewallPrompt(int port, String encodedCommand) {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (!os.contains("win")) {
            return false;
        }
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
                System.out.println("[Firewall] Windows 防火墙 (UDP 1024-65535 edge=yes) 及国内 IPv6 物理网卡直连路由已通过管理员提权配置成功");
                return true;
            }
            System.err.println("[Firewall] UAC 提权执行结束，exitCode=" + exitCode + ", bothAllowed=" + bothAllowed);
            return bothAllowed;
        } catch (Exception e) {
            System.err.println("[Firewall] 唤起 Windows 防火墙提权执行异常: " + e.getMessage());
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
                    "Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True -ErrorAction SilentlyContinue | ForEach-Object { " +
                    "$app = $_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue; " +
                    "if ($app -and ($app.Program -match 'java|jcef|scoutingpro')) { Write-Output 'BLOCKED'; break } }"
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

    public static boolean isWindowsIpv6DirectRoutesConfigured() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (!os.contains("win")) {
            return true;
        }
        try {
            ProcessBuilder pb = new ProcessBuilder(
                    "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                    "$phys = Get-NetRoute -AddressFamily IPv6 -DestinationPrefix '::/0' -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -like 'fe80:*' } | Select-Object -First 1; " +
                    "if (-not $phys) { Write-Output 'NO_IPV6_PHYS'; exit 0 }; " +
                    "$r = Get-NetRoute -AddressFamily IPv6 -DestinationPrefix '2409::/16' -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceIndex -eq $phys.InterfaceIndex }; " +
                    "if ($r) { Write-Output 'ROUTE_OK' } else { Write-Output 'ROUTE_MISSING' }"
            );
            pb.redirectErrorStream(true);
            Process p = pb.start();
            String out = new String(p.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            p.waitFor();
            return out.contains("ROUTE_OK") || out.contains("NO_IPV6_PHYS");
        } catch (Exception e) {
            return true;
        }
    }
}
