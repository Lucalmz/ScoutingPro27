<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ScoutingEvent, OfficialMatch, MatchScheduleItem } from '@/types'
import { useScheduleStore } from '@/stores/schedule'
import { useRecordStore } from '@/stores/records'
import { useToastStore } from '@/stores/toast'
import { fetchEventMatches } from '@/services/ftcApi'

const props = defineProps<{
  visible: boolean
  event: ScoutingEvent | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'imported', count: number): void
}>()

const { t } = useI18n()
const scheduleStore = useScheduleStore()
const recordStore = useRecordStore()
const toastStore = useToastStore()

const activeImportTab = ref<'official' | 'csv'>('official')
const isSyncingOfficial = ref(false)

// CSV Text & file
const csvText = ref('')
const importMode = ref<'replace' | 'append'>('replace')
const isParsing = ref(false)

const parsedPreview = computed<MatchScheduleItem[]>(() => {
  if (!props.event?.id || !csvText.value.trim()) return []
  return scheduleStore.parseCsvSchedule(props.event.id, csvText.value)
})

function handleClose() {
  emit('update:visible', false)
  csvText.value = ''
}

// 1. 一键同步 FTC 官方赛程与比分
async function handleSyncOfficial() {
  if (!props.event) return
  const year = props.event.ftcYear || 2025
  const code = (props.event.ftcEventCode || '').trim()

  if (!code) {
    toastStore.showToast(t('schedule.ftc_not_bound_hint') || '请先在侦察员面板绑定 FTC 官方赛事代码', 'warning')
    return
  }

  isSyncingOfficial.value = true
  try {
    // 1. 拉取官方赛程与比分
    const matches: OfficialMatch[] = await fetchEventMatches(year, code)
    if (!matches || matches.length === 0) {
      toastStore.showToast(t('schedule.ftc_no_matches_found') || `未在 FTC 官方查询到赛事 [${code}] 的赛程数据`, 'warning')
      return
    }

    // 2. 更新 recordsStore 中的官方比分
    recordStore.officialMatches = matches

    // 3. 将官方比赛映射转入赛程表
    const res = await scheduleStore.importFromFtcOfficial(
      props.event.id,
      matches,
      importMode.value === 'replace'
    )

    toastStore.showToast(
      t('schedule.sync_official_success', { count: res.count }) || `成功同步 ${res.count} 场官方赛程与比分！`,
      'success'
    )
    emit('imported', res.count)
    handleClose()
  } catch (err: any) {
    toastStore.showToast((t('schedule.sync_official_failed') || '官方赛程同步失败: ') + (err.message || ''), 'error')
  } finally {
    isSyncingOfficial.value = false
  }
}

// 2. 文件上传读取
function handleFileUpload(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = (event) => {
    const text = event.target?.result
    if (typeof text === 'string') {
      csvText.value = text
    }
  }
  reader.readAsText(file)
  target.value = ''
}

// 3. 确认 CSV 导入
async function handleConfirmCsvImport() {
  if (!props.event?.id) return
  if (parsedPreview.value.length === 0) {
    toastStore.showToast(t('schedule.csv_no_valid_rows') || '未解析出有效的赛程行，请检查格式', 'warning')
    return
  }

  isParsing.value = true
  try {
    const res = await scheduleStore.importSchedules(
      props.event.id,
      parsedPreview.value,
      importMode.value === 'replace',
      true
    )

    toastStore.showToast(
      t('schedule.csv_import_success', { count: res.count }) || `成功导入 ${res.count} 场赛程！`,
      'success'
    )
    emit('imported', res.count)
    handleClose()
  } catch (err: any) {
    toastStore.showToast((t('schedule.csv_import_failed') || '赛程导入失败: ') + (err.message || ''), 'error')
  } finally {
    isParsing.value = false
  }
}
</script>

