import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'
import * as api from '@/services/api'
import * as ftcApi from '@/services/ftcApi'
import * as crdt from '@/services/crdt'
import * as offlineSync from '@/utils/offlineSync'
import * as photoStorage from '@/services/photoStorage'
import * as isMobileMod from '@/composables/useIsMobile'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { usePitScoutStore } from '@/stores/pitScout'
import { useScheduleStore } from '@/stores/schedule'
import { useAiStore } from '@/stores/ai'
import RankingsTable from '@/components/rankings/RankingsTable.vue'
import TagPicker from '@/components/common/TagPicker.vue'
import OfflineSyncModal from '@/components/common/OfflineSyncModal.vue'
import AiCopilotWorkspace from '@/components/ai/AiCopilotWorkspace.vue'
import { buildEventDataContext } from '@/components/ai/contextBuilder'
import type {
  AiProviderProfile,
  MatchScheduleItem,
  PitScoutingRecord,
  RankingRow,
  ScoutingEvent,
  ScoutingRecord,
  TeamTagItem
} from '@/types'

const mockRouterPush = vi.fn()
const mockRoute = {
  params: { eventId: 'evt-b' } as Record<string, string>,
  query: {} as Record<string, string>
}

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
    currentRoute: { value: mockRoute }
  }),
  useRoute: () => mockRoute,
  onBeforeRouteLeave: vi.fn(),
  onBeforeRouteUpdate: vi.fn()
}))

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return {
    ...actual,
    listRecords: vi.fn(async () => []),
    saveRecord: vi.fn(async () => undefined),
    syncRecords: vi.fn(async () => undefined),
    markRecordsSynced: vi.fn(async () => undefined),
    fetchBannedTeams: vi.fn(async () => []),
    fetchEventTags: vi.fn(async () => []),
    fetchPitRecords: vi.fn(async () => ({ records: [], officialTeams: [] })),
    savePitRecord: vi.fn(async () => ({ success: true })),
    syncPitRecordsBatch: vi.fn(async () => ({ success: true, count: 0 })),
    syncOfficialTeams: vi.fn(async () => ({ success: true, count: 0 })),
    fetchEventSchedule: vi.fn(async () => ({ schedules: [], assignments: [] })),
    fetchCustomFields: vi.fn(async () => []),
    isStaticCloudHost: vi.fn(() => false)
  }
})

vi.mock('@/services/ftcApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ftcApi')>()
  return {
    ...actual,
    fetchEventMatches: vi.fn(async () => []),
    fetchEventAdvancement: vi.fn(async () => []),
    fetchFtcTeams: vi.fn(async () => [])
  }
})

function createTestI18n(locale: 'en' | 'zh' = 'en') {
  return createI18n({
    legacy: false,
    locale,
    messages: { en, zh }
  })
}

function makeMatchRecord(overrides: Partial<ScoutingRecord> = {}): ScoutingRecord {
  return {
    id: 'rec-1',
    eventId: 'evt-a',
    scoutId: 'scout-1',
    scoutName: 'Alice',
    matchNumber: 1,
    teamNumber: 18219,
    autoScore: 20,
    teleopScore: 30,
    endgameScore: 10,
    totalScore: 60,
    notes: 'Event A note',
    rawData: '{}',
    syncStatus: 'SYNCED',
    createdAt: '2026-11-27T10:00:00.000Z',
    updatedAt: '2026-11-27T10:00:00.000Z',
    isBroken: false,
    version: 1,
    ...overrides
  }
}

