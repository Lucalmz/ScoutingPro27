package com.bear27570.app.util;

import com.offbynull.portmapper.gateways.network.NetworkGateway;
import com.offbynull.portmapper.gateways.network.internalmessages.KillNetworkRequest;
import com.offbynull.portmapper.mapper.MappedPort;
import com.offbynull.portmapper.mapper.PortMapper;
import com.offbynull.portmapper.mapper.PortType;
import com.offbynull.portmapper.mappers.upnpigd.FirewallUpnpIgdPortMapper;
import com.offbynull.portmapper.mappers.upnpigd.PortMapperUpnpIgdPortMapper;
import org.junit.jupiter.api.Test;

import java.net.InetAddress;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

class PortForwardingServiceTest {

    private static final class FakeMappedPort implements MappedPort {
        private final int internalPort;
        private final int externalPort;
        private final InetAddress externalAddress;
        private final PortType portType;
        private final long lifetime;

        FakeMappedPort(int internalPort, int externalPort, InetAddress externalAddress, PortType portType, long lifetime) {
            this.internalPort = internalPort;
            this.externalPort = externalPort;
            this.externalAddress = externalAddress;
            this.portType = portType;
            this.lifetime = lifetime;
        }

        @Override
        public int getInternalPort() {
            return internalPort;
        }

        @Override
        public int getExternalPort() {
            return externalPort;
        }

        @Override
        public InetAddress getExternalAddress() {
            return externalAddress;
        }

        @Override
        public PortType getPortType() {
            return portType;
        }

        @Override
        public long getLifetime() {
            return lifetime;
        }
    }

    private static final class FakePortMapper implements PortMapper {
        private final InetAddress sourceAddress;
        private final InetAddress externalAddress;
        private final boolean failOnMap;
        private final boolean failOnUnmap;

        final List<Integer> mappedPorts = new CopyOnWriteArrayList<>();
        final List<Long> requestedLifetimes = new CopyOnWriteArrayList<>();
        final AtomicInteger refreshCount = new AtomicInteger(0);
        final List<Integer> unmappedPorts = new CopyOnWriteArrayList<>();

        FakePortMapper(InetAddress sourceAddress, InetAddress externalAddress, boolean failOnMap, boolean failOnUnmap) {
            this.sourceAddress = sourceAddress;
            this.externalAddress = externalAddress;
            this.failOnMap = failOnMap;
            this.failOnUnmap = failOnUnmap;
        }

        @Override
        public MappedPort mapPort(PortType portType, int internalPort, int externalPort, long lifetime) {
            if (failOnMap) {
                throw new IllegalStateException("Router rejected port mapping");
            }
            assertThat(portType).isEqualTo(PortType.UDP);
            assertThat(lifetime).isLessThanOrEqualTo(PortForwardingService.MAX_LEASE_SECONDS);
            mappedPorts.add(internalPort);
            requestedLifetimes.add(lifetime);
            return new FakeMappedPort(internalPort, externalPort, externalAddress, portType, lifetime);
        }

        @Override
        public void unmapPort(MappedPort mappedPort) {
            unmappedPorts.add(mappedPort.getInternalPort());
            if (failOnUnmap) {
                throw new IllegalStateException("Unmap failed");
            }
        }

        @Override
        public MappedPort refreshPort(MappedPort mappedPort, long lifetime) {
            refreshCount.incrementAndGet();
            return new FakeMappedPort(
                    mappedPort.getInternalPort(),
                    mappedPort.getExternalPort(),
                    mappedPort.getExternalAddress(),
                    mappedPort.getPortType(),
                    lifetime);
        }

        @Override
        public InetAddress getSourceAddress() {
            return sourceAddress;
        }
    }

