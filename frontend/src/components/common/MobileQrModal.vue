<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import QRCode from 'qrcode'
import { useToastStore } from '@/stores/toast'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  modelValue: boolean
  inviteCode: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const toastStore = useToastStore()
const { t } = useI18n()

const loading = ref(false)
const mode = ref<'lan' | 'ipv6'>('lan')
const activeTroubleshootTab = ref<'windows' | 'macos'>('windows')
const networkInfo = ref<{
  os?: string
  isWindows?: boolean
  isMac?: boolean
  primaryIp: string
  allIps: string[]
  primaryIpv6?: string | null
  allIpv6s?: string[]
  port: number
  joinBaseUrl?: string
  joinBaseUrlIpv6?: string
  firewallCommand?: string
  macFirewallCommand?: string
  firewallAllowed?: boolean
} | null>(null)

const selectedIp = ref('')
const selectedIpv6 = ref('')
const qrCanvasRef = ref<HTMLCanvasElement | null>(null)
const copied = ref(false)
const copiedPcLink = ref(false)

const hasIpv6 = computed(() => {
  return !!(networkInfo.value?.primaryIpv6 || (networkInfo.value?.allIpv6s && networkInfo.value.allIpv6s.length > 0))
})

const joinUrl = computed(() => {
  const port = networkInfo.value?.port || (typeof window !== 'undefined' ? window.location.port || '8080' : '8080')
  if (mode.value === 'ipv6') {
    const rawIp6 = selectedIpv6.value || networkInfo.value?.primaryIpv6 || (networkInfo.value?.allIpv6s && networkInfo.value.allIpv6s[0]) || ''
    if (!rawIp6) return ''
    const cleanIp6 = rawIp6.replace(/[\[\]]/g, '').split('%')[0]
    return `http://[${cleanIp6}]:${port}/#/?join=${props.inviteCode}`
  }
  const ip = selectedIp.value || networkInfo.value?.primaryIp || '127.0.0.1'
  return `http://${ip}:${port}/#/?join=${props.inviteCode}`
})

async function fetchNetworkInfo() {
  loading.value = true
  try {
    const res = await fetch('/api/system/network-info')
    if (res.ok) {
      const data = await res.json()
      networkInfo.value = data
      selectedIp.value = data.primaryIp || (data.allIps && data.allIps[0]) || '127.0.0.1'
      if (data.primaryIpv6) {
        selectedIpv6.value = data.primaryIpv6
      } else if (data.allIpv6s && data.allIpv6s.length > 0) {
        selectedIpv6.value = data.allIpv6s[0]
      }

      if (data.isMac || (data.os === 'macos') || (typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('mac'))) {
        activeTroubleshootTab.value = 'macos'
      } else {
        activeTroubleshootTab.value = 'windows'
      }
    }
  } catch (e) {
    console.warn('[MobileQrModal] Failed to fetch network info:', e)
  } finally {
    loading.value = false
    await nextTick()
    renderQrCode()
  }
}

async function renderQrCode() {
  if (!qrCanvasRef.value || !joinUrl.value) return
  try {
    await QRCode.toCanvas(qrCanvasRef.value, joinUrl.value, {
      width: 200,
      margin: 2,
      color: {
        dark: '#111827',
        light: '#ffffff'
      }
    })
  } catch (err) {
    console.error('[MobileQrModal] QR render failed:', err)
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      fetchNetworkInfo()
    }
  },
  { immediate: true }
)

watch([selectedIp, selectedIpv6, mode], async () => {
  await nextTick()
  renderQrCode()
})

