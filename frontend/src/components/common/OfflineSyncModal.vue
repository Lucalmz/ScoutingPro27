<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { useScheduleStore } from '@/stores/schedule'
import { syncRecords } from '@/services/api'
import type { ScoutingEvent, ScoutingRecord } from '@/types'
import {
  generateEventFileName,
  generateSyncFileName,
  createEventPackage,
  createSyncPackage,
  scanFilesAndFolders,
  extractFilesFromDataTransfer,
  executeBatchSyncImport,
  triggerFileDownload,
  type BatchScanResult
} from '@/utils/offlineSync'

const props = defineProps<{
  visible: boolean
  eventId?: string
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'eventImported', eventId: string): void
}>()

const { t } = useI18n()
const userStore = useUserStore()
const eventStore = useEventStore()
const recordStore = useRecordStore()
const connStore = useConnectionStore()
const toastStore = useToastStore()
const scheduleStore = useScheduleStore()

const currentTab = ref<'export' | 'import'>('export')

// --- Export State ---
const currentEvent = computed<ScoutingEvent | null>(() => {
  if (props.eventId) {
    return eventStore.events.find((e) => e.id === props.eventId) || eventStore.currentEvent || null
  }
  return eventStore.currentEvent || null
})

const isHost = computed(() => {
  if (!currentEvent.value) return false
  return eventStore.isHost
})

// Host Export Options
const hostTargetType = ref<'ALL' | 'SPECIFIC'>('ALL')
const hostSpecificTarget = ref('')
const hostFromSeq = ref(0)
const hostToSeq = ref<number | null>(null)

// Client Export Options
const clientExportMode = ref<'PENDING_ONLY' | 'ALL_MY'>('PENDING_ONLY')

const hostFilteredRecords = computed(() => {
  if (!currentEvent.value) return []
  const from = Number(hostFromSeq.value) || 0
  return recordStore.records.filter((r) => r.eventId === currentEvent.value!.id && !r.isDeleted && (from <= 0 || (r.hostSeq || 0) > from))
})

const clientFilteredRecords = computed(() => {
  if (!currentEvent.value) return []
  const myRecs = recordStore.myRecords(userStore.userId).filter((r) => r.eventId === currentEvent.value!.id)
  return clientExportMode.value === 'PENDING_ONLY' ? myRecs.filter((r) => r.syncStatus === 'PENDING') : myRecs
})

const previewFileName = computed(() => {
  if (!currentEvent.value) return ''
  if (isHost.value) {
    const maxSeq = hostFilteredRecords.value.reduce((m, r) => Math.max(m, r.hostSeq || 0), 0)
    return generateSyncFileName({
      eventName: currentEvent.value.ftcEventCode || currentEvent.value.name,
      senderName: userStore.username,
      isHost: true,
      targetName: hostTargetType.value === 'ALL' ? 'ALL' : (hostSpecificTarget.value || 'Scout'),
      fromSeq: Number(hostFromSeq.value) || 0,
      toSeq: maxSeq,
      recordCount: hostFilteredRecords.value.length
    })
  } else {
    return generateSyncFileName({
      eventName: currentEvent.value.ftcEventCode || currentEvent.value.name,
      senderName: userStore.username,
      isHost: false,
      recordCount: clientFilteredRecords.value.length
    })
  }
})

// --- Import State ---
const fileInputRef = ref<HTMLInputElement | null>(null)
const folderInputRef = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)
const isScanning = ref(false)
const isApplying = ref(false)
const importError = ref<string | null>(null)

const scanResult = ref<BatchScanResult | null>(null)
const selectedSourceLabel = ref<string>('')

watch(
  () => props.visible,
  (val) => {
    if (val) {
      currentTab.value = 'export'
      resetImport()
    }
  }
)

function resetImport() {
  selectedSourceLabel.value = ''
  scanResult.value = null
  importError.value = null
  isScanning.value = false
  isApplying.value = false
  if (fileInputRef.value) fileInputRef.value.value = ''
  if (folderInputRef.value) folderInputRef.value.value = ''
}

