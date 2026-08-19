<script setup lang="ts">
import { useConnectionStore } from '@/stores/connection'
import { useI18n } from 'vue-i18n'

const conn = useConnectionStore()
const { t } = useI18n()

async function handleReconnect() {
  await conn.reconnectNow()
}
</script>

<template>
  <div class="status-container">
    <div class="connection-status" :class="conn.status">
      <span class="material-icons status-icon">{{ conn.statusIcon }}</span>
      <span class="status-label">{{ t('connection.' + (conn.status === 'waiting' ? 'host_online' : conn.status)) }}</span>
    </div>

    <!-- Long Offline Reconnect Button -->
    <button
      v-if="conn.isLongOffline || conn.isOffline"
      class="reconnect-btn"
      :disabled="conn.isReconnecting"
      @click="handleReconnect"
    >
      <span class="material-icons btn-icon" :class="{ spinning: conn.isReconnecting }">
        {{ conn.isReconnecting ? 'sync' : 'refresh' }}
      </span>
      <span>{{ t('connection.reconnect_now') }}</span>
    </button>
  </div>
</template>

<style scoped>
.status-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.connection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  background: var(--input);
  color: var(--muted-foreground);
  transition: all 0.3s ease;
}

.status-icon {
  font-size: 16px;
}

.connection-status.connected {
  background: var(--card);
  color: var(--status-success);
  box-shadow: 0 0 10px rgba(34, 197, 94, 0.4);
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.connection-status.connecting {
  background: var(--card);
  color: var(--status-warning);
}
.connection-status.connecting .status-icon {
  animation: spin 1.5s linear infinite;
}

.connection-status.offline {
  background: var(--card);
  color: var(--status-error);
}

.connection-status.long_offline {
  background: var(--card);
  color: #f97316;
  border: 1px solid rgba(249, 115, 22, 0.4);
  box-shadow: 0 0 8px rgba(249, 115, 22, 0.3);
}

.connection-status.degraded {
  background: var(--card);
  color: var(--status-warning);
  border: 1px solid var(--status-warning);
}

.connection-status.unstable {
  background: var(--card);
  color: var(--status-warning);
  box-shadow: 0 0 8px rgba(234, 179, 8, 0.4);
}
.connection-status.unstable .status-icon {
  animation: pulse 1s infinite;
}

.connection-status.waiting {
  background: var(--card);
  color: var(--primary);
  box-shadow: var(--glow-primary);
}
.connection-status.waiting .status-icon {
  animation: pulse 2s infinite;
}

.reconnect-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  background: rgba(249, 115, 22, 0.15);
  color: #f97316;
  border: 1px solid rgba(249, 115, 22, 0.35);
  cursor: pointer;
  transition: all 0.2s ease;
}

.reconnect-btn:hover:not(:disabled) {
  background: rgba(249, 115, 22, 0.25);
  border-color: #f97316;
}

.reconnect-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-icon {
  font-size: 14px;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  100% { transform: rotate(360deg); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