async function copyUrl() {
  if (!joinUrl.value) return
  try {
    await navigator.clipboard.writeText(joinUrl.value)
    copied.value = true
    toastStore.showToast(t('qr_modal.copied'), 'success')
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch (e) {
    toastStore.showError(t('qr_modal.copy_failed'))
  }
}

async function copyPcLink() {
  if (!joinUrl.value) return
  try {
    await navigator.clipboard.writeText(joinUrl.value)
    copiedPcLink.value = true
    toastStore.showToast(t('qr_modal.copied'), 'success')
    setTimeout(() => {
      copiedPcLink.value = false
    }, 2000)
  } catch (e) {
    toastStore.showError(t('qr_modal.copy_failed'))
  }
}

const runningFirewallCmd = ref(false)
const copiedFirewallCmd = ref(false)
const copiedMacCmd = ref(false)

const firewallCommand = computed(() => {
  if (networkInfo.value?.firewallCommand) {
    return networkInfo.value.firewallCommand
  }
  const port = networkInfo.value?.port || (typeof window !== 'undefined' ? window.location.port || '8080' : '8080')
  return `netsh advfirewall firewall add rule name="ScoutingPro27 Inbound (${port})" dir=in action=allow protocol=TCP localport=${port} profile=any`
})

async function runFirewallCmd() {
  runningFirewallCmd.value = true
  // 1. 同步复制到剪贴板，双保险
  try {
    await navigator.clipboard.writeText(firewallCommand.value)
  } catch (ignored) {}

  // 2. 调用后台接口唤起管理员权限执行放行
  try {
    const res = await fetch('/api/system/open-firewall-cmd', { method: 'POST' })
    if (res.ok) {
      const data = await res.json().catch(() => null)
      if (data && (data.success || data.allowed)) {
        if (networkInfo.value) {
          networkInfo.value.firewallAllowed = true
        }
        toastStore.showToast(t('qr_modal.run_cmd_success'), 'success')
      } else {
        toastStore.showToast(t('qr_modal.run_cmd_failed'), 'warning')
      }
    } else {
      toastStore.showToast(t('qr_modal.run_cmd_failed'), 'warning')
    }
  } catch (err) {
    console.warn('[MobileQrModal] Failed to trigger open-firewall-cmd:', err)
    toastStore.showToast(t('qr_modal.run_cmd_failed'), 'warning')
  } finally {
    runningFirewallCmd.value = false
  }
}

async function copyFirewallCmd() {
  try {
    await navigator.clipboard.writeText(firewallCommand.value)
    copiedFirewallCmd.value = true
    toastStore.showToast(t('qr_modal.copy_cmd_success'), 'success')
    setTimeout(() => {
      copiedFirewallCmd.value = false
    }, 2000)
  } catch (err) {
    toastStore.showError(t('qr_modal.copy_failed'))
  }
}

async function copyMacCmd() {
  try {
    await navigator.clipboard.writeText(macFirewallCommand.value)
    copiedMacCmd.value = true
    toastStore.showToast(t('qr_modal.copy_cmd_success'), 'success')
    setTimeout(() => {
      copiedMacCmd.value = false
    }, 2000)
  } catch (err) {
    toastStore.showError(t('qr_modal.copy_failed'))
  }
}

const macFirewallCommand = computed(() => {
  if (networkInfo.value?.macFirewallCommand) {
    return networkInfo.value.macFirewallCommand
  }
  return 'sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off'
})

function getIpBadge(ip: string): string {
  if (ip.startsWith('192.168.137.')) {
    return t('qr_modal.nic_win_hotspot')
  }
  if (ip.startsWith('172.20.10.')) {
    return t('qr_modal.nic_ios_hotspot')
  }
  if (ip === networkInfo.value?.primaryIp) {
    return t('qr_modal.recommended')
  }
  return ''
}

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="qr-modal-backdrop" @click.self="close">
      <div class="qr-modal-dialog">
        <!-- 头部 -->
        <div class="qr-modal-header">
          <div class="title-with-icon">
            <span class="material-icons header-icon">devices</span>
            <h3>{{ t('qr_modal.title') }}</h3>
          </div>
          <button class="close-btn" @click="close" :aria-label="t('common.close', 'Close')">
            <span class="material-icons">close</span>
          </button>
        </div>

        <!-- 主体 -->
        <div class="qr-modal-body">
          <!-- 模式切换：局域网 Wi-Fi 模式 vs 公网 IPv6 远程直连 -->
          <div class="network-mode-tabs">
            <button
              type="button"
              class="mode-tab-btn"
              :class="{ active: mode === 'lan' }"
              @click="mode = 'lan'"
            >
              <span class="material-icons">wifi</span>
              <span>{{ t('qr_modal.mode_lan') }}</span>
            </button>
            <button
              type="button"
              class="mode-tab-btn"
              :class="{ active: mode === 'ipv6' }"
              @click="mode = 'ipv6'"
            >
              <span class="material-icons">public</span>
              <span>{{ t('qr_modal.mode_ipv6') }}</span>
            </button>
          </div>

          <p class="subtitle">
            {{ mode === 'ipv6' ? t('qr_modal.troubleshoot_ipv6_desc') : t('qr_modal.subtitle') }}
          </p>

          <!-- 邀请码高亮框 -->
          <div class="code-badge-bar">
            <span class="code-label">{{ t('qr_modal.invite_code_label') }}</span>
            <span class="code-value">{{ inviteCode }}</span>
          </div>

          <!-- IPv6 模式状态徽章 -->
          <div v-if="mode === 'ipv6' && hasIpv6" class="ipv6-status-badge">
            <span class="material-icons badge-icon">bolt</span>
            <span>{{ t('qr_modal.ipv6_ready_badge') }}</span>
          </div>

          <!-- IPv6 未检测到提示 -->
          <div v-else-if="mode === 'ipv6' && !hasIpv6 && !loading" class="ipv6-warn-box">
            <span class="material-icons warn-icon">info</span>
            <div class="warn-content">
              <strong>{{ t('qr_modal.ipv6_not_found_title') }}</strong>
              <p>{{ t('qr_modal.ipv6_not_found_desc') }}</p>
            </div>
          </div>

          <!-- 二维码展示区 -->
          <div v-if="mode === 'lan' || hasIpv6" class="qr-canvas-container">
            <div v-if="loading" class="qr-loading-placeholder">
              <span class="material-icons spinning">refresh</span>
              <span>{{ t('qr_modal.detecting_ip') }}</span>
            </div>
            <canvas ref="qrCanvasRef" :style="{ display: loading ? 'none' : 'block' }"></canvas>
          </div>

          <!-- 局域网 IPv4 切换下拉框 -->
          <div v-if="mode === 'lan'" class="nic-selector-row">
            <label for="nic-select">{{ t('qr_modal.select_ip') }}</label>
            <div class="nic-controls">
              <select id="nic-select" v-model="selectedIp">
                <option v-for="ip in (networkInfo?.allIps || [selectedIp])" :key="ip" :value="ip">
                  {{ ip }} {{ getIpBadge(ip) }}
                </option>
              </select>
              <button class="btn-refresh" :disabled="loading" @click="fetchNetworkInfo" :title="t('qr_modal.refresh_network')">
                <span class="material-icons" :class="{ spinning: loading }">refresh</span>
                <span>{{ loading ? t('qr_modal.refreshing') : t('qr_modal.refresh_network') }}</span>
              </button>
            </div>
          </div>

          <!-- 公网 IPv6 切换下拉框 -->
          <div v-else-if="mode === 'ipv6' && hasIpv6 && networkInfo?.allIpv6s && networkInfo.allIpv6s.length > 1" class="nic-selector-row">
            <label for="nic-ipv6-select">{{ t('qr_modal.select_ipv6') }}</label>
            <div class="nic-controls">
              <select id="nic-ipv6-select" v-model="selectedIpv6">
                <option v-for="ip6 in networkInfo.allIpv6s" :key="ip6" :value="ip6">
                  {{ ip6 }} {{ ip6 === networkInfo?.primaryIpv6 ? t('qr_modal.recommended') : '' }}
                </option>
              </select>
              <button class="btn-refresh" :disabled="loading" @click="fetchNetworkInfo" :title="t('qr_modal.refresh_network')">
                <span class="material-icons" :class="{ spinning: loading }">refresh</span>
                <span>{{ loading ? t('qr_modal.refreshing') : t('qr_modal.refresh_network') }}</span>
              </button>
            </div>
          </div>

          <!-- 链接一键复制 -->
          <div v-if="mode === 'lan' || hasIpv6" class="url-copy-box">
            <input readonly :value="joinUrl" class="url-input" />
            <button class="btn-copy" @click="copyUrl">
              <span class="material-icons">{{ copied ? 'check' : 'content_copy' }}</span>
              {{ copied ? t('qr_modal.copied') : t('qr_modal.copy_url') }}
            </button>
          </div>

          <!-- 电脑端专属快捷公网直连复制按钮 -->
          <div v-if="mode === 'ipv6' && hasIpv6" class="pc-link-action-row">
            <button class="btn-copy-pc" @click="copyPcLink" :title="t('qr_modal.copy_pc_link_tooltip')">
              <span class="material-icons">{{ copiedPcLink ? 'check' : 'laptop_mac' }}</span>
              <span>{{ copiedPcLink ? t('qr_modal.copied') : t('qr_modal.copy_pc_link') }}</span>
            </button>
            <span class="pc-link-hint">{{ t('qr_modal.copy_pc_link_tooltip') }}</span>
          </div>

          <!-- 独立环境排障与 502 应对专区 -->
          <div class="troubleshoot-container">
            <div class="troubleshoot-header-bar">
              <div class="troubleshoot-title-group">
                <span class="material-icons bar-icon">build_circle</span>
                <span class="bar-title">{{ t('qr_modal.troubleshoot_accordion_title') }}</span>
              </div>
              <!-- OS 切换器 -->
              <div class="os-switcher">
                <button
                  type="button"
                  class="os-tab-btn"
                  :class="{ active: activeTroubleshootTab === 'windows' }"
                  @click="activeTroubleshootTab = 'windows'"
                >
                  <span class="material-icons os-btn-icon">laptop_windows</span>
                  <span>Windows</span>
                </button>
                <button
                  type="button"
                  class="os-tab-btn"
                  :class="{ active: activeTroubleshootTab === 'macos' }"
                  @click="activeTroubleshootTab = 'macos'"
                >
                  <span class="material-icons os-btn-icon">laptop_mac</span>
                  <span>macOS</span>
                </button>
              </div>
            </div>

            <!-- Windows 排障面板 -->
            <div v-if="activeTroubleshootTab === 'windows'" class="os-troubleshoot-panel">
              <!-- 502 Bad Gateway 深度排障 -->
              <div class="troubleshoot-502-card">
                <div class="troubleshoot-502-header">
                  <span class="material-icons warn-icon">report_problem</span>
                  <span>{{ t('qr_modal.troubleshoot_502_banner_title') }}</span>
                </div>
                <ul class="troubleshoot-502-list">
                  <li class="troubleshoot-502-item">{{ t('qr_modal.troubleshoot_502_cause_cellular') }}</li>
                  <li class="troubleshoot-502-item">{{ t('qr_modal.troubleshoot_502_cause_ap') }}</li>
                  <li class="troubleshoot-502-item">{{ t('qr_modal.troubleshoot_502_cause_ip') }}</li>
                  <li class="troubleshoot-502-item">{{ t('qr_modal.troubleshoot_502_cause_router') }}</li>
                </ul>
              </div>

              <!-- Windows 移动热点指引 -->
              <div class="hotspot-card">
                <div class="hotspot-header">
                  <span class="material-icons hotspot-icon">wifi_tethering</span>
                  <span>{{ t('qr_modal.hotspot_guide_win_title') }}</span>
                </div>
                <p class="hotspot-desc">{{ t('qr_modal.hotspot_guide_win_desc') }}</p>
              </div>

              <!-- Windows 防火墙入站放行卡片 -->
              <div class="firewall-helper-card">
                <div class="firewall-header">
                  <span class="material-icons fw-icon">security</span>
                  <span class="fw-title">{{ t('qr_modal.firewall_card_title') }}</span>
                  <span v-if="networkInfo?.firewallAllowed" class="fw-status-badge fw-allowed">
                    <span class="material-icons badge-icon">check_circle</span>
                    <span>{{ t('qr_modal.firewall_allowed') }}</span>
                  </span>
                  <span v-else class="fw-status-badge fw-optional">
                    <span class="material-icons badge-icon">info</span>
                    <span>{{ t('qr_modal.firewall_optional') }}</span>
                  </span>
                </div>
                <p class="fw-desc">{{ t('qr_modal.firewall_card_desc') }}</p>
                <div class="fw-code-box">
                  <code>{{ firewallCommand }}</code>
                </div>
                <div class="fw-actions">
                  <button class="btn-run-cmd" :disabled="runningFirewallCmd || networkInfo?.firewallAllowed" @click="runFirewallCmd" :title="t('qr_modal.run_cmd_btn')">
                    <span class="material-icons" :class="{ spinning: runningFirewallCmd }">
                      {{ runningFirewallCmd ? 'sync' : (networkInfo?.firewallAllowed ? 'check_circle' : 'bolt') }}
                    </span>
                    <span>{{ runningFirewallCmd ? t('qr_modal.run_cmd_running') : (networkInfo?.firewallAllowed ? t('qr_modal.firewall_allowed') : t('qr_modal.run_cmd_btn')) }}</span>
                  </button>
                  <button class="btn-copy-cmd" @click="copyFirewallCmd" :title="t('qr_modal.copy_cmd_btn')">
                    <span class="material-icons">{{ copiedFirewallCmd ? 'check' : 'content_copy' }}</span>
                    <span>{{ copiedFirewallCmd ? t('qr_modal.copied') : t('qr_modal.copy_cmd_btn') }}</span>
                  </button>
                </div>
              </div>
            </div>

            <!-- macOS 苹果电脑排障面板 -->
            <div v-else-if="activeTroubleshootTab === 'macos'" class="os-troubleshoot-panel">
              <div class="macos-troubleshoot-card">
                <div class="macos-header">
                  <span class="material-icons macos-icon">laptop_mac</span>
                  <span>{{ t('qr_modal.macos_card_title') }}</span>
                </div>
                <div class="macos-item">
                  <strong>{{ t('qr_modal.macos_local_network_title') }}</strong>
                  <p>{{ t('qr_modal.macos_local_network_desc') }}</p>
                </div>
                <div class="macos-item">
                  <strong>{{ t('qr_modal.macos_hotspot_title') }}</strong>
                  <p>{{ t('qr_modal.macos_hotspot_desc') }}</p>
                </div>
                <div class="macos-item">
                  <strong>{{ t('qr_modal.macos_iphone_hotspot_title') }}</strong>
                  <p>{{ t('qr_modal.macos_iphone_hotspot_desc') }}</p>
                </div>
                <div class="macos-item">
                  <strong>{{ t('qr_modal.macos_fw_title') }}</strong>
                  <p>{{ t('qr_modal.macos_fw_desc') }}</p>
                </div>
              </div>

              <!-- macOS 终端命令卡片 -->
              <div class="macos-cmd-card">
                <div class="macos-cmd-header">
                  <span class="material-icons terminal-icon">terminal</span>
                  <span class="cmd-title">{{ t('qr_modal.macos_cmd_box_title') }}</span>
                </div>
                <div class="fw-code-box">
                  <code>{{ macFirewallCommand }}</code>
                </div>
                <div class="fw-actions">
                  <button class="btn-copy-cmd" @click="copyMacCmd" :title="t('qr_modal.copy_cmd_btn')">
                    <span class="material-icons">{{ copiedMacCmd ? 'check' : 'content_copy' }}</span>
                    <span>{{ copiedMacCmd ? t('qr_modal.copied') : t('qr_modal.copy_cmd_btn') }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.qr-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  overflow-y: auto;
  box-sizing: border-box;
}

.qr-modal-dialog {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  width: 100%;
  max-width: min(530px, 95vw);
  max-height: min(88vh, 820px);
  box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: modal-scale-in 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  box-sizing: border-box;
}

@keyframes modal-scale-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.qr-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  background: var(--card);
}

