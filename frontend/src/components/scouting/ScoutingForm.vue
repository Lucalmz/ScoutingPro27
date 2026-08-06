<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ScoutingRecord, ScoutingFormData } from '@/types'

const { t } = useI18n()

const props = defineProps<{
  eventId: string
  scoutId: string
  scoutName: string
  editRecord?: ScoutingRecord | null
}>()

const emit = defineEmits<{
  submit: [record: ScoutingRecord | ScoutingRecord[]]
}>()

// --- Form State ---
const scoutMode = ref<'single' | 'alliance'>('single')
const allianceColor = ref<'none' | 'red' | 'blue'>('none')
const matchNumber = ref(1)

interface TeamScoutData {
  teamNumber: number | null
  autoMoved: boolean
  autoParked: boolean
  autoPixelsPlaced: number
  teleOpPixelsScored: number
  teleOpPixelsMissed: number
  endgameHang: 'none' | 'low' | 'high'
  endgameDrone: boolean
}

function createEmptyTeam(): TeamScoutData {
  return {
    teamNumber: null,
    autoMoved: false,
    autoParked: false,
    autoPixelsPlaced: 0,
    teleOpPixelsScored: 0,
    teleOpPixelsMissed: 0,
    endgameHang: 'none',
    endgameDrone: false
  }
}

const teamsData = ref<TeamScoutData[]>([createEmptyTeam()])

watch(scoutMode, (mode) => {
  if (mode === 'alliance' && teamsData.value.length === 1) {
    teamsData.value.push(createEmptyTeam())
  } else if (mode === 'single' && teamsData.value.length === 2) {
    teamsData.value.pop()
  }
})

const submitting = ref(false)
const submitStatus = ref<'none' | 'success' | 'error'>('none')
const previousScoutMode = ref<'single' | 'alliance'>('single')

watch(() => props.editRecord, (rec: ScoutingRecord | null | undefined) => {
  if (rec) {
    if (scoutMode.value !== 'single') {
      previousScoutMode.value = scoutMode.value
      scoutMode.value = 'single'
    }
    const raw = JSON.parse(rec.rawData)
    matchNumber.value = rec.matchNumber
    allianceColor.value = raw.allianceColor || 'none'
    teamsData.value = [{
      teamNumber: rec.teamNumber,
      autoMoved: raw.autoMoved,
      autoParked: raw.autoParked,
      autoPixelsPlaced: raw.autoPixelsPlaced,
      teleOpPixelsScored: raw.teleOpPixelsScored,
      teleOpPixelsMissed: raw.teleOpPixelsMissed,
      endgameHang: raw.endgameHang,
      endgameDrone: raw.endgameDrone
    }]
  }
}, { immediate: true })

function calcTeamTotal(team: TeamScoutData) {
  const auto = (team.autoMoved ? 2 : 0) + (team.autoParked ? 5 : 0) + team.autoPixelsPlaced * 5
  const teleop = team.teleOpPixelsScored * 2 - team.teleOpPixelsMissed
  const endgame = (team.endgameHang === 'low' ? 10 : team.endgameHang === 'high' ? 20 : 0)
    + (team.endgameDrone ? 15 : 0)
  return auto + teleop + endgame
}

const isFormValid = computed(() => {
  const isMatchValid = matchNumber.value > 0
  const areTeamsValid = teamsData.value.every(t => t.teamNumber !== null && t.teamNumber > 0)
  const isColorValid = allianceColor.value !== 'none'
  const isUnique = new Set(teamsData.value.map(t => t.teamNumber)).size === teamsData.value.length
  return isMatchValid && areTeamsValid && isColorValid && isUnique
})