    @Test
    void filtersVirtualClashTunMapperMapsNarrowRangeAndUnmapsOnShutdown() throws Exception {
        InetAddress physIpv4 = InetAddress.getByName("192.168.1.50");
        InetAddress physIpv6 = InetAddress.getByName("2409:8a00:1234:5678::50");
        InetAddress clashTun = InetAddress.getByName("198.18.0.1");
        InetAddress publicIpv4 = InetAddress.getByName("111.8.3.99");

        FakePortMapper clashMapper = new FakePortMapper(clashTun, publicIpv4, false, false);
        FakePortMapper physIpv4Mapper = new FakePortMapper(physIpv4, publicIpv4, false, false);
        FakePortMapper physIpv6Mapper = new FakePortMapper(physIpv6, physIpv6, false, false);

        AtomicBoolean sessionClosed = new AtomicBoolean(false);
        PortForwardingService service = new PortForwardingService(
                nics -> new PortForwardingService.DiscoverySession() {
                    @Override
                    public List<PortMapper> getMappers() {
                        return Arrays.asList(clashMapper, physIpv4Mapper, physIpv6Mapper);
                    }

                    @Override
                    public void close() {
                        sessionClosed.set(true);
                    }
                },
                () -> Arrays.asList(physIpv4, physIpv6),
                () -> publicIpv4,
                9999L, // intentionally > 600s to assert hard lease clamp
                300L);

        PortForwardingService.StartupSummary summary = service.startAndMap();

        assertThat(service.getLeaseSeconds()).isEqualTo(PortForwardingService.MAX_LEASE_SECONDS);
        assertThat(clashMapper.mappedPorts).isEmpty();
        assertThat(physIpv4Mapper.mappedPorts).containsExactly(
                50000, 50001, 50002, 50003, 50004, 50005, 50006, 50007, 50008, 50009);
        assertThat(physIpv6Mapper.mappedPorts).containsExactly(
                50000, 50001, 50002, 50003, 50004, 50005, 50006, 50007, 50008, 50009);
        assertThat(physIpv4Mapper.requestedLifetimes).allSatisfy(l -> assertThat(l).isLessThanOrEqualTo(600L));

        assertThat(summary.getDiscoveredMapperCount()).isEqualTo(3);
        assertThat(summary.getFilteredOutMapperCount()).isEqualTo(1);
        assertThat(summary.getActiveIpv4Mappings()).isEqualTo(10);
        assertThat(summary.getActiveIpv6Pinholes()).isEqualTo(10);
        assertThat(summary.getIpv4Classification())
                .isEqualTo(PortForwardingService.ExternalIpClassification.TRUE_PUBLIC_IPV4);

        service.renewActiveMappings();
        assertThat(physIpv4Mapper.refreshCount.get()).isEqualTo(10);
        assertThat(physIpv6Mapper.refreshCount.get()).isEqualTo(10);

        service.shutdown();
        service.shutdown(); // idempotent

        assertThat(sessionClosed.get()).isTrue();
        assertThat(physIpv4Mapper.unmappedPorts).hasSize(10);
        assertThat(physIpv6Mapper.unmappedPorts).hasSize(10);
        assertThat(service.getActiveMappings()).isEmpty();
    }

    @Test
    void detectsCgnatAndDoubleNatAccurately() throws Exception {
        InetAddress cgnatStart = InetAddress.getByName("100.64.0.1");
        InetAddress cgnatEnd = InetAddress.getByName("100.127.255.254");
        InetAddress nonCgnat = InetAddress.getByName("100.63.255.254");
        InetAddress privateWan = InetAddress.getByName("192.168.0.2");
        InetAddress publicExtA = InetAddress.getByName("111.8.3.99");
        InetAddress publicExtB = InetAddress.getByName("111.8.3.100");

        assertThat(PortForwardingService.isCgnatIpv4(cgnatStart)).isTrue();
        assertThat(PortForwardingService.isCgnatIpv4(cgnatEnd)).isTrue();
        assertThat(PortForwardingService.isCgnatIpv4(nonCgnat)).isFalse();

        assertThat(PortForwardingService.classifyRouterExternalIpv4(cgnatStart, publicExtA))
                .isEqualTo(PortForwardingService.ExternalIpClassification.CGNAT);
        assertThat(PortForwardingService.classifyRouterExternalIpv4(privateWan, publicExtA))
                .isEqualTo(PortForwardingService.ExternalIpClassification.PRIVATE_OR_DOUBLE_NAT);
        assertThat(PortForwardingService.classifyRouterExternalIpv4(publicExtA, publicExtB))
                .isEqualTo(PortForwardingService.ExternalIpClassification.DOUBLE_NAT_PUBLIC_MISMATCH);
        assertThat(PortForwardingService.classifyRouterExternalIpv4(publicExtA, publicExtA))
                .isEqualTo(PortForwardingService.ExternalIpClassification.TRUE_PUBLIC_IPV4);
        assertThat(PortForwardingService.classifyRouterExternalIpv4(null, publicExtA))
                .isEqualTo(PortForwardingService.ExternalIpClassification.NO_IPV4_MAPPING);
    }