function handleClose() {
  emit('update:visible', false)
}

// --- Export Handlers ---
function handleExportEvent() {
  if (!currentEvent.value) return
  const content = createEventPackage(
    currentEvent.value,
    {
      userId: userStore.userId,
      username: userStore.username,
      role: isHost.value ? 'HOST' : 'SCOUT'
    },
    scheduleStore.schedules,
    Object.values(scheduleStore.assignments)
  )
  const filename = generateEventFileName(currentEvent.value)
  triggerFileDownload(filename, content)
  toastStore.showToast(t('offline_sync.export_event_title') + ' 导出成功！', 'info')
}

function handleExportSync() {
  if (!currentEvent.value) return
  const records = isHost.value ? hostFilteredRecords.value : clientFilteredRecords.value
  const maxSeq = records.reduce((m, r) => Math.max(m, r.hostSeq || 0), 0)

  const content = createSyncPackage({
    packetType: isHost.value ? 'HOST_BROADCAST' : 'CLIENT_PUSH',
    eventId: currentEvent.value.id,
    eventName: currentEvent.value.ftcEventCode || currentEvent.value.name,
    sender: {
      userId: userStore.userId,
      username: userStore.username,
      role: isHost.value ? 'HOST' : 'SCOUT'
    },
    target: {
      recipientType: isHost.value ? (hostTargetType.value === 'ALL' ? 'ALL_SCOUTS' : 'SCOUT') : 'HOST',
      targetUsername: isHost.value && hostTargetType.value === 'SPECIFIC' ? hostSpecificTarget.value : undefined
    },
    records,
    teamTags: isHost.value ? recordStore.teamTags : undefined,
    fromHostSeq: isHost.value ? Number(hostFromSeq.value) || 0 : 0,
    toHostSeq: isHost.value ? maxSeq : 0,
    hostSessionId: undefined
  })

  triggerFileDownload(previewFileName.value, content)
  toastStore.showToast(
    isHost.value ? t('offline_sync.btn_export_info') + ' 导出成功！' : t('offline_sync.btn_export_my_records') + ' 导出成功！',
    'info'
  )
}

// --- Import Handlers ---
async function handleFilesSelected(e: Event, isFolder = false) {
  const fileList = (e.target as HTMLInputElement).files
  if (fileList && fileList.length > 0) {
    const firstFile = fileList[0]
    if (firstFile) {
      if (isFolder) {
        const sample = firstFile.webkitRelativePath
        const folder = sample ? sample.split('/')[0] : '选中文件夹'
        selectedSourceLabel.value = `文件夹 [${folder}] (${fileList.length} 个文件)`
      } else {
        selectedSourceLabel.value = fileList.length === 1 ? firstFile.name : `已选 ${fileList.length} 个文件`
      }
    }
    await processFiles(Array.from(fileList))
  }
}

async function onDrop(e: DragEvent) {
  isDragging.value = false
  if (e.dataTransfer) {
    isScanning.value = true
    try {
      const files = await extractFilesFromDataTransfer(e.dataTransfer)
      if (files.length > 0) {
        const firstFile = files[0]
        if (firstFile) {
          selectedSourceLabel.value = files.length === 1 ? firstFile.name : `拖拽导入 (${files.length} 个文件)`
        }
        await processFiles(files)
      }
    } finally {
      isScanning.value = false
    }
  }
}

async function processFiles(files: File[]) {
  importError.value = null
  isScanning.value = true
  try {
    const res = await scanFilesAndFolders(files, currentEvent.value?.id)
    scanResult.value = res
  } catch (err: any) {
    importError.value = err.message || '数据包解析异常'
  } finally {
    isScanning.value = false
  }
}

