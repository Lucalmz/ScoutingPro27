package com.bear27570.app.util;

import org.junit.jupiter.api.Test;

import java.net.InetAddress;

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

    @Test
    void testIsWindowsFirewallPortAllowed() {
        // Method should execute cleanly and return boolean without throwing
        boolean allowed = NetworkUtil.isWindowsFirewallPortAllowed(59998);
        assertThat(allowed).isIn(true, false);
    }
}