    @Test
    void silentlyDegradesWhenDiscoveryOrMappingOrUnmapFails() throws Exception {
        InetAddress physIpv4 = InetAddress.getByName("192.168.1.50");
        PortForwardingService failingDiscovery = new PortForwardingService(
                nics -> {
                    throw new RuntimeException("UPnP socket blocked");
                },
                () -> Collections.singletonList(physIpv4),
                () -> null,
                300L,
                150L);

        assertThatCode(() -> {
            PortForwardingService.StartupSummary s = failingDiscovery.startAndMap();
            assertThat(s.getActiveIpv4Mappings()).isZero();
            failingDiscovery.shutdown();
        }).doesNotThrowAnyException();

        FakePortMapper brokenMapper = new FakePortMapper(physIpv4, InetAddress.getByName("100.64.1.2"), true, true);
        AtomicBoolean closed = new AtomicBoolean(false);
        PortForwardingService failingMap = new PortForwardingService(
                nics -> new PortForwardingService.DiscoverySession() {
                    @Override
                    public List<PortMapper> getMappers() {
                        return Collections.singletonList(brokenMapper);
                    }

                    @Override
                    public void close() {
                        closed.set(true);
                    }
                },
                () -> Collections.singletonList(physIpv4),
                () -> null,
                300L,
                150L);

        assertThatCode(() -> {
            PortForwardingService.StartupSummary s = failingMap.startAndMap();
            assertThat(s.getActiveIpv4Mappings()).isZero();
            failingMap.shutdown();
        }).doesNotThrowAnyException();
        assertThat(closed.get()).isTrue();
    }

    @Test
    void matchesIpv6AddressesIgnoringScopeIdAndParsesStunXorMappedAddress() throws Exception {
        InetAddress nicLinkLocal = InetAddress.getByName("fe80::1234:5678:9abc:def0");
        InetAddress mapperScopedLinkLocal = InetAddress.getByName("fe80::1234:5678:9abc:def0%12");
        FakePortMapper scopedMapper = new FakePortMapper(mapperScopedLinkLocal, null, false, false);

        assertThat(PortForwardingService.isMapperOnPhysicalNic(
                scopedMapper, Collections.singletonList(nicLinkLocal))).isTrue();
        assertThat(PortForwardingService.isIpv6Mapper(scopedMapper)).isTrue();

        // Build synthetic RFC 5389 Binding Success Response with XOR-MAPPED-ADDRESS = 111.8.3.99
        byte[] txId = new byte[] {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12};
        int cookie = 0x2112A442;
        byte[] expectedIp = new byte[] {111, 8, 3, 99};
        ByteBuffer resp = ByteBuffer.allocate(20 + 12);
        resp.putShort((short) 0x0101); // Binding Success
        resp.putShort((short) 12); // attr length (4 header + 8 value)
        resp.putInt(cookie);
        resp.put(txId);
        resp.putShort((short) 0x0020); // XOR-MAPPED-ADDRESS
        resp.putShort((short) 8);
        resp.put((byte) 0x00);
        resp.put((byte) 0x01); // IPv4
        resp.putShort((short) (50000 ^ (cookie >>> 16)));
        resp.put((byte) (expectedIp[0] ^ ((cookie >>> 24) & 0xFF)));
        resp.put((byte) (expectedIp[1] ^ ((cookie >>> 16) & 0xFF)));
        resp.put((byte) (expectedIp[2] ^ ((cookie >>> 8) & 0xFF)));
        resp.put((byte) (expectedIp[3] ^ (cookie & 0xFF)));

        InetAddress parsed = PortForwardingService.parseStunMappedIpv4(resp.array(), resp.capacity(), txId);
        assertThat(parsed).isNotNull();
        assertThat(parsed.getHostAddress()).isEqualTo("111.8.3.99");

        byte[] wrongTxId = new byte[12];
        assertThat(PortForwardingService.parseStunMappedIpv4(resp.array(), resp.capacity(), wrongTxId)).isNull();
    }

