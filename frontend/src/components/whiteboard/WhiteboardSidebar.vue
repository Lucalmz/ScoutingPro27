<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useRecordStore } from '@/stores/records'
import { usePitScoutStore } from '@/stores/pitScout'
import { useNavigationStore } from '@/stores/navigation'
import { calculateBragIndex } from '@/utils/bragIndex'
import { sortRecordsChronologically, getMatchLevelPrefix } from '@/utils/tournament'
import TagPicker from '@/components/common/TagPicker.vue'
import type { StationType, ScoutingRecord, PitScoutingRecord, RankingRow, BragInfo } from '@/types'
import {
  STATION_LIST,
  type RobotTokenState,
  type TacticalRole
} from './useTacticalWhiteboard'

const props = defineProps<{
  eventId: string
  mode: 'overview' | 'detail'
  selectedStation: StationType
  robots: Record<StationType, RobotTokenState>
  tacticalNotes: string
}>()

const emit = defineEmits<{
  (e: 'update:mode', mode: 'overview' | 'detail'): void
  (e: 'selectStation', station: StationType, openDetail?: boolean): void
  (e: 'locateStation', station: StationType): void
  (e: 'rotateStation', station: StationType): void
  (e: 'updateRole', payload: { station: StationType; role: TacticalRole }): void
  (e: 'updateNotes', notes: string): void
}>()

const { t } = useI18n()
const router = useRouter()
const recordStore = useRecordStore()
const pitStore = usePitScoutStore()
const navStore = useNavigationStore()

export interface StationTeamIntel {
  station: StationType
  stationLabel: string
  alliance: 'red' | 'blue'
  teamNumber: number
  teamName: string
  role: TacticalRole
  rank: number | null
  rankRow: RankingRow | null
  pitRecord: PitScoutingRecord | null
  bragInfo: BragInfo | null
  matches: ScoutingRecord[]
  matchCount: number
  avgTotal: number
  avgAuto: number
  avgTeleop: number
  avgEndgame: number
  maxScore: number
  leaveRate: number
  parkRate: number
  flowerRate: number
  brokenRate: number
}

