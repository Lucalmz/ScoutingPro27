<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useConnectionStore } from '@/stores/connection'
import { useEventStore } from '@/stores/events'
import { useI18n } from 'vue-i18n'
import {
  diagnosticLogs,
  clearDiagnosticLogs,
  exportDiagnosticReport,
  type LogLevel
} from '@/utils/logger'
import { hapticLight, hapticSuccess } from '@/utils/haptics'

const conn = useConnectionStore()
const eventStore = useEventStore()

let t = (key: string, paramsOrDef?: any, defaultMsg?: string) => {
  if (typeof defaultMsg === 'string') return defaultMsg
  if (typeof paramsOrDef === 'string') return paramsOrDef
  return key
}

try {
  const i18n = useI18n()
  t = i18n.t
} catch {
  // Fallback for unit tests mounting App.vue without i18n instance
}

const isOpen = computed(() => conn.isDiagnosticsModalOpen)

const selectedLevel = ref<LogLevel | 'all'>('all')
const selectedTag = ref<string>('ALL')
const searchQuery = ref('')
const autoScroll = ref(true)
const isCopied = ref(false)
const expandedLogs = ref<Set<number>>(new Set())

const logContainerRef = ref<HTMLElement | null>(null)

const isHost = computed(() => Boolean(eventStore.isHost && !conn.isStandbyHost))

const availableTags = computed(() => {
  const tags = new Set<string>()
  for (const item of diagnosticLogs.value) {
    tags.add(item.tag)
  }
  return Array.from(tags).sort()
})

const filteredLogs = computed(() => {
  return diagnosticLogs.value.filter((log) => {
    // Level filter
    if (selectedLevel.value !== 'all' && log.level !== selectedLevel.value) {
      return false
    }
    // Tag filter
    if (selectedTag.value !== 'ALL' && log.tag !== selectedTag.value) {
      return false
    }
    // Search query filter
    if (searchQuery.value.trim()) {
      const q = searchQuery.value.trim().toLowerCase()
      const matchMsg = log.message.toLowerCase().includes(q)
      const matchTag = log.tag.toLowerCase().includes(q)
      const matchData = log.data ? JSON.stringify(log.data).toLowerCase().includes(q) : false
      if (!matchMsg && !matchTag && !matchData) {
        return false
      }
    }
    return true
  })
})

function toggleExpand(id: number) {
  if (expandedLogs.value.has(id)) {
    expandedLogs.value.delete(id)
  } else {
    expandedLogs.value.add(id)
  }
}

function handleClose() {
  hapticLight()
  conn.closeDiagnosticsModal()
}

function handleClear() {
  hapticLight()
  clearDiagnosticLogs()
  expandedLogs.value.clear()
}

async function handleCopy() {
  hapticSuccess()
  const report = exportDiagnosticReport({
    role: isHost.value ? 'Host' : conn.isStandbyHost ? 'Standby Host' : 'Client',
    status: conn.status,
    transport: conn.transportInfo,
    pendingSasCount: conn.pendingSasQueue.length,
    eventName: eventStore.currentEvent?.name,
    inviteCode: eventStore.currentEvent?.inviteCode
  })

  try {
    await navigator.clipboard.writeText(report)
    isCopied.value = true
    setTimeout(() => {
      isCopied.value = false
    }, 2200)
  } catch {
    // Fallback for non-secure contexts or older browsers
    const textarea = document.createElement('textarea')
    textarea.value = report
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    isCopied.value = true
    setTimeout(() => {
      isCopied.value = false
    }, 2200)
  }
}

// Auto scroll to bottom on new logs
watch(
  () => diagnosticLogs.value.length,
  async () => {
    if (autoScroll.value && isOpen.value) {
      await nextTick()
      if (logContainerRef.value) {
        logContainerRef.value.scrollTop = logContainerRef.value.scrollHeight
      }
    }
  }
)