    @Test
    void closesDiscoverySessionImmediatelyWhenEmptyOrUnresponsiveAndFailsFastOnTimeout() throws Exception {
        InetAddress physIpv4 = InetAddress.getByName("192.168.1.50");
        AtomicBoolean emptySessionClosed = new AtomicBoolean(false);
        PortForwardingService emptySvc = new PortForwardingService(
                nics -> new PortForwardingService.DiscoverySession() {
                    @Override
                    public List<PortMapper> getMappers() {
                        return Collections.emptyList();
                    }

                    @Override
                    public void close() {
                        emptySessionClosed.set(true);
                    }
                },
                () -> Collections.singletonList(physIpv4),
                () -> null,
                300L,
                150L);
        emptySvc.startAndMap();
        assertThat(emptySessionClosed.get()).isTrue();
        emptySvc.shutdown();

        AtomicInteger mapCallCount = new AtomicInteger(0);
        AtomicBoolean unresponsiveSessionClosed = new AtomicBoolean(false);
        PortMapper timeoutMapper = new PortMapper() {
            @Override
            public MappedPort mapPort(PortType portType, int internalPort, int externalPort, long lifetime) {
                mapCallCount.incrementAndGet();
                throw new IllegalStateException("No response/invalid response to mapping port");
            }

            @Override
            public void unmapPort(MappedPort mappedPort) {}

            @Override
            public MappedPort refreshPort(MappedPort mappedPort, long lifetime) {
                return mappedPort;
            }

            @Override
            public InetAddress getSourceAddress() {
                return physIpv4;
            }
        };
        PortForwardingService failFastSvc = new PortForwardingService(
                nics -> new PortForwardingService.DiscoverySession() {
                    @Override
                    public List<PortMapper> getMappers() {
                        return Collections.singletonList(timeoutMapper);
                    }

                    @Override
                    public void close() {
                        unresponsiveSessionClosed.set(true);
                    }
                },
                () -> Collections.singletonList(physIpv4),
                () -> null,
                300L,
                150L);
        failFastSvc.startAndMap();
        assertThat(mapCallCount.get()).isEqualTo(1);
        assertThat(unresponsiveSessionClosed.get()).isTrue();
        failFastSvc.shutdown();
    }

    @Test
    void parsesWindowsRoutePrintAndUpnpIgdXmlExcludingClashTun() throws Exception {
        InetAddress physIpv4 = InetAddress.getByName("192.168.1.10");
        String route4 = """
                          0.0.0.0          0.0.0.0      192.168.1.1     192.168.1.10     35
                          0.0.0.0          0.0.0.0       198.18.0.2       198.18.0.1      0
                """;
        List<PortForwardingService.PhysicalGatewayEndpoint> gws =
                PortForwardingService.parseWindowsRoutePrint4(route4, Collections.singletonList(physIpv4));
        assertThat(gws).hasSize(1);
        assertThat(gws.get(0).localAddress.getHostAddress()).isEqualTo("192.168.1.10");
        assertThat(gws.get(0).gatewayAddress.getHostAddress()).isEqualTo("192.168.1.1");

        String igdXml = """
                <root xmlns="urn:schemas-upnp-org:device-1-0">
                  <device>
                    <serviceList>
                      <service>
                        <serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType>
                        <controlURL>/ctl/IPConn</controlURL>
                      </service>
                      <service>
                        <serviceType>urn:schemas-upnp-org:service:WANIPv6FirewallControl:1</serviceType>
                        <controlURL>/ctl/IPv6Fw</controlURL>
                      </service>
                    </serviceList>
                  </device>
                </root>
                """;
        NetworkGateway gw = NetworkGateway.create();
        try {
            // IPv4 LOCATION + IPv4 sourceAddress: must map WANIPConnection:2 and skip WANIPv6FirewallControl:1
            // (FirewallUpnpIgdPortMapper uses sourceAddress for both TCP connect and AddPinhole InternalClient)
            List<PortMapper> parsedV4 = PortForwardingService.parseUpnpIgdServicesFromXml(
                    gw.getBus(),
                    physIpv4,
                    "http://192.168.1.1:1900/rootDesc.xml",
                    "TestRouter/1.0",
                    igdXml,
                    false);
            assertThat(parsedV4).hasSize(1);
            assertThat(parsedV4.get(0)).isInstanceOf(PortMapperUpnpIgdPortMapper.class);

            // IPv6 LOCATION + multiple NIC GUA IPv6s: must instantiate FirewallUpnpIgdPortMapper for each GUA IPv6
            InetAddress gua1 = InetAddress.getByName("2409:8a00:1234:5678::10");
            InetAddress gua2 = InetAddress.getByName("2409:8a00:1234:5678::20");
            List<PortMapper> parsedV6 = PortForwardingService.parseUpnpIgdServicesFromXml(
                    gw.getBus(),
                    gua1,
                    Arrays.asList(gua1, gua2),
                    "http://[fe80::1]:1900/rootDesc.xml",
                    "TestRouter/1.0",
                    igdXml,
                    false);
            assertThat(parsedV6).hasSize(2);
            assertThat(parsedV6).allSatisfy(m -> assertThat(m).isInstanceOf(FirewallUpnpIgdPortMapper.class));
            assertThat(parsedV6.stream().map(m -> m.getSourceAddress().getHostAddress()))
                    .containsExactlyInAnyOrder(gua1.getHostAddress(), gua2.getHostAddress());
        } finally {
            gw.getBus().send(new KillNetworkRequest());
            gw.join();
        }
    }

