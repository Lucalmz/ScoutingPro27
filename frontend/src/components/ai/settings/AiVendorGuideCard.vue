<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { isZhLocale } from '@/components/ai/constants'
import { VENDOR_PROTOCOL_GUIDE, type VendorProtocolGuideRow } from '@/components/ai/presets'

const emit = defineEmits<{
  fill: [row: VendorProtocolGuideRow]
}>()

const { t, locale } = useI18n()
const isZh = computed(() => isZhLocale(locale.value))
</script>

<template>
  <div class="vendor-guide-card">
    <div class="vendor-guide-title">{{ t('ai.vendor_guide_title') }}</div>
    <div class="vendor-guide-scroll">
      <table class="vendor-guide-table">
        <thead>
          <tr>
            <th>{{ t('ai.vendor_col_name') }}</th>
            <th>{{ t('ai.vendor_col_protocol') }}</th>
            <th>{{ t('ai.vendor_col_base_url') }}</th>
            <th>{{ t('ai.vendor_col_key') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in VENDOR_PROTOCOL_GUIDE" :key="row.vendor">
            <td>
              <strong>{{ isZh ? row.vendorZh : row.vendorEn }}</strong>
              <div class="vg-note">{{ isZh ? row.notesZh : row.notesEn }}</div>
            </td>
            <td>
              <span class="proto-tag" :class="`proto-${row.protocol.toLowerCase()}`">{{
                isZh ? row.protocolLabelZh : row.protocolLabelEn
              }}</span>
            </td>
            <td><code class="vg-url">{{ row.baseUrl }}</code></td>
            <td><code class="vg-key">{{ row.keyFormat }}</code></td>
            <td>
              <button type="button" class="btn-fill-vendor" @click="emit('fill', row)">
                {{ t('ai.vendor_fill') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.vendor-guide-card {
  border: 1px solid var(--status-info-border);
  background: color-mix(in srgb, var(--status-info-bg) 55%, var(--surface));
  border-radius: 10px;
  padding: 10px 12px;
}

.vendor-guide-title {
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--status-info);
}

.vendor-guide-scroll {
  overflow-x: auto;
  max-height: 220px;
  overflow-y: auto;
}

.vendor-guide-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.vendor-guide-table th,
.vendor-guide-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-subtle);
  text-align: left;
  vertical-align: top;
}

.vg-note {
  color: var(--muted-foreground);
  font-size: 10px;
  margin-top: 2px;
}

.vg-url,
.vg-key {
  font-family: var(--font-mono);
  font-size: 10px;
  word-break: break-all;
}

.btn-fill-vendor {
  background: var(--surface-elevated);
  border: 1px solid var(--border-strong);
  color: var(--foreground);
  border-radius: 5px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.btn-fill-vendor:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.proto-tag {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  flex-shrink: 0;
}

.proto-openai {
  background: rgba(57, 255, 20, 0.12);
  color: var(--s-300);
  border: 1px solid var(--s-700);
}

.proto-gemini {
  background: var(--status-info-bg);
  color: var(--status-info);
  border: 1px solid var(--status-info-border);
}

.proto-anthropic {
  background: var(--status-ai-bg);
  color: var(--status-ai);
  border: 1px solid var(--status-ai-border);
}
</style>
