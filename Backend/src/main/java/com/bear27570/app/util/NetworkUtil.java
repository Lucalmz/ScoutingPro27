package com.bear27570.app.util;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;

/**
 * 局域网网络探测工具类。
 * 智能过滤回环网卡、虚拟网卡（WSL, VMware, VirtualBox, Docker, Hyper-V 等），
 * 提取宿主机真实的活动 Site-Local IPv4 地址，用于手机端扫码直连。
 */
public class NetworkUtil {

    public record NetworkInfo(String primaryIp, List<String> allIps) {}

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

    public static NetworkInfo getLanIpv4Info() {
        List<String> validIps = new ArrayList<>();
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
                                if (!validIps.contains(ip)) {
                                    validIps.add(ip);
                                }
                            }
                        }
                    } catch (SocketException ignored) {}
                }
            }
        } catch (SocketException e) {
            System.err.println("[NetworkUtil] Error enumerating network interfaces: " + e.getMessage());
        }

        // 挑选首选 IP：
        // 1. 优先 192.168.137.x（Windows 自带移动热点默认网段）
        // 2. 其次 192.168.43.x（安卓手机热点默认网段）
        // 3. 其次 172.20.10.x（iPhone 个人热点默认网段）
        // 4. 其次 192.168.x.x
        // 5. 再次 172.16-31.x.x
        // 6. 再次 10.x.x.x
        String primary = "127.0.0.1";
        if (!validIps.isEmpty()) {
            primary = validIps.stream()
                    .filter(ip -> ip.startsWith("192.168.137."))
                    .findFirst()
                    .orElseGet(() -> validIps.stream()
                            .filter(ip -> ip.startsWith("192.168.43."))
                            .findFirst()
                            .orElseGet(() -> validIps.stream()
                                    .filter(ip -> ip.startsWith("172.20.10."))
                                    .findFirst()
                                    .orElseGet(() -> validIps.stream()
                                            .filter(ip -> ip.startsWith("192.168."))
                                            .findFirst()
                                            .orElseGet(() -> validIps.stream()
                                                    .filter(ip -> ip.startsWith("172."))
                                                    .findFirst()
                                                    .orElseGet(() -> validIps.stream()
                                                            .filter(ip -> ip.startsWith("10."))
                                                            .findFirst()
                                                            .orElse(validIps.get(0)))))));
        }

        return new NetworkInfo(primary, validIps);
    }
}