    @Test
    void failsFastOnNullMessageIllegalStateExceptionAndCapsShutdownUnmapTime() throws Exception {
        InetAddress physIpv4 = InetAddress.getByName("192.168.1.50");
        AtomicInteger nullMsgCalls = new AtomicInteger(0);
        PortMapper nullMsgTimeoutMapper = new PortMapper() {
            @Override
            public MappedPort mapPort(PortType portType, int internalPort, int externalPort, long lifetime) {
                nullMsgCalls.incrementAndGet();
                throw new IllegalStateException(); // FirewallUpnpIgdPortMapper throws null-message IllegalStateException
            }

            @Override
            public void unmapPort(MappedPort mappedPort) {}

            @Override
            public MappedPort refreshPort(MappedPort mappedPort, long lifetime) {
                return mappedPort;
            }

            @Override
            public InetAddress getSourceAddress() {
                return physIpv4;
            }
        };

        PortForwardingService failFastSvc = new PortForwardingService(
                nics -> new PortForwardingService.DiscoverySession() {
                    @Override
                    public List<PortMapper> getMappers() {
                        return Collections.singletonList(nullMsgTimeoutMapper);
                    }

                    @Override
                    public void close() {}
                },
                () -> Collections.singletonList(physIpv4),
                () -> null,
                300L,
                150L);
        PortForwardingService.StartupSummary s = failFastSvc.startAndMap();
        assertThat(nullMsgCalls.get()).isEqualTo(1);
        assertThat(s.getActiveIpv4Mappings()).isZero();
        failFastSvc.shutdown();

        // Bounded shutdown unmap when unmapPort hangs
        PortMapper hangingUnmapMapper = new PortMapper() {
            @Override
            public MappedPort mapPort(PortType portType, int internalPort, int externalPort, long lifetime) {
                return new FakeMappedPort(internalPort, externalPort, physIpv4, portType, lifetime);
            }

            @Override
            public void unmapPort(MappedPort mappedPort) throws InterruptedException {
                Thread.sleep(5000);
            }

            @Override
            public MappedPort refreshPort(MappedPort mappedPort, long lifetime) {
                return mappedPort;
            }

            @Override
            public InetAddress getSourceAddress() {
                return physIpv4;
            }
        };
        PortForwardingService boundedShutdownSvc = new PortForwardingService(
                nics -> new PortForwardingService.DiscoverySession() {
                    @Override
                    public List<PortMapper> getMappers() {
                        return Collections.singletonList(hangingUnmapMapper);
                    }

                    @Override
                    public void close() {}
                },
                () -> Collections.singletonList(physIpv4),
                () -> null,
                300L,
                150L,
                5000L,
                250L);
        boundedShutdownSvc.startAndMap();
        long t0 = System.currentTimeMillis();
        boundedShutdownSvc.shutdown();
        long elapsed = System.currentTimeMillis() - t0;
        assertThat(elapsed).isLessThan(2000L);
    }