watch(isOpen, async (val) => {
  if (val) {
    await nextTick()
    if (logContainerRef.value) {
      logContainerRef.value.scrollTop = logContainerRef.value.scrollHeight
    }
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="diag-fade">
      <div v-if="isOpen" class="diag-overlay" @click.self="handleClose">
        <div class="diag-card" role="dialog" aria-modal="true">
          <!-- Modal Header -->
          <div class="diag-header">
            <div class="diag-header-title">
              <span class="material-icons diag-title-icon">terminal</span>
              <div>
                <h2>{{ t('diagnostics.modal_title', 'WebRTC 连接与链路诊断') }}</h2>
                <span class="diag-subtitle">
                  {{ t('diagnostics.buffer_count', { count: diagnosticLogs.length, max: 300 }, `已缓存 ${diagnosticLogs.length} 条诊断事件 (上限 300)`) }}
                </span>
              </div>
            </div>
            <button class="diag-close-btn" @click="handleClose" :title="t('common.close', '关闭')">
              <span class="material-icons">close</span>
            </button>
          </div>

          <!-- Quick Overview Cards -->
          <div class="diag-overview-grid">
            <div class="overview-item">
              <span class="overview-label">{{ t('event.role', '角色') }}</span>
              <span class="overview-val font-semibold">
                {{ isHost ? t('event.host', '主机') : conn.isStandbyHost ? t('event.standby_host', '次级待命主机') : t('event.client', '从机节点') }}
              </span>
            </div>

            <div class="overview-item">
              <span class="overview-label">{{ t('connection.status', '链路状态') }}</span>
              <span class="overview-val" :class="conn.status">
                <span class="material-icons inline-icon">{{ conn.statusIcon }}</span>
                {{ conn.status }}
              </span>
            </div>

            <div class="overview-item">
              <span class="overview-label">{{ t('connection.transport', '传输拓扑') }}</span>
              <span class="overview-val">
                {{ conn.transportInfo?.type || 'unknown' }}
                <span v-if="conn.transportInfo?.rttMs !== null" class="rtt-badge">
                  {{ conn.transportInfo?.rttMs }}ms
                </span>
              </span>
            </div>

            <div class="overview-item">
              <span class="overview-label">{{ t('connection.sas_state', '安全核验 (SAS)') }}</span>
              <span class="overview-val sas-val">
                {{ conn.transportInfo?.securityFingerprint || 'None' }}
              </span>
            </div>
          </div>

          <!-- Transport Pair Details (if available) -->
          <div v-if="conn.transportInfo?.selectedCandidatePair" class="diag-transport-detail">
            <span class="material-icons detail-icon">router</span>
            <span class="detail-text font-mono">
              {{ conn.transportInfo.selectedCandidatePair }}
            </span>
          </div>

          <!-- Relay Notice Banner -->
          <div v-if="conn.transportInfo?.type === 'relay'" class="diag-relay-notice">
            <span class="material-icons relay-notice-icon">info</span>
            <span class="relay-notice-text">
              当前通过 TURN 中继中转。若两端均具备公网 IPv6 环境，系统将自动优先采用 IPv6 P2P 直连。
            </span>
          </div>

          <!-- Log Controls & Filters -->
          <div class="diag-toolbar">
            <div class="filter-group">
              <!-- Level Filter -->
              <div class="level-pills">
                <button
                  type="button"
                  class="pill-btn"
                  :class="{ active: selectedLevel === 'all' }"
                  @click="selectedLevel = 'all'"
                >
                  {{ t('diagnostics.filter_all', '全部') }}
                </button>
                <button
                  type="button"
                  class="pill-btn level-error"
                  :class="{ active: selectedLevel === 'error' }"
                  @click="selectedLevel = 'error'"
                >
                  ERROR
                </button>
                <button
                  type="button"
                  class="pill-btn level-warn"
                  :class="{ active: selectedLevel === 'warn' }"
                  @click="selectedLevel = 'warn'"
                >
                  WARN
                </button>
                <button
                  type="button"
                  class="pill-btn level-info"
                  :class="{ active: selectedLevel === 'info' }"
                  @click="selectedLevel = 'info'"
                >
                  INFO
                </button>
                <button
                  type="button"
                  class="pill-btn level-debug"
                  :class="{ active: selectedLevel === 'debug' }"
                  @click="selectedLevel = 'debug'"
                >
                  DEBUG
                </button>
              </div>

              <!-- Module Filter Dropdown -->
              <select v-model="selectedTag" class="tag-select">
                <option value="ALL">{{ t('diagnostics.all_modules', '所有模块') }}</option>
                <option v-for="tag in availableTags" :key="tag" :value="tag">
                  {{ tag }}
                </option>
              </select>
            </div>

            <div class="search-group">
              <div class="search-wrap">
                <span class="material-icons search-icon">search</span>
                <input
                  v-model="searchQuery"
                  type="text"
                  class="search-input"
                  :placeholder="t('diagnostics.search_placeholder', '搜索日志内容...')"
                />
                <button v-if="searchQuery" class="clear-search-btn" @click="searchQuery = ''">
                  <span class="material-icons">clear</span>
                </button>
              </div>

              <label class="autoscroll-toggle" :title="t('diagnostics.autoscroll', '自动滚动到底部')">
                <input v-model="autoScroll" type="checkbox" />
                <span>{{ t('diagnostics.autoscroll_short', '自动滚动') }}</span>
              </label>
            </div>
          </div>

          <!-- Log Viewer Console Area -->
          <div ref="logContainerRef" class="diag-console">
            <div v-if="filteredLogs.length === 0" class="empty-logs">
              <span class="material-icons empty-icon">notes</span>
              <p>{{ t('diagnostics.no_logs_found', '暂无符合条件的诊断日志') }}</p>
            </div>

            <div
              v-for="log in filteredLogs"
              :key="log.id"
              class="log-row"
              :class="['level-' + log.level.toLowerCase()]"
            >
              <div class="log-meta">
                <span class="log-time">{{ log.time }}</span>
                <span class="log-badge" :class="'badge-' + log.level.toLowerCase()">
                  {{ log.level }}
                </span>
                <span class="log-tag">{{ log.tag }}</span>
              </div>

              <div class="log-content">
                <span class="log-message">{{ log.message }}</span>

                <!-- Expandable Payload Toggle -->
                <button
                  v-if="log.data !== undefined"
                  type="button"
                  class="btn-expand-payload"
                  @click="toggleExpand(log.id)"
                >
                  <span class="material-icons expand-icon" :class="{ 'is-expanded': expandedLogs.has(log.id) }">
                    chevron_right
                  </span>
                  <span>{{ expandedLogs.has(log.id) ? t('diagnostics.hide_payload', '收起数据') : t('diagnostics.view_payload', '查看详情') }}</span>
                </button>

                <!-- Expanded JSON Payload -->
                <div v-if="log.data !== undefined && expandedLogs.has(log.id)" class="log-payload">
                  <pre>{{ JSON.stringify(log.data, null, 2) }}</pre>
                </div>
              </div>
            </div>
          </div>

          <!-- Modal Footer Actions -->
          <div class="diag-footer">
            <button type="button" class="btn btn-secondary btn-clear" @click="handleClear">
              <span class="material-icons">delete_sweep</span>
              {{ t('diagnostics.clear_logs', '清空') }}
            </button>

            <div class="footer-right">
              <button
                type="button"
                class="btn btn-primary btn-copy"
                :class="{ 'is-copied': isCopied }"
                @click="handleCopy"
              >
                <span class="material-icons">{{ isCopied ? 'done' : 'content_copy' }}</span>
                <span>{{ isCopied ? t('diagnostics.copied_to_clipboard', '已复制报告！') : t('diagnostics.copy_report', '复制完整诊断报告') }}</span>
              </button>

              <button type="button" class="btn btn-secondary" @click="handleClose">
                {{ t('common.close', '关闭') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.diag-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.82);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: 16px;
  animation: diag-fade-in 0.2s ease-out;
}

.diag-card {
  background: #0f172a;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 16px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.65);
  width: 100%;
  max-width: 960px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #f1f5f9;
}

/* Header */
.diag-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  background: rgba(30, 41, 59, 0.85);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.diag-header-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.diag-title-icon {
  font-size: 26px;
  color: #38bdf8;
}

.diag-header-title h2 {
  font-size: 1.15rem;
  font-weight: 700;
  margin: 0;
  color: #ffffff;
}

.diag-subtitle {
  font-size: 0.78rem;
  color: #94a3b8;
}

.diag-close-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.diag-close-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

/* Overview Cards */
.diag-overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  padding: 12px 20px;
  background: #1e293b;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.overview-item {
  display: flex;
  flex-direction: column;
  background: rgba(15, 23, 42, 0.65);
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.overview-label {
  font-size: 0.72rem;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.overview-val {
  font-size: 0.88rem;
  color: #e2e8f0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.overview-val.connected {
  color: #34d399;
}

.overview-val.connecting {
  color: #fbbf24;
}

.overview-val.offline {
  color: #f87171;
}

.inline-icon {
  font-size: 16px;
}

.rtt-badge {
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  font-size: 0.75rem;
  padding: 1px 6px;
  border-radius: 4px;
  font-family: monospace;
}

.sas-val {
  font-family: monospace;
  letter-spacing: 1px;
}

/* Transport detail */
.diag-transport-detail {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 20px;
  background: rgba(15, 23, 42, 0.9);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 0.78rem;
  color: #38bdf8;
  overflow-x: auto;
}

.detail-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.detail-text {
  white-space: nowrap;
}

/* Relay notice banner */
.diag-relay-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 20px;
  background: rgba(245, 158, 11, 0.12);
  border-bottom: 1px solid rgba(245, 158, 11, 0.25);
  font-size: 0.78rem;
  color: #fbbf24;
}

.relay-notice-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.relay-notice-text {
  line-height: 1.4;
}

/* Toolbar */
.diag-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 20px;
  background: #0f172a;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.filter-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.level-pills {
  display: flex;
  background: #1e293b;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.pill-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}

.pill-btn:hover {
  color: #f1f5f9;
}

.pill-btn.active {
  background: #334155;
  color: #ffffff;
}

.pill-btn.level-error.active {
  background: #ef4444;
  color: #ffffff;
}

.pill-btn.level-warn.active {
  background: #f59e0b;
  color: #ffffff;
}

.pill-btn.level-info.active {
  background: #0284c7;
  color: #ffffff;
}

.pill-btn.level-debug.active {
  background: #64748b;
  color: #ffffff;
}

.tag-select {
  background: #1e293b;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  color: #e2e8f0;
  font-size: 0.78rem;
  padding: 5px 8px;
  outline: none;
  cursor: pointer;
}

.search-group {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-grow: 1;
  justify-content: flex-end;
}

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 180px;
  max-width: 260px;
  width: 100%;
}

.search-icon {
  position: absolute;
  left: 8px;
  font-size: 16px;
  color: #64748b;
  pointer-events: none;
}

.search-input {
  width: 100%;
  background: #1e293b;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  color: #ffffff;
  font-size: 0.8rem;
  padding: 5px 28px 5px 30px;
  outline: none;
}

.search-input:focus {
  border-color: #38bdf8;
}

.clear-search-btn {
  position: absolute;
  right: 4px;
  background: transparent;
  border: none;
  color: #64748b;
  cursor: pointer;
  display: flex;
  align-items: center;
}

.clear-search-btn span {
  font-size: 16px;
}

.autoscroll-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.75rem;
  color: #94a3b8;
  cursor: pointer;
  user-select: none;
}

/* Console Area */
.diag-console {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  background: #090d16;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.78rem;
  min-height: 280px;
}

.empty-logs {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 0;
  color: #64748b;
  gap: 8px;
}

.empty-icon {
  font-size: 36px;
  opacity: 0.5;
}

.log-row {
  display: flex;
  flex-direction: column;
  padding: 6px 8px;
  border-radius: 6px;
  margin-bottom: 4px;
  border-left: 3px solid transparent;
  transition: background 0.1s;
}

.log-row:hover {
  background: rgba(255, 255, 255, 0.03);
}

.log-row.level-error {
  border-left-color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
}

.log-row.level-warn {
  border-left-color: #f59e0b;
  background: rgba(245, 158, 11, 0.06);
}

.log-row.level-info {
  border-left-color: #0284c7;
}

.log-row.level-debug {
  border-left-color: #64748b;
  opacity: 0.85;
}

.log-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
}

