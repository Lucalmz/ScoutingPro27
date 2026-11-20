<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useRecordStore } from '@/stores/records'
import { usePitScoutStore } from '@/stores/pitScout'
import { useNavigationStore } from '@/stores/navigation'
import { calculateBragIndex } from '@/utils/bragIndex'
import { parseScoutRawData } from '@/utils/analytics/rankings'
import { aggregateTeamPredictCycleStats } from '@/utils/analytics/predictCycleTime'
import { sortRecordsChronologically, getMatchLevelPrefix, getRecordTournamentLevel } from '@/utils/tournament'
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
  (e: 'loadMatch', payload: { matchNumber: number; tournamentLevel: string }): void
}>()

const { t, te } = useI18n()
const router = useRouter()
const recordStore = useRecordStore()
const pitStore = usePitScoutStore()
const navStore = useNavigationStore()

const safeT = (key: string, fallback: string) =>
  typeof te === 'function' && te(key) ? t(key) : fallback

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
  autoParkRate: number
  teleopParkRate: number
  parkRate: number
  avgMobilityRpPts: number
  flowerRate: number
  avgFlowerNectars: number
  avgFlowerBottomBonus: number
  avgFlowerPollens: number
  avgGardenBalls: number
  descoreRate: number
  g410FoulRate: number
  predictCycleTime: number | null
  predictCycleSpread: number | null
  predictCycleMatches: number
  estimatedMaxCycles: number | null
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
      autoParkRate: 0,
      teleopParkRate: 0,
      parkRate: 0,
      avgMobilityRpPts: 0,
      flowerRate: 0,
      avgFlowerNectars: 0,
      avgFlowerBottomBonus: 0,
      avgFlowerPollens: 0,
      avgGardenBalls: 0,
      descoreRate: 0,
      g410FoulRate: 0,
      predictCycleTime: null,
      predictCycleSpread: null,
      predictCycleMatches: 0,
      estimatedMaxCycles: null,
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
  const validMatches = matches.filter((m) => !m.isBroken)
  const validCount = validMatches.length
  let leaveCount = 0
  let autoParkCount = 0
  let teleopParkCount = 0
  let flowerCount = 0
  let brokenCount = 0
  let sumMobilityRp = 0
  let sumFlowerNectars = 0
  let sumFlowerBottomBonus = 0
  let sumFlowerPollens = 0
  let sumGardenBalls = 0
  let descoreCount = 0
  let g410Count = 0

  for (const m of matches) {
    if (m.isBroken) {
      brokenCount++
      continue
    }
    const parsed = parseScoutRawData(m.rawData)
    if (parsed.autoLeave) leaveCount++
    if (parsed.autoPark) autoParkCount++
    if (parsed.endgame.teleopPark) teleopParkCount++
    if (parsed.endgame.flowerNectars > 0 || parsed.endgame.flowerBottomBonusCount > 0) {
      flowerCount++
    }
    sumMobilityRp += (parsed.autoLeave ? 3 : 0) + (parsed.autoPark ? 5 : 0) + (parsed.endgame.teleopPark ? 5 : 0)
    sumFlowerNectars += parsed.endgame.flowerNectars
    sumFlowerBottomBonus += parsed.endgame.flowerBottomBonusCount
    sumFlowerPollens += parsed.endgame.flowerPollens
    sumGardenBalls += parsed.endgame.gardenBalls
    if (parsed.endgame.flowerDescore) descoreCount++
    if (parsed.endgame.g410EarlyFlowerFoul) g410Count++
  }

  const predictStats = aggregateTeamPredictCycleStats(matches)
  const autoParkRate = validCount > 0 ? Math.round((autoParkCount / validCount) * 100) : 0
  const teleopParkRate = validCount > 0 ? Math.round((teleopParkCount / validCount) * 100) : 0

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
    leaveRate: validCount > 0 ? Math.round((leaveCount / validCount) * 100) : 0,
    autoParkRate,
    teleopParkRate,
    parkRate: teleopParkRate,
    avgMobilityRpPts: validCount > 0 ? Number((sumMobilityRp / validCount).toFixed(1)) : 0,
    flowerRate: validCount > 0 ? Math.round((flowerCount / validCount) * 100) : 0,
    avgFlowerNectars: validCount > 0 ? Number((sumFlowerNectars / validCount).toFixed(1)) : 0,
    avgFlowerBottomBonus: validCount > 0 ? Number((sumFlowerBottomBonus / validCount).toFixed(1)) : 0,
    avgFlowerPollens: validCount > 0 ? Number((sumFlowerPollens / validCount).toFixed(1)) : 0,
    avgGardenBalls: validCount > 0 ? Number((sumGardenBalls / validCount).toFixed(1)) : 0,
    descoreRate: validCount > 0 ? Math.round((descoreCount / validCount) * 100) : 0,
    g410FoulRate: validCount > 0 ? Math.round((g410Count / validCount) * 100) : 0,
    predictCycleTime: predictStats.predictCycleTime,
    predictCycleSpread: predictStats.predictCycleSpread,
    predictCycleMatches: predictStats.predictCycleMatches,
    estimatedMaxCycles: predictStats.estimatedMaxCycles,
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

  const redMobilityRp = Number((r1.avgMobilityRpPts + r2.avgMobilityRpPts).toFixed(1))
  const blueMobilityRp = Number((b1.avgMobilityRpPts + b2.avgMobilityRpPts).toFixed(1))
  const redNectars = Number((r1.avgFlowerNectars + r2.avgFlowerNectars).toFixed(1))
  const blueNectars = Number((b1.avgFlowerNectars + b2.avgFlowerNectars).toFixed(1))

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
    redMobilityRp,
    blueMobilityRp,
    redMobilityMet: redMobilityRp >= 16,
    blueMobilityMet: blueMobilityRp >= 16,
    redMobilityGap: Number(Math.max(0, 16 - redMobilityRp).toFixed(1)),
    blueMobilityGap: Number(Math.max(0, 16 - blueMobilityRp).toFixed(1)),
    redNectars,
    blueNectars,
    redShare,
    blueShare: 100 - redShare
  }
})

