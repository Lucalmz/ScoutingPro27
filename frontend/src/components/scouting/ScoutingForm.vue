<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRecordStore } from '@/stores/records'
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
  cancelEdit: []
}>()

// --- Form State ---
const scoutMode = ref<'single' | 'alliance'>('single')
const allianceColor = ref<'none' | 'red' | 'blue'>('none')
const matchNumber = ref(1)

interface TeamScoutData {
  teamNumber: number | null
  autoClassified: number
  autoOverflow: number
  autoPatterns: number
  autoMovementScore: number
  teleopClassified: number
  teleopOverflow: number
  gatesTriggered: number
  baseScore: number
  supportMultiplier: number
}

function createEmptyTeam(): TeamScoutData {
  return {
    teamNumber: null,
    autoClassified: 0,
    autoOverflow: 0,
    autoPatterns: 0,
    autoMovementScore: 0,
    teleopClassified: 0,
    teleopOverflow: 0,
    gatesTriggered: 0,
    baseScore: 5,
    supportMultiplier: 0
  }
}

const teamsData = ref<TeamScoutData[]>([createEmptyTeam()])

watch(scoutMode, (mode) => {
  if (mode === 'alliance' && teamsData.value.length === 1) {
    teamsData.value.push(createEmptyTeam())
  }
})

const submitting = ref(false)
const submitStatus = ref<'none' | 'success' | 'error'>('none')
const submitErrorMsg = ref('')
const previousScoutMode = ref<'single' | 'alliance'>('single')

watch(() => props.editRecord, (rec: ScoutingRecord | null | undefined) => {
  if (rec) {
    if (scoutMode.value !== 'single') {
      previousScoutMode.value = scoutMode.value
      scoutMode.value = 'single'
    }
    let raw: Partial<ScoutingFormData> = {}
    try {
      raw = JSON.parse(rec.rawData) as Partial<ScoutingFormData>
    } catch {
      // Fallback to empty if corrupted
    }
    matchNumber.value = rec.matchNumber
    allianceColor.value = raw.allianceColor || 'none'
    teamsData.value = [{
      teamNumber: rec.teamNumber,
      autoClassified: raw.autoClassified ?? 0,
      autoOverflow: raw.autoOverflow ?? 0,
      autoPatterns: raw.autoPatterns ?? 0,
      autoMovementScore: raw.autoMovementScore ?? 0,
      teleopClassified: raw.teleopClassified ?? 0,
      teleopOverflow: raw.teleopOverflow ?? 0,
      gatesTriggered: raw.gatesTriggered ?? 0,
      baseScore: raw.baseScore ?? 5,
      supportMultiplier: raw.supportMultiplier ?? 0
    }]
  }
}, { immediate: true })

function calcTeamTotal(team: TeamScoutData) {
  const auto = (3 * team.autoClassified) + (1 * team.autoOverflow) + (2 * team.autoPatterns) + (Number(team.autoMovementScore) || 0)
  const teleop = (3 * team.teleopClassified) + (1 * team.teleopOverflow) + (1.5 * team.gatesTriggered)
  const endgame = team.baseScore + (team.supportMultiplier * 18)
  return auto + teleop + endgame
}

const isFormValid = computed(() => {
  const isMatchValid = matchNumber.value > 0
  const activeTeams = scoutMode.value === 'single' ? teamsData.value.slice(0, 1) : teamsData.value
  const areTeamsValid = activeTeams.every(t => t.teamNumber !== null && t.teamNumber > 0)
  const isColorValid = allianceColor.value !== 'none'
  const isUnique = new Set(activeTeams.map(t => t.teamNumber)).size === activeTeams.length
  return isMatchValid && areTeamsValid && isColorValid && isUnique
})