async function applyImport() {
  if (!scanResult.value) return
  isApplying.value = true
  importError.value = null

  try {
    const res = await executeBatchSyncImport({
      scanResult: scanResult.value,
      targetEventId: currentEvent.value?.id || '',
      isHost: isHost.value,
      events: eventStore.events,
      bulkSync: recordStore.bulkSync,
      stampHostSeq: connStore.stampHostSeq,
      persistRecordsToDb: async (recs) => {
        await syncRecords(recs)
      },
      markSynced: recordStore.markSynced,
      applyTagsFullSync: recordStore.applyTagsFullSync,
      applyScheduleFullSync: scheduleStore.applyScheduleFullSync
    })

    if (res.totalDropped > 0) {
      toastStore.showToast(
        t('offline_sync.pill_sync_partial'),
        'warning',
        {
          detail: `${t('offline_sync.pill_sync_detail', { files: res.totalFiles, records: res.totalAccepted })} · ${t('offline_sync.pill_dropped_detail', { count: res.totalDropped })}`,
          icon: 'warning'
        }
      )
    } else {
      toastStore.showToast(
        t('offline_sync.pill_sync_success'),
        'success',
        {
          detail: t('offline_sync.pill_sync_detail', { files: res.totalFiles, records: res.totalAccepted }),
          icon: 'check_circle'
        }
      )
    }

    if (res.importedEventId) {
      emit('eventImported', res.importedEventId)
    }

    resetImport()
    handleClose()
  } catch (err: any) {
    importError.value = err.message || '应用同步数据包失败'
    toastStore.showToast(t('offline_sync.import_failed') + (err.message || ''), 'error')
  } finally {
    isApplying.value = false
  }
}
</script>