function formatMatchBiobuzzMeta(rec: ScoutingRecord): string {
  const parsed = parseScoutRawData(rec.rawData)
  const parts: string[] = []
  if (parsed.endgame.teleopPark) parts.push('Park')
  if (parsed.endgame.flowerNectars > 0) parts.push(`N:${parsed.endgame.flowerNectars}`)
  if (parsed.endgame.flowerBottomBonusCount > 0) parts.push(`B:${parsed.endgame.flowerBottomBonusCount}`)
  if (parsed.endgame.flowerPollens > 0) parts.push(`P:${parsed.endgame.flowerPollens}`)
  if (parsed.endgame.gardenBalls > 0) parts.push(`G:${parsed.endgame.gardenBalls}`)
  if (parsed.endgame.flowerDescore) parts.push('Descore')
  if (parsed.endgame.g410EarlyFlowerFoul) parts.push('G410!')
  if (parsed.predictCycleTimeSec !== null) parts.push(`${parsed.predictCycleTimeSec.toFixed(1)}s/cyc`)
  return parts.join(' · ')
}

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
      <!-- BIOBUZZ Swarm RP (>=16 机动/停泊阈值) 与联盟 8 Nectar 预算 -->
      <div class="wb-rp-strip" data-testid="wb-swarm-rp-strip">
        <div class="wb-rp-row">
          <span class="wb-rp-pill red" :class="{ met: alliancePrediction.redMobilityMet }">
            R {{ t('whiteboard.swarm_rp_forecast') }}:
            {{
              alliancePrediction.redMobilityMet
                ? t('whiteboard.swarm_rp_met', { pts: alliancePrediction.redMobilityRp })
                : t('whiteboard.swarm_rp_short', { pts: alliancePrediction.redMobilityRp, gap: alliancePrediction.redMobilityGap })
            }}
          </span>
          <span class="wb-rp-pill blue" :class="{ met: alliancePrediction.blueMobilityMet }">
            B {{ t('whiteboard.swarm_rp_forecast') }}:
            {{
              alliancePrediction.blueMobilityMet
                ? t('whiteboard.swarm_rp_met', { pts: alliancePrediction.blueMobilityRp })
                : t('whiteboard.swarm_rp_short', { pts: alliancePrediction.blueMobilityRp, gap: alliancePrediction.blueMobilityGap })
            }}
          </span>
        </div>
        <div class="wb-nectar-budget">
          <span :class="{ over: alliancePrediction.redNectars > 8 }">
            R · {{ t('whiteboard.nectar_budget_note', { used: alliancePrediction.redNectars }) }}
          </span>
          <span :class="{ over: alliancePrediction.blueNectars > 8 }">
            B · {{ t('whiteboard.nectar_budget_note', { used: alliancePrediction.blueNectars }) }}
          </span>
        </div>
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
              {{ safeT(`pit_scout.drivetrain.${stationsIntel[st].pitRecord!.drivetrainType}`, stationsIntel[st].pitRecord!.drivetrainType) }}
            </span>
            <span v-if="stationsIntel[st].pitRecord?.chassisSize" class="wb-chip hardware">
              {{ safeT(`pit_scout.chassis_size_presets.${stationsIntel[st].pitRecord!.chassisSize}`, stationsIntel[st].pitRecord!.chassisSize!) }}
            </span>
            <span class="wb-chip">
              {{ t('whiteboard.stat_max') }}: {{ stationsIntel[st].maxScore }}
            </span>
            <span class="wb-chip">
              {{ t('whiteboard.stat_teleop_park_rate') }}: {{ stationsIntel[st].teleopParkRate }}%
            </span>
            <span class="wb-chip">
              {{ t('whiteboard.stat_mobility_rp') }}: {{ stationsIntel[st].avgMobilityRpPts }}
            </span>
            <span class="wb-chip" data-testid="wb-card-predict-cycle">
              {{ t('whiteboard.stat_predict_cycle') }}:
              {{
                stationsIntel[st].predictCycleTime !== null
                  ? `${stationsIntel[st].predictCycleTime}s`
                  : t('whiteboard.stat_predict_cycle_insufficient')
              }}
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
            <span class="k-lbl">{{ t('whiteboard.stat_mobility_rp') }}</span>
            <span class="k-val">{{ activeIntel.avgMobilityRpPts }}</span>
          </div>
          <div class="wb-kpi-cell">
            <span class="k-lbl">{{ t('whiteboard.stat_auto_park_rate') }}</span>
            <span class="k-val">{{ activeIntel.autoParkRate }}%</span>
          </div>
          <div class="wb-kpi-cell">
            <span class="k-lbl">{{ t('whiteboard.stat_teleop_park_rate') }}</span>
            <span class="k-val">{{ activeIntel.teleopParkRate }}%</span>
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
            <span class="k-lbl">{{ t('whiteboard.stat_predict_cycle') }}</span>
            <span class="k-val">
              {{
                activeIntel.predictCycleTime !== null
                  ? `${activeIntel.predictCycleTime}s`
                  : t('whiteboard.stat_predict_cycle_insufficient')
              }}
            </span>
          </div>
          <div class="wb-kpi-cell">
            <span class="k-lbl">{{ t('whiteboard.stat_g410_rate') }}</span>
            <span class="k-val" :class="{ warn: activeIntel.g410FoulRate > 0 }">{{ activeIntel.g410FoulRate }}%</span>
          </div>
        </div>
        <div v-if="activeIntel.matchCount > 0" class="wb-biobuzz-chips">
          <span class="wb-chip">{{ t('whiteboard.stat_nectars') }}: {{ activeIntel.avgFlowerNectars }}</span>
          <span class="wb-chip">{{ t('whiteboard.stat_pollens') }}: {{ activeIntel.avgFlowerPollens }}</span>
          <span class="wb-chip">{{ t('whiteboard.stat_garden') }}: {{ activeIntel.avgGardenBalls }}</span>
          <span v-if="activeIntel.estimatedMaxCycles !== null" class="wb-chip">
            ~{{ activeIntel.estimatedMaxCycles }} cyc
          </span>
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
              {{ t('pit_scout.detail_card.spec_drivetrain', { val: safeT(`pit_scout.drivetrain.${activeIntel.pitRecord.drivetrainType}`, activeIntel.pitRecord.drivetrainType) }) }}
            </span>
            <span v-if="activeIntel.pitRecord.chassisSize" class="wb-chip hardware">
              {{ t('pit_scout.detail_card.spec_chassis_size', { val: safeT(`pit_scout.chassis_size_presets.${activeIntel.pitRecord.chassisSize}`, activeIntel.pitRecord.chassisSize) }) }}
            </span>
            <span class="wb-chip">
              {{ t('pit_scout.detail_card.spec_odometry', { val: safeT(`pit_scout.odometry.${activeIntel.pitRecord.odometryType || 'none'}`, activeIntel.pitRecord.odometryType || 'none') }) }}
            </span>
            <span class="wb-chip">
              {{ t('pit_scout.detail_card.spec_ball_compat', { val: safeT(`pit_scout.ball_compatibility.${activeIntel.pitRecord.ballCompatibility || 'universal'}`, activeIntel.pitRecord.ballCompatibility || 'universal') }) }}
            </span>
            <span v-if="activeIntel.pitRecord.launcherType" class="wb-chip">
              {{ t('pit_scout.detail_card.spec_launcher', { val: activeIntel.pitRecord.launcherType }) }}
            </span>
            <span v-if="activeIntel.pitRecord.flowerMechanism" class="wb-chip">
              {{ t('pit_scout.detail_card.spec_flower', { val: safeT(`pit_scout.flower_presets.${activeIntel.pitRecord.flowerMechanism}`, activeIntel.pitRecord.flowerMechanism) }) }}
            </span>
            <span v-if="activeIntel.bragInfo" class="wb-chip brag" :class="activeIntel.bragInfo.tier">
              {{ activeIntel.bragInfo.label }}
            </span>
          </div>
          <div class="wb-pit-claimed-row">
            <span>{{ t('pit_scout.detail_card.claimed_calc_total') }}: <strong>{{ activeIntel.pitRecord.claimedTotalScore }}</strong></span>
            <span>
              {{
                t('pit_scout.detail_card.claimed_auto_teleop_endgame', {
                  auto: activeIntel.pitRecord.claimedAutoScore,
                  teleop: activeIntel.pitRecord.claimedTeleopScore,
                  cycles: activeIntel.pitRecord.claimedTeleopCycles ?? 0,
                  endgame: activeIntel.pitRecord.claimedEndgameScore ?? 0
                })
              }}
            </span>
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
              <button
                type="button"
                class="wb-hist-match-btn"
                :title="t('whiteboard.load_match_to_board')"
                @click="emit('loadMatch', { matchNumber: rec.matchNumber, tournamentLevel: getRecordTournamentLevel(rec) })"
              >
                <span class="wb-hist-match">{{ getMatchLevelPrefix(rec) }}{{ rec.matchNumber }}</span>
                <span class="material-icons" aria-hidden="true" style="font-size: 12px;">draw</span>
              </button>
              <span class="wb-hist-scores">
                A:{{ rec.autoScore }} · T:{{ rec.teleopScore }} · E:{{ rec.endgameScore }}
              </span>
              <strong class="wb-hist-total">{{ rec.totalScore }} {{ t('wizard.pts_unit') }}</strong>
            </div>
            <div v-if="formatMatchBiobuzzMeta(rec)" class="wb-hist-biobuzz">
              {{ formatMatchBiobuzzMeta(rec) }}
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
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.wb-sidebar-header {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-elevated);
}