async function handleSubmit() {
  if (!isFormValid.value) {
    submitStatus.value = 'error'
    submitErrorMsg.value = t('scouting.submit_failed')
    setTimeout(() => { submitStatus.value = 'none' }, 2000)
    return
  }
  
  const recordStore = useRecordStore()
  const activeTeams = scoutMode.value === 'single' ? teamsData.value.slice(0, 1) : teamsData.value

  if (!props.editRecord) {
    for (const team of activeTeams) {
      if (recordStore.records.some(r => r.matchNumber === matchNumber.value && r.teamNumber === team.teamNumber)) {
        submitStatus.value = 'error'
        submitErrorMsg.value = `Duplicate: Match ${matchNumber.value}, Team ${team.teamNumber}`
        setTimeout(() => { submitStatus.value = 'none' }, 2000)
        return
      }
    }
  }

  submitting.value = true
  submitStatus.value = 'none'

  try {
    const records: ScoutingRecord[] = activeTeams.map(team => {
      const auto = (3 * team.autoClassified) + (1 * team.autoOverflow) + (2 * team.autoPatterns) + (Number(team.autoMovementScore) || 0)
      const teleop = (3 * team.teleopClassified) + (1 * team.teleopOverflow) + (1.5 * team.gatesTriggered)
      const endgame = team.baseScore + (team.supportMultiplier * 18)
      const total = auto + teleop + endgame

      const formData: ScoutingFormData = {
        matchNumber: matchNumber.value,
        teamNumber: team.teamNumber!,
        allianceColor: allianceColor.value,
        autoClassified: team.autoClassified,
        autoOverflow: team.autoOverflow,
        autoPatterns: team.autoPatterns,
        autoMovementScore: team.autoMovementScore,
        teleopClassified: team.teleopClassified,
        teleopOverflow: team.teleopOverflow,
        gatesTriggered: team.gatesTriggered,
        baseScore: team.baseScore,
        supportMultiplier: team.supportMultiplier
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

    if (props.editRecord) {
      emit('cancelEdit')
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
            <div class="spdt-thumb" v-show="allianceColor !== 'none'"></div>
            <div class="spdt-labels">
              <span @click="allianceColor = 'red'" :class="{ active: allianceColor === 'red' }">{{ t('scouting.red') }}</span>
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
            <input v-model.number="matchNumber" type="number" min="1" max="999" />
          </label>
        </div>
      </section>

      <div class="teams-grid" :class="{ 'alliance-grid': scoutMode === 'alliance' }">
        <div v-for="(team, index) in (scoutMode === 'single' ? teamsData.slice(0, 1) : teamsData)" :key="index" class="team-column">
          <h2 class="team-header" v-if="scoutMode === 'alliance'">
            {{ index === 0 ? t('scouting.team_1') : t('scouting.team_2') }}: #{{ team.teamNumber || '?' }}
          </h2>

          <section class="form-section">
            <div class="field-row">
              <label class="field">
                <span>{{ t('scouting.team_number') }}</span>
                <input v-model.number="team.teamNumber" type="number" min="1" max="99999" placeholder="e.g. 12345" />
              </label>
            </div>
          </section>

          <!-- Autonomous -->
          <section class="form-section">
            <h3><span class="material-icons">smart_toy</span> {{ t('scouting.autonomous') }}</h3>
            <div class="field-row">
              <label class="field">
                <span>{{ t('scouting.movement') }}</span>
                <input v-model.number="team.autoMovementScore" type="number" max="999" />
              </label>
              <div class="counter-field" style="flex: 1">
                <span>{{ t('scouting.patterns') }}</span>
                <div class="counter">
                  <button type="button" class="counter-btn" @click="team.autoPatterns > 0 && team.autoPatterns--">-</button>
                  <span class="counter-val">{{ team.autoPatterns }}</span>
                  <button type="button" class="counter-btn" @click="team.autoPatterns < 99 && team.autoPatterns++">+</button>
                </div>
              </div>
            </div>
            <div class="field-row" style="margin-top: 12px">
              <div class="counter-field" style="flex: 1">
                <span>{{ t('scouting.classified') }}</span>
                <div class="counter">
                  <button type="button" class="counter-btn" @click="team.autoClassified > 0 && team.autoClassified--">-</button>
                  <span class="counter-val">{{ team.autoClassified }}</span>
                  <button type="button" class="counter-btn" @click="team.autoClassified < 99 && team.autoClassified++">+</button>
                </div>
              </div>
              <div class="counter-field" style="flex: 1">
                <span>{{ t('scouting.overflow') }}</span>
                <div class="counter">
                  <button type="button" class="counter-btn" @click="team.autoOverflow > 0 && team.autoOverflow--">-</button>
                  <span class="counter-val">{{ team.autoOverflow }}</span>
                  <button type="button" class="counter-btn" @click="team.autoOverflow < 99 && team.autoOverflow++">+</button>
                </div>
              </div>
            </div>
          </section>

          <!-- TeleOp -->
          <section class="form-section">
            <h3><span class="material-icons">sports_esports</span> {{ t('scouting.teleop') }}</h3>
            <div class="field-row">
              <div class="counter-field" style="flex: 1">
                <span>{{ t('scouting.gates') }}</span>
                <div class="counter">
                  <button type="button" class="counter-btn" @click="team.gatesTriggered > 0 && team.gatesTriggered--">-</button>
                  <span class="counter-val">{{ team.gatesTriggered }}</span>
                  <button type="button" class="counter-btn" @click="team.gatesTriggered < 99 && team.gatesTriggered++">+</button>
                </div>
              </div>
            </div>
            <div class="field-row" style="margin-top: 12px">
              <div class="counter-field" style="flex: 1">
                <span>{{ t('scouting.classified') }}</span>
                <div class="counter">
                  <button type="button" class="counter-btn" @click="team.teleopClassified > 0 && team.teleopClassified--">-</button>
                  <span class="counter-val">{{ team.teleopClassified }}</span>
                  <button type="button" class="counter-btn" @click="team.teleopClassified < 99 && team.teleopClassified++">+</button>
                </div>
              </div>
              <div class="counter-field" style="flex: 1">
                <span>{{ t('scouting.overflow') }}</span>
                <div class="counter">
                  <button type="button" class="counter-btn" @click="team.teleopOverflow > 0 && team.teleopOverflow--">-</button>
                  <span class="counter-val">{{ team.teleopOverflow }}</span>
                  <button type="button" class="counter-btn" @click="team.teleopOverflow < 99 && team.teleopOverflow++">+</button>
                </div>
              </div>
            </div>
          </section>

          <!-- Endgame -->
          <section class="form-section">
            <h3><span class="material-icons">flag</span> {{ t('scouting.endgame') }}</h3>
            <div class="field">
              <span>{{ t('scouting.base_score') }}</span>
              <select v-model.number="team.baseScore">
                <option :value="5">5 pts</option>
                <option :value="10">10 pts</option>
              </select>
            </div>
            <label class="toggle" style="margin-top: 10px">
              <input v-model="team.supportMultiplier" :true-value="1" :false-value="0" type="checkbox" />
              <span>{{ t('scouting.support') }}</span>
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
        <div class="submit-status-msg error" v-else-if="submitStatus === 'error'"><span class="material-icons">error</span> {{ submitErrorMsg || t('scouting.submit_failed') }}</div>
        <div v-else></div>

        <div style="display: flex; gap: 12px;">
          <button v-if="editRecord" type="button" class="btn-cancel" @click="$emit('cancelEdit')">
            <span class="material-icons">close</span> Cancel
          </button>

          <button 
            type="submit" 
            :disabled="submitting || !isFormValid" 
            class="btn-submit" 
            :class="{ 'btn-edit-mode': !!editRecord }"
          >
            <span class="material-icons" v-if="!submitting">{{ editRecord ? 'edit' : 'cloud_upload' }}</span>
            <template v-if="editRecord">
              {{ submitting ? t('scouting.saving') : t('history.btn_save') }}
            </template>
            <template v-else>
              {{ submitting ? t('scouting.saving') : t('scouting.submit') }}
            </template>
          </button>
        </div>
      </div>
    </form>
  </div>
</template>

<style scoped>
.scouting-wrapper {
  position: relative;
  transition: box-shadow 0.5s ease, background 0.5s ease;
  border-radius: 24px;
  padding: 24px;
  z-index: 1;
}

.scouting-wrapper::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 24px;
  pointer-events: none;
  transition: opacity 0.5s ease, box-shadow 0.5s ease;
  opacity: 0;
  z-index: -1;
}

@keyframes randomFlickerGlowRed {
  0% { opacity: 0.5; box-shadow: 0 0 70px 15px rgba(239, 68, 68, 0.3); }
  7% { opacity: 0.9; box-shadow: 0 0 90px 25px rgba(239, 68, 68, 0.4); }
  14% { opacity: 0.4; box-shadow: 0 0 60px 10px rgba(239, 68, 68, 0.25); }
  22% { opacity: 0.8; box-shadow: 0 0 85px 20px rgba(239, 68, 68, 0.35); }
  35% { opacity: 0.3; box-shadow: 0 0 50px 5px rgba(239, 68, 68, 0.2); }
  42% { opacity: 1; box-shadow: 0 0 100px 30px rgba(239, 68, 68, 0.45); }
  55% { opacity: 0.6; box-shadow: 0 0 75px 18px rgba(239, 68, 68, 0.3); }
  68% { opacity: 0.9; box-shadow: 0 0 95px 28px rgba(239, 68, 68, 0.4); }
  80% { opacity: 0.4; box-shadow: 0 0 65px 12px rgba(239, 68, 68, 0.25); }
  92% { opacity: 0.85; box-shadow: 0 0 88px 22px rgba(239, 68, 68, 0.38); }
  100% { opacity: 0.5; box-shadow: 0 0 70px 15px rgba(239, 68, 68, 0.3); }
}

@keyframes randomFlickerGlowBlue {
  0% { opacity: 0.5; box-shadow: 0 0 70px 15px rgba(59, 130, 246, 0.3); }
  7% { opacity: 0.9; box-shadow: 0 0 90px 25px rgba(59, 130, 246, 0.4); }
  14% { opacity: 0.4; box-shadow: 0 0 60px 10px rgba(59, 130, 246, 0.25); }
  22% { opacity: 0.8; box-shadow: 0 0 85px 20px rgba(59, 130, 246, 0.35); }
  35% { opacity: 0.3; box-shadow: 0 0 50px 5px rgba(59, 130, 246, 0.2); }
  42% { opacity: 1; box-shadow: 0 0 100px 30px rgba(59, 130, 246, 0.45); }
  55% { opacity: 0.6; box-shadow: 0 0 75px 18px rgba(59, 130, 246, 0.3); }
  68% { opacity: 0.9; box-shadow: 0 0 95px 28px rgba(59, 130, 246, 0.4); }
  80% { opacity: 0.4; box-shadow: 0 0 65px 12px rgba(59, 130, 246, 0.25); }
  92% { opacity: 0.85; box-shadow: 0 0 88px 22px rgba(59, 130, 246, 0.38); }
  100% { opacity: 0.5; box-shadow: 0 0 70px 15px rgba(59, 130, 246, 0.3); }
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
  animation: randomFlickerGlowRed 12s infinite alternate;
}

.scouting-wrapper.color-blue {
  background: rgba(59, 130, 246, 0.05);
  box-shadow: 0 0 30px 5px rgba(59, 130, 246, 0.2);
}
.scouting-wrapper.color-blue::before {
  opacity: 1;
  animation: randomFlickerGlowBlue 12s infinite alternate;
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

.scouting-wrapper {
  max-width: 800px;
  margin: 0 auto;
}

.scouting-form {
  width: 100%;
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
  width: calc(50% - 3px);
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

.spdt-switch.pos-blue .spdt-thumb {
  left: calc(50% + 1px);
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

.btn-cancel {
  padding: 14px 20px;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 16px;
  font-weight: 700;
  border: 1px solid var(--border);
  border-radius: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.2s;
}
.btn-cancel:hover {
  background: var(--card);
  color: var(--foreground);
}
</style>
