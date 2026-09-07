<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRecordStore } from '@/stores/records'
import type { MatchDiscrepancy } from '@/utils/analytics/audit'

const props = defineProps<{
  visible: boolean
  focusMatchNumber?: number | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'selectMatch', matchNumber: number): void
}>()

const { t } = useI18n()
const recordStore = useRecordStore()

const top5List = computed<MatchDiscrepancy[]>(() => {
  return recordStore.top5Discrepancies
})

const maxDeviation = computed(() => {
  if (top5List.value.length === 0) return 0
  return Math.max(...top5List.value.map((d) => d.maxDiff))
})

function handleClose() {
  emit('update:visible', false)
}

function handleSelectMatch(matchNumber: number) {
  emit('selectMatch', matchNumber)
  handleClose()
}
</script>

<template>
  <Transition name="modal">
    <div v-if="visible" class="audit-modal-backdrop" @click.self="handleClose">
      <div class="audit-modal">
        <!-- 弹窗头部 -->
        <header class="modal-header">
          <div class="header-title">
            <span class="material-icons header-icon">fact_check</span>
            <div>
              <h3>{{ t('audit.modal_title') }}</h3>
              <p class="subtitle">{{ t('audit.modal_subtitle') }}</p>
            </div>
          </div>
          <button class="btn-close" @click="handleClose" :title="t('common.close')">
            <span class="material-icons">close</span>
          </button>
        </header>

        <!-- 汇总指示卡 -->
        <div v-if="top5List.length > 0" class="audit-overview-bar">
          <div class="overview-stat">
            <span class="stat-num text-danger">{{ top5List.length }}</span>
            <span class="stat-label">{{ t('audit.stat_top_matches') }}</span>
          </div>
          <div class="overview-divider"></div>
          <div class="overview-stat">
            <span class="stat-num text-warning">±{{ maxDeviation }}</span>
            <span class="stat-label">{{ t('audit.stat_max_diff') }}</span>
          </div>
          <div class="overview-hint">
            <span class="material-icons info-icon">info</span>
            <span>{{ t('audit.overview_hint') }}</span>
          </div>
        </div>

        <!-- 列表内容区 -->
        <div class="modal-body">
          <div v-if="top5List.length === 0" class="empty-audit-card">
            <span class="material-icons ok-icon">verified</span>
            <h4>{{ t('audit.empty_title') }}</h4>
            <p>{{ t('audit.empty_desc') }}</p>
          </div>

          <div v-else class="discrepancy-card-list">
            <div
              v-for="item in top5List"
              :key="item.matchNumber"
              class="discrepancy-card"
              :class="{ focused: focusMatchNumber === item.matchNumber }"
            >
              <div class="card-header">
                <div class="rank-badge" :class="`rank-${item.rank || 1}`">
                  Top {{ item.rank }}
                </div>
                <div class="match-title">
                  <span class="match-code">Q{{ item.matchNumber }}</span>
                  <span class="diff-highlight">最大差额 ±{{ item.maxDiff }} 分 ({{ (item.maxRatio * 100).toFixed(0) }}%)</span>
                </div>
                <button class="btn-locate" @click="handleSelectMatch(item.matchNumber)">
                  <span class="material-icons">search</span>
                  <span>{{ t('audit.btn_locate_match') }}</span>
                </button>
              </div>

              <!-- 红蓝对阵差额对比网格 -->
              <div class="alliance-comparison-grid">
                <!-- 红方联盟 -->
                <div class="alliance-col red-col">
                  <div class="alliance-header">
                    <span class="alliance-name red">{{ t('schedule.red_alliance') }}</span>
                    <span v-if="item.red" class="diff-badge" :class="item.red.signedDiff >= 0 ? 'higher' : 'lower'">
                      {{ item.red.signedDiff >= 0 ? `+${item.red.signedDiff}` : item.red.signedDiff }} 分
                    </span>
                  </div>

                  <div v-if="item.red" class="scores-row">
                    <div class="score-pair">
                      <span class="pair-lbl">{{ t('audit.scouts_total') }}:</span>
                      <span class="pair-val">{{ item.red.scoutScore }}</span>
                    </div>
                    <div class="score-pair">
                      <span class="pair-lbl">{{ t('audit.official_net') }}:</span>
                      <span class="pair-val">{{ item.red.officialScore }}</span>
                    </div>
                  </div>

                  <div v-if="item.red?.scouts.length" class="scout-records-box">
                    <div v-for="s in item.red.scouts" :key="`${item.matchNumber}_${s.teamNumber}`" class="scout-chip">
                      <span class="team-tag">#{{ s.teamNumber }}</span>
                      <span class="scout-person">{{ s.scoutName }}:</span>
                      <span class="scout-score">{{ s.score }}分</span>
                    </div>
                  </div>
                  <div v-else class="no-scout-hint">{{ t('audit.no_scout_records') }}</div>
                </div>

                <!-- 蓝方联盟 -->
                <div class="alliance-col blue-col">
                  <div class="alliance-header">
                    <span class="alliance-name blue">{{ t('schedule.blue_alliance') }}</span>
                    <span v-if="item.blue" class="diff-badge" :class="item.blue.signedDiff >= 0 ? 'higher' : 'lower'">
                      {{ item.blue.signedDiff >= 0 ? `+${item.blue.signedDiff}` : item.blue.signedDiff }} 分
                    </span>
                  </div>

                  <div v-if="item.blue" class="scores-row">
                    <div class="score-pair">
                      <span class="pair-lbl">{{ t('audit.scouts_total') }}:</span>
                      <span class="pair-val">{{ item.blue.scoutScore }}</span>
                    </div>
                    <div class="score-pair">
                      <span class="pair-lbl">{{ t('audit.official_net') }}:</span>
                      <span class="pair-val">{{ item.blue.officialScore }}</span>
                    </div>
                  </div>

                  <div v-if="item.blue?.scouts.length" class="scout-records-box">
                    <div v-for="s in item.blue.scouts" :key="`${item.matchNumber}_${s.teamNumber}`" class="scout-chip">
                      <span class="team-tag">#{{ s.teamNumber }}</span>
                      <span class="scout-person">{{ s.scoutName }}:</span>
                      <span class="scout-score">{{ s.score }}分</span>
                    </div>
                  </div>
                  <div v-else class="no-scout-hint">{{ t('audit.no_scout_records') }}</div>
                </div>
              </div>

              <!-- 差额诊断建议 -->
              <div class="diagnosis-row">
                <span class="material-icons diag-icon">lightbulb</span>
                <span class="diag-text">{{ item.summaryMessage }}</span>
              </div>
            </div>
          </div>
        </div>

        <footer class="modal-footer">
          <button class="btn-primary" @click="handleClose">
            {{ t('common.confirm') }}
          </button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped src="./ScheduleAuditModal.css"></style>
