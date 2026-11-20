package com.bear27570.app.util;

import com.offbynull.portmapper.gateway.Bus;
import com.offbynull.portmapper.gateway.Gateway;
import com.offbynull.portmapper.gateways.network.NetworkGateway;
import com.offbynull.portmapper.gateways.network.internalmessages.KillNetworkRequest;
import com.offbynull.portmapper.mapper.MappedPort;
import com.offbynull.portmapper.mapper.PortMapper;
import com.offbynull.portmapper.mapper.PortType;
import com.offbynull.portmapper.mappers.natpmp.NatPmpPortMapper;
import com.offbynull.portmapper.mappers.pcp.PcpPortMapper;
import com.offbynull.portmapper.mappers.upnpigd.FirewallUpnpIgdPortMapper;
import com.offbynull.portmapper.mappers.upnpigd.PortMapperUpnpIgdPortMapper;
import org.apache.commons.lang3.Range;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Enumeration;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Automatic router port-opening service (UPnP IGDv1/v2 including WANIPv6FirewallControl:1,
 * NAT-PMP, and PCP) scoped strictly to real physical NICs and the narrow WebRTC UDP port range.
 *
 * <p>Safety invariants:
 * <ul>
 *   <li>Only maps/pinholes UDP {@link #WEBRTC_UDP_PORT_START}..{@link #WEBRTC_UDP_PORT_END}.</li>
 *   <li>Never modifies Windows OS firewall, registry, or Clash/TUN routing tables.</li>
 *   <li>Enforces short lease ({@code <= 600s}) with periodic renewal and explicit unmap on {@link #shutdown()}.</li>
 *   <li>Silently degrades when unsupported, CGNAT-blocked, or offline without impacting app startup.</li>
 * </ul>
 */
public final class PortForwardingService implements AutoCloseable {

    private static final Logger logger = LoggerFactory.getLogger(PortForwardingService.class);

    public static final int WEBRTC_UDP_PORT_START = 50000;
    public static final int WEBRTC_UDP_PORT_END = 50009;
    public static final String WEBRTC_UDP_PORT_RANGE = WEBRTC_UDP_PORT_START + "-" + WEBRTC_UDP_PORT_END;

    public static final int JCEF_WEBRTC_UDP_PORT_START = 50000;
    public static final int JCEF_WEBRTC_UDP_PORT_END = 50099;
    public static final String JCEF_WEBRTC_UDP_PORT_RANGE = JCEF_WEBRTC_UDP_PORT_START + "-" + JCEF_WEBRTC_UDP_PORT_END;

    public static final long DEFAULT_LEASE_SECONDS = 300L;
    public static final long MAX_LEASE_SECONDS = 600L;
    public static final long DEFAULT_RENEW_INTERVAL_SECONDS = 150L;
    static final long DEFAULT_STARTUP_BUDGET_MS = 12_000L;
    static final long DEFAULT_SHUTDOWN_UNMAP_TIMEOUT_MS = 2_500L;

    public static final String DEFAULT_STUN_HOST = "111.8.3.78";
    public static final int DEFAULT_STUN_PORT = 3478;
    private static final int STUN_TIMEOUT_MS = 2500;
    private static final int STUN_MAGIC_COOKIE = 0x2112A442;
    private static final long GATEWAY_JOIN_TIMEOUT_MS = 2000L;

    public enum ExternalIpClassification {
        TRUE_PUBLIC_IPV4,
        DOUBLE_NAT_PUBLIC_MISMATCH,
        CGNAT,
        PRIVATE_OR_DOUBLE_NAT,
        NO_IPV4_MAPPING
    }

    public interface DiscoverySession extends AutoCloseable {
        List<PortMapper> getMappers();

        @Override
        void close();
    }

    @FunctionalInterface
    public interface PortMapperDiscovery {
        DiscoverySession discover(List<InetAddress> physicalNicAddresses) throws Exception;
    }

    public static final class ActiveMapping {
        private final PortMapper mapper;
        private volatile MappedPort mappedPort;
        private final boolean ipv6Pinhole;

        ActiveMapping(PortMapper mapper, MappedPort mappedPort, boolean ipv6Pinhole) {
            this.mapper = mapper;
            this.mappedPort = mappedPort;
            this.ipv6Pinhole = ipv6Pinhole;
        }

        public PortMapper getMapper() {
            return mapper;
        }

        public MappedPort getMappedPort() {
            return mappedPort;
        }

        void setMappedPort(MappedPort mappedPort) {
            this.mappedPort = mappedPort;
        }

        public boolean isIpv6Pinhole() {
            return ipv6Pinhole;
        }
    }

    public static final class StartupSummary {
        private final int discoveredMapperCount;
        private final int filteredOutMapperCount;
        private final int activeIpv4Mappings;
        private final int activeIpv6Pinholes;
        private final InetAddress routerExternalIpv4;
        private final InetAddress stunSrflxIpv4;
        private final ExternalIpClassification ipv4Classification;

        StartupSummary(
                int discoveredMapperCount,
                int filteredOutMapperCount,
                int activeIpv4Mappings,
                int activeIpv6Pinholes,
                InetAddress routerExternalIpv4,
                InetAddress stunSrflxIpv4,
                ExternalIpClassification ipv4Classification) {
            this.discoveredMapperCount = discoveredMapperCount;
            this.filteredOutMapperCount = filteredOutMapperCount;
            this.activeIpv4Mappings = activeIpv4Mappings;
            this.activeIpv6Pinholes = activeIpv6Pinholes;
            this.routerExternalIpv4 = routerExternalIpv4;
            this.stunSrflxIpv4 = stunSrflxIpv4;
            this.ipv4Classification = ipv4Classification;
        }

        public int getDiscoveredMapperCount() {
            return discoveredMapperCount;
        }

        public int getFilteredOutMapperCount() {
            return filteredOutMapperCount;
        }

        public int getActiveIpv4Mappings() {
            return activeIpv4Mappings;
        }

        public int getActiveIpv6Pinholes() {
            return activeIpv6Pinholes;
        }

        public InetAddress getRouterExternalIpv4() {
            return routerExternalIpv4;
        }

        public InetAddress getStunSrflxIpv4() {
            return stunSrflxIpv4;
        }

        public ExternalIpClassification getIpv4Classification() {
            return ipv4Classification;
        }
    }

    private final PortMapperDiscovery discovery;
    private final Supplier<List<InetAddress>> physicalNicSupplier;
    private final Supplier<InetAddress> stunIpv4Probe;
    private final long leaseSeconds;
    private final long renewIntervalSeconds;
    private final long startupBudgetMs;
    private final long shutdownUnmapTimeoutMs;

    private final AtomicBoolean started = new AtomicBoolean(false);
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final Object lifecycleLock = new Object();
    private final List<ActiveMapping> activeMappings = new CopyOnWriteArrayList<>();

    private volatile DiscoverySession activeSession;
    private volatile ScheduledExecutorService renewalScheduler;
    private volatile StartupSummary lastSummary;

    public PortForwardingService() {
        this(
                PortForwardingService::defaultDiscover,
                PortForwardingService::collectPhysicalNicAddresses,
                null,
                DEFAULT_LEASE_SECONDS,
                DEFAULT_RENEW_INTERVAL_SECONDS
        );
    }

    /**
     * Injectable constructor for deterministic unit testing.
     */
    public PortForwardingService(
            PortMapperDiscovery discovery,
            Supplier<List<InetAddress>> physicalNicSupplier,
            Supplier<InetAddress> stunIpv4Probe,
            long leaseSeconds,
            long renewIntervalSeconds) {
        this(
                discovery,
                physicalNicSupplier,
                stunIpv4Probe,
                leaseSeconds,
                renewIntervalSeconds,
                DEFAULT_STARTUP_BUDGET_MS,
                DEFAULT_SHUTDOWN_UNMAP_TIMEOUT_MS
        );
    }

    PortForwardingService(
            PortMapperDiscovery discovery,
            Supplier<List<InetAddress>> physicalNicSupplier,
            Supplier<InetAddress> stunIpv4Probe,
            long leaseSeconds,
            long renewIntervalSeconds,
            long startupBudgetMs,
            long shutdownUnmapTimeoutMs) {
        this.discovery = discovery;
        this.physicalNicSupplier = physicalNicSupplier;
        this.stunIpv4Probe = stunIpv4Probe;
        this.leaseSeconds = Math.max(60L, Math.min(leaseSeconds, MAX_LEASE_SECONDS));
        this.renewIntervalSeconds = Math.max(1L, renewIntervalSeconds);
        this.startupBudgetMs = Math.max(100L, startupBudgetMs);
        this.shutdownUnmapTimeoutMs = Math.max(100L, shutdownUnmapTimeoutMs);
    }

    /**
     * Starts router port mapping on a background daemon thread so application boot never blocks.
     */
    public void startAsync() {
        if (!started.compareAndSet(false, true)) {
            return;
        }
        Thread thread = new Thread(this::safeStartAndMap, "webrtc-port-mapper-init");
        thread.setDaemon(true);
        thread.start();
    }

    /**
     * Synchronous entry point (also used by tests and CLI diagnostics). Never throws.
     */
    public StartupSummary startAndMap() {
        started.set(true);
        return safeStartAndMap();
    }

    private StartupSummary safeStartAndMap() {
        if (closed.get()) {
            return emptySummary();
        }
        try {
            List<InetAddress> physicalNics = safeCollectPhysicalNics();
            logger.info("[PortForwarding] Physical NIC candidates (virtual/TUN excluded): {}",
                    formatAddresses(physicalNics));
            if (physicalNics.isEmpty()) {
                logger.info("[PortForwarding] No eligible physical NIC addresses found; skipping router port mapping.");
                return recordSummary(emptySummary());
            }

            DiscoverySession session = discovery.discover(physicalNics);
            synchronized (lifecycleLock) {
                if (closed.get()) {
                    safeCloseSession(session);
                    return emptySummary();
                }
                this.activeSession = session;
            }

            List<PortMapper> allMappers = session != null && session.getMappers() != null
                    ? session.getMappers()
                    : Collections.emptyList();
            if (allMappers.isEmpty()) {
                closeAndClearActiveSession(session);
                InetAddress stunSrflx = probePhysicalStunIpv4(physicalNics);
                logger.info("[PortForwarding] No UPnP IGD / NAT-PMP / PCP gateway discovered (physicalStunSrflx={}); silently degrading to P2P/VirtualDC.",
                        stunSrflx != null ? stunSrflx.getHostAddress() : "unavailable");
                return recordSummary(new StartupSummary(
                        0, 0, 0, 0, null, stunSrflx, ExternalIpClassification.NO_IPV4_MAPPING));
            }

            List<PortMapper> physicalMappers = new ArrayList<>();
            int filteredOutCount = 0;
            for (PortMapper mapper : allMappers) {
                if (mapper == null) {
                    continue;
                }
                if (isMapperOnPhysicalNic(mapper, physicalNics)) {
                    physicalMappers.add(mapper);
                } else {
                    filteredOutCount++;
                    logger.info("[PortForwarding] Filtered out non-physical mapper {} (source={})",
                            mapper.getClass().getSimpleName(),
                            mapper.getSourceAddress() != null ? mapper.getSourceAddress().getHostAddress() : "null");
                }
            }

            final long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(startupBudgetMs);
            int ipv4MappedCount = 0;
            int ipv6PinholeCount = 0;
            InetAddress routerExternalIpv4 = null;

            for (PortMapper mapper : physicalMappers) {
                if (closed.get() || System.nanoTime() >= deadlineNanos) {
                    if (!closed.get()) {
                        logger.info("[PortForwarding] Startup mapping budget ({}ms) reached; continuing gracefully.",
                                startupBudgetMs);
                    }
                    break;
                }
                if (mapper instanceof FirewallUpnpIgdPortMapper && !(mapper.getSourceAddress() instanceof Inet6Address)) {
                    logger.info("[PortForwarding] Skipping FirewallUpnpIgdPortMapper with non-IPv6 sourceAddress={}; AddPinhole requires IPv6.",
                            mapper.getSourceAddress() != null ? mapper.getSourceAddress().getHostAddress() : "null");
                    continue;
                }
                boolean isIpv6 = isIpv6Mapper(mapper);
                String protoName = mapper.getClass().getSimpleName();
                String sourceIp = mapper.getSourceAddress() != null
                        ? mapper.getSourceAddress().getHostAddress()
                        : "unknown";
                int mapperSuccess = 0;
                int mapperFailed = 0;
                InetAddress sampleExtAddr = null;
                long sampleLifetime = -1L;

                for (int port = WEBRTC_UDP_PORT_START; port <= WEBRTC_UDP_PORT_END; port++) {
                    if (closed.get() || System.nanoTime() >= deadlineNanos) {
                        break;
                    }
                    try {
                        MappedPort mapped = mapper.mapPort(PortType.UDP, port, port, leaseSeconds);
                        if (mapped == null) {
                            mapperFailed++;
                            continue;
                        }
                        if (!registerOrImmediatelyUnmap(mapper, mapped, isIpv6)) {
                            break;
                        }
                        mapperSuccess++;
                        if (sampleExtAddr == null && mapped.getExternalAddress() != null) {
                            sampleExtAddr = mapped.getExternalAddress();
                        }
                        if (sampleLifetime < 0) {
                            sampleLifetime = mapped.getLifetime();
                        }
                        if (!isIpv6 && routerExternalIpv4 == null
                                && mapped.getExternalAddress() instanceof Inet4Address) {
                            routerExternalIpv4 = mapped.getExternalAddress();
                        }
                        if (isIpv6) {
                            ipv6PinholeCount++;
                        } else {
                            ipv4MappedCount++;
                        }
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        mapperFailed++;
                        break;
                    } catch (Throwable t) {
                        mapperFailed++;
                        String errMsg = t.getMessage() != null ? t.getMessage() : "";
                        logger.debug("[PortForwarding] {} ({}) port {}/UDP failed: {} ({})",
                                protoName, isIpv6 ? "IPv6-Pinhole" : "IPv4-Map", port,
                                t.getClass().getSimpleName(), errMsg);
                        if (isUnresponsiveGatewayError(t, errMsg)) {
                            logger.debug("[PortForwarding] {} ({}) unresponsive on port {}; skipping remaining ports.",
                                    protoName, sourceIp, port);
                            break;
                        }
                    }
                }

                logger.info(
                        "[PortForwarding] {} [{}] src={} range={}/UDP -> mapped={}/{} extAddr={} lease={}s (requested={}s)",
                        isIpv6 ? "IPv6 Pinhole" : "IPv4 PortMap",
                        protoName,
                        sourceIp,
                        WEBRTC_UDP_PORT_RANGE,
                        mapperSuccess,
                        (WEBRTC_UDP_PORT_END - WEBRTC_UDP_PORT_START + 1),
                        sampleExtAddr != null ? sampleExtAddr.getHostAddress() : "n/a",
                        sampleLifetime,
                        leaseSeconds);
                if (mapperFailed > 0 && mapperSuccess == 0) {
                    logger.info("[PortForwarding] {} ({}) did not accept any UDP port in {}; continuing gracefully.",
                            protoName, sourceIp, WEBRTC_UDP_PORT_RANGE);
                }
            }

            InetAddress stunSrflxIpv4 = probePhysicalStunIpv4(physicalNics);
            ExternalIpClassification classification = classifyRouterExternalIpv4(routerExternalIpv4, stunSrflxIpv4);
            logExternalIpv4Verdict(classification, routerExternalIpv4, stunSrflxIpv4, ipv6PinholeCount);

            if (!activeMappings.isEmpty() && !closed.get()) {
                startRenewalScheduler();
            } else {
                closeAndClearActiveSession(session);
            }

            return recordSummary(new StartupSummary(
                    allMappers.size(),
                    filteredOutCount,
                    ipv4MappedCount,
                    ipv6PinholeCount,
                    routerExternalIpv4,
                    stunSrflxIpv4,
                    classification));
        } catch (Throwable t) {
            logger.info("[PortForwarding] Port mapping discovery unavailable ({}); degrading silently.",
                    t.toString());
            return recordSummary(emptySummary());
        }
    }

    private boolean registerOrImmediatelyUnmap(PortMapper mapper, MappedPort mapped, boolean isIpv6) {
        synchronized (lifecycleLock) {
            if (closed.get()) {
                safeUnmap(mapper, mapped);
                return false;
            }
            activeMappings.add(new ActiveMapping(mapper, mapped, isIpv6));
            return true;
        }
    }

    private void startRenewalScheduler() {
        synchronized (lifecycleLock) {
            if (closed.get() || renewalScheduler != null) {
                return;
            }
            ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "webrtc-port-mapper-renew");
                t.setDaemon(true);
                return t;
            });
            scheduler.scheduleAtFixedRate(
                    this::renewActiveMappings,
                    renewIntervalSeconds,
                    renewIntervalSeconds,
                    TimeUnit.SECONDS);
            this.renewalScheduler = scheduler;
            logger.info("[PortForwarding] Scheduled lease renewal every {}s (lease={}s, activeMappings={}).",
                    renewIntervalSeconds, leaseSeconds, activeMappings.size());
        }
    }

    /**
     * Renews all active port mappings/pinholes using {@link PortMapper#refreshPort(MappedPort, long)}.
     * Package-private so tests can also verify renewal deterministically.
     */
    void renewActiveMappings() {
        if (closed.get() || activeMappings.isEmpty()) {
            return;
        }
        int renewed = 0;
        for (ActiveMapping entry : activeMappings) {
            if (closed.get()) {
                return;
            }
            try {
                MappedPort refreshed = entry.getMapper().refreshPort(entry.getMappedPort(), leaseSeconds);
                if (refreshed != null) {
                    entry.setMappedPort(refreshed);
                    renewed++;
                }
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return;
            } catch (Throwable t) {
                logger.debug("[PortForwarding] refreshPort failed for port {}: {}",
                        entry.getMappedPort().getInternalPort(), t.getMessage());
            }
        }
        logger.debug("[PortForwarding] Renewed {}/{} active port mappings.", renewed, activeMappings.size());
    }

    /**
     * Idempotently cancels lease renewal, explicitly unmaps every active mapping/pinhole,
     * and shuts down gateway threads cleanly.
     */
    public void shutdown() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        ScheduledExecutorService schedulerSnapshot;
        DiscoverySession sessionSnapshot;
        List<ActiveMapping> mappingsSnapshot;
        synchronized (lifecycleLock) {
            schedulerSnapshot = this.renewalScheduler;
            this.renewalScheduler = null;
            sessionSnapshot = this.activeSession;
            this.activeSession = null;
            mappingsSnapshot = new ArrayList<>(this.activeMappings);
            this.activeMappings.clear();
        }

        if (schedulerSnapshot != null) {
            schedulerSnapshot.shutdownNow();
        }

        final AtomicInteger unmappedCount = new AtomicInteger(0);

        if (!mappingsSnapshot.isEmpty()) {
            // Serialize unmapPort() per PortMapper instance while allowing distinct mappers to unmap in parallel.
            Map<PortMapper, List<ActiveMapping>> mappingsByMapper = new IdentityHashMap<>();
            for (ActiveMapping entry : mappingsSnapshot) {
                mappingsByMapper.computeIfAbsent(entry.getMapper(), k -> new ArrayList<>()).add(entry);
            }

            int workers = Math.min(4, mappingsByMapper.size());
            var unmapPool = Executors.newFixedThreadPool(workers, r -> {
                Thread t = new Thread(r, "webrtc-port-unmap");
                t.setDaemon(true);
                return t;
            });
            for (List<ActiveMapping> mapperEntries : mappingsByMapper.values()) {
                unmapPool.execute(() -> {
                    for (ActiveMapping entry : mapperEntries) {
                        if (Thread.currentThread().isInterrupted()) {
                            break;
                        }
                        if (safeUnmap(entry.getMapper(), entry.getMappedPort())) {
                            unmappedCount.incrementAndGet();
                        }
                    }
                });
            }
            unmapPool.shutdown();
            try {
                if (!unmapPool.awaitTermination(shutdownUnmapTimeoutMs, TimeUnit.MILLISECONDS)) {
                    logger.debug("[PortForwarding] Shutdown unmap timed out after {}ms; forcing exit.",
                            shutdownUnmapTimeoutMs);
                    unmapPool.shutdownNow();
                }
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                unmapPool.shutdownNow();
            }
        }

        safeCloseSession(sessionSnapshot);
        logger.info("[PortForwarding] Shutdown complete: unmapped {}/{} active mappings/pinholes.",
                unmappedCount.get(), mappingsSnapshot.size());
    }

    @Override
    public void close() {
        shutdown();
    }

    public List<ActiveMapping> getActiveMappings() {
        return Collections.unmodifiableList(new ArrayList<>(activeMappings));
    }

    public StartupSummary getLastSummary() {
        return lastSummary;
    }

    public long getLeaseSeconds() {
        return leaseSeconds;
    }

    private static boolean safeUnmap(PortMapper mapper, MappedPort mapped) {
        if (mapper == null || mapped == null) {
            return false;
        }
        try {
            mapper.unmapPort(mapped);
            return true;
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            return false;
        } catch (Throwable t) {
            logger.debug("[PortForwarding] unmapPort({}) ignored error: {}",
                    mapped.getInternalPort(), t.getMessage());
            return false;
        }
    }

    private void closeAndClearActiveSession(DiscoverySession session) {
        synchronized (lifecycleLock) {
            if (this.activeSession == session) {
                this.activeSession = null;
            }
        }
        safeCloseSession(session);
    }

    private static void safeCloseSession(DiscoverySession session) {
        if (session == null) {
            return;
        }
        try {
            session.close();
        } catch (Throwable t) {
            logger.debug("[PortForwarding] DiscoverySession close error ignored: {}", t.getMessage());
        }
    }

    private StartupSummary recordSummary(StartupSummary summary) {
        this.lastSummary = summary;
        return summary;
    }

    private static StartupSummary emptySummary() {
        return new StartupSummary(0, 0, 0, 0, null, null, ExternalIpClassification.NO_IPV4_MAPPING);
    }

    private List<InetAddress> safeCollectPhysicalNics() {
        try {
            List<InetAddress> list = physicalNicSupplier.get();
            return list != null ? list : Collections.emptyList();
        } catch (Throwable t) {
            logger.debug("[PortForwarding] Failed to enumerate physical NICs: {}", t.getMessage());
            return Collections.emptyList();
        }
    }

    private InetAddress probePhysicalStunIpv4(List<InetAddress> physicalNics) {
        if (stunIpv4Probe != null) {
            try {
                return stunIpv4Probe.get();
            } catch (Throwable t) {
                return null;
            }
        }
        InetAddress localIpv4 = pickPrimaryPhysicalIpv4(physicalNics);
        if (localIpv4 == null) {
            return null;
        }
        return probeStunPublicIpv4(localIpv4, DEFAULT_STUN_HOST, DEFAULT_STUN_PORT);
    }

    static InetAddress pickPrimaryPhysicalIpv4(List<InetAddress> physicalNics) {
        InetAddress fallback = null;
        for (InetAddress addr : physicalNics) {
            if (addr instanceof Inet4Address && !isClashOrBenchmarkIpv4(addr)) {
                if (addr.isSiteLocalAddress()) {
                    return addr;
                }
                if (fallback == null) {
                    fallback = addr;
                }
            }
        }
        return fallback;
    }

    /**
     * Collects physical NIC IPv4 and IPv6 addresses while strictly excluding virtual/TUN interfaces
     * (Clash, Mihomo, Wintun, VMware, VirtualBox, WSL, Hyper-V, etc.).
     */
    public static List<InetAddress> collectPhysicalNicAddresses() {
        List<InetAddress> result = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces != null && ifaces.hasMoreElements()) {
                NetworkInterface iface = ifaces.nextElement();
                if (!iface.isUp() || iface.isLoopback() || NetworkUtil.isVirtualOrIgnoredInterface(iface)) {
                    continue;
                }
                Enumeration<InetAddress> addrs = iface.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (addr.isLoopbackAddress() || addr.isAnyLocalAddress() || addr.isMulticastAddress()) {
                        continue;
                    }
                    if (addr instanceof Inet4Address) {
                        if (addr.isLinkLocalAddress() || isClashOrBenchmarkIpv4(addr)) {
                            continue;
                        }
                        result.add(addr);
                    } else if (addr instanceof Inet6Address) {
                        if (NetworkUtil.isGlobalUnicastIpv6(addr) || addr.isLinkLocalAddress()) {
                            result.add(addr);
                        }
                    }
                }
            }
        } catch (Exception e) {
            logger.debug("[PortForwarding] Physical NIC enumeration failed: {}", e.getMessage());
        }
        return result;
    }

    static boolean isMapperOnPhysicalNic(PortMapper mapper, List<InetAddress> physicalNics) {
        if (mapper == null) {
            return false;
        }
        InetAddress source = mapper.getSourceAddress();
        if (source == null || source.isLoopbackAddress() || isClashOrBenchmarkIpv4(source)) {
            return false;
        }
        byte[] sourceBytes = source.getAddress();
        for (InetAddress nicAddr : physicalNics) {
            if (nicAddr != null && Arrays.equals(sourceBytes, nicAddr.getAddress())) {
                return true;
            }
        }
        return false;
    }

    static boolean isIpv6Mapper(PortMapper mapper) {
        if (mapper instanceof FirewallUpnpIgdPortMapper) {
            return true;
        }
        return mapper != null && mapper.getSourceAddress() instanceof Inet6Address;
    }

    /**
     * Checks RFC 6598 shared address space {@code 100.64.0.0/10} (CGNAT).
     */
    public static boolean isCgnatIpv4(InetAddress addr) {
        if (!(addr instanceof Inet4Address)) {
            return false;
        }
        byte[] b = addr.getAddress();
        return (b[0] & 0xFF) == 100 && (b[1] & 0xC0) == 64;
    }

    /**
     * Checks RFC 2544 / Clash Fake-IP / TUN {@code 198.18.0.0/15}.
     */
    public static boolean isClashOrBenchmarkIpv4(InetAddress addr) {
        if (!(addr instanceof Inet4Address)) {
            return false;
        }
        byte[] b = addr.getAddress();
        int first = b[0] & 0xFF;
        int second = b[1] & 0xFF;
        return first == 198 && (second == 18 || second == 19);
    }

    /**
     * Returns true only when {@code addr} is a globally routable unicast IPv4 address
     * (not private RFC1918, loopback, link-local, CGNAT 100.64/10, 198.18/15, multicast, or 0.0.0.0).
     */
    public static boolean isPublicRoutableIpv4(InetAddress addr) {
        if (!(addr instanceof Inet4Address)) {
            return false;
        }
        if (addr.isAnyLocalAddress()
                || addr.isLoopbackAddress()
                || addr.isLinkLocalAddress()
                || addr.isSiteLocalAddress()
                || addr.isMulticastAddress()
                || isCgnatIpv4(addr)
                || isClashOrBenchmarkIpv4(addr)) {
            return false;
        }
        byte[] b = addr.getAddress();
        int first = b[0] & 0xFF;
        // Exclude 0.0.0.0/8 ("this network") and 240.0.0.0/4 (reserved/broadcast)
        return first != 0 && first < 224;
    }

    public static ExternalIpClassification classifyRouterExternalIpv4(
            InetAddress routerExternalIpv4,
            InetAddress stunSrflxIpv4) {
        if (!(routerExternalIpv4 instanceof Inet4Address)) {
            return ExternalIpClassification.NO_IPV4_MAPPING;
        }
        if (isCgnatIpv4(routerExternalIpv4)) {
            return ExternalIpClassification.CGNAT;
        }
        if (!isPublicRoutableIpv4(routerExternalIpv4)) {
            return ExternalIpClassification.PRIVATE_OR_DOUBLE_NAT;
        }
        if (stunSrflxIpv4 instanceof Inet4Address
                && !Arrays.equals(routerExternalIpv4.getAddress(), stunSrflxIpv4.getAddress())) {
            return ExternalIpClassification.DOUBLE_NAT_PUBLIC_MISMATCH;
        }
        return ExternalIpClassification.TRUE_PUBLIC_IPV4;
    }

    private static void logExternalIpv4Verdict(
            ExternalIpClassification classification,
            InetAddress routerExternalIpv4,
            InetAddress stunSrflxIpv4,
            int ipv6PinholeCount) {
        String routerStr = routerExternalIpv4 != null ? routerExternalIpv4.getHostAddress() : "none";
        String stunStr = stunSrflxIpv4 != null ? stunSrflxIpv4.getHostAddress() : "unavailable";
        switch (classification) {
            case TRUE_PUBLIC_IPV4 -> logger.info(
                    "[PortForwarding] IPv4 WAN Verdict: TRUE_PUBLIC_IPV4 (routerExt={}, physicalStunSrflx={}, ipv6Pinholes={}).",
                    routerStr, stunStr, ipv6PinholeCount);
            case DOUBLE_NAT_PUBLIC_MISMATCH -> logger.info(
                    "[PortForwarding] IPv4 WAN Verdict: DOUBLE_NAT_PUBLIC_MISMATCH (routerExt={} != physicalStunSrflx={}, ipv6Pinholes={}).",
                    routerStr, stunStr, ipv6PinholeCount);
            case CGNAT -> logger.info(
                    "[PortForwarding] IPv4 WAN Verdict: CGNAT 100.64/10 detected (routerExt={}, physicalStunSrflx={}, ipv6Pinholes={}); IPv4 UPnP cannot penetrate ISP CGNAT.",
                    routerStr, stunStr, ipv6PinholeCount);
            case PRIVATE_OR_DOUBLE_NAT -> logger.info(
                    "[PortForwarding] IPv4 WAN Verdict: PRIVATE_OR_DOUBLE_NAT (routerExt={} is non-public RFC1918, physicalStunSrflx={}, ipv6Pinholes={}).",
                    routerStr, stunStr, ipv6PinholeCount);
            case NO_IPV4_MAPPING -> logger.info(
                    "[PortForwarding] IPv4 WAN Verdict: NO_IPV4_MAPPING (physicalStunSrflx={}, ipv6Pinholes={}).",
                    stunStr, ipv6PinholeCount);
        }
    }

    /**
     * Performs a lightweight RFC 5389 STUN Binding Request directly bound to the physical IPv4 NIC,
     * bypassing any Clash/TUN virtual interface.
     */
    public static InetAddress probeStunPublicIpv4(InetAddress localIpv4, String stunHost, int stunPort) {
        if (!(localIpv4 instanceof Inet4Address)) {
            return null;
        }
        try (DatagramSocket socket = new DatagramSocket(new InetSocketAddress(localIpv4, 0))) {
            socket.setSoTimeout(STUN_TIMEOUT_MS);
            byte[] txId = new byte[12];
            new SecureRandom().nextBytes(txId);

            ByteBuffer req = ByteBuffer.allocate(20);
            req.putShort((short) 0x0001); // Binding Request
            req.putShort((short) 0x0000); // Message Length
            req.putInt(STUN_MAGIC_COOKIE);
            req.put(txId);

            InetAddress serverAddr = InetAddress.getByName(stunHost);
            byte[] reqBytes = req.array();
            socket.send(new DatagramPacket(reqBytes, reqBytes.length, serverAddr, stunPort));

            byte[] respBuf = new byte[512];
            DatagramPacket respPacket = new DatagramPacket(respBuf, respBuf.length);
            socket.receive(respPacket);
            return parseStunMappedIpv4(respBuf, respPacket.getLength(), txId);
        } catch (Exception e) {
            logger.debug("[PortForwarding] Physical-NIC STUN probe ({} -> {}:{}) failed: {}",
                    localIpv4.getHostAddress(), stunHost, stunPort, e.getMessage());
            return null;
        }
    }

    /**
     * Parses RFC 5389 Binding Success Response XOR-MAPPED-ADDRESS (0x0020) or MAPPED-ADDRESS (0x0001).
     */
    static InetAddress parseStunMappedIpv4(byte[] data, int length, byte[] expectedTxId) {
        if (data == null || length < 20 || expectedTxId == null || expectedTxId.length != 12) {
            return null;
        }
        ByteBuffer buf = ByteBuffer.wrap(data, 0, length);
        int msgType = buf.getShort() & 0xFFFF;
        int msgLen = buf.getShort() & 0xFFFF;
        int cookie = buf.getInt();
        byte[] txId = new byte[12];
        buf.get(txId);
        if (msgType != 0x0101 || cookie != STUN_MAGIC_COOKIE || !Arrays.equals(expectedTxId, txId)) {
            return null;
        }
        int endOffset = Math.min(length, 20 + msgLen);
        int pos = 20;
        InetAddress fallbackMapped = null;
        while (pos + 4 <= endOffset) {
            int attrType = ((data[pos] & 0xFF) << 8) | (data[pos + 1] & 0xFF);
            int attrLen = ((data[pos + 2] & 0xFF) << 8) | (data[pos + 3] & 0xFF);
            int valPos = pos + 4;
            if (valPos + attrLen > endOffset) {
                break;
            }
            if ((attrType == 0x0020 || attrType == 0x0001) && attrLen >= 8 && (data[valPos + 1] & 0xFF) == 0x01) {
                byte[] ipBytes = new byte[4];
                System.arraycopy(data, valPos + 4, ipBytes, 0, 4);
                if (attrType == 0x0020) {
                    ipBytes[0] ^= (byte) ((STUN_MAGIC_COOKIE >>> 24) & 0xFF);
                    ipBytes[1] ^= (byte) ((STUN_MAGIC_COOKIE >>> 16) & 0xFF);
                    ipBytes[2] ^= (byte) ((STUN_MAGIC_COOKIE >>> 8) & 0xFF);
                    ipBytes[3] ^= (byte) (STUN_MAGIC_COOKIE & 0xFF);
                    try {
                        return InetAddress.getByAddress(ipBytes);
                    } catch (Exception ignored) {
                        return null;
                    }
                } else if (fallbackMapped == null) {
                    try {
                        fallbackMapped = InetAddress.getByAddress(ipBytes);
                    } catch (Exception ignored) {
                        // ignore malformed address
                    }
                }
            }
            int paddedLen = (attrLen + 3) & ~3;
            pos = valPos + paddedLen;
        }
        return fallbackMapped;
    }

    private static boolean isUnresponsiveGatewayError(Throwable t, String errMsg) {
        if (t instanceof java.util.concurrent.TimeoutException || t instanceof java.net.SocketTimeoutException) {
            return true;
        }
        if (t instanceof IllegalStateException && (t.getMessage() == null || t.getMessage().isBlank())) {
            return true;
        }
        return isUnresponsiveGatewayError(errMsg);
    }

    private static boolean isUnresponsiveGatewayError(String errMsg) {
        if (errMsg == null || errMsg.isBlank()) {
            return false;
        }
        String lower = errMsg.toLowerCase(Locale.ROOT);
        return lower.contains("no response")
                || lower.contains("timed out")
                || lower.contains("timeout")
                || lower.contains("connection refused")
                || lower.contains("unreachable")
                || lower.contains("invalid response")
                || lower.contains("failed to bind")
                || lower.contains("failed to connect");
    }

    /**
     * Discovers router mappers strictly over real physical NICs without spawning {@code ifconfig}
     * (eliminating Windows {@code CreateProcess error=2}) and explicitly sets
     * {@code IP_MULTICAST_IF} / {@link MulticastSocket#setNetworkInterface(NetworkInterface)}
     * so Clash/Mihomo TUN low-metric multicast routes (e.g. {@code 224.0.0.0/4} on {@code 198.18.0.1})
     * cannot hijack SSDP discovery.
     */
    private static DiscoverySession defaultDiscover(List<InetAddress> physicalNicAddresses) throws Exception {
        NetworkGateway networkGateway = NetworkGateway.create();
        try {
            Bus networkBus = networkGateway.getBus();
            List<PortMapper> mappers = new ArrayList<>();
            mappers.addAll(discoverUpnpViaPhysicalMulticast(networkBus, physicalNicAddresses));
            mappers.addAll(discoverNatPmpAndPcpViaPhysicalGateways(networkBus, physicalNicAddresses));
            return new DiscoverySession() {
                @Override
                public List<PortMapper> getMappers() {
                    return mappers;
                }

                @Override
                public void close() {
                    shutdownGateway(networkGateway, new KillNetworkRequest(), "portmapper-net-kill");
                }
            };
        } catch (Exception | Error e) {
            shutdownGateway(networkGateway, new KillNetworkRequest(), "portmapper-net-kill");
            throw e;
        }
    }

    static final class PhysicalGatewayEndpoint {
        final InetAddress localAddress;
        final InetAddress gatewayAddress;

        PhysicalGatewayEndpoint(InetAddress localAddress, InetAddress gatewayAddress) {
            this.localAddress = localAddress;
            this.gatewayAddress = gatewayAddress;
        }
    }

    private static List<PortMapper> discoverNatPmpAndPcpViaPhysicalGateways(
            Bus networkBus,
            List<InetAddress> physicalNicAddresses) {
        List<PortMapper> out = new ArrayList<>();
        List<PhysicalGatewayEndpoint> gateways = discoverPhysicalDefaultGateways(physicalNicAddresses);
        if (gateways.isEmpty()) {
            logger.debug("[PortForwarding] No physical IPv4/IPv6 default gateway found for NAT-PMP/PCP.");
            return out;
        }
        for (PhysicalGatewayEndpoint ep : gateways) {
            if (ep.localAddress instanceof Inet4Address && ep.gatewayAddress instanceof Inet4Address) {
                logger.debug("[PortForwarding] Probing NAT-PMP & PCPv4 via physical {} -> gw {}",
                        ep.localAddress.getHostAddress(), ep.gatewayAddress.getHostAddress());
                out.add(new NatPmpPortMapper(networkBus, ep.localAddress, ep.gatewayAddress));
                out.add(new PcpPortMapper(networkBus, ep.localAddress, ep.gatewayAddress));
            } else if (ep.localAddress instanceof Inet6Address && ep.gatewayAddress instanceof Inet6Address) {
                logger.debug("[PortForwarding] Probing PCPv6 via physical {} -> gw {}",
                        ep.localAddress.getHostAddress(), ep.gatewayAddress.getHostAddress());
                out.add(new PcpPortMapper(networkBus, ep.localAddress, ep.gatewayAddress));
            }
        }
        return out;
    }

    private static List<PhysicalGatewayEndpoint> discoverPhysicalDefaultGateways(List<InetAddress> physicalNicAddresses) {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        if (!os.contains("win")) {
            return Collections.emptyList();
        }
        List<PhysicalGatewayEndpoint> endpoints = new ArrayList<>();
        String route4 = runReadOnlyCommand("route", "print", "-4");
        if (route4 != null && !route4.isEmpty()) {
            endpoints.addAll(parseWindowsRoutePrint4(route4, physicalNicAddresses));
        }
        String route6 = runReadOnlyCommand("route", "print", "-6");
        if (route6 != null && !route6.isEmpty()) {
            endpoints.addAll(parseWindowsRoutePrint6(route6, physicalNicAddresses));
        }
        return endpoints;
    }

    /**
     * Parses {@code route print -4} output for {@code 0.0.0.0 0.0.0.0 <gateway> <interfaceIp> <metric>}
     * and filters strictly to {@code physicalNicAddresses} (excluding Clash TUN {@code 198.18.x}).
     */
    static List<PhysicalGatewayEndpoint> parseWindowsRoutePrint4(
            String routePrintOutput,
            List<InetAddress> physicalNicAddresses) {
        List<PhysicalGatewayEndpoint> result = new ArrayList<>();
        if (routePrintOutput == null || physicalNicAddresses == null || physicalNicAddresses.isEmpty()) {
            return result;
        }
        Pattern p = Pattern.compile(
                "^\\s*0\\.0\\.0\\.0\\s+0\\.0\\.0\\.0\\s+(\\d+\\.\\d+\\.\\d+\\.\\d+)\\s+(\\d+\\.\\d+\\.\\d+\\.\\d+)\\s+\\d+");
        Set<String> seen = new LinkedHashSet<>();
        for (String line : routePrintOutput.split("\\R")) {
            Matcher m = p.matcher(line);
            if (!m.find()) {
                continue;
            }
            try {
                InetAddress gw = InetAddress.getByName(m.group(1));
                InetAddress ifIp = InetAddress.getByName(m.group(2));
                if (isClashOrBenchmarkIpv4(gw) || isClashOrBenchmarkIpv4(ifIp)) {
                    continue;
                }
                InetAddress matchedLocal = findMatchingAddress(ifIp, physicalNicAddresses);
                if (matchedLocal == null) {
                    continue;
                }
                String key = matchedLocal.getHostAddress() + "->" + gw.getHostAddress();
                if (seen.add(key)) {
                    result.add(new PhysicalGatewayEndpoint(matchedLocal, gw));
                }
            } catch (Exception ignored) {
                // skip unparseable route line
            }
        }
        return result;
    }

    /**
     * Parses {@code route print -6} output for {@code <ifIndex> <metric> ::/0 <gateway>}
     * and maps {@code ifIndex} to physical IPv6 NIC addresses in {@code physicalNicAddresses}.
     */
    static List<PhysicalGatewayEndpoint> parseWindowsRoutePrint6(
            String routePrint6Output,
            List<InetAddress> physicalNicAddresses) {
        List<PhysicalGatewayEndpoint> result = new ArrayList<>();
        if (routePrint6Output == null || physicalNicAddresses == null || physicalNicAddresses.isEmpty()) {
            return result;
        }
        Pattern p = Pattern.compile("^\\s*(\\d+)\\s+\\d+\\s+::/0\\s+([^\\s]+)");
        Set<String> seen = new LinkedHashSet<>();
        for (String line : routePrint6Output.split("\\R")) {
            Matcher m = p.matcher(line);
            if (!m.find()) {
                continue;
            }
            int ifIndex;
            try {
                ifIndex = Integer.parseInt(m.group(1));
            } catch (NumberFormatException ignored) {
                continue;
            }
            String gwStr = m.group(2);
            if ("On-link".equalsIgnoreCase(gwStr) || "在链路上".equals(gwStr)) {
                continue;
            }
            try {
                NetworkInterface iface = NetworkInterface.getByIndex(ifIndex);
                if (iface == null || !iface.isUp() || iface.isLoopback() || NetworkUtil.isVirtualOrIgnoredInterface(iface)) {
                    continue;
                }
                InetAddress localV6 = pickPhysicalIpv6OnInterface(iface, physicalNicAddresses);
                if (localV6 == null) {
                    continue;
                }
                String scopedGwStr = (gwStr.toLowerCase(Locale.ROOT).startsWith("fe80:") && !gwStr.contains("%"))
                        ? gwStr + "%" + iface.getName()
                        : gwStr;
                InetAddress gw = InetAddress.getByName(scopedGwStr);
                String key = localV6.getHostAddress() + "->" + gw.getHostAddress();
                if (seen.add(key)) {
                    result.add(new PhysicalGatewayEndpoint(localV6, gw));
                }
            } catch (Exception ignored) {
                // skip unparseable IPv6 route line
            }
        }
        return result;
    }

    private static InetAddress pickPhysicalIpv6OnInterface(
            NetworkInterface iface,
            List<InetAddress> physicalNicAddresses) {
        InetAddress fallbackLinkLocal = null;
        Enumeration<InetAddress> addrs = iface.getInetAddresses();
        while (addrs.hasMoreElements()) {
            InetAddress nicAddr = addrs.nextElement();
            if (!(nicAddr instanceof Inet6Address)) {
                continue;
            }
            InetAddress matched = findMatchingAddress(nicAddr, physicalNicAddresses);
            if (matched == null) {
                continue;
            }
            if (NetworkUtil.isGlobalUnicastIpv6(matched)) {
                return matched;
            }
            if (fallbackLinkLocal == null) {
                fallbackLinkLocal = matched;
            }
        }
        return fallbackLinkLocal;
    }

    private static InetAddress findMatchingAddress(InetAddress candidate, List<InetAddress> pool) {
        if (candidate == null || pool == null) {
            return null;
        }
        byte[] targetBytes = candidate.getAddress();
        for (InetAddress item : pool) {
            if (item != null && Arrays.equals(targetBytes, item.getAddress())) {
                return item;
            }
        }
        return null;
    }

    private static String runReadOnlyCommand(String... command) {
        try {
            Process proc = new ProcessBuilder(command).redirectErrorStream(true).start();
            byte[] bytes;
            try (InputStream is = proc.getInputStream()) {
                bytes = is.readAllBytes();
            }
            proc.waitFor(3, TimeUnit.SECONDS);
            return decodeWindowsConsoleOutput(bytes);
        } catch (Exception e) {
            logger.debug("[PortForwarding] Command {} failed: {}", Arrays.toString(command), e.getMessage());
            return "";
        }
    }

    static String decodeWindowsConsoleOutput(byte[] bytes) {
        if (bytes == null || bytes.length == 0) {
            return "";
        }
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        if (!os.contains("win")) {
            return new String(bytes, StandardCharsets.UTF_8);
        }
        List<java.nio.charset.Charset> charsets = NetworkUtil.resolveWindowsConsoleCharsets();
        if (charsets == null || charsets.isEmpty()) {
            return new String(bytes, StandardCharsets.UTF_8);
        }
        String firstDecoded = new String(bytes, charsets.get(0));
        if (firstDecoded.indexOf('\uFFFD') < 0) {
            return firstDecoded;
        }
        for (int i = 1; i < charsets.size(); i++) {
            String candidate = new String(bytes, charsets.get(i));
            if (candidate.indexOf('\uFFFD') < 0) {
                return candidate;
            }
        }
        return firstDecoded;
    }

    private static List<PortMapper> discoverUpnpViaPhysicalMulticast(
            Bus networkBus,
            List<InetAddress> physicalNicAddresses) {
        List<PortMapper> out = new ArrayList<>();
        Map<NetworkInterface, List<InetAddress>> byInterface = groupPhysicalAddressesByInterface(physicalNicAddresses);
        if (byInterface.isEmpty()) {
            return out;
        }

        Set<String> seenServiceKeys = new LinkedHashSet<>();
        for (Map.Entry<NetworkInterface, List<InetAddress>> entry : byInterface.entrySet()) {
            NetworkInterface iface = entry.getKey();
            List<InetAddress> ifaceAddrs = entry.getValue();
            InetAddress physV4 = pickPrimaryPhysicalIpv4(ifaceAddrs);
            InetAddress physV6 = pickPreferredIpv6(ifaceAddrs);
            List<InetAddress> ifaceIpv6s = collectPreferredIpv6s(ifaceAddrs);

            Map<String, String> discoveredLocations = new LinkedHashMap<>();
            if (physV4 != null) {
                sendSsdpSearchV4(iface, physV4, discoveredLocations);
            }
            if (physV6 != null) {
                sendSsdpSearchV6(iface, discoveredLocations);
            }

            for (Map.Entry<String, String> locEntry : discoveredLocations.entrySet()) {
                String locationUrl = locEntry.getKey();
                String serverHeader = locEntry.getValue();
                InetAddress bindSource = pickSourceAddressForLocation(locationUrl, physV4, physV6, ifaceAddrs);
                if (bindSource == null) {
                    continue;
                }
                try {
                    String xml = fetchHttpText(locationUrl);
                    if (xml == null || xml.isEmpty()) {
                        continue;
                    }
                    List<PortMapper> parsed = parseUpnpIgdServicesFromXml(
                            networkBus, bindSource, ifaceIpv6s, locationUrl, serverHeader, xml, true);
                    for (PortMapper mapper : parsed) {
                        String dedupKey = mapper.getClass().getName() + "|" + mapper;
                        if (seenServiceKeys.add(dedupKey)) {
                            out.add(mapper);
                        }
                    }
                } catch (Exception e) {
                    logger.debug("[PortForwarding] Failed to fetch/parse UPnP description {}: {}",
                            locationUrl, e.getMessage());
                }
            }
        }
        return out;
    }

    private static Map<NetworkInterface, List<InetAddress>> groupPhysicalAddressesByInterface(
            List<InetAddress> physicalNicAddresses) {
        Map<NetworkInterface, List<InetAddress>> grouped = new LinkedHashMap<>();
        for (InetAddress addr : physicalNicAddresses) {
            try {
                NetworkInterface iface = NetworkInterface.getByInetAddress(addr);
                if (iface == null && addr instanceof Inet6Address v6 && v6.getScopedInterface() != null) {
                    iface = v6.getScopedInterface();
                }
                if (iface != null) {
                    grouped.computeIfAbsent(iface, k -> new ArrayList<>()).add(addr);
                }
            } catch (Exception ignored) {
                // skip
            }
        }
        return grouped;
    }

    private static InetAddress pickPreferredIpv6(List<InetAddress> addrs) {
        InetAddress fallback = null;
        for (InetAddress a : addrs) {
            if (a instanceof Inet6Address) {
                if (NetworkUtil.isGlobalUnicastIpv6(a)) {
                    return a;
                }
                if (fallback == null) {
                    fallback = a;
                }
            }
        }
        return fallback;
    }

    private static List<InetAddress> collectPreferredIpv6s(List<InetAddress> addrs) {
        List<InetAddress> guas = new ArrayList<>();
        InetAddress fallbackLinkLocal = null;
        for (InetAddress a : addrs) {
            if (a instanceof Inet6Address) {
                if (NetworkUtil.isGlobalUnicastIpv6(a)) {
                    guas.add(a);
                } else if (fallbackLinkLocal == null) {
                    fallbackLinkLocal = a;
                }
            }
        }
        if (!guas.isEmpty()) {
            return guas;
        }
        return fallbackLinkLocal != null ? Collections.singletonList(fallbackLinkLocal) : Collections.emptyList();
    }

    private static InetAddress pickSourceAddressForLocation(
            String locationUrl,
            InetAddress physV4,
            InetAddress physV6,
            List<InetAddress> ifaceAddrs) {
        try {
            String host = URI.create(locationUrl).getHost();
            if (host != null && host.contains(":")) {
                return physV6;
            }
        } catch (Exception ignored) {
            // fall through to v4 preference
        }
        return physV4;
    }

    private static void sendSsdpSearchV4(
            NetworkInterface iface,
            InetAddress physV4,
            Map<String, String> outLocations) {
        try (MulticastSocket ms = new MulticastSocket(new InetSocketAddress(physV4, 0))) {
            ms.setNetworkInterface(iface);
            ms.setTimeToLive(4);
            ms.setSoTimeout(1200);
            InetAddress ssdpV4 = InetAddress.getByName("239.255.255.250");
            for (String st : new String[]{
                    "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
                    "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
                    "ssdp:all"}) {
                String req = "M-SEARCH * HTTP/1.1\r\n"
                        + "HOST: 239.255.255.250:1900\r\n"
                        + "MAN: \"ssdp:discover\"\r\n"
                        + "MX: 2\r\n"
                        + "ST: " + st + "\r\n\r\n";
                byte[] b = req.getBytes(StandardCharsets.UTF_8);
                ms.send(new DatagramPacket(b, b.length, ssdpV4, 1900));
            }
            collectSsdpResponses(ms, 2200L, outLocations);
        } catch (Exception e) {
            logger.debug("[PortForwarding] IPv4 SSDP on {} failed: {}", physV4.getHostAddress(), e.getMessage());
        }
    }

    private static void sendSsdpSearchV6(NetworkInterface iface, Map<String, String> outLocations) {
        try (MulticastSocket ms6 = new MulticastSocket()) {
            ms6.setNetworkInterface(iface);
            ms6.setTimeToLive(4);
            ms6.setSoTimeout(1200);
            for (String mcast : new String[]{"ff02::c", "ff05::c"}) {
                InetAddress dest = mcast.startsWith("ff02")
                        ? InetAddress.getByName(mcast + "%" + iface.getName())
                        : InetAddress.getByName(mcast);
                for (String st : new String[]{
                        "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
                        "urn:schemas-upnp-org:service:WANIPv6FirewallControl:1",
                        "ssdp:all"}) {
                    try {
                        String req = "M-SEARCH * HTTP/1.1\r\n"
                                + "HOST: [" + mcast + "]:1900\r\n"
                                + "MAN: \"ssdp:discover\"\r\n"
                                + "MX: 2\r\n"
                                + "ST: " + st + "\r\n\r\n";
                        byte[] b = req.getBytes(StandardCharsets.UTF_8);
                        ms6.send(new DatagramPacket(b, b.length, dest, 1900));
                    } catch (Exception ignored) {
                        // ff05::c may be unroutable on link-local-only interfaces; keep trying remaining probes
                    }
                }
            }
            collectSsdpResponses(ms6, 2000L, outLocations);
        } catch (Exception e) {
            logger.debug("[PortForwarding] IPv6 SSDP on {} failed: {}", iface.getName(), e.getMessage());
        }
    }

    private static void collectSsdpResponses(
            MulticastSocket socket,
            long windowMs,
            Map<String, String> outLocations) {
        long deadline = System.currentTimeMillis() + windowMs;
        byte[] buf = new byte[4096];
        while (System.currentTimeMillis() < deadline) {
            try {
                DatagramPacket packet = new DatagramPacket(buf, buf.length);
                socket.receive(packet);
                String payload = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
                String location = extractSsdpHeader(payload, "LOCATION");
                if (location != null && !location.isEmpty()) {
                    String server = extractSsdpHeader(payload, "SERVER");
                    outLocations.putIfAbsent(location, server != null ? server : "UPnP-IGD");
                }
            } catch (SocketTimeoutException e) {
                break;
            } catch (Exception e) {
                break;
            }
        }
    }

    private static String extractSsdpHeader(String payload, String headerName) {
        if (payload == null) {
            return null;
        }
        for (String line : payload.split("\\r?\\n")) {
            int colon = line.indexOf(':');
            if (colon <= 0) {
                continue;
            }
            String key = line.substring(0, colon).trim();
            if (key.equalsIgnoreCase(headerName)) {
                return line.substring(colon + 1).trim();
            }
        }
        return null;
    }

    private static String fetchHttpText(String urlStr) throws Exception {
        URL url = URI.create(urlStr).toURL();
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(2000);
        conn.setReadTimeout(2000);
        conn.setRequestMethod("GET");
        int code = conn.getResponseCode();
        if (code < 200 || code >= 300) {
            return "";
        }
        try (InputStream is = conn.getInputStream()) {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        } finally {
            conn.disconnect();
        }
    }

    static List<PortMapper> parseUpnpIgdServicesFromXml(
            Bus networkBus,
            InetAddress sourceAddress,
            String baseLocationUrl,
            String serverName,
            String rootDescXml,
            boolean fetchScpdForAddAny) throws Exception {
        List<InetAddress> ipv6Candidates = (sourceAddress instanceof Inet6Address)
                ? Collections.singletonList(sourceAddress)
                : Collections.emptyList();
        return parseUpnpIgdServicesFromXml(
                networkBus,
                sourceAddress,
                ipv6Candidates,
                baseLocationUrl,
                serverName,
                rootDescXml,
                fetchScpdForAddAny);
    }

    static List<PortMapper> parseUpnpIgdServicesFromXml(
            Bus networkBus,
            InetAddress sourceAddress,
            List<InetAddress> ipv6SourceAddresses,
            String baseLocationUrl,
            String serverName,
            String rootDescXml,
            boolean fetchScpdForAddAny) throws Exception {
        List<PortMapper> out = new ArrayList<>();
        if (rootDescXml == null || rootDescXml.isBlank()) {
            return out;
        }
        DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
        dbf.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        dbf.setFeature("http://xml.org/sax/features/external-general-entities", false);
        dbf.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        dbf.setXIncludeAware(false);
        dbf.setExpandEntityReferences(false);
        Document doc = dbf.newDocumentBuilder()
                .parse(new ByteArrayInputStream(rootDescXml.getBytes(StandardCharsets.UTF_8)));

        String urlBaseText = getFirstChildTagText(doc.getDocumentElement(), "URLBase");
        URI baseUri = URI.create(
                (urlBaseText != null && !urlBaseText.isBlank()) ? urlBaseText.trim() : baseLocationUrl);

        Range<Long> portRange = Range.between(1L, 65535L);
        Range<Long> leaseRange = Range.between(1L, 86400L);

        NodeList services = doc.getElementsByTagName("service");
        for (int i = 0; i < services.getLength(); i++) {
            if (!(services.item(i) instanceof Element svcEl)) {
                continue;
            }
            String serviceType = getFirstChildTagText(svcEl, "serviceType");
            String controlUrlStr = getFirstChildTagText(svcEl, "controlURL");
            String scpdUrlStr = getFirstChildTagText(svcEl, "SCPDURL");
            if (serviceType == null || controlUrlStr == null) {
                continue;
            }
            URL controlUrl = baseUri.resolve(controlUrlStr.trim()).toURL();
            String normalizedType = serviceType.trim();
            boolean isIpv6ControlUrl = controlUrl.getHost() != null && controlUrl.getHost().contains(":");

            if (normalizedType.startsWith("urn:schemas-upnp-org:service:WANIPConnection:")
                    || normalizedType.startsWith("urn:schemas-upnp-org:service:WANPPPConnection:")) {
                if (!(sourceAddress instanceof Inet4Address) || isIpv6ControlUrl) {
                    logger.info("[PortForwarding] Skipping {} because IPv4 PortMapper requires IPv4 sourceAddress & controlURL (controlURL={}, sourceAddress={}).",
                            normalizedType, controlUrl,
                            sourceAddress != null ? sourceAddress.getHostAddress() : "null");
                    continue;
                }
                boolean hasAddAny = normalizedType.endsWith(":2");
                if (fetchScpdForAddAny && scpdUrlStr != null && !scpdUrlStr.isBlank()) {
                    try {
                        String scpdUrl = baseUri.resolve(scpdUrlStr.trim()).toString();
                        String scpdXml = fetchHttpText(scpdUrl);
                        if (scpdXml.contains("AddAnyPortMapping")) {
                            hasAddAny = true;
                        }
                    } catch (Exception ignored) {
                        // keep version heuristic
                    }
                }
                out.add(new PortMapperUpnpIgdPortMapper(
                        networkBus,
                        sourceAddress,
                        controlUrl,
                        serverName,
                        normalizedType,
                        portRange,
                        leaseRange,
                        hasAddAny));
            } else if (normalizedType.startsWith("urn:schemas-upnp-org:service:WANIPv6FirewallControl:")) {
                if (!isIpv6ControlUrl) {
                    logger.info("[PortForwarding] Skipping WANIPv6FirewallControl ({}) at IPv4-only controlURL={}; FirewallUpnpIgdPortMapper requires an IPv6 controlURL matching an IPv6 sourceAddress.",
                            serverName, controlUrl);
                    continue;
                }
                List<InetAddress> matchedV6Sources = new ArrayList<>();
                if (ipv6SourceAddresses != null) {
                    for (InetAddress addr : ipv6SourceAddresses) {
                        if (addr instanceof Inet6Address) {
                            matchedV6Sources.add(addr);
                        }
                    }
                }
                if (matchedV6Sources.isEmpty() && sourceAddress instanceof Inet6Address) {
                    matchedV6Sources.add(sourceAddress);
                }
                if (matchedV6Sources.isEmpty()) {
                    logger.info("[PortForwarding] Skipping WANIPv6FirewallControl ({}) at {} because no physical IPv6 sourceAddress is available.",
                            serverName, controlUrl);
                    continue;
                }
                for (InetAddress v6Source : matchedV6Sources) {
                    out.add(new FirewallUpnpIgdPortMapper(
                            networkBus,
                            v6Source,
                            controlUrl,
                            serverName,
                            normalizedType,
                            portRange,
                            leaseRange));
                }
            }
        }
        return out;
    }

    private static String getFirstChildTagText(Element parent, String tagName) {
        if (parent == null) {
            return null;
        }
        NodeList list = parent.getElementsByTagName(tagName);
        if (list.getLength() == 0) {
            return null;
        }
        return list.item(0).getTextContent();
    }

    private static void shutdownGateway(Gateway gateway, Object killRequest, String threadName) {
        if (gateway == null) {
            return;
        }
        try {
            gateway.getBus().send(killRequest);
        } catch (Throwable ignored) {
            // best-effort shutdown signal
        }
        Thread joiner = new Thread(() -> {
            try {
                gateway.join();
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            } catch (Throwable ignored) {
                // ignore
            }
        }, threadName);
        joiner.setDaemon(true);
        joiner.start();
        try {
            joiner.join(GATEWAY_JOIN_TIMEOUT_MS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private static String formatAddresses(List<InetAddress> addrs) {
        if (addrs == null || addrs.isEmpty()) {
            return "[]";
        }
        List<String> out = new ArrayList<>(addrs.size());
        for (InetAddress a : addrs) {
            out.add(a.getHostAddress());
        }
        return out.toString();
    }
}
