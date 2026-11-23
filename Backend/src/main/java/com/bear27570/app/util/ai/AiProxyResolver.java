package com.bear27570.app.util.ai;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.List;
import java.util.Locale;

/**
 * Resolves effective HTTP proxies with loopback bypass and 30s local VPN proxy auto-detection caching.
 */
public final class AiProxyResolver {
    private static final Logger logger = LoggerFactory.getLogger(AiProxyResolver.class);

    // Common local proxy ports used by desktop VPN/tunnel clients
    private static final int[] COMMON_LOCAL_PROXY_PORTS = {7890, 7897, 10809, 10808, 7891, 1080};
    private static final long PROXY_SCAN_CACHE_TTL_MS = 30_000L;
    private static volatile long cachedProxyScanAtMs = 0L;
    private static volatile int cachedAutoProxyPort = -1;

    private AiProxyResolver() {}

    public static boolean isLoopbackUrl(String targetUrl) {
        if (targetUrl == null || targetUrl.isBlank()) {
            return false;
        }
        try {
            URI uri = URI.create(targetUrl.trim());
            String host = uri.getHost();
            if (host == null || host.isBlank()) {
                return false;
            }
            host = host.toLowerCase(Locale.ROOT);
            if (host.startsWith("[") && host.endsWith("]")) {
                host = host.substring(1, host.length() - 1);
            }
            return host.equals("localhost")
                    || host.equals("127.0.0.1")
                    || host.equals("::1")
                    || host.equals("0:0:0:0:0:0:0:1")
                    || host.equals("0.0.0.0")
                    || host.endsWith(".localhost");
        } catch (Exception e) {
            return false;
        }
    }

    public static Proxy resolveEffectiveProxy(String customHost, Integer customPort, String targetUrl) {
        // 1. Explicit proxy host/port takes highest precedence
        if (customPort != null && customPort > 0 && customPort <= 65535) {
            String host = (customHost != null && !customHost.isBlank()) ? customHost.trim() : "127.0.0.1";
            return new Proxy(Proxy.Type.HTTP, new InetSocketAddress(host, customPort));
        }

        // 1b. Local loopback targets bypass local VPN proxies automatically (Ollama / LM Studio / local tests)
        if (isLoopbackUrl(targetUrl)) {
            return Proxy.NO_PROXY;
        }

        // 2. Environment variables HTTPS_PROXY / HTTP_PROXY
        String envProxy = System.getenv("HTTPS_PROXY");
        if (envProxy == null || envProxy.isBlank()) {
            envProxy = System.getenv("HTTP_PROXY");
        }
        if (envProxy != null && !envProxy.isBlank()) {
            try {
                URI u = URI.create(envProxy.trim());
                if (u.getHost() != null && u.getPort() > 0) {
                    return new Proxy(Proxy.Type.HTTP, new InetSocketAddress(u.getHost(), u.getPort()));
                }
            } catch (Exception ignored) {}
        }

        // 3. Cached probe for local VPN proxy port
        int detectedPort = detectActiveLocalProxyPortCached();
        if (detectedPort > 0) {
            return new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", detectedPort));
        }

        // 4. Fallback to OS default proxy selector
        try {
            ProxySelector sysSelector = ProxySelector.getDefault();
            if (sysSelector != null) {
                URI sampleUri = (targetUrl != null && !targetUrl.isBlank())
                        ? URI.create(targetUrl.trim())
                        : URI.create("https://api.openai.com");
                List<Proxy> proxies = sysSelector.select(sampleUri);
                if (proxies != null && !proxies.isEmpty()) {
                    Proxy p = proxies.get(0);
                    if (p != null && p.type() != Proxy.Type.DIRECT) {
                        return p;
                    }
                }
            }
        } catch (Exception ignored) {}
        return Proxy.NO_PROXY;
    }

    private static int detectActiveLocalProxyPortCached() {
        long now = System.currentTimeMillis();
        if (cachedProxyScanAtMs > 0 && (now - cachedProxyScanAtMs) < PROXY_SCAN_CACHE_TTL_MS) {
            return cachedAutoProxyPort;
        }
        synchronized (AiProxyResolver.class) {
            now = System.currentTimeMillis();
            if (cachedProxyScanAtMs > 0 && (now - cachedProxyScanAtMs) < PROXY_SCAN_CACHE_TTL_MS) {
                return cachedAutoProxyPort;
            }
            int found = -1;
            for (int port : COMMON_LOCAL_PROXY_PORTS) {
                try (Socket s = new Socket()) {
                    s.connect(new InetSocketAddress("127.0.0.1", port), 35);
                    found = port;
                    logger.info("[AiClient] Auto-detected active local VPN proxy on 127.0.0.1:{}", port);
                    break;
                } catch (Exception ignored) {}
            }
            cachedAutoProxyPort = found;
            cachedProxyScanAtMs = System.currentTimeMillis();
            return found;
        }
    }

    public static ProxySelector resolveEffectiveProxySelector(String customHost, Integer customPort, String targetUrl) {
        if ((customPort == null || customPort <= 0) && isLoopbackUrl(targetUrl)) {
            return HttpClient.Builder.NO_PROXY;
        }
        Proxy proxy = resolveEffectiveProxy(customHost, customPort, targetUrl);
        if (proxy != null && proxy.type() != Proxy.Type.DIRECT && proxy.address() instanceof InetSocketAddress addr) {
            return ProxySelector.of(addr);
        }
        if (proxy == Proxy.NO_PROXY || (proxy != null && proxy.type() == Proxy.Type.DIRECT)) {
            return HttpClient.Builder.NO_PROXY;
        }
        ProxySelector sys = ProxySelector.getDefault();
        return sys != null ? sys : HttpClient.Builder.NO_PROXY;
    }

    public static HttpClient buildHttpClient(String proxyHost, Integer proxyPort, String targetUrl) {
        return HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15))
                .proxy(resolveEffectiveProxySelector(proxyHost, proxyPort, targetUrl))
                .build();
    }
}