function buildStationIntel(station: StationType): StationTeamIntel {
  const r = props.robots[station]
  const teamNumber = r?.teamNumber || 0
  const alliance = station.startsWith('red') ? 'red' : 'blue'
  const stationLabel = station.toUpperCase().replace('RED', 'R').replace('BLUE', 'B')

  if (teamNumber <= 0) {
    return {
      station,
      stationLabel,
      alliance,
      teamNumber: 0,
      teamName: 'TBD',
      role: r?.role || 'none',
      rank: null,
      rankRow: null,
      pitRecord: null,
      bragInfo: null,
      matches: [],
      matchCount: 0,
      avgTotal: 0,
      avgAuto: 0,
      avgTeleop: 0,
      avgEndgame: 0,
      maxScore: 0,
      leaveRate: 0,
      parkRate: 0,
      flowerRate: 0,
      brokenRate: 0
    }
  }

  const rankIdx = recordStore.rankings.findIndex((row) => row.teamNumber === teamNumber)
  const rankRow = rankIdx >= 0 ? recordStore.rankings[rankIdx]! : null
  const pitRecord =
    pitStore.activeRecords.find(
      (p) => p.teamNumber === teamNumber && (!props.eventId || p.eventId === props.eventId)
    ) || null
  const official = pitStore.officialTeams.find(
    (ot) => ot.teamNumber === teamNumber && (!props.eventId || !ot.eventId || ot.eventId === props.eventId)
  )
  const matches = sortRecordsChronologically(
    recordStore.activeRecords.filter(
      (rec) => rec.teamNumber === teamNumber && (!props.eventId || rec.eventId === props.eventId)
    )
  )

  const matchCount = matches.length
  let leaveCount = 0
  let parkCount = 0
  let flowerCount = 0
  let brokenCount = 0

  for (const m of matches) {
    if (m.isBroken) brokenCount++
    try {
      const parsed = m.rawData ? JSON.parse(m.rawData) : null
      if (parsed) {
        if (parsed.autoLeave) leaveCount++
        if (parsed.teleopPark || parsed.autoPark) parkCount++
        if (parsed.flowerPlaced) flowerCount++
      }
    } catch {}
  }

  const avgTotal = rankRow
    ? Number(rankRow.avgRating.toFixed(1))
    : matchCount > 0
      ? Number((matches.reduce((s, m) => s + (m.totalScore || 0), 0) / matchCount).toFixed(1))
      : 0
  const avgAuto = rankRow
    ? Number(rankRow.avgAutoScore.toFixed(1))
    : matchCount > 0
      ? Number((matches.reduce((s, m) => s + (m.autoScore || 0), 0) / matchCount).toFixed(1))
      : 0
  const avgTeleop = rankRow
    ? Number(rankRow.avgTeleopScore.toFixed(1))
    : matchCount > 0
      ? Number((matches.reduce((s, m) => s + (m.teleopScore || 0), 0) / matchCount).toFixed(1))
      : 0
  const avgEndgame = rankRow
    ? Number(rankRow.avgEndgameScore.toFixed(1))
    : matchCount > 0
      ? Number((matches.reduce((s, m) => s + (m.endgameScore || 0), 0) / matchCount).toFixed(1))
      : 0
  const maxScore = rankRow
    ? rankRow.maxScore
    : matchCount > 0
      ? Math.max(...matches.map((m) => m.totalScore || 0))
      : 0

  const bragInfo = calculateBragIndex(pitRecord, matches) ?? null
  const teamName =
    official?.nameFull ||
    pitRecord?.robotName ||
    `Team #${teamNumber}`

  return {
    station,
    stationLabel,
    alliance,
    teamNumber,
    teamName,
    role: r?.role || 'none',
    rank: rankIdx >= 0 ? rankIdx + 1 : null,
    rankRow,
    pitRecord,
    bragInfo,
    matches,
    matchCount,
    avgTotal,
    avgAuto,
    avgTeleop,
    avgEndgame,
    maxScore,
    leaveRate: matchCount > 0 ? Math.round((leaveCount / matchCount) * 100) : 0,
    parkRate: matchCount > 0 ? Math.round((parkCount / matchCount) * 100) : 0,
    flowerRate: matchCount > 0 ? Math.round((flowerCount / matchCount) * 100) : 0,
    brokenRate: matchCount > 0 ? Math.round((brokenCount / matchCount) * 100) : 0
  }
}

const stationsIntel = computed<Record<StationType, StationTeamIntel>>(() => ({
  red1: buildStationIntel('red1'),
  red2: buildStationIntel('red2'),
  blue1: buildStationIntel('blue1'),
  blue2: buildStationIntel('blue2')
}))

const activeIntel = computed<StationTeamIntel>(() => {
  return stationsIntel.value[props.selectedStation] || stationsIntel.value.red1
})

const alliancePrediction = computed(() => {
  const r1 = stationsIntel.value.red1
  const r2 = stationsIntel.value.red2
  const b1 = stationsIntel.value.blue1
  const b2 = stationsIntel.value.blue2

  const redTotal = Number((r1.avgTotal + r2.avgTotal).toFixed(1))
  const blueTotal = Number((b1.avgTotal + b2.avgTotal).toFixed(1))
  const redAuto = Number((r1.avgAuto + r2.avgAuto).toFixed(1))
  const blueAuto = Number((b1.avgAuto + b2.avgAuto).toFixed(1))
  const redTeleop = Number((r1.avgTeleop + r2.avgTeleop).toFixed(1))
  const blueTeleop = Number((b1.avgTeleop + b2.avgTeleop).toFixed(1))
  const redEndgame = Number((r1.avgEndgame + r2.avgEndgame).toFixed(1))
  const blueEndgame = Number((b1.avgEndgame + b2.avgEndgame).toFixed(1))

  const sum = redTotal + blueTotal
  const redShare = sum > 0 ? Math.round((redTotal / sum) * 100) : 50

  return {
    redTotal,
    blueTotal,
    redAuto,
    blueAuto,
    redTeleop,
    blueTeleop,
    redEndgame,
    blueEndgame,
    redShare,
    blueShare: 100 - redShare
  }
})