.log-time {
  color: #64748b;
  font-size: 0.72rem;
}

.log-badge {
  font-size: 0.65rem;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 4px;
  text-transform: uppercase;
}

.badge-error {
  background: rgba(239, 68, 68, 0.25);
  color: #f87171;
}

.badge-warn {
  background: rgba(245, 158, 11, 0.25);
  color: #fbbf24;
}

.badge-info {
  background: rgba(2, 132, 199, 0.25);
  color: #38bdf8;
}

.badge-debug {
  background: rgba(100, 116, 139, 0.25);
  color: #94a3b8;
}

.log-tag {
  color: #cbd5e1;
  font-weight: 600;
  font-size: 0.72rem;
}

.log-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 2px;
}

.log-message {
  color: #f1f5f9;
  word-break: break-word;
  line-height: 1.4;
}

.level-error .log-message {
  color: #fca5a5;
}

.level-warn .log-message {
  color: #fde047;
}

.btn-expand-payload {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #94a3b8;
  font-size: 0.7rem;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  margin-top: 2px;
}

.btn-expand-payload:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #ffffff;
}

.expand-icon {
  font-size: 14px;
  transition: transform 0.15s;
}

.expand-icon.is-expanded {
  transform: rotate(90deg);
}

.log-payload {
  background: #030712;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 8px;
  margin-top: 4px;
  overflow-x: auto;
}