.wb-mode-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  background: var(--surface-recessed);
  padding: 4px;
  border-radius: 9px;
}

.wb-mode-tab {
  min-block-size: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  cursor: pointer;
  transition: all var(--motion-duration-fast) var(--motion-ease-out);
}

.wb-mode-tab.active {
  background: var(--surface-elevated);
  color: var(--primary);
  box-shadow: var(--shadow-1);
}

.wb-prediction-card {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-recessed);
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
  color: var(--muted-foreground);
}

.wb-pred-score {
  font-size: 18px;
  font-weight: 800;
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.wb-pred-side.red .wb-pred-score {
  color: var(--alliance-red);
}

.wb-pred-side.blue .wb-pred-score {
  color: var(--alliance-blue);
}

.wb-pred-sub {
  font-size: 10px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.wb-pred-vs {
  font-size: 11px;
  font-weight: 800;
  color: var(--g-400);
}

.wb-pred-bar {
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  display: flex;
  background: var(--surface-hover);
}

.wb-pred-fill.red {
  background: linear-gradient(90deg, var(--alliance-red-fill), var(--red-300));
  transition: width var(--motion-duration-normal) var(--motion-ease-out);
}

.wb-pred-fill.blue {
  background: linear-gradient(90deg, var(--status-info), var(--alliance-blue-fill));
  transition: width var(--motion-duration-normal) var(--motion-ease-out);
}

@media (prefers-reduced-motion: no-preference) {
  .wb-pred-fill.red,
  .wb-pred-fill.blue {
    transition: width var(--motion-duration-slow) linear(0, 0.45 15%, 1.08 35%, 0.97 55%, 1.01 75%, 1);
  }
}

.wb-hist-match-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: 5px;
  border: 1px solid var(--status-success-border);
  background: var(--status-success-bg);
  color: var(--primary);
  cursor: pointer;
}

.wb-hist-match-btn:hover {
  background: var(--s-800);
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
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-left-width: 4px;
  cursor: pointer;
  transition: border-color var(--motion-duration-fast) var(--motion-ease-out),
              transform var(--motion-duration-fast) var(--motion-ease-out);
}

.wb-team-card.red {
  border-left-color: var(--alliance-red);
}

.wb-team-card.blue {
  border-left-color: var(--alliance-blue);
}

.wb-team-card.selected {
  border-color: var(--primary);
  background: var(--status-success-bg);
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
  color: var(--g-50);
}

.wb-st-badge.red1 {
  background: var(--alliance-red-fill);
}
.wb-st-badge.red2 {
  background: var(--red-700);
  color: var(--red-300);
}
.wb-st-badge.blue1 {
  background: var(--alliance-blue-fill);
}
.wb-st-badge.blue2 {
  background: var(--status-info-border);
  color: var(--status-info);
}

.wb-team-num {
  font-size: 15px;
  font-weight: 800;
  color: var(--foreground);
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.wb-rank-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--status-success-bg);
  color: var(--primary);
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
  border: 1px solid var(--border-strong);
  background: var(--card);
  color: var(--g-200);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.wb-mini-icon-btn:hover {
  color: var(--primary);
  border-color: var(--primary);
}

.wb-mini-icon-btn .material-icons {
  font-size: 15px;
}

.wb-team-subname {
  font-size: 11px;
  color: var(--muted-foreground);
  margin: 2px 0 6px;
}

.wb-kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 5px;
  background: var(--surface-recessed);
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
  color: var(--muted-foreground);
}

