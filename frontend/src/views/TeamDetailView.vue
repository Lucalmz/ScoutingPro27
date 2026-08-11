<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useRecordStore } from '@/stores/records'
import type { ScoutingRecord } from '@/types'

const props = defineProps<{
  eventId: string
  teamNumber: string
}>()

const router = useRouter()
const { t } = useI18n()
const recordStore = useRecordStore()

const teamMatches = computed<ScoutingRecord[]>(() => {
  return recordStore.records
    .filter(r => r.teamNumber === parseInt(props.teamNumber))
    .sort((a, b) => a.matchNumber - b.matchNumber)
})

const editingMatchId = ref<string | null>(null)
const editCommentText = ref('')
const isSaving = ref(false)

function startEditComment(match: ScoutingRecord) {
  editingMatchId.value = match.id
  editCommentText.value = match.notes || ''
}

function cancelEditComment() {
  editingMatchId.value = null
  editCommentText.value = ''
}

async function saveComment(match: ScoutingRecord) {
  isSaving.value = true
  try {
    const updatedRecord = { ...match, notes: editCommentText.value, updatedAt: new Date().toISOString() }
    const { success, recordsToPush } = await recordStore.updateRecord(updatedRecord)
    if (success) {
      import('@/stores/connection').then(({ useConnectionStore }) => {
        useConnectionStore().pushIfNeeded(recordsToPush)
      })
      editingMatchId.value = null
    }
  } catch (e: any) {
    alert('Failed to save comment: ' + e.message)
  } finally {
    isSaving.value = false
  }
}
</script>

<template>
  <div class="team-detail-view">
    <header class="app-header">
      <button class="btn-back" @click="router.back()">
        <span class="material-icons">arrow_back</span>
        {{ t('team_detail.back') }}
      </button>
      <div class="header-title">
        <h1>{{ t('team_detail.title', { team: teamNumber }) }}</h1>
      </div>
    </header>

    <main class="content-area">
      <div v-if="teamMatches.length === 0" class="empty-state">
        <p>{{ t('team_detail.no_records') }}</p>
      </div>

      <div v-else class="matches-list">
        <div v-for="match in teamMatches" :key="match.id" class="match-card" :class="{ 'is-broken': match.isBroken }">
          <div class="match-header">
            <h3>{{ t('team_detail.match') }} {{ match.matchNumber }}</h3>
            <span v-if="match.isBroken" class="broken-badge">
              <span class="material-icons" style="font-size: 14px;">build</span>
              {{ t('team_detail.is_broken') }}
            </span>
          </div>

          <div class="score-grid">
            <div class="score-item">
              <span class="label">{{ t('history.auto') }}</span>
              <span class="value">{{ match.autoScore }}</span>
            </div>
            <div class="score-item">
              <span class="label">{{ t('history.teleop') }}</span>
              <span class="value">{{ match.teleopScore }}</span>
            </div>
            <div class="score-item">
              <span class="label">{{ t('history.endgame') }}</span>
              <span class="value">{{ match.endgameScore }}</span>
            </div>
            <div class="score-item total">
              <span class="label">{{ t('scouting.total_score') }}</span>
              <span class="value">{{ match.totalScore }}</span>
            </div>
          </div>

          <div class="comments-section">
            <div class="comments-label">
              <span class="material-icons" style="font-size: 16px;">chat_bubble_outline</span>
              {{ t('team_detail.comments') }}
              
              <button 
                v-if="editingMatchId !== match.id" 
                @click="startEditComment(match)" 
                class="btn-icon" 
                style="margin-left: auto;"
                title="Edit Evaluation"
              >
                <span class="material-icons" style="font-size: 16px;">edit</span>
              </button>
            </div>
            
            <div v-if="editingMatchId === match.id" class="edit-comment-area">
              <textarea 
                v-model="editCommentText" 
                class="edit-textarea" 
                rows="3" 
                placeholder="Evaluate this team's performance..."
              ></textarea>
              <div class="edit-actions">
                <button @click="cancelEditComment" class="btn-cancel" :disabled="isSaving">Cancel</button>
                <button @click="saveComment(match)" class="btn-save" :disabled="isSaving">{{ isSaving ? 'Saving...' : 'Save' }}</button>
              </div>
            </div>
            <p v-else-if="match.notes" class="comments-text">{{ match.notes }}</p>
            <p v-else class="comments-text empty">No evaluation recorded yet.</p>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.team-detail-view {
  min-height: 100vh;
  background: var(--background);
  display: flex;
  flex-direction: column;
}

.app-header {
  height: 60px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 16px;
  position: sticky;
  top: 0;
  z-index: 100;
}

.btn-back {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px;
  border-radius: 8px;
  transition: all 0.2s;
}

.btn-back:hover {
  background: var(--input);
  color: var(--foreground);
}

.header-title {
  flex: 1;
  text-align: center;
  margin-right: 70px; /* Offset to center title visually against back button */
}

.header-title h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--primary);
}

.content-area {
  flex: 1;
  padding: 24px 16px;
  max-width: 800px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

.empty-state {
  text-align: center;
  padding: 48px;
  color: var(--muted-foreground);
}

.matches-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.match-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  transition: box-shadow 0.2s;
}

.match-card.is-broken {
  border-color: rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.02);
}

.match-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 12px;
}

.match-header h3 {
  margin: 0;
  font-size: 16px;
  color: var(--foreground);
}

.broken-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--status-error);
  color: white;
  padding: 4px 8px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.score-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.score-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--background);
  padding: 12px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
}

.score-item .label {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-bottom: 4px;
}

.score-item .value {
  font-size: 18px;
  font-weight: 700;
  color: var(--foreground);
}

.score-item.total .value {
  color: var(--primary);
}

.comments-section {
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}

.comments-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted-foreground);
  margin-bottom: 8px;
}

.comments-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--foreground);
  white-space: pre-wrap;
}

.comments-text.empty {
  color: var(--muted-foreground);
  font-style: italic;
}

.btn-icon {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-icon:hover {
  background: var(--input);
  color: var(--primary);
}

.edit-comment-area {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.edit-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--input);
  color: var(--foreground);
  font-size: 14px;
  resize: vertical;
}

.edit-textarea:focus {
  outline: none;
  border-color: var(--primary);
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn-save {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.btn-save:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-cancel {
  background: transparent;
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

.btn-cancel:hover:not(:disabled) {
  background: var(--card);
  color: var(--foreground);
}

@media (max-width: 600px) {
  .score-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