.log-payload pre {
  margin: 0;
  font-size: 0.72rem;
  color: #a5f3fc;
  white-space: pre-wrap;
  word-break: break-all;
}

/* Footer */
.diag-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: #1e293b;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  border: none;
}

.btn-secondary {
  background: #334155;
  color: #f1f5f9;
}

.btn-secondary:hover {
  background: #475569;
}

.btn-primary {
  background: #0284c7;
  color: #ffffff;
}

.btn-primary:hover {
  background: #0369a1;
}

.btn-copy.is-copied {
  background: #16a34a;
  color: #ffffff;
}

.btn-clear {
  color: #f87171;
  background: rgba(239, 68, 68, 0.12);
}

.btn-clear:hover {
  background: rgba(239, 68, 68, 0.22);
}

/* Modal Transition */
.diag-fade-enter-active,
.diag-fade-leave-active {
  transition: opacity 0.2s ease;
}

.diag-fade-enter-from,
.diag-fade-leave-to {
  opacity: 0;
}

@keyframes diag-fade-in {
  from { opacity: 0; transform: scale(0.98); }
  to { opacity: 1; transform: scale(1); }
}

@media (max-width: 640px) {
  .diag-card {
    max-height: 95vh;
  }
  .diag-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  .search-group {
    justify-content: space-between;
  }
  .search-wrap {
    max-width: none;
  }
}
</style>
