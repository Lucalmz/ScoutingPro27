package com.bear27570.app.util;

import com.offbynull.portmapper.gateway.Bus;
import com.offbynull.portmapper.gateways.network.NetworkGateway;
import com.offbynull.portmapper.gateways.network.internalmessages.KillNetworkRequest;
import com.offbynull.portmapper.mapper.PortMapper;
import com.offbynull.portmapper.mappers.upnpigd.FirewallUpnpIgdPortMapper;
import org.apache.commons.lang3.Range;
import org.junit.jupiter.api.Test;

import java.net.InetAddress;
import java.net.URL;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class PortForwardingAndNetworkExtendedTest {

    @Test
    void testIpClassifiersPrimaryPickAndEmptyNicsStartup() throws Exception {
        InetAddress clash = InetAddress.getByName("198.18.0.1");
        InetAddress bench = InetAddress.getByName("198.19.255.254");
        InetAddress cgnat = InetAddress.getByName("100.100.1.1");
        InetAddress priv = InetAddress.getByName("10.0.0.5");
        InetAddress multicast = InetAddress.getByName("224.0.0.1");
        InetAddress zeroNet = InetAddress.getByName("0.0.0.1");
        InetAddress pub = InetAddress.getByName("8.8.8.8");

        assertThat(PortForwardingService.isClashOrBenchmarkIpv4(clash)).isTrue();
        assertThat(PortForwardingService.isClashOrBenchmarkIpv4(bench)).isTrue();
        assertThat(PortForwardingService.isClashOrBenchmarkIpv4(pub)).isFalse();

        assertThat(PortForwardingService.isPublicRoutableIpv4(pub)).isTrue();
        assertThat(PortForwardingService.isPublicRoutableIpv4(priv)).isFalse();
        assertThat(PortForwardingService.isPublicRoutableIpv4(cgnat)).isFalse();
        assertThat(PortForwardingService.isPublicRoutableIpv4(clash)).isFalse();
        assertThat(PortForwardingService.isPublicRoutableIpv4(multicast)).isFalse();
        assertThat(PortForwardingService.isPublicRoutableIpv4(zeroNet)).isFalse();

        // pickPrimaryPhysicalIpv4 skips Clash TUN and prefers site-local over public
        assertThat(PortForwardingService.pickPrimaryPhysicalIpv4(Arrays.asList(clash, pub, priv)))
                .isEqualTo(priv);
        assertThat(PortForwardingService.pickPrimaryPhysicalIpv4(Arrays.asList(clash, pub)))
                .isEqualTo(pub);
        assertThat(PortForwardingService.pickPrimaryPhysicalIpv4(Collections.singletonList(clash)))
                .isNull();

        // Empty physical NIC list skips discovery and yields NO_IPV4_MAPPING
        PortForwardingService emptyNicSvc = new PortForwardingService(
                nics -> { throw new AssertionError("Discovery must not run when physical NICs are empty"); },
                Collections::emptyList,
                () -> null,
                300L,
                150L);
        PortForwardingService.StartupSummary summary = emptyNicSvc.startAndMap();
        assertThat(summary.getDiscoveredMapperCount()).isZero();
        assertThat(summary.getIpv4Classification()).isEqualTo(PortForwardingService.ExternalIpClassification.NO_IPV4_MAPPING);
        assertThat(emptyNicSvc.getLastSummary()).isSameAs(summary);
        emptyNicSvc.close();

        // collectPhysicalNicAddresses runs cleanly without throwing
        assertThat(PortForwardingService.collectPhysicalNicAddresses()).isNotNull();
    }

    @Test
    void testStunMappedAddressFallbackAndInvalidPackets() throws Exception {
        byte[] txId = new byte[]{9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12};
        ByteBuffer resp = ByteBuffer.allocate(20 + 12);
        resp.putShort((short) 0x0101); // Binding Success
        resp.putShort((short) 12);
        resp.putInt(0x2112A442);
        resp.put(txId);
        resp.putShort((short) 0x0001); // MAPPED-ADDRESS fallback (not XOR)
        resp.putShort((short) 8);
        resp.put((byte) 0x00);
        resp.put((byte) 0x01); // IPv4
        resp.putShort((short) 50000);
        resp.put(new byte[]{120, 45, 67, 89});

        InetAddress mapped = PortForwardingService.parseStunMappedIpv4(resp.array(), resp.capacity(), txId);
        assertThat(mapped).isNotNull();
        assertThat(mapped.getHostAddress()).isEqualTo("120.45.67.89");

        // Short/null packets return null safely
        assertThat(PortForwardingService.parseStunMappedIpv4(null, 0, txId)).isNull();
        assertThat(PortForwardingService.parseStunMappedIpv4(new byte[10], 10, txId)).isNull();
    }

    @Test
    void testFirewallMapperWithIpv4SourceIsSkippedDuringStartAndMap() throws Exception {
        InetAddress physIpv4 = InetAddress.getByName("192.168.1.50");
        NetworkGateway gw = NetworkGateway.create();
        try {
            Bus bus = gw.getBus();
            FirewallUpnpIgdPortMapper misboundV4Firewall = new FirewallUpnpIgdPortMapper(
                    bus,
                    physIpv4,
                    new URL("http://192.168.1.1:1900/ctl"),
                    "TestRouter",
                    "urn:schemas-upnp-org:service:WANIPv6FirewallControl:1",
                    Range.between(1L, 65535L),
                    Range.between(1L, 86400L)
            );

            PortForwardingService svc = new PortForwardingService(
                    nics -> new PortForwardingService.DiscoverySession() {
                        @Override
                        public List<PortMapper> getMappers() {
                            return Collections.singletonList(misboundV4Firewall);
                        }

                        @Override
                        public void close() {}
                    },
                    () -> Collections.singletonList(physIpv4),
                    () -> null,
                    300L,
                    150L
            );
            PortForwardingService.StartupSummary summary = svc.startAndMap();
            assertThat(summary.getActiveIpv6Pinholes()).isZero();
            assertThat(summary.getActiveIpv4Mappings()).isZero();
            svc.shutdown();
        } finally {
            gw.getBus().send(new KillNetworkRequest());
            gw.join();
        }
    }

    @Test
    void testNetworkUtilOsTypeMacFirewallAndCleanIpv6EdgeCases() throws Exception {
        assertThat(NetworkUtil.getOsType()).isIn("windows", "macos", "linux", "unknown");
        assertThat(NetworkUtil.getMacFirewallCommand(8080)).contains("socketfilterfw");
        assertThat(NetworkUtil.getCleanIpv6HostAddress(null)).isNull();
        InetAddress scoped = InetAddress.getByName("fe80::1%12");
        assertThat(NetworkUtil.getCleanIpv6HostAddress(scoped)).isEqualTo("fe80:0:0:0:0:0:0:1");
    }
}
