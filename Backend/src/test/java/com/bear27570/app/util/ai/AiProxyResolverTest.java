package com.bear27570.app.util.ai;

import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.http.HttpClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AiProxyResolverTest {

    @Test
    void testLoopbackUrlDetection() {
        assertThat(AiProxyResolver.isLoopbackUrl("http://127.0.0.1:11434/v1")).isTrue();
        assertThat(AiProxyResolver.isLoopbackUrl("http://localhost:8080/api")).isTrue();
        assertThat(AiProxyResolver.isLoopbackUrl("http://[::1]:11434/v1")).isTrue();
        assertThat(AiProxyResolver.isLoopbackUrl("http://sub.localhost:3000")).isTrue();
        assertThat(AiProxyResolver.isLoopbackUrl("http://0.0.0.0:8000")).isTrue();

        assertThat(AiProxyResolver.isLoopbackUrl("https://api.openai.com/v1")).isFalse();
        assertThat(AiProxyResolver.isLoopbackUrl("")).isFalse();
        assertThat(AiProxyResolver.isLoopbackUrl(null)).isFalse();
        assertThat(AiProxyResolver.isLoopbackUrl("not a url ://")).isFalse();
    }

    @Test
    void testResolveEffectiveProxyAndSelectorPrecedenceAndValidation() {
        // Explicit loopback proxy takes precedence
        Proxy explicit = AiProxyResolver.resolveEffectiveProxy("127.0.0.1", 7890, "https://api.openai.com/v1");
        assertThat(explicit.type()).isEqualTo(Proxy.Type.HTTP);
        assertThat(((InetSocketAddress) explicit.address()).getPort()).isEqualTo(7890);

        // Blank proxyHost with explicit port defaults to 127.0.0.1
        Proxy defaultHostProxy = AiProxyResolver.resolveEffectiveProxy("  ", 8080, "https://api.openai.com/v1");
        assertThat(((InetSocketAddress) defaultHostProxy.address()).getHostString()).isEqualTo("127.0.0.1");

        // Loopback target bypasses auto-proxy detection
        Proxy loopbackBypass = AiProxyResolver.resolveEffectiveProxy(null, null, "http://127.0.0.1:11434/v1");
        assertThat(loopbackBypass).isEqualTo(Proxy.NO_PROXY);

        ProxySelector selector = AiProxyResolver.resolveEffectiveProxySelector("127.0.0.1", 7890, "https://api.openai.com/v1");
        assertThat(selector).isNotEqualTo(HttpClient.Builder.NO_PROXY);

        ProxySelector loopbackSelector = AiProxyResolver.resolveEffectiveProxySelector(null, null, "http://localhost:11434/v1");
        assertThat(loopbackSelector).isEqualTo(HttpClient.Builder.NO_PROXY);

        // Invalid port or unsafe proxy host rejected
        assertThatThrownBy(() -> AiProxyResolver.resolveEffectiveProxy("127.0.0.1", 0, "https://api.openai.com"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Invalid proxy port");
        assertThatThrownBy(() -> AiProxyResolver.resolveEffectiveProxy("127.0.0.1", 65536, "https://api.openai.com"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AiProxyResolver.resolveEffectiveProxy("10.0.0.1", 8080, "https://api.openai.com"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Forbidden proxyHost");

        // buildHttpClient caches identically configured clients
        HttpClient c1 = AiProxyResolver.buildHttpClient("127.0.0.1", 7890, "https://api.openai.com/v1");
        HttpClient c2 = AiProxyResolver.buildHttpClient("127.0.0.1", 7890, "https://api.openai.com/v1");
        assertThat(c1).isSameAs(c2);

        HttpClient localClient = AiProxyResolver.buildHttpClient(null, null, "http://127.0.0.1:11434/v1");
        assertThat(localClient).isNotNull();

        // Loopback variations: expanded IPv6 & mixed-case localhost
        assertThat(AiProxyResolver.isLoopbackUrl("http://[0:0:0:0:0:0:0:1]:11434/v1")).isTrue();
        assertThat(AiProxyResolver.isLoopbackUrl("http://LOCALHOST:8080/v1")).isTrue();
        assertThat(AiProxyResolver.isLoopbackUrl("mailto:user@example.com")).isFalse();

        // External target without custom proxy uses system/env/detected proxy or NO_PROXY cleanly
        Proxy extProxy = AiProxyResolver.resolveEffectiveProxy(null, null, "https://api.openai.com/v1");
        assertThat(extProxy).isNotNull();
        ProxySelector extSelector = AiProxyResolver.resolveEffectiveProxySelector(null, null, "https://api.openai.com/v1");
        assertThat(extSelector).isNotNull();
        HttpClient extClient = AiProxyResolver.buildHttpClient(null, null, "https://api.openai.com/v1");
        assertThat(extClient).isNotNull();
    }
}
