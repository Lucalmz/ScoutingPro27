<script setup lang="ts">
import { useConnectionStore } from '@/stores/connection'
import { useI18n } from 'vue-i18n'

const conn = useConnectionStore()
const { t } = useI18n()
</script>

<template>
  <div class="connection-status" :class="conn.status">
    <span class="material-icons status-icon">{{ conn.statusIcon }}</span>
    <span class="status-label">{{ t('connection.' + (conn.status === 'waiting' ? 'host_online' : conn.status)) }}</span>
  </div>
</template>

<style scoped>
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

.connection-status.waiting {
  background: var(--card);
  color: var(--primary);
  box-shadow: var(--glow-primary);
}
.connection-status.waiting .status-icon {
  animation: pulse 2s infinite;
}

@keyframes spin {
  100% { transform: rotate(360deg); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