async function handleSubmit() {
  if (!isFormValid.value) {
    submitStatus.value = 'error'
    setTimeout(() => { submitStatus.value = 'none' }, 2000)
    return
  }
  submitting.value = true
  submitStatus.value = 'none'

  try {
    const records: ScoutingRecord[] = teamsData.value.map(team => {
      const auto = (team.autoMoved ? 2 : 0) + (team.autoParked ? 5 : 0) + team.autoPixelsPlaced * 5
      const teleop = team.teleOpPixelsScored * 2 - team.teleOpPixelsMissed
      const endgame = (team.endgameHang === 'low' ? 10 : team.endgameHang === 'high' ? 20 : 0)
        + (team.endgameDrone ? 15 : 0)
      const total = auto + teleop + endgame

      const formData: ScoutingFormData = {
        matchNumber: matchNumber.value,
        teamNumber: team.teamNumber!,
        allianceColor: allianceColor.value,
        autoMoved: team.autoMoved,
        autoParked: team.autoParked,
        autoPixelsPlaced: team.autoPixelsPlaced,
        teleOpPixelsScored: team.teleOpPixelsScored,
        teleOpPixelsMissed: team.teleOpPixelsMissed,
        endgameHang: team.endgameHang,
        endgameDrone: team.endgameDrone,
      }

      return {
        id: props.editRecord ? props.editRecord.id : (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`),
        eventId: props.eventId,
        scoutId: props.scoutId,
        scoutName: props.scoutName,
        matchNumber: matchNumber.value,
        teamNumber: team.teamNumber!,
        autoScore: auto,
        teleopScore: teleop,
        endgameScore: endgame,
        totalScore: total,
        notes: '',
        rawData: JSON.stringify(formData),
        syncStatus: 'PENDING',
        createdAt: props.editRecord ? props.editRecord.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    })

    if (records.length === 1) {
      emit('submit', records[0]!)
    } else {
      emit('submit', records)
    }

    submitStatus.value = 'success'
    matchNumber.value++
    // reset teams
    if (props.editRecord && previousScoutMode.value === 'alliance') {
      scoutMode.value = 'alliance'
      teamsData.value = [createEmptyTeam(), createEmptyTeam()]
    } else {
      teamsData.value = teamsData.value.map(() => createEmptyTeam())
    }
    if (!props.editRecord) {
      allianceColor.value = 'none'
    }

  } catch (err) {
    submitStatus.value = 'error'
  } finally {
    submitting.value = false
    setTimeout(() => {
      submitStatus.value = 'none'
    }, 2000)
  }
}

const wrapperClass = computed(() => {
  return [
    'scouting-wrapper',
    `color-${allianceColor.value}`,
    `status-${submitStatus.value}`
  ]
})
</script>

<template>
  <div :class="wrapperClass">
    <form class="scouting-form" @submit.prevent="handleSubmit">
      
      <!-- Top Settings (Mode & Color) -->
      <section class="form-section settings-section">
        <div class="setting-group">
          <span>{{ t('scouting.mode') }}</span>
          <div class="segmented-control">
            <button type="button" :class="{ active: scoutMode === 'single' }" :disabled="!!editRecord" @click="scoutMode = 'single'">{{ t('scouting.single_team') }}</button>
            <button type="button" :class="{ active: scoutMode === 'alliance' }" :disabled="!!editRecord" @click="scoutMode = 'alliance'">{{ t('scouting.alliance') }}</button>
          </div>
        </div>
        <div class="setting-group">
          <span>{{ t('scouting.alliance_color') }}</span>
          <div class="spdt-switch" :class="'pos-' + allianceColor">
            <div class="spdt-thumb"></div>
            <div class="spdt-labels">
              <span @click="allianceColor = 'red'" :class="{ active: allianceColor === 'red' }">{{ t('scouting.red') }}</span>
              <span @click="allianceColor = 'none'" :class="{ active: allianceColor === 'none' }">{{ t('scouting.none') }}</span>
              <span @click="allianceColor = 'blue'" :class="{ active: allianceColor === 'blue' }">{{ t('scouting.blue') }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Match Info (Shared) -->
      <section class="form-section">
        <h3><span class="material-icons">push_pin</span> {{ t('scouting.match_info') }}</h3>
        <div class="field-row">
          <label class="field">
            <span>{{ t('scouting.match_number') }}</span>
            <input v-model.number="matchNumber" type="number" min="1" />
          </label>
        </div>
      </section>

      <div class="teams-grid" :class="{ 'alliance-grid': scoutMode === 'alliance' }">
        <div v-for="(team, index) in teamsData" :key="index" class="team-column">
          <h2 class="team-header" v-if="scoutMode === 'alliance'">
            {{ index === 0 ? t('scouting.team_1') : t('scouting.team_2') }}: #{{ team.teamNumber || '?' }}
          </h2>

          <section class="form-section">
            <div class="field-row">
              <label class="field">
                <span>{{ t('scouting.team_number') }}</span>
                <input v-model.number="team.teamNumber" type="number" min="1" placeholder="e.g. 12345" />
              </label>
            </div>
          </section>

          <!-- Autonomous -->
          <section class="form-section">
            <h3><span class="material-icons">smart_toy</span> {{ t('scouting.autonomous') }}</h3>
            <div class="toggle-row">
              <label class="toggle">
                <input v-model="team.autoMoved" type="checkbox" />
                <span>{{ t('scouting.auto_moved') }}</span>
              </label>
              <label class="toggle">
                <input v-model="team.autoParked" type="checkbox" />
                <span>{{ t('scouting.auto_parked') }}</span>
              </label>
            </div>
            <div class="counter-field">
              <span>{{ t('scouting.pixels_placed') }}</span>
              <div class="counter">
                <button type="button" class="counter-btn" @click="team.autoPixelsPlaced > 0 && team.autoPixelsPlaced--">-</button>
                <span class="counter-val">{{ team.autoPixelsPlaced }}</span>
                <button type="button" class="counter-btn" @click="team.autoPixelsPlaced++">+</button>
              </div>
            </div>
          </section>

          <!-- TeleOp -->
          <section class="form-section">
            <h3><span class="material-icons">sports_esports</span> {{ t('scouting.teleop') }}</h3>
            <div class="counter-field">
              <span>{{ t('scouting.pixels_scored') }}</span>
              <div class="counter">
                <button type="button" class="counter-btn" @click="team.teleOpPixelsScored > 0 && team.teleOpPixelsScored--">-</button>
                <span class="counter-val">{{ team.teleOpPixelsScored }}</span>
                <button type="button" class="counter-btn" @click="team.teleOpPixelsScored++">+</button>
              </div>
            </div>
            <div class="counter-field">
              <span>{{ t('scouting.pixels_missed') }}</span>
              <div class="counter">
                <button type="button" class="counter-btn" @click="team.teleOpPixelsMissed > 0 && team.teleOpPixelsMissed--">-</button>
                <span class="counter-val">{{ team.teleOpPixelsMissed }}</span>
                <button type="button" class="counter-btn" @click="team.teleOpPixelsMissed++">+</button>
              </div>
            </div>
          </section>

          <!-- Endgame -->
          <section class="form-section">
            <h3><span class="material-icons">flag</span> {{ t('scouting.endgame') }}</h3>
            <div class="field">
              <span>{{ t('scouting.suspended') }}</span>
              <select v-model="team.endgameHang">
                <option value="none">{{ t('scouting.hang_none') }}</option>
                <option value="low">{{ t('scouting.hang_low') }}</option>
                <option value="high">{{ t('scouting.hang_high') }}</option>
              </select>
            </div>
            <label class="toggle" style="margin-top: 10px">
              <input v-model="team.endgameDrone" type="checkbox" />
              <span>{{ t('scouting.drone_pts') }}</span>
            </label>
          </section>
          
          <div class="total-score-inline">
            <span class="total-label">{{ t('scouting.total_score') }}</span>
            <span class="total-value">{{ calcTeamTotal(team) }}</span>
          </div>
        </div>
      </div>

      <!-- Submit area -->
      <div class="submit-area">
        <div class="submit-status-msg" v-if="submitStatus === 'success'"><span class="material-icons">check_circle</span> {{ t('scouting.submitted') }}</div>
        <div class="submit-status-msg error" v-else-if="submitStatus === 'error'"><span class="material-icons">error</span> {{ t('scouting.submit_failed') }}</div>
        <div v-else></div>

        <button 
          type="submit" 
          :disabled="submitting" 
          class="btn-submit" 
          :class="{ 'btn-edit-mode': !!editRecord }"
        >
          <span class="material-icons" v-if="!submitting">cloud_upload</span>
          <template v-if="editRecord">
            {{ submitting ? t('scouting.saving') : t('scouting.submit_edit') }}
          </template>
          <template v-else>
            {{ submitting ? t('scouting.saving') : t('scouting.submit') }}
          </template>
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.scouting-wrapper {
  position: relative;
  transition: box-shadow 0.5s ease, background 0.5s ease;
  border-radius: 16px;
  padding: 16px;
  z-index: 1;
}

.scouting-wrapper::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 16px;
  pointer-events: none;
  transition: opacity 0.5s ease, box-shadow 0.5s ease;
  opacity: 0;
  z-index: -1;
}

@keyframes randomFlickerGlow {
  0% { opacity: 0.5; transform: scale(1); }
  7% { opacity: 0.9; transform: scale(1.02); }
  14% { opacity: 0.4; transform: scale(0.99); }
  22% { opacity: 0.8; transform: scale(1.01); }
  35% { opacity: 0.3; transform: scale(0.98); }
  42% { opacity: 1; transform: scale(1.03); }
  55% { opacity: 0.6; transform: scale(1); }
  68% { opacity: 0.9; transform: scale(1.015); }
  80% { opacity: 0.4; transform: scale(0.995); }
  92% { opacity: 0.85; transform: scale(1.01); }
  100% { opacity: 0.5; transform: scale(1); }
}

/* Glowing effects */
.scouting-wrapper.color-none {
  background: transparent;
  box-shadow: 0 0 0 transparent;
}
.scouting-wrapper.color-none::before {
  opacity: 0;
}

.scouting-wrapper.color-red {
  background: rgba(239, 68, 68, 0.05);
  box-shadow: 0 0 30px 5px rgba(239, 68, 68, 0.2);
}
.scouting-wrapper.color-red::before {
  opacity: 1;
  box-shadow: 0 0 80px 20px rgba(239, 68, 68, 0.35);
  animation: randomFlickerGlow 4.7s infinite alternate;
}

.scouting-wrapper.color-blue {
  background: rgba(59, 130, 246, 0.05);
  box-shadow: 0 0 30px 5px rgba(59, 130, 246, 0.2);
}
.scouting-wrapper.color-blue::before {
  opacity: 1;
  box-shadow: 0 0 80px 20px rgba(59, 130, 246, 0.35);
  animation: randomFlickerGlow 4.7s infinite alternate;
}

@keyframes errorBlink {
  0% { box-shadow: 0 0 30px rgba(249, 115, 22, 0.8); }
  50% { box-shadow: 0 0 10px rgba(249, 115, 22, 0.2); }
  100% { box-shadow: 0 0 30px rgba(249, 115, 22, 0.8); }
}

.scouting-wrapper.status-success {
  background: rgba(34, 197, 94, 0.1) !important;
  box-shadow: inset 0 0 60px rgba(34, 197, 94, 0.4), 0 0 30px rgba(34, 197, 94, 0.5) !important;
}

.scouting-wrapper.status-error {
  background: rgba(249, 115, 22, 0.1) !important;
  animation: errorBlink 0.5s infinite;
}

.scouting-form {
  max-width: 800px;
  margin: 0 auto;
}

.settings-section {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
}

.setting-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
}

.setting-group > span {
  font-size: 13px;
  color: var(--muted-foreground);
  font-weight: 600;
}

.segmented-control {
  display: flex;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

.segmented-control button {
  flex: 1;
  padding: 8px;
  border: none;
  background: none;
  color: var(--muted-foreground);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.segmented-control button.active {
  background: var(--primary);
  color: var(--primary-foreground);
}

.segmented-control button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spdt-switch {
  position: relative;
  width: 100%;
  max-width: 240px;
  height: 38px;
  background: var(--input);
  border-radius: 19px;
  display: flex;
  align-items: center;
  box-shadow: inset 0 2px 4px rgba(0,0,0,0.4);
}

.spdt-thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  width: calc(33.333% - 2px);
  border-radius: 16px;
  background: white;
  transition: left 0.3s cubic-bezier(0.4, 0, 0.2, 1), background 0.3s, box-shadow 0.3s;
  z-index: 1;
}

.spdt-switch.pos-red .spdt-thumb {
  left: 3px;
  background: #ef4444;
  box-shadow: 0 0 10px #ef4444;
}

.spdt-switch.pos-none .spdt-thumb {
  left: calc(33.333% + 1px);
  background: var(--muted-foreground);
}

.spdt-switch.pos-blue .spdt-thumb {
  left: calc(66.666% - 1px);
  background: #3b82f6;
  box-shadow: 0 0 10px #3b82f6;
}

.spdt-labels {
  position: absolute;
  inset: 0;
  display: flex;
  z-index: 2;
}

.spdt-labels span {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: var(--muted-foreground);
  cursor: pointer;
  transition: color 0.3s;
}

.spdt-labels span.active {
  color: white;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
}

.teams-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 20px;
}
@media (min-width: 600px) {
  .alliance-grid {
    grid-template-columns: 1fr 1fr;
  }
}

.team-header {
  font-size: 18px;
  margin: 0 0 12px;
  text-align: center;
  color: var(--primary);
}

.form-section {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 16px;
}

.form-section h3 {
  margin: 0 0 14px;
  font-size: 16px;
  color: var(--foreground);
  display: flex;
  align-items: center;
  gap: 8px;
}

.field-row { display: flex; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.field > span, .counter-field > span:first-child { font-size: 13px; color: var(--muted-foreground); }

input[type='number'], select {
  padding: 10px 12px;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--foreground);
  font-size: 16px;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}
input:focus, select:focus { border-color: var(--primary); }

.toggle-row { display: flex; gap: 20px; margin-bottom: 12px; }
.toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px; color: var(--muted-foreground); }
.toggle input[type='checkbox'] {
  appearance: none; width: 44px; height: 24px;
  background: var(--input); border-radius: 12px;
  position: relative; transition: all 0.3s; outline: none; cursor: pointer; margin: 0;
}
.toggle input[type='checkbox']::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px;
  background: var(--muted-foreground); border-radius: 50%; transition: all 0.3s; box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}
.toggle input[type='checkbox']:checked { background: var(--primary); box-shadow: var(--glow-primary); }
.toggle input[type='checkbox']:checked::after { transform: translateX(20px); background: var(--primary-foreground); }

.counter-field { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; }
.counter { display: flex; align-items: center; gap: 12px; }
.counter-btn {
  width: 36px; height: 36px; border-radius: 8px; border: 1px solid var(--input);
  background: var(--border); color: var(--foreground); font-size: 20px; font-weight: 700;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.counter-btn:hover { background: var(--input); }
.counter-val { font-size: 22px; font-weight: 700; min-width: 32px; text-align: center; }

.total-score-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--card);
  padding: 12px 20px;
  border-radius: 12px;
  border: 1px solid var(--border);
  margin-bottom: 16px;
}

.total-label { font-size: 12px; color: var(--muted-foreground); text-transform: uppercase; font-weight: 600;}
.total-value { font-size: 28px; font-weight: 800; color: var(--primary); }

.submit-area {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 20px;
}

.submit-status-msg {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--status-success);
  font-weight: 600;
}
.submit-status-msg.error {
  color: #f97316;
}

.btn-submit {
  padding: 14px 28px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 16px;
  font-weight: 700;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: var(--glow-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-submit.btn-edit-mode {
  background: #f97316;
  box-shadow: 0 0 10px rgba(249, 115, 22, 0.4);
}
.btn-submit:hover:not(:disabled) { filter: brightness(1.1); }
.btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