.title-with-icon {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-icon {
  color: var(--primary);
  font-size: 22px;
}

.qr-modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--foreground);
}

.close-btn {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  border-radius: 6px;
}

.close-btn:hover {
  background: var(--muted);
  color: var(--foreground);
}

.qr-modal-body {
  padding: 16px 20px 24px;
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
  box-sizing: border-box;
  scroll-behavior: smooth;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}

.qr-modal-body::-webkit-scrollbar {
  width: 6px;
}

.qr-modal-body::-webkit-scrollbar-track {
  background: transparent;
}

.qr-modal-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 9999px;
}

.qr-modal-body::-webkit-scrollbar-thumb:hover {
  background: var(--muted-foreground);
}

.network-mode-tabs {
  display: flex;
  width: 100%;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 4px;
  gap: 4px;
  box-sizing: border-box;
}

.mode-tab-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: transparent;
  color: var(--muted-foreground);
  border: none;
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.mode-tab-btn .material-icons {
  font-size: 16px;
}

.mode-tab-btn.active {
  background: var(--card);
  color: var(--primary);
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(57, 255, 20, 0.3);
}

.subtitle {
  margin: 0;
  font-size: 12.5px;
  color: var(--muted-foreground);
  line-height: 1.5;
  width: 100%;
}