function openFullTeamPage(teamNumber: number) {
  if (!teamNumber || teamNumber <= 0) return
  navStore.saveEventPosition({
    eventId: props.eventId,
    fromTab: 'whiteboard',
    teamNumber
  })
  router.push(`/event/${props.eventId}/team/${teamNumber}`)
}
</script>

<template>
  <aside class="wb-sidebar" data-testid="whiteboard-sidebar">
    <!-- 顶部模式切换栏 -->
    <div class="wb-sidebar-header">
      <div class="wb-mode-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'overview'"
          class="wb-mode-tab"
          :class="{ active: mode === 'overview' }"
          @click="emit('update:mode', 'overview')"
        >
          <span class="material-icons" aria-hidden="true" style="font-size: 16px;">grid_view</span>
          <span>{{ t('whiteboard.sidebar_mode_overview') }}</span>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'detail'"
          class="wb-mode-tab"
          :class="{ active: mode === 'detail' }"
          @click="emit('update:mode', 'detail')"
        >
          <span class="material-icons" aria-hidden="true" style="font-size: 16px;">analytics</span>
          <span>{{ t('whiteboard.sidebar_mode_detail') }}</span>
        </button>
      </div>
    </div>

    <!-- 联盟预测比分横幅 (常驻展示) -->
    <div class="wb-prediction-card">
      <div class="wb-pred-top">
        <div class="wb-pred-side red">
          <span class="wb-pred-label">{{ t('whiteboard.red_alliance') }}</span>
          <strong class="wb-pred-score">{{ alliancePrediction.redTotal }}</strong>
          <span class="wb-pred-sub">
            A:{{ alliancePrediction.redAuto }} · T:{{ alliancePrediction.redTeleop }} · E:{{ alliancePrediction.redEndgame }}
          </span>
        </div>
        <div class="wb-pred-vs">VS</div>
        <div class="wb-pred-side blue">
          <span class="wb-pred-label">{{ t('whiteboard.blue_alliance') }}</span>
          <strong class="wb-pred-score">{{ alliancePrediction.blueTotal }}</strong>
          <span class="wb-pred-sub">
            A:{{ alliancePrediction.blueAuto }} · T:{{ alliancePrediction.blueTeleop }} · E:{{ alliancePrediction.blueEndgame }}
          </span>
        </div>
      </div>
      <div class="wb-pred-bar" :title="`${alliancePrediction.redShare}% : ${alliancePrediction.blueShare}%`">
        <div class="wb-pred-fill red" :style="{ width: `${alliancePrediction.redShare}%` }"></div>
        <div class="wb-pred-fill blue" :style="{ width: `${alliancePrediction.blueShare}%` }"></div>
      </div>
    </div>

    <!-- 模式一：四队同屏对阵总览 -->
    <div v-if="mode === 'overview'" class="wb-sidebar-scroll">
      <div class="wb-station-cards">
        <div
          v-for="st in STATION_LIST"
          :key="st"
          :data-testid="`wb-team-card-${st}`"
          class="wb-team-card"
          :class="[
            stationsIntel[st].alliance,
            { selected: selectedStation === st }
          ]"
          @click="emit('selectStation', st, true)"
        >
          <div class="wb-card-hdr">
            <div class="wb-card-title">
              <span class="wb-st-badge" :class="st">{{ stationsIntel[st].stationLabel }}</span>
              <span class="wb-team-num">
                {{ stationsIntel[st].teamNumber > 0 ? `#${stationsIntel[st].teamNumber}` : 'TBD' }}
              </span>
              <span v-if="stationsIntel[st].rank" class="wb-rank-pill">
                #{{ stationsIntel[st].rank }}
              </span>
            </div>

            <div class="wb-card-actions" @click.stop>
              <button
                type="button"
                class="wb-mini-icon-btn"
                :title="t('whiteboard.locate_on_field')"
                :aria-label="t('whiteboard.locate_on_field')"
                @click="emit('locateStation', st)"
              >
                <span class="material-icons" aria-hidden="true">my_location</span>
              </button>
              <button
                type="button"
                class="wb-mini-icon-btn"
                :title="t('whiteboard.rotate_robot')"
                :aria-label="t('whiteboard.rotate_robot')"
                @click="emit('rotateStation', st)"
              >
                <span class="material-icons" aria-hidden="true">rotate_right</span>
              </button>
            </div>
          </div>

          <div class="wb-team-subname">{{ stationsIntel[st].teamName }}</div>

          <!-- 核心量化指标 4 宫格 -->
          <div class="wb-kpi-grid">
            <div class="wb-kpi-cell">
              <span class="k-lbl">{{ t('whiteboard.stat_avg') }}</span>
              <span class="k-val primary">{{ stationsIntel[st].avgTotal }}</span>
            </div>
            <div class="wb-kpi-cell">
              <span class="k-lbl">{{ t('whiteboard.stat_auto') }}</span>
              <span class="k-val">{{ stationsIntel[st].avgAuto }}</span>
            </div>
            <div class="wb-kpi-cell">
              <span class="k-lbl">{{ t('whiteboard.stat_teleop') }}</span>
              <span class="k-val">{{ stationsIntel[st].avgTeleop }}</span>
            </div>
            <div class="wb-kpi-cell">
              <span class="k-lbl">{{ t('whiteboard.stat_endgame') }}</span>
              <span class="k-val">{{ stationsIntel[st].avgEndgame }}</span>
            </div>
          </div>

          <!-- 展位硬件与稳定性摘要 -->
          <div class="wb-meta-chips">
            <span v-if="stationsIntel[st].pitRecord" class="wb-chip hardware">
              {{ t(`pit_scout.drivetrain.${stationsIntel[st].pitRecord!.drivetrainType}`) }}
            </span>
            <span class="wb-chip">
              {{ t('whiteboard.stat_max') }}: {{ stationsIntel[st].maxScore }}
            </span>
            <span class="wb-chip">
              {{ t('whiteboard.stat_park_rate') }}: {{ stationsIntel[st].parkRate }}%
            </span>
            <span
              v-if="stationsIntel[st].brokenRate > 0"
              class="wb-chip danger"
            >
              {{ t('whiteboard.stat_broken_rate') }}: {{ stationsIntel[st].brokenRate }}%
            </span>
          </div>

          <!-- 战术角色指派下拉 -->
          <div class="wb-role-row" @click.stop>
            <span class="wb-role-lbl">{{ t('whiteboard.role_label') }}:</span>
            <select
              class="wb-role-select"
              :value="stationsIntel[st].role"
              @change="emit('updateRole', { station: st, role: ($event.target as HTMLSelectElement).value as TacticalRole })"
            >
              <option value="none">{{ t('whiteboard.role_none') }}</option>
              <option value="scorer">{{ t('whiteboard.role_scorer') }}</option>
              <option value="cycler">{{ t('whiteboard.role_cycler') }}</option>
              <option value="defense">{{ t('whiteboard.role_defense') }}</option>
              <option value="support">{{ t('whiteboard.role_support') }}</option>
            </select>
          </div>
        </div>
      </div>

      <!-- 本场战术备忘录 -->
      <div class="wb-notes-box">
        <label class="wb-notes-hdr">
          <span class="material-icons" aria-hidden="true" style="font-size: 16px;">edit_note</span>
          <span>{{ t('whiteboard.tactical_notes_title') }}</span>
        </label>
        <textarea
          class="wb-notes-textarea"
          rows="4"
          :value="tacticalNotes"
          :placeholder="t('whiteboard.tactical_notes_placeholder')"
          @input="emit('updateNotes', ($event.target as HTMLTextAreaElement).value)"
        ></textarea>
      </div>
    </div>

    <!-- 模式二：单队深度情报直览 -->
    <div v-else class="wb-sidebar-scroll" data-testid="wb-detail-panel">
      <!-- 顶部四工位快速切换胶囊 -->
      <div class="wb-station-switcher">
        <button
          v-for="st in STATION_LIST"
          :key="st"
          type="button"
          :data-testid="`wb-detail-switch-${st}`"
          class="wb-st-pill"
          :class="[st, { active: selectedStation === st }]"
          @click="emit('selectStation', st, true)"
        >
          <span class="st-code">{{ stationsIntel[st].stationLabel }}</span>
          <span class="st-num">{{ stationsIntel[st].teamNumber > 0 ? `#${stationsIntel[st].teamNumber}` : 'TBD' }}</span>
        </button>
      </div>

      <!-- 当前选中队伍头部 -->
      <div class="wb-detail-hero" :class="activeIntel.alliance">
        <div class="wb-detail-hero-left">
          <div class="wb-detail-title-row">
            <span class="wb-st-badge" :class="activeIntel.station">{{ activeIntel.stationLabel }}</span>
            <h3 class="wb-detail-team-num">
              {{ activeIntel.teamNumber > 0 ? `#${activeIntel.teamNumber}` : 'TBD' }}
            </h3>
            <span v-if="activeIntel.rank" class="wb-rank-pill">Rank #{{ activeIntel.rank }}</span>
          </div>
          <div class="wb-detail-team-name">{{ activeIntel.teamName }}</div>
        </div>
        <div class="wb-detail-hero-actions">
          <button
            type="button"
            class="wb-mini-icon-btn"
            :title="t('whiteboard.locate_on_field')"
            :aria-label="t('whiteboard.locate_on_field')"
            @click="emit('locateStation', activeIntel.station)"
          >
            <span class="material-icons" aria-hidden="true">my_location</span>
          </button>
          <button
            v-if="activeIntel.teamNumber > 0"
            type="button"
            class="wb-mini-icon-btn"
            :title="t('whiteboard.open_full_page')"
            :aria-label="t('whiteboard.open_full_page')"
            @click="openFullTeamPage(activeIntel.teamNumber)"
          >
            <span class="material-icons" aria-hidden="true">open_in_new</span>
          </button>
        </div>
      </div>

      <!-- 详细技术统计卡 -->
      <div class="wb-detail-section">
        <div class="wb-kpi-grid detail-eight">
          <div class="wb-kpi-cell">
            <span class="k-lbl">{{ t('whiteboard.stat_avg') }}</span>
            <span class="k-val primary">{{ activeIntel.avgTotal }}</span>
          </div>
          <div class="wb-kpi-cell">
            <span class="k-lbl">{{ t('whiteboard.stat_max') }}</span>
            <span class="k-val">{{ activeIntel.maxScore }}</span>
          </div>
          <div class="wb-kpi-cell">
            <span class="k-lbl">{{ t('whiteboard.stat_auto') }}</span>
            <span class="k-val">{{ activeIntel.avgAuto }}</span>
          </div>
          <div class="wb-kpi-cell">
            <span class="k-lbl">{{ t('whiteboard.stat_teleop') }}</span>
            <span class="k-val">{{ activeIntel.avgTeleop }}</span>
          </div>
          <div class="wb-kpi-cell">
            <span class="k-lbl">{{ t('whiteboard.stat_endgame') }}</span>
            <span class="k-val">{{ activeIntel.avgEndgame }}</span>
          </div>
          <div class="wb-kpi-cell">
            <span class="k-lbl">{{ t('whiteboard.stat_leave_rate') }}</span>
            <span class="k-val">{{ activeIntel.leaveRate }}%</span>
          </div>
          <div class="wb-kpi-cell">
            <span class="k-lbl">{{ t('whiteboard.stat_flower_rate') }}</span>
            <span class="k-val">{{ activeIntel.flowerRate }}%</span>
          </div>
          <div class="wb-kpi-cell">
            <span class="k-lbl">{{ t('whiteboard.stat_park_rate') }}</span>
            <span class="k-val">{{ activeIntel.parkRate }}%</span>
          </div>
        </div>
      </div>

      <!-- 战术标签直改 -->
      <div v-if="activeIntel.teamNumber > 0" class="wb-detail-section">
        <h4 class="wb-sec-title">{{ t('tags.section_title') }}</h4>
        <TagPicker :event-id="eventId" :team-number="activeIntel.teamNumber" />
      </div>

      <!-- 展位硬件与自述对账 -->
      <div class="wb-detail-section">
        <h4 class="wb-sec-title">{{ t('whiteboard.pit_section_title') }}</h4>
        <div v-if="activeIntel.pitRecord" class="wb-pit-box">
          <div class="wb-pit-specs">
            <span class="wb-chip hardware">
              {{ t('pit_scout.detail_card.spec_drivetrain', { val: t(`pit_scout.drivetrain.${activeIntel.pitRecord.drivetrainType}`) }) }}
            </span>
            <span class="wb-chip">
              {{ t('pit_scout.detail_card.spec_odometry', { val: t(`pit_scout.odometry.${activeIntel.pitRecord.odometryType || 'none'}`) }) }}
            </span>
            <span class="wb-chip">
              {{ t('pit_scout.detail_card.spec_ball_compat', { val: t(`pit_scout.ball_compatibility.${activeIntel.pitRecord.ballCompatibility || 'universal'}`) }) }}
            </span>
            <span v-if="activeIntel.pitRecord.launcherType" class="wb-chip">
              {{ t('pit_scout.detail_card.spec_launcher', { val: activeIntel.pitRecord.launcherType }) }}
            </span>
            <span v-if="activeIntel.pitRecord.flowerMechanism" class="wb-chip">
              {{ t('pit_scout.detail_card.spec_flower', { val: activeIntel.pitRecord.flowerMechanism }) }}
            </span>
            <span v-if="activeIntel.bragInfo" class="wb-chip brag" :class="activeIntel.bragInfo.tier">
              {{ activeIntel.bragInfo.label }}
            </span>
          </div>
          <div class="wb-pit-claimed-row">
            <span>{{ t('pit_scout.detail_card.claimed_calc_total') }}: <strong>{{ activeIntel.pitRecord.claimedTotalScore }}</strong></span>
            <span>{{ t('pit_scout.detail_card.claimed_auto_teleop', { auto: activeIntel.pitRecord.claimedAutoScore, teleop: activeIntel.pitRecord.claimedTeleopScore }) }}</span>
          </div>
          <p v-if="activeIntel.pitRecord.claimedAutoStrategy" class="wb-pit-auto-note">
            <strong>Auto:</strong> {{ activeIntel.pitRecord.claimedAutoStrategy }}
          </p>
        </div>
        <div v-else class="wb-empty-hint">
          {{ t('pit_scout.detail_card.no_pit_data') }}
        </div>
      </div>

      <!-- 近期比赛记录列表 -->
      <div class="wb-detail-section">
        <h4 class="wb-sec-title">
          {{ t('whiteboard.match_history_title') }} ({{ activeIntel.matchCount }})
        </h4>
        <div v-if="activeIntel.matches.length > 0" class="wb-history-list">
          <div
            v-for="rec in activeIntel.matches"
            :key="rec.id"
            class="wb-history-item"
            :class="{ broken: rec.isBroken }"
          >
            <div class="wb-hist-top">
              <span class="wb-hist-match">{{ getMatchLevelPrefix(rec) }}{{ rec.matchNumber }}</span>
              <span class="wb-hist-scores">
                A:{{ rec.autoScore }} · T:{{ rec.teleopScore }} · E:{{ rec.endgameScore }}
              </span>
              <strong class="wb-hist-total">{{ rec.totalScore }} {{ t('wizard.pts_unit') }}</strong>
            </div>
            <div v-if="rec.isBroken || rec.notes" class="wb-hist-notes">
              <span v-if="rec.isBroken" class="wb-broken-tag">BROKEN</span>
              <span v-if="rec.notes">{{ rec.notes }}</span>
            </div>
          </div>
        </div>
        <div v-else class="wb-empty-hint">
          {{ t('whiteboard.no_match_records') }}
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.wb-sidebar {
  width: 360px;
  min-width: 310px;
  max-width: 100%;
  background: var(--card, #141413);
  border: 1px solid var(--border, #262624);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.wb-sidebar-header {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border, #262624);
  background: var(--surface-elevated, #1a1b19);
}

.wb-mode-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  background: #0e0f0e;
  padding: 4px;
  border-radius: 9px;
}

.wb-mode-tab {
  min-block-size: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted-foreground, #8e8d87);
  font-size: 12px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.wb-mode-tab.active {
  background: var(--card, #1c1d1b);
  color: var(--primary, #39ff14);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
}

.wb-prediction-card {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border, #262624);
  background: #101110;
}

.wb-pred-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.wb-pred-side {
  display: flex;
  flex-direction: column;
}

.wb-pred-side.blue {
  text-align: right;
}

.wb-pred-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted-foreground, #8e8d87);
}

.wb-pred-score {
  font-size: 18px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.wb-pred-side.red .wb-pred-score {
  color: #f87171;
}

.wb-pred-side.blue .wb-pred-score {
  color: #60a5fa;
}

.wb-pred-sub {
  font-size: 10px;
  color: var(--muted-foreground, #8e8d87);
  font-variant-numeric: tabular-nums;
}

.wb-pred-vs {
  font-size: 11px;
  font-weight: 800;
  color: #666;
}

.wb-pred-bar {
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  display: flex;
  background: #222;
}

.wb-pred-fill.red {
  background: linear-gradient(90deg, #dc2626, #f97316);
  transition: width 0.25s ease;
}

.wb-pred-fill.blue {
  background: linear-gradient(90deg, #06b6d4, #2563eb);
  transition: width 0.25s ease;
}

.wb-sidebar-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wb-station-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.wb-team-card {
  border-radius: 10px;
  padding: 9px 10px;
  background: #181917;
  border: 1px solid #282926;
  border-left-width: 4px;
  cursor: pointer;
  transition: border-color 0.15s ease, transform 0.12s ease;
}

.wb-team-card.red {
  border-left-color: #ef4444;
}

.wb-team-card.blue {
  border-left-color: #3b82f6;
}

.wb-team-card.selected {
  border-color: var(--primary, #39ff14);
  background: #1c1e1a;
}

.wb-card-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.wb-card-title {
  display: flex;
  align-items: center;
  gap: 6px;
}

.wb-st-badge {
  font-size: 11px;
  font-weight: 800;
  padding: 2px 6px;
  border-radius: 5px;
  color: #fff;
}

.wb-st-badge.red1 {
  background: #dc2626;
}
.wb-st-badge.red2 {
  background: #ea580c;
}
.wb-st-badge.blue1 {
  background: #2563eb;
}
.wb-st-badge.blue2 {
  background: #0891b2;
}

.wb-team-num {
  font-size: 15px;
  font-weight: 800;
  color: var(--foreground, #f0efe9);
  font-variant-numeric: tabular-nums;
}

.wb-rank-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(57, 255, 20, 0.14);
  color: var(--primary, #39ff14);
}

.wb-card-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.wb-mini-icon-btn {
  min-inline-size: 26px;
  min-block-size: 26px;
  border-radius: 6px;
  border: 1px solid #2e302c;
  background: #121311;
  color: #b5b4ae;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.wb-mini-icon-btn:hover {
  color: var(--primary, #39ff14);
  border-color: var(--primary, #39ff14);
}

.wb-mini-icon-btn .material-icons {
  font-size: 15px;
}

.wb-team-subname {
  font-size: 11px;
  color: var(--muted-foreground, #8e8d87);
  margin: 2px 0 6px;
}

.wb-kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 5px;
  background: #111210;
  padding: 6px;
  border-radius: 7px;
}

.wb-kpi-grid.detail-eight {
  grid-template-columns: repeat(4, 1fr);
}

.wb-kpi-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.k-lbl {
  font-size: 10px;
  color: var(--muted-foreground, #8e8d87);
}

.k-val {
  font-size: 13px;
  font-weight: 800;
  color: var(--foreground, #f0efe9);
  font-variant-numeric: tabular-nums;
}

.k-val.primary {
  color: var(--primary, #39ff14);
}

.wb-meta-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}

.wb-chip {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 5px;
  background: #222420;
  color: #c8c7c0;
}

.wb-chip.hardware {
  background: rgba(59, 130, 246, 0.15);
  color: #93c5fd;
}

.wb-chip.danger {
  background: rgba(239, 68, 68, 0.18);
  color: #fca5a5;
}

.wb-chip.brag {
  background: rgba(234, 179, 8, 0.16);
  color: #fde047;
}

.wb-role-row {
  margin-top: 7px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.wb-role-lbl {
  font-size: 11px;
  color: var(--muted-foreground, #8e8d87);
}

.wb-role-select {
  flex: 1;
  background: #111210;
  color: var(--foreground, #f0efe9);
  border: 1px solid #2c2e2a;
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 11px;
}

.wb-notes-box {
  margin-top: 4px;
  background: #181917;
  border: 1px solid #282926;
  border-radius: 10px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wb-notes-hdr {
  font-size: 12px;
  font-weight: 700;
  color: var(--foreground, #f0efe9);
  display: flex;
  align-items: center;
  gap: 5px;
}

.wb-notes-textarea {
  width: 100%;
  resize: vertical;
  background: #101110;
  color: var(--foreground, #f0efe9);
  border: 1px solid #2a2b28;
  border-radius: 7px;
  padding: 7px 8px;
  font-size: 12px;
  font-family: inherit;
}

.wb-station-switcher {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 5px;
}

.wb-st-pill {
  padding: 5px 4px;
  border-radius: 7px;
  border: 1px solid #2b2c29;
  background: #161715;
  color: var(--foreground, #f0efe9);
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
}

.wb-st-pill.active {
  border-color: var(--primary, #39ff14);
  background: rgba(57, 255, 20, 0.1);
}

.wb-st-pill .st-code {
  font-size: 10px;
  font-weight: 800;
  color: var(--muted-foreground, #8e8d87);
}

.wb-st-pill .st-num {
  font-size: 12px;
  font-weight: 800;
}

.wb-detail-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px;
  border-radius: 10px;
  background: #181917;
  border: 1px solid #282926;
}

.wb-detail-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.wb-detail-team-num {
  margin: 0;
  font-size: 18px;
  font-weight: 800;
}

.wb-detail-team-name {
  font-size: 12px;
  color: var(--muted-foreground, #8e8d87);
  margin-top: 2px;
}

.wb-detail-hero-actions {
  display: flex;
  gap: 5px;
}

.wb-detail-section {
  background: #181917;
  border: 1px solid #282926;
  border-radius: 10px;
  padding: 9px 10px;
}

.wb-sec-title {
  margin: 0 0 7px 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--muted-foreground, #8e8d87);
}

.wb-pit-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wb-pit-specs {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.wb-pit-claimed-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #c8c7c0;
  background: #111210;
  padding: 5px 8px;
  border-radius: 6px;
}

.wb-pit-auto-note {
  margin: 0;
  font-size: 11px;
  color: #a8a7a0;
  line-height: 1.4;
}

.wb-history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
}

.wb-history-item {
  background: #111210;
  border: 1px solid #252623;
  border-radius: 7px;
  padding: 6px 8px;
}

.wb-history-item.broken {
  border-color: rgba(239, 68, 68, 0.5);
}

.wb-hist-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}

.wb-hist-match {
  font-weight: 800;
  color: var(--primary, #39ff14);
}

.wb-hist-scores {
  font-size: 11px;
  color: var(--muted-foreground, #8e8d87);
}

.wb-hist-total {
  color: var(--foreground, #f0efe9);
}

.wb-hist-notes {
  margin-top: 4px;
  font-size: 11px;
  color: #b5b4ae;
  display: flex;
  align-items: center;
  gap: 5px;
}

.wb-broken-tag {
  font-size: 10px;
  font-weight: 800;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.wb-empty-hint {
  font-size: 12px;
  color: var(--muted-foreground, #8e8d87);
  text-align: center;
  padding: 10px 4px;
}
</style>
