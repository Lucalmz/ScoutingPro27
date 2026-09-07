package com.bear27570.app.util;

import org.junit.jupiter.api.Test;

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
}