.code-badge-bar {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  background: rgba(59, 130, 246, 0.1);
  border: 1px dashed var(--primary);
  border-radius: 8px;
  padding: 5px 14px;
}

.code-label {
  font-size: 12px;
  color: var(--muted-foreground);
}

.code-value {
  font-size: 16px;
  font-weight: 700;
  color: var(--primary);
  letter-spacing: 1px;
}

.ipv6-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(57, 255, 20, 0.1);
  border: 1px solid rgba(57, 255, 20, 0.3);
  border-radius: 20px;
  padding: 4px 12px;
  font-size: 11px;
  color: var(--primary);
}

.ipv6-status-badge .badge-icon {
  font-size: 16px;
  color: var(--primary);
  animation: pulse-glow 1.5s infinite;
}

@keyframes pulse-glow {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(1.15); }
}

.ipv6-warn-box {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 10px;
  padding: 10px 12px;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
}

.ipv6-warn-box .warn-icon {
  color: #ef4444;
  font-size: 20px;
  flex-shrink: 0;
  margin-top: 1px;
}

.warn-content strong {
  display: block;
  font-size: 12.5px;
  color: #ef4444;
  margin-bottom: 3px;
}

.warn-content p {
  margin: 0;
  font-size: 11px;
  color: var(--muted-foreground);
  line-height: 1.4;
}