function makePitRecord(overrides: Partial<PitScoutingRecord> = {}): PitScoutingRecord {
  return {
    id: 'pit-1',
    eventId: 'evt-a',
    teamNumber: 18219,
    scoutId: 'scout-1',
    scoutName: 'Alice',
    robotName: 'AlphaBot',
    drivetrainType: 'swerve',
    weightLbs: 35,
    ballCompatibility: 'universal',
    launcherType: 'Flywheel',
    flowerMechanism: 'Lift',
    hasColorSensor: true,
    odometryType: 'two_wheel',
    claimedAutoStrategy: '',
    claimedAutoScore: 20,
    claimedTeleopCycles: 5,
    claimedTeleopScore: 40,
    claimedEndgameScore: 15,
    claimedTotalScore: 75,
    version: 1,
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (val: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('Cross-event data isolation ("串数据" anti-regression suite)', () => {
  const wrappers: VueWrapper<any>[] = []
  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }

  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    mockRoute.params = { eventId: 'evt-b' }
    mockRoute.query = {}
    mockRouterPush.mockClear()
    await crdt.resetCrdtRegistryForTesting()
    vi.clearAllMocks()
    vi.mocked(api.isStaticCloudHost).mockReturnValue(false)
    vi.mocked(api.listRecords).mockResolvedValue([])
    vi.mocked(api.fetchBannedTeams).mockResolvedValue([])
    vi.mocked(api.fetchEventTags).mockResolvedValue([])
    vi.mocked(api.fetchPitRecords).mockResolvedValue({ records: [], officialTeams: [] })
    vi.mocked(api.fetchEventSchedule).mockResolvedValue({ schedules: [], assignments: [] })
    vi.mocked(api.fetchCustomFields).mockResolvedValue([])
    vi.mocked(ftcApi.fetchEventMatches).mockResolvedValue([])
    vi.mocked(ftcApi.fetchEventAdvancement).mockResolvedValue([])
  })

  afterEach(async () => {
    while (wrappers.length > 0) {
      wrappers.pop()!.unmount()
    }
    await crdt.resetCrdtRegistryForTesting()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })

  describe('pitScout store isolation', () => {
    it('clears previous event pit data when switching to an event with empty cache/backend and self-heals polluted cache', async () => {
      const pitStore = usePitScoutStore()

      vi.mocked(api.fetchPitRecords).mockResolvedValueOnce({
        records: [makePitRecord({ id: 'p-a', eventId: 'evt-a', teamNumber: 18219, robotName: 'RobotA' })],
        officialTeams: [{ eventId: 'evt-a', teamNumber: 18219, nameFull: 'Team A' }]
      })
      await pitStore.fetchPitData('evt-a')
      expect(pitStore.records.map((r) => r.teamNumber)).toEqual([18219])
      expect(pitStore.officialTeams.map((t) => t.teamNumber)).toEqual([18219])

      // Switch to evt-b whose cache and backend are empty
      vi.mocked(api.fetchPitRecords).mockResolvedValueOnce({ records: [], officialTeams: [] })
      await pitStore.fetchPitData('evt-b')

      expect(pitStore.records).toEqual([])
      expect(pitStore.officialTeams).toEqual([])
      expect(JSON.parse(localStorage.getItem('sp27_pit_records_evt-b') || '[]')).toEqual([])
      expect(JSON.parse(localStorage.getItem('sp27_pit_teams_evt-b') || '[]')).toEqual([])

      // Polluted localStorage self-heals on load: retains evt-b and strips evt-a
      localStorage.setItem(
        'sp27_pit_records_evt-b',
        JSON.stringify([
          makePitRecord({ id: 'p-a', eventId: 'evt-a', teamNumber: 18219 }),
          makePitRecord({ id: 'p-b', eventId: 'evt-b', teamNumber: 38080, robotName: 'RobotB' })
        ])
      )
      vi.mocked(api.fetchPitRecords).mockRejectedValueOnce(new Error('offline'))
      await pitStore.fetchPitData('evt-b')
      expect(pitStore.records.map((r) => r.teamNumber)).toEqual([38080])
      expect(JSON.parse(localStorage.getItem('sp27_pit_records_evt-b') || '[]')).toHaveLength(1)
    })

    it('drops stale fetchPitData responses and ignores syncFromCrdt for inactive events', async () => {
      const pitStore = usePitScoutStore()
      const slowA = deferred<{ records: PitScoutingRecord[]; officialTeams: any[] }>()
      const fastB = deferred<{ records: PitScoutingRecord[]; officialTeams: any[] }>()

      vi.mocked(api.fetchPitRecords)
        .mockReturnValueOnce(slowA.promise)
        .mockReturnValueOnce(fastB.promise)

      const pA = pitStore.fetchPitData('evt-a')
      const pB = pitStore.fetchPitData('evt-b')

      fastB.resolve({
        records: [makePitRecord({ id: 'p-b', eventId: 'evt-b', teamNumber: 38080 })],
        officialTeams: [{ eventId: 'evt-b', teamNumber: 38080, nameFull: 'Team B' }]
      })
      await pB

      slowA.resolve({
        records: [makePitRecord({ id: 'p-a', eventId: 'evt-a', teamNumber: 18219 })],
        officialTeams: [{ eventId: 'evt-a', teamNumber: 18219, nameFull: 'Team A' }]
      })
      await pA

      expect(pitStore.currentEventId).toBe('evt-b')
      expect(pitStore.records.map((r) => r.teamNumber)).toEqual([38080])
      expect(pitStore.officialTeams.map((t) => t.teamNumber)).toEqual([38080])

      const hA = crdt.getOrCreateEventCrdt('evt-a', { enableHttp: false, enableIndexedDb: false })
      crdt.writePitRecordToCrdt(hA.store, makePitRecord({ id: 'p-a-2', eventId: 'evt-a', teamNumber: 12808 }))
      pitStore.syncFromCrdt('evt-a')
      expect(pitStore.records.map((r) => r.teamNumber)).toEqual([38080])
    })
  })

  describe('schedule store & logout isolation', () => {
    it('clears previous event schedule/assignments on switch, self-heals polluted cache, and clears on logout', async () => {
      const scheduleStore = useScheduleStore()
      const userStore = useUserStore()

      const schedA: MatchScheduleItem = {
        id: 'evt-a_M1',
        eventId: 'evt-a',
        matchNumber: 1,
        tournamentLevel: 'QUALIFICATION',
        red1: 18219,
        red2: 12808,
        blue1: 8417,
        blue2: 27570
      }
      vi.mocked(api.fetchEventSchedule).mockResolvedValueOnce({
        schedules: [schedA],
        assignments: [
          {
            id: 'a-1',
            eventId: 'evt-a',
            matchNumber: 1,
            tournamentLevel: 'QUALIFICATION',
            station: 'red1',
            teamNumber: 18219,
            scoutId: 's1',
            scoutName: 'Alice'
          }
        ]
      })
      await scheduleStore.loadSchedule('evt-a')
      expect(scheduleStore.schedules).toHaveLength(1)
      expect(Object.keys(scheduleStore.assignments)).toHaveLength(1)

      // Switch to evt-b with empty backend
      vi.mocked(api.fetchEventSchedule).mockResolvedValueOnce({ schedules: [], assignments: [] })
      await scheduleStore.loadSchedule('evt-b')

      expect(scheduleStore.schedules).toEqual([])
      expect(scheduleStore.assignments).toEqual({})
      expect(JSON.parse(localStorage.getItem('scoutingpro27_schedule_evt-b') || '[]')).toEqual([])
      expect(JSON.parse(localStorage.getItem('scoutingpro27_assignments_evt-b') || '{}')).toEqual({})

      // Polluted localStorage self-heals
      localStorage.setItem(
        'scoutingpro27_schedule_evt-b',
        JSON.stringify([
          schedA,
          { id: 'evt-b_M1', eventId: 'evt-b', matchNumber: 1, tournamentLevel: 'QUALIFICATION', red1: 38080, red2: 37505, blue1: 36911, blue2: 32198 }
        ])
      )
      vi.mocked(api.fetchEventSchedule).mockRejectedValueOnce(new Error('offline'))
      await scheduleStore.loadSchedule('evt-b')
      expect(scheduleStore.schedules.map((s) => s.red1)).toEqual([38080])

      // Logout clears scheduleStore memory
      await userStore.logout()
      expect(scheduleStore.schedules).toEqual([])
      expect(scheduleStore.assignments).toEqual({})
      expect(scheduleStore.currentEventId).toBeNull()
    })
  })

  describe('records store isolation (tags, storage events, stale fetch)', () => {
    it('isolates tags by eventId, drops foreign tags on applyTagsFullSync, and ignores legacy global storage events', async () => {
      const recordStore = useRecordStore()
      const tagA: TeamTagItem = { id: 'ta', eventId: 'evt-a', teamNumber: 18219, tag: 'fast_cycle', color: 'green', isPreset: false }
      const tagB: TeamTagItem = { id: 'tb', eventId: 'evt-b', teamNumber: 38080, tag: 'swerve_b', color: 'blue', isPreset: false }

      recordStore.applyTagsFullSync([tagA], 'evt-a')
      recordStore.applyTagsFullSync([tagA, tagB], 'evt-b')

      recordStore.currentEventId = 'evt-b'
      expect(recordStore.currentTeamTags.map((t) => t.tag)).toEqual(['swerve_b'])
      expect(recordStore.getTagsForEvent('evt-b').map((t) => t.tag)).toEqual(['swerve_b'])
      expect(recordStore.getTagsForEvent('evt-a').map((t) => t.tag)).toEqual(['fast_cycle'])

      // Legacy global storage event must NOT clobber current event's officialMatches/bannedTeams
      recordStore.officialMatches = [{ matchNum: 1, scores: null, teams: [{ teamNumber: 38080, alliance: 'Red' }] }]
      recordStore.bannedTeams = [9999]
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'scoutingpro_officialMatches',
          newValue: JSON.stringify([{ matchNum: 99, scores: null, teams: [{ teamNumber: 18219, alliance: 'Red' }] }])
        })
      )
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'scoutingpro_bannedTeams',
          newValue: JSON.stringify([18219])
        })
      )
      expect(recordStore.officialMatches[0]?.matchNum).toBe(1)
      expect(recordStore.bannedTeams).toEqual([9999])

      // Positive control: event-scoped storage key DOES update active event
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'sp27_banned_teams_evt-b',
          newValue: JSON.stringify([38080])
        })
      )
      expect(recordStore.bannedTeams).toEqual([38080])

      // Stale fetchRecords(evt-a) after switching to evt-b does not overwrite evt-b FTC/banned state
      const slowMatchesA = deferred<any[]>()
      vi.mocked(ftcApi.fetchEventMatches).mockReturnValueOnce(slowMatchesA.promise)
      const fA = recordStore.fetchRecords('evt-a', 2026, 'CODEA')
      const fB = recordStore.fetchRecords('evt-b')
      await fB
      slowMatchesA.resolve([{ matchNum: 55, scores: null, teams: [{ teamNumber: 18219, alliance: 'Red' }] }])
      await fA
      expect(recordStore.currentEventId).toBe('evt-b')
      expect(recordStore.officialMatches).toEqual([])
    })
  })

  describe('UI & AI Copilot cross-event isolation', () => {
    it('RankingsTable only displays and filters by current event tags', async () => {
      const eventStore = useEventStore()
      const recordStore = useRecordStore()

      eventStore.setCurrentEvent({ id: 'evt-b', name: 'CNHAQ1', inviteCode: '3JJKLS', hostId: 'host-1' })
      recordStore.currentEventId = 'evt-b'
      recordStore.teamTags = [
        { id: 't-a', eventId: 'evt-a', teamNumber: 18219, tag: '#人玩易违规', color: 'red', isPreset: false },
        { id: 't-b', eventId: 'evt-b', teamNumber: 38080, tag: 'cnhaq1_fast', color: 'green', isPreset: false }
      ]

      const rankings: RankingRow[] = [
        { teamNumber: 38080, matchCount: 0, brokenCount: 0, avgAutoScore: 0, avgTeleopScore: 0, avgEndgameScore: 0, maxScore: 0, avgRating: 0, trend: 'new' },
        { teamNumber: 37505, matchCount: 0, brokenCount: 0, avgAutoScore: 0, avgTeleopScore: 0, avgEndgameScore: 0, maxScore: 0, avgRating: 0, trend: 'new' }
      ]

      const wrapper = track(
        mount(RankingsTable, {
          props: { rankings, loading: false },
          global: { plugins: [createTestI18n('en')] }
        })
      )

      const chipTexts = wrapper.findAll('.filter-chip').map((c) => c.text())
      expect(chipTexts.some((t) => t.includes('cnhaq1_fast'))).toBe(true)
      expect(chipTexts.some((t) => t.includes('#人玩易违规'))).toBe(false)

      const chipB = wrapper.findAll('.filter-chip').find((c) => c.text().includes('cnhaq1_fast'))!
      await chipB.trigger('click')
      expect(wrapper.find('[data-team-row="38080"]').exists()).toBe(true)
      expect(wrapper.find('[data-team-row="37505"]').exists()).toBe(false)
    })

    it('TagPicker only displays and suggests tags belonging to props.eventId', async () => {
      const recordStore = useRecordStore()
      recordStore.teamTags = [
        { id: 't-a1', eventId: 'evt-a', teamNumber: 27570, tag: 'foreign_tag', color: 'red', isPreset: false },
        { id: 't-a2', eventId: 'evt-a', teamNumber: 18219, tag: 'foreign_sugg', color: 'red', isPreset: false },
        { id: 't-b1', eventId: 'evt-b', teamNumber: 27570, tag: 'local_tag', color: 'green', isPreset: false },
        { id: 't-b2', eventId: 'evt-b', teamNumber: 38080, tag: 'local_sugg', color: 'blue', isPreset: false }
      ]

      const wrapper = track(
        mount(TagPicker, {
          props: { eventId: 'evt-b', teamNumber: 27570 },
          global: { plugins: [createTestI18n('en')] }
        })
      )

      const badgeTexts = wrapper.findAll('.tag-badge').map((b) => b.text())
      expect(badgeTexts.some((t) => t.includes('local_tag'))).toBe(true)
      expect(badgeTexts.some((t) => t.includes('foreign_tag'))).toBe(false)

      await wrapper.find('.btn-add-tag').trigger('click')
      const suggTexts = wrapper.findAll('.sugg-chip').map((s) => s.text())
      expect(suggTexts).toContain('local_sugg')
      expect(suggTexts).not.toContain('foreign_sugg')
    })

    it('AiCopilotWorkspace and buildEventDataContext strictly isolate context to current event (screenshot scenario)', async () => {
      const userStore = useUserStore()
      const eventStore = useEventStore()
      const recordStore = useRecordStore()
      const pitStore = usePitScoutStore()
      const scheduleStore = useScheduleStore()
      const aiStore = useAiStore()

      userStore.user = { id: 'u-1', username: 'Lucalmz', token: 'jwt-1' }
      const evtA: ScoutingEvent = { id: 'evt-a', name: 'Other Event', inviteCode: 'OTHER1', hostId: 'u-1' }
      const evtB: ScoutingEvent = { id: 'evt-b', name: '杭州一资格赛', inviteCode: '3JJKLS', hostId: 'u-1', ftcYear: 2026, ftcEventCode: 'CNHAQ1' }
      eventStore.events = [evtA, evtB]
      eventStore.setCurrentEvent(evtB)

      // Seed evt-a data in stores while evt-b has 0 match records and 1 official team
      recordStore.currentEventId = 'evt-b'
      recordStore.records = [
        makeMatchRecord({ id: 'r-a1', eventId: 'evt-a', teamNumber: 18219, matchNumber: 1, totalScore: 78, notes: 'From Event A' }),
        makeMatchRecord({ id: 'r-a2', eventId: 'evt-a', teamNumber: 12808, matchNumber: 2, totalScore: 62, notes: 'From Event A 2' })
      ]
      recordStore.teamTags = [
        { id: 'tg-a', eventId: 'evt-a', teamNumber: 18219, tag: 'foreign_tag', color: 'red', isPreset: false }
      ]
      recordStore.officialMatches = [
        { matchNum: 1, scores: null, teams: [{ teamNumber: 38080, alliance: 'Red' }] }
      ]
      pitStore.currentEventId = 'evt-b'
      pitStore.records = [makePitRecord({ id: 'p-a', eventId: 'evt-a', teamNumber: 18219 })]
      scheduleStore.schedules = [
        { id: 's-a', eventId: 'evt-a', matchNumber: 1, tournamentLevel: 'QUALIFICATION', red1: 18219, red2: 12808, blue1: 8417, blue2: 16461 }
      ]

      // Direct contextBuilder defense-in-depth check
      const directCtx = buildEventDataContext({
        event: evtB,
        rankings: recordStore.rankings,
        records: recordStore.records,
        tags: recordStore.teamTags,
        pitRecords: pitStore.records,
        schedules: scheduleStore.schedules
      })
      expect(directCtx).toContain('Event Name: 杭州一资格赛')
      expect(directCtx).toContain('Total Active Records: 0 | Total Tracked Teams: 1')
      expect(directCtx).toContain('38080')
      expect(directCtx).not.toContain('18219')
      expect(directCtx).not.toContain('12808')
      expect(directCtx).not.toContain('foreign_tag')
      expect(directCtx).not.toContain('From Event A')

      // Mount AiCopilotWorkspace and verify context badge + captured request payload
      const activeProfile: AiProviderProfile = {
        id: 'prof-1',
        name: 'Gemini',
        presetId: 'gemini',
        protocol: 'GEMINI',
        apiKeyEncrypted: 'AIza****123',
        hasApiKey: true,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        modelName: 'gemini-2.5-flash',
        customModels: ['gemini-2.5-flash'],
        systemPrompt: '',
        temperature: 0.4,
        maxTokens: 4096,
        enableThinking: false,
        thinkingBudget: 2048,
        anthropicVersion: '2023-06-01',
        maxContextMsgs: 16,
        proxyHost: '',
        proxyPort: null,
        isActive: true
      }
      aiStore.profiles = [activeProfile]
      aiStore.activeProfileId = 'prof-1'

      let capturedSystemPrompt = ''
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/ai/profiles')) {
          return new Response(JSON.stringify([activeProfile]), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (url.endsWith('/ai-threads') && (!init?.method || init.method === 'GET')) {
          return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (url.endsWith('/ai-threads') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              id: 'thr-b',
              userId: 'u-1',
              eventId: 'evt-b',
              title: 'New Chat',
              personaId: 'pit_brief',
              pinned: false,
              messages: [],
              contextConfig: {
                enabled: true,
                sections: { rankings: true, schedule: true, pit: true, matches: true, tags: true },
                focusTeams: [],
                focusMatch: null
              }
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (url.includes('/api/ai/chat/stream')) {
          const parsedBody = JSON.parse(String(init?.body || '{}'))
          capturedSystemPrompt = parsedBody.systemPrompt || ''
          const enc = new TextEncoder()
          const stream = new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(enc.encode('data: {"text":"OK"}\n\ndata: [DONE]\n\n'))
              ctrl.close()
            }
          })
          return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      })
      vi.stubGlobal('fetch', fetchMock)

      const wrapper = track(
        mount(AiCopilotWorkspace, {
          props: { eventId: 'evt-b', mode: 'dock' },
          global: { plugins: [createTestI18n('en')] }
        })
      )
      await flushPromises()

      expect(wrapper.text()).toContain('1T/0M')
      expect(wrapper.text()).not.toContain('2M')

      const textarea = wrapper.find('textarea')
      await textarea.setValue('Analyze this event')
      await textarea.trigger('keydown', { key: 'Enter' })
      await flushPromises()

      expect(capturedSystemPrompt).toContain('CNHAQ1')
      expect(capturedSystemPrompt).toContain('38080')
      expect(capturedSystemPrompt).not.toContain('18219')
      expect(capturedSystemPrompt).not.toContain('12808')
      expect(capturedSystemPrompt).not.toContain('foreign_tag')
      expect(capturedSystemPrompt).not.toContain('From Event A')
    })

    it('OfflineSyncModal Host export scopes tags, schedules, and assignments to current event', async () => {
      vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(true)
      vi.spyOn(isMobileMod, 'isMobileDevice').mockReturnValue(false)
      const downloadSpy = vi.spyOn(offlineSync, 'triggerFileDownload').mockImplementation(() => {})

      const userStore = useUserStore()
      const eventStore = useEventStore()
      const recordStore = useRecordStore()
      const scheduleStore = useScheduleStore()

      const evtB: ScoutingEvent = { id: 'evt-b', name: 'CNHAQ1', inviteCode: '3JJKLS', hostId: 'host-1' }
      userStore.user = { id: 'host-1', username: 'Host', token: 'jwt-h' }
      eventStore.events = [evtB]
      eventStore.setCurrentEvent(evtB)

      recordStore.records = [
        makeMatchRecord({ id: 'r-a', eventId: 'evt-a', teamNumber: 18219 }),
        makeMatchRecord({ id: 'r-b', eventId: 'evt-b', teamNumber: 38080 })
      ]
      recordStore.teamTags = [
        { id: 't-a', eventId: 'evt-a', teamNumber: 18219, tag: 'tag_a', color: 'red', isPreset: false },
        { id: 't-b', eventId: 'evt-b', teamNumber: 38080, tag: 'tag_b', color: 'green', isPreset: false }
      ]
      scheduleStore.schedules = [
        { id: 's-a', eventId: 'evt-a', matchNumber: 1, tournamentLevel: 'QUALIFICATION', red1: 18219, red2: 12808, blue1: 8417, blue2: 16461 },
        { id: 's-b', eventId: 'evt-b', matchNumber: 1, tournamentLevel: 'QUALIFICATION', red1: 38080, red2: 37505, blue1: 36911, blue2: 32198 }
      ]
      scheduleStore.assignments = {
        A_1: { id: 'aa', eventId: 'evt-a', matchNumber: 1, tournamentLevel: 'QUALIFICATION', station: 'red1', teamNumber: 18219, scoutId: 's1', scoutName: 'S1' },
        B_1: { id: 'ab', eventId: 'evt-b', matchNumber: 1, tournamentLevel: 'QUALIFICATION', station: 'red1', teamNumber: 38080, scoutId: 's2', scoutName: 'S2' }
      }

      const wrapper = track(
        mount(OfflineSyncModal, {
          props: { visible: true, eventId: 'evt-b' },
          global: { plugins: [createTestI18n('en')] }
        })
      )

      const buttons = wrapper.findAll('.btn-action')
      await buttons[0]!.trigger('click') // Export .event
      await buttons[1]!.trigger('click') // Export .info

      expect(downloadSpy).toHaveBeenCalledTimes(2)
      const evtPkg = JSON.parse(downloadSpy.mock.calls[0]![1])
      expect(evtPkg.schedule.map((s: any) => s.eventId)).toEqual(['evt-b'])
      expect(evtPkg.assignments.map((a: any) => a.eventId)).toEqual(['evt-b'])

      const infoPkg = JSON.parse(downloadSpy.mock.calls[1]![1])
      expect(infoPkg.payload.records.map((r: any) => r.eventId)).toEqual(['evt-b'])
      expect(infoPkg.payload.teamTags.map((t: any) => t.tag)).toEqual(['tag_b'])
    })
  })
})