<template>
  <Transition name="modal">
    <div v-if="visible" class="schedule-import-backdrop" @click.self="handleClose">
      <div class="schedule-import-modal">
        <header class="modal-header">
          <div class="header-title">
            <span class="material-icons header-icon">event_available</span>
            <div>
              <h3>{{ t('schedule.import_title') }}</h3>
              <p class="subtitle">{{ t('schedule.import_subtitle') }}</p>
            </div>
          </div>
          <button class="btn-close" @click="handleClose">
            <span class="material-icons">close</span>
          </button>
        </header>

        <!-- Tab 切换 -->
        <div class="import-tabs">
          <button
            class="tab-btn"
            :class="{ active: activeImportTab === 'official' }"
            @click="activeImportTab = 'official'"
          >
            <span class="material-icons">cloud_download</span>
            {{ t('schedule.tab_ftc_official') }}
          </button>
          <button
            class="tab-btn"
            :class="{ active: activeImportTab === 'csv' }"
            @click="activeImportTab = 'csv'"
          >
            <span class="material-icons">table_chart</span>
            {{ t('schedule.tab_csv_paste') }}
          </button>
        </div>

        <div class="modal-body">
          <!-- 覆盖选项 -->
          <div class="import-mode-selector">
            <span class="mode-label">{{ t('schedule.import_mode_label') }}:</span>
            <label class="radio-label">
              <input type="radio" value="replace" v-model="importMode" />
              <span>{{ t('schedule.mode_replace') }}</span>
            </label>
            <label class="radio-label">
              <input type="radio" value="append" v-model="importMode" />
              <span>{{ t('schedule.mode_append') }}</span>
            </label>
          </div>

          <!-- 模式 1: FTC 官方 API 一键同步 -->
          <div v-if="activeImportTab === 'official'" class="tab-pane">
            <div class="ftc-bound-card">
              <div class="ftc-info-row">
                <span class="material-icons status-icon" :class="{ bound: Boolean(event?.ftcEventCode) }">
                  {{ event?.ftcEventCode ? 'verified' : 'link_off' }}
                </span>
                <div class="ftc-meta">
                  <div class="meta-title">
                    {{ event?.ftcEventCode ? `FTC 赛事: ${event.ftcEventCode} (${event.ftcYear || 2025})` : t('schedule.ftc_unbound_notice') }}
                  </div>
                  <div class="meta-desc">
                    {{ event?.ftcEventCode ? t('schedule.ftc_bound_desc') : t('schedule.ftc_unbound_desc') }}
                  </div>
                </div>
              </div>

              <div class="official-action-box">
                <button
                  class="btn-primary-action"
                  :disabled="!event?.ftcEventCode || isSyncingOfficial"
                  @click="handleSyncOfficial"
                >
                  <span class="material-icons" :class="{ spinning: isSyncingOfficial }">
                    {{ isSyncingOfficial ? 'sync' : 'cloud_sync' }}
                  </span>
                  <span>{{ isSyncingOfficial ? t('schedule.syncing_official') : t('schedule.btn_sync_official_now') }}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- 模式 2: CSV 导入与文本粘贴 -->
          <div v-else class="tab-pane">
            <div class="csv-upload-banner">
              <label class="btn-file-upload">
                <span class="material-icons">upload_file</span>
                <span>{{ t('schedule.btn_choose_csv_file') }}</span>
                <input type="file" accept=".csv,.txt" @change="handleFileUpload" style="display: none;" />
              </label>
              <span class="file-hint">{{ t('schedule.csv_format_hint') }}</span>
            </div>

            <div class="textarea-wrapper">
              <textarea
                v-model="csvText"
                class="csv-textarea"
                :placeholder="t('schedule.csv_textarea_placeholder')"
                rows="6"
              ></textarea>
            </div>

            <!-- 解析预览 -->
            <div v-if="parsedPreview.length > 0" class="preview-section">
              <div class="preview-header">
                <span>{{ t('schedule.preview_title', { count: parsedPreview.length }) }}</span>
              </div>
              <div class="preview-table-container">
                <table class="preview-table">
                  <thead>
                    <tr>
                      <th>{{ t('schedule.col_match') }}</th>
                      <th class="red-hdr">{{ t('schedule.col_red1') }}</th>
                      <th class="red-hdr">{{ t('schedule.col_red2') }}</th>
                      <th class="blue-hdr">{{ t('schedule.col_blue1') }}</th>
                      <th class="blue-hdr">{{ t('schedule.col_blue2') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in parsedPreview.slice(0, 5)" :key="row.matchNumber">
                      <td class="match-cell">Q{{ row.matchNumber }}</td>
                      <td class="red-cell">{{ row.red1 }}</td>
                      <td class="red-cell">{{ row.red2 }}</td>
                      <td class="blue-cell">{{ row.blue1 }}</td>
                      <td class="blue-cell">{{ row.blue2 }}</td>
                    </tr>
                  </tbody>
                </table>
                <div v-if="parsedPreview.length > 5" class="preview-more">
                  {{ t('schedule.preview_more', { count: parsedPreview.length - 5 }) }}
                </div>
              </div>
            </div>

            <div class="csv-action-box">
              <button
                class="btn-primary-action"
                :disabled="parsedPreview.length === 0 || isParsing"
                @click="handleConfirmCsvImport"
              >
                <span class="material-icons">{{ isParsing ? 'sync' : 'check' }}</span>
                <span>{{ t('schedule.btn_confirm_csv_import') }} ({{ parsedPreview.length }})</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped src="./ScheduleImportModal.css"></style>