.k-val {
  font-size: 13px;
  font-weight: 800;
  color: var(--foreground);
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.k-val.primary {
  color: var(--primary);
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
  background: var(--surface-hover);
  color: var(--g-200);
}

.wb-chip.hardware {
  background: var(--alliance-blue-bg);
  color: var(--blue-300);
}

.wb-chip.danger {
  background: var(--status-error-bg);
  color: var(--status-error-text);
}

.wb-chip.brag {
  background: var(--status-warning-bg);
  color: var(--status-warning);
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
  color: var(--muted-foreground);
}

.wb-role-select {
  flex: 1;
  background: var(--surface-recessed);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 11px;
}

.wb-notes-box {
  margin-top: 4px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wb-notes-hdr {
  font-size: 12px;
  font-weight: 700;
  color: var(--foreground);
  display: flex;
  align-items: center;
  gap: 5px;
}

.wb-notes-textarea {
  width: 100%;
  resize: vertical;
  background: var(--surface-recessed);
  color: var(--foreground);
  border: 1px solid var(--border);
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
  border: 1px solid var(--border);
  background: var(--surface-elevated);
  color: var(--foreground);
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
}

.wb-st-pill.active {
  border-color: var(--primary);
  background: var(--status-success-bg);
}

.wb-st-pill .st-code {
  font-size: 10px;
  font-weight: 800;
  color: var(--muted-foreground);
}

.wb-st-pill .st-num {
  font-size: 12px;
  font-weight: 800;
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.wb-detail-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px;
  border-radius: 10px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
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
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.wb-detail-team-name {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-top: 2px;
}

.wb-detail-hero-actions {
  display: flex;
  gap: 5px;
}

.wb-detail-section {
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 10px;
}

.wb-sec-title {
  margin: 0 0 7px 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--muted-foreground);
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
  color: var(--g-200);
  background: var(--surface-recessed);
  padding: 5px 8px;
  border-radius: 6px;
}

.wb-pit-auto-note {
  margin: 0;
  font-size: 11px;
  color: var(--g-300);
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
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 6px 8px;
}

.wb-history-item.broken {
  border-color: var(--status-error-border);
}

.wb-hist-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}

.wb-hist-match {
  font-weight: 800;
  color: var(--primary);
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.wb-hist-scores {
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.wb-hist-total {
  color: var(--foreground);
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.wb-hist-notes {
  margin-top: 4px;
  font-size: 11px;
  color: var(--g-200);
  display: flex;
  align-items: center;
  gap: 5px;
}

.wb-broken-tag {
  font-size: 10px;
  font-weight: 800;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--status-error-bg);
  color: var(--status-error);
}

.wb-empty-hint {
  font-size: 12px;
  color: var(--muted-foreground);
  text-align: center;
  padding: 10px 4px;
}

.wb-rp-strip {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.wb-rp-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.wb-rp-pill {
  font-size: 10.5px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--surface-elevated);
  color: var(--g-200);
}

.wb-rp-pill.red.met {
  background: var(--alliance-red-bg);
  color: var(--red-300);
}

.wb-rp-pill.blue.met {
  background: var(--alliance-blue-bg);
  color: var(--blue-300);
}

.wb-nectar-budget {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10px;
  color: var(--muted-foreground);
}

.wb-nectar-budget .over {
  color: var(--status-warning);
  font-weight: 700;
}

.wb-biobuzz-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 8px;
}

.wb-kpi-cell .k-val.warn {
  color: var(--status-warning);
}

.wb-hist-biobuzz {
  font-size: 10.5px;
  color: var(--s-200);
  margin-top: 3px;
}
</style>