    @Test
    void decodesChineseWindowsConsoleCharsetForRoutePrintAndWidensJcefUdpPortRange() throws Exception {
        assertThat(PortForwardingService.JCEF_WEBRTC_UDP_PORT_END - PortForwardingService.JCEF_WEBRTC_UDP_PORT_START + 1)
                .isGreaterThanOrEqualTo(100);
        assertThat(PortForwardingService.JCEF_WEBRTC_UDP_PORT_RANGE).isEqualTo("50000-50099");

        String sampleRoute6 = "  14    281 ::/0                     在链路上\r\n"
                + "  14    281 ::/0                     FE80::1\r\n";
        String os = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT);
        if (os.contains("win")) {
            java.nio.charset.Charset primary = NetworkUtil.resolveWindowsConsoleCharsets().get(0);
            byte[] encoded = sampleRoute6.getBytes(primary);
            String decoded = PortForwardingService.decodeWindowsConsoleOutput(encoded);
            assertThat(decoded).contains("在链路上");
            assertThat(decoded).contains("FE80::1");
        }

        // Case-insensitive FE80: gateway check must not fail on uppercase FE80::1
        List<PortForwardingService.PhysicalGatewayEndpoint> emptyNics =
                PortForwardingService.parseWindowsRoutePrint6(sampleRoute6, Collections.emptyList());
        assertThat(emptyNics).isEmpty();
    }

    @Test
    void failsFastOnNatPmpInvalidResponseAndRejectsIpv6ControlUrlForWanIpConnection() throws Exception {
        InetAddress physIpv4 = InetAddress.getByName("192.168.1.50");
        InetAddress gua1 = InetAddress.getByName("2409:8a00:1234::10");
        InetAddress gua2 = InetAddress.getByName("2409:8a00:1234::20");

        // 1) NatPmp/Pcp "No response/invalid response" IllegalStateException must fail fast on 1st attempt
        AtomicInteger natPmpCalls = new AtomicInteger();
        PortMapper natPmpFailMapper = new PortMapper() {
            @Override
            public MappedPort mapPort(PortType portType, int internalPort, int externalPort, long lifetime) {
                natPmpCalls.incrementAndGet();
                throw new IllegalStateException("No response/invalid response to external address request");
            }

            @Override
            public void unmapPort(MappedPort mappedPort) {}

            @Override
            public MappedPort refreshPort(MappedPort mappedPort, long lifetime) {
                return mappedPort;
            }

            @Override
            public InetAddress getSourceAddress() {
                return physIpv4;
            }
        };
        PortForwardingService svc = new PortForwardingService(
                nics -> new PortForwardingService.DiscoverySession() {
                    @Override
                    public List<PortMapper> getMappers() {
                        return Collections.singletonList(natPmpFailMapper);
                    }

                    @Override
                    public void close() {}
                },
                () -> Collections.singletonList(physIpv4),
                () -> null,
                300L,
                150L);
        PortForwardingService.StartupSummary summary = svc.startAndMap();
        assertThat(natPmpCalls.get()).isEqualTo(1);
        assertThat(summary.getActiveIpv4Mappings()).isZero();
        svc.shutdown();

        // 2) WANIPConnection:2 with IPv6 controlURL or Inet6Address source must NEVER produce an IPv4 mapper,
        //    whereas WANIPv6FirewallControl:1 with IPv6 controlURL accepts multiple GUA IPv6 addresses.
        String dualXml = "<?xml version=\"1.0\"?>\n"
                + "<root xmlns=\"urn:schemas-upnp-org:device-1-0\">\n"
                + "  <device>\n"
                + "    <serviceList>\n"
                + "      <service>\n"
                + "        <serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType>\n"
                + "        <controlURL>http://[fe80::1]:1900/upnp/control/WANIPConn2</controlURL>\n"
                + "      </service>\n"
                + "      <service>\n"
                + "        <serviceType>urn:schemas-upnp-org:service:WANIPv6FirewallControl:1</serviceType>\n"
                + "        <controlURL>http://[fe80::1]:1900/upnp/control/WANIPv6Fw1</controlURL>\n"
                + "      </service>\n"
                + "    </serviceList>\n"
                + "  </device>\n"
                + "</root>";

        NetworkGateway gw = NetworkGateway.create();
        try {
            List<PortMapper> ipv6SourceMappers = PortForwardingService.parseUpnpIgdServicesFromXml(
                    gw.getBus(),
                    gua1,
                    Arrays.asList(gua1, gua2),
                    "http://[fe80::1]:1900/rootDesc.xml",
                    "TestRouter/1.0",
                    dualXml,
                    false);
            assertThat(ipv6SourceMappers).hasSize(2);
            assertThat(ipv6SourceMappers).allSatisfy(m -> assertThat(m).isInstanceOf(FirewallUpnpIgdPortMapper.class));
            assertThat(ipv6SourceMappers.get(1).getSourceAddress()).isEqualTo(gua2);

            // Even when SSDP sourceAddress is IPv4, WANIPConnection:2 with IPv6 controlURL is rejected,
            // while IPv6-reachable WANIPv6FirewallControl:1 still binds physical NIC GUA IPv6 addresses (never IPv4).
            List<PortMapper> ipv4SourceIpv6ControlMappers = PortForwardingService.parseUpnpIgdServicesFromXml(
                    gw.getBus(),
                    physIpv4,
                    Arrays.asList(gua1, gua2),
                    "http://[fe80::1]:1900/rootDesc.xml",
                    "TestRouter/1.0",
                    dualXml,
                    false);
            assertThat(ipv4SourceIpv6ControlMappers).hasSize(2);
            assertThat(ipv4SourceIpv6ControlMappers).allSatisfy(m -> assertThat(m).isInstanceOf(FirewallUpnpIgdPortMapper.class));

            // And with NO physical GUA IPv6 addresses on the NIC, IPv4 source must produce ZERO mappers (neither IPv4 PortMapper nor FirewallUpnpIgdPortMapper).
            List<PortMapper> ipv4OnlyMappers = PortForwardingService.parseUpnpIgdServicesFromXml(
                    gw.getBus(),
                    physIpv4,
                    Collections.emptyList(),
                    "http://[fe80::1]:1900/rootDesc.xml",
                    "TestRouter/1.0",
                    dualXml,
                    false);
            assertThat(ipv4OnlyMappers).isEmpty();
        } finally {
            gw.getBus().send(new KillNetworkRequest());
            gw.join();
        }
    }

    @Test
    void failsFastOnPartialTimeoutAfterEarlierPortSuccessAndFallsBackToGbkOnReplacementChar() throws Exception {
        InetAddress physIpv4 = InetAddress.getByName("192.168.1.50");
        AtomicInteger callCount = new AtomicInteger(0);
        PortMapper partialTimeoutMapper = new PortMapper() {
            @Override
            public MappedPort mapPort(PortType portType, int internalPort, int externalPort, long lifetime) {
                if (callCount.incrementAndGet() == 1) {
                    return new FakeMappedPort(internalPort, externalPort, physIpv4, portType, lifetime);
                }
                throw new IllegalStateException(); // timeout on 2nd port must break out immediately
            }

            @Override
            public void unmapPort(MappedPort mappedPort) {}

            @Override
            public MappedPort refreshPort(MappedPort mappedPort, long lifetime) {
                return mappedPort;
            }

            @Override
            public InetAddress getSourceAddress() {
                return physIpv4;
            }
        };

        PortForwardingService svc = new PortForwardingService(
                nics -> new PortForwardingService.DiscoverySession() {
                    @Override
                    public List<PortMapper> getMappers() {
                        return Collections.singletonList(partialTimeoutMapper);
                    }

                    @Override
                    public void close() {}
                },
                () -> Collections.singletonList(physIpv4),
                () -> null,
                300L,
                150L);
        PortForwardingService.StartupSummary summary = svc.startAndMap();
        assertThat(callCount.get()).isEqualTo(2);
        assertThat(summary.getActiveIpv4Mappings()).isEqualTo(1);
        svc.shutdown();

        String os = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT);
        if (os.contains("win")) {
            String prevStdoutEnc = System.getProperty("sun.stdout.encoding");
            try {
                System.setProperty("sun.stdout.encoding", "UTF-8");
                byte[] gbkBytes = "  14    281 ::/0                     在链路上\r\n".getBytes("GBK");
                String decoded = PortForwardingService.decodeWindowsConsoleOutput(gbkBytes);
                assertThat(decoded).contains("在链路上");
            } finally {
                if (prevStdoutEnc == null) {
                    System.clearProperty("sun.stdout.encoding");
                } else {
                    System.setProperty("sun.stdout.encoding", prevStdoutEnc);
                }
            }
        }
    }

    @Test
    void shutdownSerializesUnmapPerMapperInstanceWhileRunningDistinctMappersInParallel() throws Exception {
        InetAddress physIpv4 = InetAddress.getByName("192.168.1.50");
        InetAddress physIpv6 = InetAddress.getByName("2409:8a00:1234:5678::50");
        InetAddress publicIpv4 = InetAddress.getByName("111.8.3.99");

        CountDownLatch parallelEntryLatch = new CountDownLatch(2);
        AtomicBoolean parallelBarrierMet = new AtomicBoolean(false);

        final class ConcurrencyTrackingPortMapper implements PortMapper {
            private final InetAddress sourceAddress;
            private final InetAddress externalAddress;
            final AtomicInteger activeUnmaps = new AtomicInteger(0);
            final AtomicInteger maxConcurrentUnmaps = new AtomicInteger(0);
            final List<Integer> unmappedPorts = new CopyOnWriteArrayList<>();
            final AtomicBoolean enteredFirstUnmap = new AtomicBoolean(false);

            ConcurrencyTrackingPortMapper(InetAddress sourceAddress, InetAddress externalAddress) {
                this.sourceAddress = sourceAddress;
                this.externalAddress = externalAddress;
            }

            @Override
            public MappedPort mapPort(PortType portType, int internalPort, int externalPort, long lifetime) {
                return new FakeMappedPort(internalPort, externalPort, externalAddress, portType, lifetime);
            }

            @Override
            public void unmapPort(MappedPort mappedPort) throws InterruptedException {
                int current = activeUnmaps.incrementAndGet();
                maxConcurrentUnmaps.accumulateAndGet(current, Math::max);
                try {
                    if (enteredFirstUnmap.compareAndSet(false, true)) {
                        parallelEntryLatch.countDown();
                        if (parallelEntryLatch.await(2, TimeUnit.SECONDS)) {
                            parallelBarrierMet.set(true);
                        }
                    } else {
                        Thread.sleep(2L);
                    }
                    unmappedPorts.add(mappedPort.getInternalPort());
                } finally {
                    activeUnmaps.decrementAndGet();
                }
            }

            @Override
            public MappedPort refreshPort(MappedPort mappedPort, long lifetime) {
                return mappedPort;
            }

            @Override
            public InetAddress getSourceAddress() {
                return sourceAddress;
            }
        }

        ConcurrencyTrackingPortMapper mapperA = new ConcurrencyTrackingPortMapper(physIpv4, publicIpv4);
        ConcurrencyTrackingPortMapper mapperB = new ConcurrencyTrackingPortMapper(physIpv6, physIpv6);

        PortForwardingService service = new PortForwardingService(
                nics -> new PortForwardingService.DiscoverySession() {
                    @Override
                    public List<PortMapper> getMappers() {
                        return Arrays.asList(mapperA, mapperB);
                    }

                    @Override
                    public void close() {}
                },
                () -> Arrays.asList(physIpv4, physIpv6),
                () -> publicIpv4,
                300L,
                150L,
                5000L,
                4000L);

        PortForwardingService.StartupSummary summary = service.startAndMap();
        assertThat(summary.getActiveIpv4Mappings()).isEqualTo(10);
        assertThat(summary.getActiveIpv6Pinholes()).isEqualTo(10);

        service.shutdown();

        assertThat(parallelBarrierMet.get()).isTrue();
        assertThat(mapperA.maxConcurrentUnmaps.get()).isEqualTo(1);
        assertThat(mapperB.maxConcurrentUnmaps.get()).isEqualTo(1);
        assertThat(mapperA.unmappedPorts).containsExactly(
                50000, 50001, 50002, 50003, 50004, 50005, 50006, 50007, 50008, 50009);
        assertThat(mapperB.unmappedPorts).containsExactly(
                50000, 50001, 50002, 50003, 50004, 50005, 50006, 50007, 50008, 50009);
        assertThat(service.getActiveMappings()).isEmpty();
    }
}