.qr-canvas-container {
  background: #ffffff;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
}

.qr-canvas-container canvas {
  max-width: 100%;
  height: auto !important;
}

.qr-loading-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: #6b7280;
  font-size: 12px;
  padding: 30px 20px;
}

.nic-selector-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--muted-foreground);
  width: 100%;
  text-align: left;
  box-sizing: border-box;
}

.nic-controls {
  display: flex;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
}

.nic-controls select {
  flex: 1;
  background: var(--background);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
}

.btn-refresh {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--card);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
}

.btn-refresh:hover:not(:disabled) {
  background: var(--accent);
}

.btn-refresh:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-refresh .material-icons {
  font-size: 15px;
}

.url-copy-box {
  display: flex;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
}

.url-input {
  flex: 1;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12px;
  color: var(--muted-foreground);
  font-family: monospace;
}

.btn-copy {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--primary);
  color: #ffffff;
  border: none;
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.2s;
}

.btn-copy:hover {
  opacity: 0.9;
}

.pc-link-action-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
  box-sizing: border-box;
}

.btn-copy-pc {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(59, 130, 246, 0.15);
  border: 1px solid rgba(59, 130, 246, 0.4);
  color: #60a5fa;
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-copy-pc:hover {
  background: rgba(59, 130, 246, 0.25);
  border-color: #60a5fa;
  box-shadow: 0 0 10px rgba(59, 130, 246, 0.3);
}

.btn-copy-pc .material-icons {
  font-size: 17px;
}

.pc-link-hint {
  font-size: 11px;
  color: var(--muted-foreground);
  line-height: 1.3;
}

/* 独立排障与适配专区样式 */
.troubleshoot-container {
  width: 100%;
  border-top: 1px solid var(--border);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-sizing: border-box;
}

.troubleshoot-header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 8px;
  box-sizing: border-box;
}