<template>
  <Transition name="modal">
    <div v-if="visible" class="offline-sync-backdrop" @click.self="handleClose">
      <div class="offline-sync-modal">
      <header class="modal-header">
        <div class="header-title-group">
          <span class="material-icons modal-icon">usb</span>
          <div>
            <h3>{{ t('offline_sync.title') }}</h3>
            <p class="modal-subtitle">{{ t('offline_sync.subtitle') }}</p>
          </div>
        </div>
        <button class="btn-close" @click="handleClose">
          <span class="material-icons">close</span>
        </button>
      </header>

      <!-- Tab Switcher -->
      <div class="modal-tabs">
        <button
          class="tab-btn"
          :class="{ active: currentTab === 'export' }"
          @click="currentTab = 'export'"
        >
          <span class="material-icons">upload</span>
          {{ t('offline_sync.tab_export') }}
        </button>
        <button
          class="tab-btn"
          :class="{ active: currentTab === 'import' }"
          @click="currentTab = 'import'"
        >
          <span class="material-icons">download</span>
          {{ t('offline_sync.tab_import') }}
        </button>
      </div>

      <!-- Tab 1: Export -->
      <div v-if="currentTab === 'export'" class="tab-body">
        <!-- Host Export Section -->
        <template v-if="isHost">
          <!-- Event Package Export -->
          <div class="export-card">
            <h4>{{ t('offline_sync.export_event_title') }}</h4>
            <p class="card-desc">{{ t('offline_sync.export_event_desc') }}</p>
            <button class="btn-action secondary" @click="handleExportEvent">
              <span class="material-icons">share</span>
              {{ t('offline_sync.btn_export_event') }}
            </button>
          </div>

          <!-- Incremental Info Package Export -->
          <div class="export-card">
            <h4>{{ t('offline_sync.export_info_title') }}</h4>
            <p class="card-desc">{{ t('offline_sync.export_info_host_desc') }}</p>

            <div class="form-row">
              <label>{{ t('offline_sync.target_recipient') }}</label>
              <div class="radio-group">
                <label class="radio-label">
                  <input type="radio" value="ALL" v-model="hostTargetType" />
                  {{ t('offline_sync.recipient_all') }}
                </label>
                <label class="radio-label">
                  <input type="radio" value="SPECIFIC" v-model="hostTargetType" />
                  {{ t('offline_sync.recipient_scout') }}
                </label>
              </div>
            </div>

            <div v-if="hostTargetType === 'SPECIFIC'" class="form-row">
              <input
                type="text"
                v-model="hostSpecificTarget"
                placeholder="例如: Alice, Bob"
                class="text-input"
              />
            </div>

            <div class="form-row">
              <label>{{ t('offline_sync.from_version') }}</label>
              <input
                type="number"
                min="0"
                v-model="hostFromSeq"
                class="text-input number-input"
              />
              <small class="hint">{{ t('offline_sync.full_sync') }}</small>
            </div>

            <div class="export-summary">
              <div>{{ t('offline_sync.records_to_export') }}: <strong>{{ hostFilteredRecords.length }}</strong></div>
              <div>{{ t('offline_sync.tags_to_export') }}: <strong>{{ recordStore.teamTags.length }}</strong></div>
              <div class="filename-box">
                <span class="material-icons file-icon">description</span>
                <code>{{ previewFileName }}</code>
              </div>
            </div>

            <button
              class="btn-action primary"
              @click="handleExportSync"
              :disabled="hostFilteredRecords.length === 0"
            >
              <span class="material-icons">file_download</span>
              {{ t('offline_sync.btn_export_info') }}
            </button>
          </div>
        </template>

        <!-- Client (Scout) Export Section -->
        <template v-else>
          <div class="export-card">
            <h4>{{ t('offline_sync.export_info_title') }}</h4>
            <p class="card-desc">{{ t('offline_sync.export_info_scout_desc') }}</p>

            <div class="form-row">
              <label>{{ t('offline_sync.target_recipient') }}: <strong>{{ t('offline_sync.recipient_host') }}</strong></label>
            </div>

            <div class="export-summary">
              <div>{{ t('offline_sync.records_to_export') }}: <strong>{{ clientFilteredRecords.length }}</strong></div>
              <div class="filename-box">
                <span class="material-icons file-icon">description</span>
                <code>{{ previewFileName }}</code>
              </div>
            </div>

            <button
              class="btn-action primary"
              @click="handleExportSync"
              :disabled="clientFilteredRecords.length === 0"
            >
              <span class="material-icons">file_download</span>
              {{ t('offline_sync.btn_export_my_records') }}
            </button>
            <div v-if="clientFilteredRecords.length === 0" class="empty-hint">
              {{ t('offline_sync.no_pending_records') }}
            </div>
          </div>
        </template>
      </div>

      <!-- Tab 2: Import -->
      <div v-else class="tab-body">
        <input
          ref="fileInputRef"
          type="file"
          multiple
          accept=".info,.event,.json"
          style="display: none;"
          @change="(e) => handleFilesSelected(e, false)"
        />
        <input
          ref="folderInputRef"
          type="file"
          webkitdirectory
          directory
          multiple
          style="display: none;"
          @change="(e) => handleFilesSelected(e, true)"
        />

        <!-- Dropzone -->
        <div
          class="dropzone"
          :class="{ dragging: isDragging }"
          @dragover.prevent="isDragging = true"
          @dragleave.prevent="isDragging = false"
          @drop.prevent="onDrop"
        >
          <span class="material-icons drop-icon">folder_open</span>
          <div class="drop-text">{{ selectedSourceLabel || t('offline_sync.drag_drop_hint') }}</div>
          <div class="btn-choose-group">
            <button class="btn-choose" type="button" @click.stop="fileInputRef?.click()">
              <span class="material-icons" style="font-size: 16px;">file_present</span>
              {{ t('offline_sync.choose_file') }}
            </button>
            <button class="btn-choose folder-btn" type="button" @click.stop="folderInputRef?.click()">
              <span class="material-icons" style="font-size: 16px;">folder</span>
              {{ t('offline_sync.choose_folder') }}
            </button>
          </div>
          <small class="drop-hint">{{ t('offline_sync.import_hint') }}</small>
        </div>

        <div v-if="isScanning" class="scanning-indicator">
          <div class="scanning-spinner"></div>
          <span>正在智能检索与筛选数据包...</span>
        </div>

        <div v-if="importError" class="import-error-banner">
          <span class="material-icons">error_outline</span>
          <span>{{ importError }}</span>
        </div>

        <!-- Empty Scan Result Banner -->
        <div
          v-if="scanResult && !isScanning && scanResult.matchedEventFiles.length === 0 && scanResult.matchedSyncFiles.length === 0"
          class="empty-scan-banner"
        >
          <span class="material-icons">info</span>
          <div>
            <strong>{{ t('offline_sync.no_files_matched') }}</strong>
            <div style="font-size: 0.76rem; opacity: 0.85; margin-top: 2px;">
              {{ t('offline_sync.scanned_total', { count: scanResult.totalScannedFiles }) }} · {{ t('offline_sync.scanned_ignored', { count: scanResult.ignoredFiles }) }}
            </div>
          </div>
        </div>

        <!-- Matched Scan Preview Card -->
        <div
          v-if="scanResult && !isScanning && (scanResult.matchedEventFiles.length > 0 || scanResult.matchedSyncFiles.length > 0)"
          class="preview-card"
        >
          <h4>{{ t('offline_sync.scan_summary_title') }}</h4>
          <div class="stat-pills-row">
            <span class="stat-pill muted">
              <span class="material-icons" style="font-size: 14px;">find_in_page</span>
              {{ t('offline_sync.scanned_total', { count: scanResult.totalScannedFiles }) }}
            </span>
            <span class="stat-pill warning">
              <span class="material-icons" style="font-size: 14px;">filter_alt</span>
              {{ t('offline_sync.scanned_ignored', { count: scanResult.ignoredFiles }) }}
            </span>
            <span class="stat-pill success">
              <span class="material-icons" style="font-size: 14px;">check_circle</span>
              {{ t('offline_sync.scanned_matched', { count: scanResult.matchedEventFiles.length + scanResult.matchedSyncFiles.length }) }}
            </span>
            <span class="stat-pill success">
              <span class="material-icons" style="font-size: 14px;">dataset</span>
              {{ t('offline_sync.scanned_records', { count: scanResult.totalRecords }) }}
            </span>
            <span v-if="scanResult.totalTags > 0" class="stat-pill success">
              <span class="material-icons" style="font-size: 14px;">label</span>
              {{ t('offline_sync.scanned_tags', { count: scanResult.totalTags }) }}
            </span>
          </div>

          <div class="matched-files-list">
            <div v-for="(item, idx) in scanResult.matchedEventFiles" :key="'evt-' + idx" class="matched-file-item">
              <div class="matched-file-left">
                <span class="file-badge event">EVENT</span>
                <span class="matched-file-name">{{ item.file.name }}</span>
              </div>
              <span class="matched-file-meta">{{ item.eventPkg?.event.name }}</span>
            </div>
            <div v-for="(item, idx) in scanResult.matchedSyncFiles" :key="'sync-' + idx" class="matched-file-item">
              <div class="matched-file-left">
                <span class="file-badge info">INFO</span>
                <span class="matched-file-name">{{ item.file.name }}</span>
              </div>
              <span class="matched-file-meta">
                {{ item.scoutName || 'Scout' }} · {{ item.recordCount }} 条记录
              </span>
            </div>
          </div>

          <button
            class="btn-action primary apply-btn"
            @click="applyImport"
            :disabled="isApplying"
          >
            <span class="material-icons">sync</span>
            {{ isApplying ? '处理中...' : `${t('offline_sync.btn_apply_import')} (${scanResult.matchedEventFiles.length + scanResult.matchedSyncFiles.length} 个文件 / ${scanResult.totalRecords} 条记录)` }}
          </button>
        </div>
      </div>
    </div>
    </div>
  </Transition>
</template>

<style scoped src="./OfflineSyncModal.css"></style>
