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
               name.contains("pseudo");
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
                                if (!validIpv4s.contains(ip)) {
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
     * 生成放行指定 TCP 端口的 Windows 防火墙标准命令行
     */
    public static String getFirewallCommand(int port) {
        return "netsh advfirewall firewall add rule name=\"ScoutingPro27 Inbound (" + port + ")\" dir=in action=allow protocol=TCP localport=" + port + " profile=any";
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
     * 在 Windows 环境下尝试自动化配置入站防火墙放行规则
     */
    public static void ensureWindowsFirewallPort(int port) {
        if (!System.getProperty("os.name", "").toLowerCase().contains("win")) return;
        if (isWindowsFirewallPortAllowed(port)) {
            System.out.println("[Firewall] Windows 防火墙已存在放行规则 (TCP " + port + ")，无需重复添加");
            return;
        }
        try {
            ProcessBuilder pb = new ProcessBuilder(
                    "netsh", "advfirewall", "firewall", "add", "rule",
                    "name=ScoutingPro27 Inbound (" + port + ")",
                    "dir=in", "action=allow", "protocol=TCP",
                    "localport=" + port, "profile=any"
            );
            pb.redirectErrorStream(true);
            Process p = pb.start();
            int code = p.waitFor();
            if (code == 0) {
                System.out.println("[Firewall] Windows 防火墙入站规则已确认放行 TCP 端口 " + port);
            } else {
                System.out.println("[Firewall] 提示: netsh 返回代码 " + code + "（如受限，请以管理员身份运行以完全放行公网入站）");
            }
        } catch (Exception e) {
            System.err.println("[Firewall] 检查 Windows 防火墙规则异常: " + e.getMessage());
        }
    }

    /**
     * 响应用户界面点击：通过 UAC 管理员提权运行 netsh 放行防火墙端口
     */
    public static boolean openWindowsFirewallPrompt(int port) {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (!os.contains("win")) {
            return false;
        }
        if (isWindowsFirewallPortAllowed(port)) {
            System.out.println("[Firewall] 端口 " + port + " 已经放行，无需重复配置");
            return true;
        }
        try {
            // 通过 PowerShell Start-Process 以管理员权限 (Verb RunAs) 静默调用 netsh
            ProcessBuilder pb = new ProcessBuilder(
                    "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                    "Start-Process netsh.exe -ArgumentList 'advfirewall firewall add rule name=\"\"\"ScoutingPro27 Inbound (" + port + ")\"\"\" dir=in action=allow protocol=TCP localport=" + port + " profile=any' -Verb RunAs -Wait -WindowStyle Hidden"
            );
            Process p = pb.start();
            int exitCode = p.waitFor();
            if (exitCode == 0 && isWindowsFirewallPortAllowed(port)) {
                System.out.println("[Firewall] Windows 防火墙入站端口 " + port + " 已通过管理员提权成功放行");
                return true;
            }
            return isWindowsFirewallPortAllowed(port);
        } catch (Exception e) {
            System.err.println("[Firewall] 唤起 Windows 防火墙提权执行异常: " + e.getMessage());
            return false;
        }
    }
}