.troubleshoot-title-group {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--foreground);
}

.bar-icon {
  font-size: 17px;
  color: var(--primary);
}

.bar-title {
  font-size: 13px;
  font-weight: 600;
}

.os-switcher {
  display: flex;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}

.os-tab-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  color: var(--muted-foreground);
  border: none;
  border-radius: 6px;
  padding: 5px 9px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.os-btn-icon {
  font-size: 14px;
}

.os-tab-btn.active {
  background: var(--card);
  color: var(--foreground);
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border);
}

.os-troubleshoot-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  box-sizing: border-box;
}

.troubleshoot-502-card {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 10px;
  padding: 10px 12px;
  text-align: left;
  box-sizing: border-box;
  width: 100%;
}

.troubleshoot-502-header {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #f59e0b;
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 6px;
}

.warn-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.troubleshoot-502-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.troubleshoot-502-item {
  font-size: 11px;
  color: var(--muted-foreground);
  line-height: 1.45;
}

.hotspot-card {
  background: rgba(59, 130, 246, 0.08);
  border: 1px solid rgba(59, 130, 246, 0.25);
  border-radius: 10px;
  padding: 10px 12px;
  text-align: left;
  box-sizing: border-box;
  width: 100%;
}

.hotspot-header {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #60a5fa;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
}

.hotspot-icon {
  font-size: 16px;
}

.hotspot-desc {
  font-size: 11px;
  color: var(--muted-foreground);
  margin: 0;
  line-height: 1.45;
}

.firewall-helper-card {
  background: rgba(16, 185, 129, 0.06);
  border: 1px solid rgba(16, 185, 129, 0.25);
  border-radius: 10px;
  padding: 10px 12px;
  text-align: left;
  box-sizing: border-box;
  width: 100%;
}

.firewall-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.fw-icon {
  font-size: 16px;
  color: #10b981;
}

.fw-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground);
}

.fw-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 9999px;
  margin-left: auto;
  font-weight: 500;
}

.fw-status-badge .badge-icon {
  font-size: 13px;
}

.fw-status-badge.fw-allowed {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.fw-status-badge.fw-optional {
  background: rgba(148, 163, 184, 0.12);
  color: var(--muted-foreground);
  border: 1px solid rgba(148, 163, 184, 0.2);
}

.fw-desc {
  font-size: 11px;
  color: var(--muted-foreground);
  margin: 0 0 6px;
  line-height: 1.4;
}

.fw-code-box {
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 6px 10px;
  margin-bottom: 8px;
  overflow-x: auto;
}

.fw-code-box code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 10.5px;
  color: #34d399;
  word-break: break-all;
  white-space: pre-wrap;
}

.fw-actions {
  display: flex;
  gap: 8px;
}

.btn-run-cmd {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: linear-gradient(135deg, #10b981, #059669);
  color: #ffffff;
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 2px 6px rgba(16, 185, 129, 0.3);
}

.btn-run-cmd:hover:not(:disabled) {
  filter: brightness(1.1);
  transform: translateY(-1px);
}

.btn-run-cmd:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-run-cmd .material-icons {
  font-size: 15px;
}

.btn-copy-cmd {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: var(--foreground);
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
  white-space: nowrap;
}

.btn-copy-cmd:hover {
  background: rgba(255, 255, 255, 0.12);
}

.btn-copy-cmd .material-icons {
  font-size: 14px;
}

/* macOS 专属卡片 */
.macos-troubleshoot-card {
  background: rgba(147, 51, 234, 0.08);
  border: 1px solid rgba(147, 51, 234, 0.25);
  border-radius: 10px;
  padding: 10px 12px;
  text-align: left;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.macos-header {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #c084fc;
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 2px;
}

.macos-icon {
  font-size: 16px;
}

.macos-item strong {
  display: block;
  font-size: 11.5px;
  color: var(--foreground);
  margin-bottom: 2px;
}

.macos-item p {
  margin: 0;
  font-size: 11px;
  color: var(--muted-foreground);
  line-height: 1.4;
}

.macos-cmd-card {
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  text-align: left;
  box-sizing: border-box;
  width: 100%;
}

.macos-cmd-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: var(--muted-foreground);
}

.terminal-icon {
  font-size: 15px;
}

.cmd-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--foreground);
}

@media (max-width: 480px) {
  .qr-modal-backdrop {
    padding: 8px;
  }
  .qr-modal-body {
    padding: 12px 10px 18px;
  }
  .url-copy-box {
    flex-direction: column;
  }
  .btn-copy {
    justify-content: center;
  }
  .nic-controls {
    flex-direction: column;
  }
  .troubleshoot-header-bar {
    flex-direction: column;
    align-items: flex-start;
  }
  .os-switcher {
    width: 100%;
  }
}
</style>
