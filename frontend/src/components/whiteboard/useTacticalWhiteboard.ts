import { ref, computed, watch, type Ref } from 'vue'
import type { StationType, MatchScheduleItem, OfficialMatch } from '@/types'

export type WhiteboardPhase = 'auto' | 'teleop' | 'endgame'
export type WhiteboardTool =
  | 'select'
  | 'pen'
  | 'arrow'
  | 'dashed-arrow'
  | 'line'
  | 'rect'
  | 'circle'
  | 'text'
  | 'eraser'

export type TacticalRole = 'none' | 'scorer' | 'cycler' | 'defense' | 'support'
export type FieldRotation = 0 | 90 | 180 | 270

export interface NormalizedPoint {
  x: number
  y: number
}

export interface WhiteboardStroke {
  id: string
  type: Exclude<WhiteboardTool, 'select' | 'eraser'>
  color: string
  width: number
  points: NormalizedPoint[]
  text?: string
  createdAt: number
}

export interface RobotTokenState {
  station: StationType
  teamNumber: number
  x: number
  y: number
  heading: FieldRotation
  role: TacticalRole
}

export interface PhaseBoardState {
  strokes: WhiteboardStroke[]
  undoStack: WhiteboardStroke[][]
  redoStack: WhiteboardStroke[][]
  robots: Record<StationType, RobotTokenState>
}

export interface MatchWhiteboardPlan {
  matchKey: string
  matchNumber: number
  tournamentLevel: string
  customTeams?: {
    red1: number
    red2: number
    blue1: number
    blue2: number
  }
  phases: Record<WhiteboardPhase, PhaseBoardState>
  tacticalNotes: string
  updatedAt: number
}

export const STATION_LIST: StationType[] = ['red1', 'red2', 'blue1', 'blue2']

export const WHITEBOARD_COLORS = [
  { id: 'red1', hex: '#ef4444', labelKey: 'whiteboard.color_red1' },
  { id: 'red2', hex: '#f97316', labelKey: 'whiteboard.color_red2' },
  { id: 'blue1', hex: '#3b82f6', labelKey: 'whiteboard.color_blue1' },
  { id: 'blue2', hex: '#06b6d4', labelKey: 'whiteboard.color_blue2' },
  { id: 'neon', hex: '#39ff14', labelKey: 'whiteboard.color_neon' },
  { id: 'yellow', hex: '#eab308', labelKey: 'whiteboard.color_yellow' },
  { id: 'white', hex: '#f8fafc', labelKey: 'whiteboard.color_white' }
] as const

const MAX_UNDO_STEPS = 50
const MAX_SAVED_PLANS_PER_EVENT = 120

export function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0
  return Math.max(0, Math.min(1, val))
}

/**
 * 将规范化场地坐标 (fx, fy in [0,1]) 转换为当前视图旋转/镜像后的画布归一化坐标 (vx, vy in [0,1])
 */
export function fieldToViewCoords(
  fx: number,
  fy: number,
  rotation: FieldRotation = 0,
  flipH = false
): NormalizedPoint {
  const x = clamp01(fx)
  const y = clamp01(fy)
  let rx = x
  let ry = y

  if (rotation === 90) {
    rx = 1 - y
    ry = x
  } else if (rotation === 180) {
    rx = 1 - x
    ry = 1 - y
  } else if (rotation === 270) {
    rx = y
    ry = 1 - x
  }

  const vx = flipH ? 1 - rx : rx
  return { x: clamp01(vx), y: clamp01(ry) }
}

/**
 * 将当前视图画布归一化坐标 (vx, vy in [0,1]) 逆变换回规范化场地坐标 (fx, fy in [0,1])
 */
export function viewToFieldCoords(
  vx: number,
  vy: number,
  rotation: FieldRotation = 0,
  flipH = false
): NormalizedPoint {
  const rx = flipH ? 1 - clamp01(vx) : clamp01(vx)
  const ry = clamp01(vy)
  let fx = rx
  let fy = ry

  if (rotation === 90) {
    fx = ry
    fy = 1 - rx
  } else if (rotation === 180) {
    fx = 1 - rx
    fy = 1 - ry
  } else if (rotation === 270) {
    fx = 1 - ry
    fy = rx
  }

  return { x: clamp01(fx), y: clamp01(fy) }
}

/**
 * 点 (px, py) 到线段 (x1, y1)-(x2, y2) 的欧氏距离
 */
export function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) {
    return Math.hypot(px - x1, py - y1)
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq))
  const projX = x1 + t * dx
  const projY = y1 + t * dy
  return Math.hypot(px - projX, py - projY)
}

/**
 * 检测某个笔画是否被橡皮擦命中（在场地归一化坐标系下）
 */
export function isStrokeHitByEraser(
  stroke: WhiteboardStroke,
  pt: NormalizedPoint,
  eraserRadiusNorm = 0.032
): boolean {
  if (!stroke || !Array.isArray(stroke.points) || stroke.points.length === 0) {
    return false
  }
  const pts = stroke.points
  const p0 = pts[0]!

  if (stroke.type === 'text') {
    const textLen = Math.max(3, (stroke.text || '').length)
    const halfW = Math.min(0.25, textLen * 0.014 + eraserRadiusNorm)
    const halfH = 0.03 + eraserRadiusNorm
    return Math.abs(pt.x - p0.x) <= halfW && Math.abs(pt.y - p0.y) <= halfH
  }

  if (pts.length === 1) {
    return Math.hypot(pt.x - p0.x, pt.y - p0.y) <= eraserRadiusNorm
  }

  if (stroke.type === 'rect') {
    const p1 = pts[pts.length - 1]!
    const minX = Math.min(p0.x, p1.x)
    const maxX = Math.max(p0.x, p1.x)
    const minY = Math.min(p0.y, p1.y)
    const maxY = Math.max(p0.y, p1.y)
    const dTop = distanceToSegment(pt.x, pt.y, minX, minY, maxX, minY)
    const dBottom = distanceToSegment(pt.x, pt.y, minX, maxY, maxX, maxY)
    const dLeft = distanceToSegment(pt.x, pt.y, minX, minY, minX, maxY)
    const dRight = distanceToSegment(pt.x, pt.y, maxX, minY, maxX, maxY)
    return Math.min(dTop, dBottom, dLeft, dRight) <= eraserRadiusNorm
  }

  if (stroke.type === 'circle') {
    const p1 = pts[pts.length - 1]!
    const radius = Math.hypot(p1.x - p0.x, p1.y - p0.y)
    const distToCenter = Math.hypot(pt.x - p0.x, pt.y - p0.y)
    if (radius <= eraserRadiusNorm) {
      return distToCenter <= eraserRadiusNorm * 1.2
    }
    return Math.abs(distToCenter - radius) <= eraserRadiusNorm
  }

  // pen, line, arrow, dashed-arrow
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    if (distanceToSegment(pt.x, pt.y, a.x, a.y, b.x, b.y) <= eraserRadiusNorm) {
      return true
    }
  }
  return false
}

/**
 * 默认机器人站位（按阶段区分：Auto 贴近联盟墙起始线，TeleOp 分布在半场循环通道，Endgame 靠近停泊/花坛区）
 */
export function createDefaultPhaseRobots(
  phase: WhiteboardPhase,
  teams: { red1: number; red2: number; blue1: number; blue2: number },
  existingRoles?: Partial<Record<StationType, TacticalRole>>
): Record<StationType, RobotTokenState> {
  if (phase === 'auto') {
    return {
      red1: { station: 'red1', teamNumber: teams.red1, x: 0.14, y: 0.30, heading: 90, role: existingRoles?.red1 || 'scorer' },
      red2: { station: 'red2', teamNumber: teams.red2, x: 0.14, y: 0.70, heading: 90, role: existingRoles?.red2 || 'cycler' },
      blue1: { station: 'blue1', teamNumber: teams.blue1, x: 0.86, y: 0.30, heading: 270, role: existingRoles?.blue1 || 'scorer' },
      blue2: { station: 'blue2', teamNumber: teams.blue2, x: 0.86, y: 0.70, heading: 270, role: existingRoles?.blue2 || 'cycler' }
    }
  }
  if (phase === 'teleop') {
    return {
      red1: { station: 'red1', teamNumber: teams.red1, x: 0.32, y: 0.34, heading: 90, role: existingRoles?.red1 || 'scorer' },
      red2: { station: 'red2', teamNumber: teams.red2, x: 0.28, y: 0.68, heading: 90, role: existingRoles?.red2 || 'cycler' },
      blue1: { station: 'blue1', teamNumber: teams.blue1, x: 0.68, y: 0.34, heading: 270, role: existingRoles?.blue1 || 'scorer' },
      blue2: { station: 'blue2', teamNumber: teams.blue2, x: 0.72, y: 0.68, heading: 270, role: existingRoles?.blue2 || 'cycler' }
    }
  }
  // endgame
  return {
    red1: { station: 'red1', teamNumber: teams.red1, x: 0.22, y: 0.20, heading: 0, role: existingRoles?.red1 || 'scorer' },
    red2: { station: 'red2', teamNumber: teams.red2, x: 0.42, y: 0.50, heading: 90, role: existingRoles?.red2 || 'cycler' },
    blue1: { station: 'blue1', teamNumber: teams.blue1, x: 0.78, y: 0.20, heading: 0, role: existingRoles?.blue1 || 'scorer' },
    blue2: { station: 'blue2', teamNumber: teams.blue2, x: 0.58, y: 0.50, heading: 270, role: existingRoles?.blue2 || 'cycler' }
  }
}

export function cloneStrokes(strokes: WhiteboardStroke[]): WhiteboardStroke[] {
  return strokes.map((s) => ({
    ...s,
    points: s.points.map((p) => ({ x: p.x, y: p.y }))
  }))
}

export function hitTestRobotToken(
  robots: Record<StationType, RobotTokenState>,
  fx: number,
  fy: number,
  hitRadiusNorm = 0.058
): StationType | null {
  // 按渲染逆序检测，最上层优先
  const order: StationType[] = ['blue2', 'blue1', 'red2', 'red1']
  for (const st of order) {
    const r = robots[st]
    if (!r) continue
    if (Math.hypot(fx - r.x, fy - r.y) <= hitRadiusNorm) {
      return st
    }
  }
  return null
}

/**
 * 将规范化场地坐标转换为 FTC 6x6 地垫网格编号 (A1 - F6)
 */
export function formatFieldTileCoord(fx: number, fy: number): string {
  const cols = ['A', 'B', 'C', 'D', 'E', 'F']
  const colIdx = Math.min(5, Math.max(0, Math.floor(clamp01(fx) * 6)))
  const rowIdx = Math.min(5, Math.max(0, Math.floor(clamp01(fy) * 6)))
  return `${cols[colIdx]}${rowIdx + 1}`
}

/**
 * 磁吸对齐到 FTC 6x6 地垫中心或格线 (默认 12 等分，即每半块地垫一个磁吸锚点)
 */
export function snapToFieldGrid(
  fx: number,
  fy: number,
  subdivisions = 12
): NormalizedPoint {
  const divs = Math.max(2, subdivisions)
  const sx = Math.round(clamp01(fx) * divs) / divs
  const sy = Math.round(clamp01(fy) * divs) / divs
  return { x: clamp01(sx), y: clamp01(sy) }
}

/**
 * 沿多段折线按进度 progress (0..1) 线性插值，返回当前位置、切线角度与已走过的折线顶点
 * 用于战术路径动画演示与机器人轨迹自动巡航回放
 */
export function interpolatePointAlongPolyline(
  points: NormalizedPoint[],
  progress: number
): {
  x: number
  y: number
  angleDeg: number
  partialPoints: NormalizedPoint[]
} {
  if (!points || points.length === 0) {
    return { x: 0.5, y: 0.5, angleDeg: 0, partialPoints: [] }
  }
  const p0 = points[0]!
  if (points.length === 1 || progress <= 0) {
    const p1 = points[1] || p0
    const deg = (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI
    return { x: p0.x, y: p0.y, angleDeg: Number.isFinite(deg) ? deg : 0, partialPoints: [{ ...p0 }] }
  }

  const clampedProg = clamp01(progress)
  const segLengths: number[] = []
  let totalLen = 0
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    segLengths.push(len)
    totalLen += len
  }

  if (totalLen <= 1e-6 || clampedProg >= 1) {
    const last = points[points.length - 1]!
    const prev = points[points.length - 2] || p0
    const deg = (Math.atan2(last.y - prev.y, last.x - prev.x) * 180) / Math.PI
    return {
      x: last.x,
      y: last.y,
      angleDeg: Number.isFinite(deg) ? deg : 0,
      partialPoints: points.map((p) => ({ ...p }))
    }
  }

  const targetDist = totalLen * clampedProg
  let accum = 0
  const partial: NormalizedPoint[] = [{ ...p0 }]

  for (let i = 0; i < segLengths.length; i++) {
    const segLen = segLengths[i]!
    const a = points[i]!
    const b = points[i + 1]!
    if (accum + segLen >= targetDist && segLen > 0) {
      const localT = (targetDist - accum) / segLen
      const curX = a.x + (b.x - a.x) * localT
      const curY = a.y + (b.y - a.y) * localT
      const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
      partial.push({ x: curX, y: curY })
      return {
        x: curX,
        y: curY,
        angleDeg: Number.isFinite(deg) ? deg : 0,
        partialPoints: partial
      }
    }
    partial.push({ ...b })
    accum += segLen
  }

  const last = points[points.length - 1]!
  return { x: last.x, y: last.y, angleDeg: 0, partialPoints: partial }
}

/**
 * 逆序命中检测最顶层笔画 ID（供选择工具平移或橡皮擦悬停高亮使用）
 */
export function hitTestTopStroke(
  strokes: WhiteboardStroke[],
  pt: NormalizedPoint,
  hitRadiusNorm = 0.032
): string | null {
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i]!
    if (isStrokeHitByEraser(s, pt, hitRadiusNorm)) {
      return s.id
    }
  }
  return null
}

export function createEmptyPhaseBoard(
  phase: WhiteboardPhase,
  teams: { red1: number; red2: number; blue1: number; blue2: number }
): PhaseBoardState {
  return {
    strokes: [],
    undoStack: [],
    redoStack: [],
    robots: createDefaultPhaseRobots(phase, teams)
  }
}

export function createMatchPlan(
  matchKey: string,
  matchNumber: number,
  tournamentLevel: string,
  teams: { red1: number; red2: number; blue1: number; blue2: number },
  isCustom = false
): MatchWhiteboardPlan {
  return {
    matchKey,
    matchNumber,
    tournamentLevel,
    customTeams: isCustom ? { ...teams } : undefined,
    phases: {
      auto: createEmptyPhaseBoard('auto', teams),
      teleop: createEmptyPhaseBoard('teleop', teams),
      endgame: createEmptyPhaseBoard('endgame', teams)
    },
    tacticalNotes: '',
    updatedAt: Date.now()
  }
}

export interface UseTacticalWhiteboardOptions {
  eventId: Ref<string>
  schedules: Ref<MatchScheduleItem[]>
  officialMatches: Ref<OfficialMatch[]>
  initialMatch?: Ref<{ matchNumber: number; tournamentLevel?: string } | null | undefined>
}

export function useTacticalWhiteboard(options: UseTacticalWhiteboardOptions) {
  const { eventId, schedules, officialMatches, initialMatch } = options

  const activePhase = ref<WhiteboardPhase>('auto')
  const activeTool = ref<WhiteboardTool>('pen')
  const activeColor = ref<string>('#ef4444')
  const activeStrokeWidth = ref<number>(5)
  const fieldRotation = ref<FieldRotation>(0)
  const fieldFlipH = ref<boolean>(false)
  const showGridCoords = ref<boolean>(true)
  const snapToGrid = ref<boolean>(false)
  const isFullscreen = ref<boolean>(false)
  const showSidebar = ref<boolean>(true)
  const sidebarMode = ref<'overview' | 'detail'>('overview')
  const selectedStation = ref<StationType>('red1')
  const highlightedStation = ref<StationType | null>(null)
  const filterTeamQuery = ref<string>('')

  // 所有已保存的场次方案字典：key = matchKey (`QUALIFICATION_1`, `PLAYOFF_2`, `CUSTOM`)
  const plansByMatchKey = ref<Record<string, MatchWhiteboardPlan>>({})
  const selectedMatchKey = ref<string>('CUSTOM')

  // 合并赛程表与官方比赛，生成可选场次列表
  const availableMatches = computed<MatchScheduleItem[]>(() => {
    const map = new Map<string, MatchScheduleItem>()

    for (const s of schedules.value || []) {
      const level = (s.tournamentLevel || 'QUALIFICATION').toUpperCase()
      const key = `${level}_${s.matchNumber}`
      map.set(key, {
        ...s,
        tournamentLevel: level,
        red1: Number(s.red1) || 0,
        red2: Number(s.red2) || 0,
        blue1: Number(s.blue1) || 0,
        blue2: Number(s.blue2) || 0
      })
    }

    for (const om of officialMatches.value || []) {
      const level = (om.tournamentLevel || 'QUALIFICATION').toUpperCase()
      const key = `${level}_${om.matchNum}`
      if (!map.has(key) && Array.isArray(om.teams)) {
        const reds = om.teams.filter((t) => t.alliance?.toLowerCase() === 'red').map((t) => Number(t.teamNumber) || 0)
        const blues = om.teams.filter((t) => t.alliance?.toLowerCase() === 'blue').map((t) => Number(t.teamNumber) || 0)
        map.set(key, {
          eventId: eventId.value,
          matchNumber: om.matchNum,
          tournamentLevel: level,
          red1: reds[0] || 0,
          red2: reds[1] || 0,
          blue1: blues[0] || 0,
          blue2: blues[1] || 0,
          scoreRedFinal: om.scores?.red?.totalPointsNp ?? null,
          scoreBlueFinal: om.scores?.blue?.totalPointsNp ?? null
        })
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      const orderA = (a.tournamentLevel || '').toUpperCase() === 'PLAYOFF' ? 1 : 0
      const orderB = (b.tournamentLevel || '').toUpperCase() === 'PLAYOFF' ? 1 : 0
      if (orderA !== orderB) return orderA - orderB
      return a.matchNumber - b.matchNumber
    })
  })

  const filteredMatches = computed<MatchScheduleItem[]>(() => {
    const q = filterTeamQuery.value.trim()
    if (!q) return availableMatches.value
    return availableMatches.value.filter((m) =>
      [m.red1, m.red2, m.blue1, m.blue2].some((tn) => tn > 0 && String(tn).includes(q))
    )
  })

  function getStorageKey(evtId: string): string {
    return `sp27_whiteboard_v1_${evtId || 'default'}`
  }

  function loadPlansFromStorage(evtId: string) {
    if (typeof localStorage === 'undefined') return
    try {
      const raw = localStorage.getItem(getStorageKey(evtId))
      if (!raw) {
        plansByMatchKey.value = {}
        return
      }
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const sanitized: Record<string, MatchWhiteboardPlan> = {}
        for (const [k, val] of Object.entries(parsed)) {
          const v = val as any
          if (v && typeof v === 'object' && v.phases && v.phases.auto && v.phases.teleop && v.phases.endgame) {
            for (const ph of ['auto', 'teleop', 'endgame'] as WhiteboardPhase[]) {
              const pState = v.phases[ph]
              if (!Array.isArray(pState.strokes)) pState.strokes = []
              pState.undoStack = Array.isArray(pState.undoStack) ? pState.undoStack.slice(-15) : []
              pState.redoStack = []
            }
            sanitized[k] = v as MatchWhiteboardPlan
          }
        }
        plansByMatchKey.value = sanitized
      }
    } catch {
      plansByMatchKey.value = {}
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function savePlansToStorage() {
    if (typeof localStorage === 'undefined') return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        const entries = Object.entries(plansByMatchKey.value)
        // 限制最大存储场次数，防止撑爆 localStorage
        const trimmed = entries
          .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
          .slice(0, MAX_SAVED_PLANS_PER_EVENT)
        const serializable: Record<string, any> = {}
        for (const [k, plan] of trimmed) {
          serializable[k] = {
            ...plan,
            phases: {
              auto: { ...plan.phases.auto, undoStack: [], redoStack: [] },
              teleop: { ...plan.phases.teleop, undoStack: [], redoStack: [] },
              endgame: { ...plan.phases.endgame, undoStack: [], redoStack: [] }
            }
          }
        }
        localStorage.setItem(getStorageKey(eventId.value), JSON.stringify(serializable))
      } catch {
        // Ignore quota errors gracefully
      }
    }, 250)
  }

  function resolveTeamsForMatchKey(key: string): {
    matchNumber: number
    tournamentLevel: string
    teams: { red1: number; red2: number; blue1: number; blue2: number }
    isCustom: boolean
  } {
    if (key === 'CUSTOM') {
      const existingCustom = plansByMatchKey.value['CUSTOM']?.customTeams
      return {
        matchNumber: 0,
        tournamentLevel: 'CUSTOM',
        teams: existingCustom || { red1: 0, red2: 0, blue1: 0, blue2: 0 },
        isCustom: true
      }
    }
    const found = availableMatches.value.find(
      (m) => `${(m.tournamentLevel || 'QUALIFICATION').toUpperCase()}_${m.matchNumber}` === key
    )
    if (found) {
      const existingCustom = plansByMatchKey.value[key]?.customTeams
      return {
        matchNumber: found.matchNumber,
        tournamentLevel: (found.tournamentLevel || 'QUALIFICATION').toUpperCase(),
        teams: existingCustom || {
          red1: found.red1,
          red2: found.red2,
          blue1: found.blue1,
          blue2: found.blue2
        },
        isCustom: Boolean(existingCustom)
      }
    }
    return {
      matchNumber: 1,
      tournamentLevel: 'QUALIFICATION',
      teams: { red1: 0, red2: 0, blue1: 0, blue2: 0 },
      isCustom: true
    }
  }

  function ensurePlan(key: string): MatchWhiteboardPlan {
    const info = resolveTeamsForMatchKey(key)
    let plan = plansByMatchKey.value[key]
    if (!plan) {
      plan = createMatchPlan(key, info.matchNumber, info.tournamentLevel, info.teams, info.isCustom)
      plansByMatchKey.value[key] = plan
    } else if (!plan.customTeams && key !== 'CUSTOM') {
      // 同步赛程表最新四队编号（保留用户拖拽过的机位坐标与战术分工）
      for (const ph of ['auto', 'teleop', 'endgame'] as WhiteboardPhase[]) {
        const robots = plan.phases[ph].robots
        robots.red1.teamNumber = info.teams.red1
        robots.red2.teamNumber = info.teams.red2
        robots.blue1.teamNumber = info.teams.blue1
        robots.blue2.teamNumber = info.teams.blue2
      }
    }
    return plan
  }

  const currentPlan = computed<MatchWhiteboardPlan>(() => {
    return ensurePlan(selectedMatchKey.value)
  })

  const currentPhaseBoard = computed<PhaseBoardState>(() => {
    return currentPlan.value.phases[activePhase.value]
  })

  const currentTeams = computed<Record<StationType, number>>(() => {
    const robots = currentPhaseBoard.value.robots
    return {
      red1: robots.red1.teamNumber || 0,
      red2: robots.red2.teamNumber || 0,
      blue1: robots.blue1.teamNumber || 0,
      blue2: robots.blue2.teamNumber || 0
    }
  })

  const canUndo = computed(() => currentPhaseBoard.value.undoStack.length > 0)
  const canRedo = computed(() => currentPhaseBoard.value.redoStack.length > 0)

  function selectMatch(key: string) {
    ensurePlan(key)
    selectedMatchKey.value = key
    // 默认选中第一个有效队号的工位
    const teams = currentTeams.value
    const firstValid = STATION_LIST.find((st) => teams[st] > 0) || 'red1'
    selectedStation.value = firstValid
  }

  function selectMatchByNumber(matchNumber: number, tournamentLevel = 'QUALIFICATION') {
    const normLevel = (tournamentLevel || 'QUALIFICATION').toUpperCase()
    const key = `${normLevel}_${Number(matchNumber)}`
    selectMatch(key)
  }

  function stepMatch(delta: -1 | 1) {
    const list = filteredMatches.value
    if (list.length === 0) return
    const curIdx = list.findIndex(
      (m) => `${(m.tournamentLevel || 'QUALIFICATION').toUpperCase()}_${m.matchNumber}` === selectedMatchKey.value
    )
    if (curIdx === -1) {
      const target = delta > 0 ? list[0]! : list[list.length - 1]!
      selectMatchByNumber(target.matchNumber, target.tournamentLevel)
    } else {
      const nextIdx = (curIdx + delta + list.length) % list.length
      const target = list[nextIdx]!
      selectMatchByNumber(target.matchNumber, target.tournamentLevel)
    }
  }

  function setCustomMatchTeams(teams: { red1: number; red2: number; blue1: number; blue2: number }) {
    const plan = currentPlan.value
    plan.customTeams = {
      red1: Math.max(0, Math.floor(Number(teams.red1) || 0)),
      red2: Math.max(0, Math.floor(Number(teams.red2) || 0)),
      blue1: Math.max(0, Math.floor(Number(teams.blue1) || 0)),
      blue2: Math.max(0, Math.floor(Number(teams.blue2) || 0))
    }
    for (const ph of ['auto', 'teleop', 'endgame'] as WhiteboardPhase[]) {
      const robots = plan.phases[ph].robots
      robots.red1.teamNumber = plan.customTeams.red1
      robots.red2.teamNumber = plan.customTeams.red2
      robots.blue1.teamNumber = plan.customTeams.blue1
      robots.blue2.teamNumber = plan.customTeams.blue2
    }
    plan.updatedAt = Date.now()
    savePlansToStorage()
  }

  function pushUndoSnapshot(board: PhaseBoardState) {
    board.undoStack.push(cloneStrokes(board.strokes))
    if (board.undoStack.length > MAX_UNDO_STEPS) {
      board.undoStack.shift()
    }
    board.redoStack = []
  }

  function addStroke(stroke: WhiteboardStroke) {
    const board = currentPhaseBoard.value
    pushUndoSnapshot(board)
    board.strokes.push({
      ...stroke,
      points: stroke.points.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    })
    currentPlan.value.updatedAt = Date.now()
    savePlansToStorage()
  }

  function eraseStrokesAt(pt: NormalizedPoint, eraserRadiusNorm = 0.032): number {
    const board = currentPhaseBoard.value
    const hits = board.strokes.filter((s) => isStrokeHitByEraser(s, pt, eraserRadiusNorm))
    if (hits.length === 0) return 0
    pushUndoSnapshot(board)
    const hitIds = new Set(hits.map((h) => h.id))
    board.strokes = board.strokes.filter((s) => !hitIds.has(s.id))
    currentPlan.value.updatedAt = Date.now()
    savePlansToStorage()
    return hits.length
  }

  function undo() {
    const board = currentPhaseBoard.value
    if (board.undoStack.length === 0) return false
    const prev = board.undoStack.pop()!
    board.redoStack.push(cloneStrokes(board.strokes))
    board.strokes = prev
    currentPlan.value.updatedAt = Date.now()
    savePlansToStorage()
    return true
  }

  function redo() {
    const board = currentPhaseBoard.value
    if (board.redoStack.length === 0) return false
    const next = board.redoStack.pop()!
    board.undoStack.push(cloneStrokes(board.strokes))
    board.strokes = next
    currentPlan.value.updatedAt = Date.now()
    savePlansToStorage()
    return true
  }

  function clearCurrentPhaseStrokes() {
    const board = currentPhaseBoard.value
    if (board.strokes.length === 0) return
    pushUndoSnapshot(board)
    board.strokes = []
    currentPlan.value.updatedAt = Date.now()
    savePlansToStorage()
  }

  function beginStrokeTranslate(strokeId: string): boolean {
    const board = currentPhaseBoard.value
    const exists = board.strokes.some((s) => s.id === strokeId)
    if (!exists) return false
    pushUndoSnapshot(board)
    return true
  }

  function translateStrokeById(strokeId: string, dx: number, dy: number) {
    const board = currentPhaseBoard.value
    const stroke = board.strokes.find((s) => s.id === strokeId)
    if (!stroke) return
    stroke.points = stroke.points.map((p) => ({
      x: clamp01(p.x + dx),
      y: clamp01(p.y + dy)
    }))
    currentPlan.value.updatedAt = Date.now()
    savePlansToStorage()
  }

  function moveRobotToken(station: StationType, fx: number, fy: number) {
    const robot = currentPhaseBoard.value.robots[station]
    if (!robot) return
    robot.x = clamp01(fx)
    robot.y = clamp01(fy)
    currentPlan.value.updatedAt = Date.now()
    savePlansToStorage()
  }

  function rotateRobotToken(station: StationType) {
    const robot = currentPhaseBoard.value.robots[station]
    if (!robot) return
    robot.heading = (((robot.heading || 0) + 90) % 360) as FieldRotation
    currentPlan.value.updatedAt = Date.now()
    savePlansToStorage()
  }

  function setRobotRole(station: StationType, role: TacticalRole) {
    // 战术分工跨阶段同步到整场比赛
    for (const ph of ['auto', 'teleop', 'endgame'] as WhiteboardPhase[]) {
      const r = currentPlan.value.phases[ph].robots[station]
      if (r) r.role = role
    }
    currentPlan.value.updatedAt = Date.now()
    savePlansToStorage()
  }

  function resetCurrentPhaseRobots() {
    const roles: Partial<Record<StationType, TacticalRole>> = {
      red1: currentPhaseBoard.value.robots.red1.role,
      red2: currentPhaseBoard.value.robots.red2.role,
      blue1: currentPhaseBoard.value.robots.blue1.role,
      blue2: currentPhaseBoard.value.robots.blue2.role
    }
    currentPhaseBoard.value.robots = createDefaultPhaseRobots(activePhase.value, currentTeams.value, roles)
    currentPlan.value.updatedAt = Date.now()
    savePlansToStorage()
  }

  function syncRobotsFromPreviousPhase(): boolean {
    const prevPhase: WhiteboardPhase =
      activePhase.value === 'endgame' ? 'teleop' : activePhase.value === 'teleop' ? 'auto' : 'auto'
    if (prevPhase === activePhase.value) return false
    const srcRobots = currentPlan.value.phases[prevPhase].robots
    const dstRobots = currentPhaseBoard.value.robots
    for (const st of STATION_LIST) {
      dstRobots[st] = { ...srcRobots[st] }
    }
    currentPlan.value.updatedAt = Date.now()
    savePlansToStorage()
    return true
  }

  function rotateField() {
    fieldRotation.value = (((fieldRotation.value || 0) + 90) % 360) as FieldRotation
  }

  function toggleFlipField() {
    fieldFlipH.value = !fieldFlipH.value
  }

  function selectStationForDetail(station: StationType, switchToDetail = true) {
    selectedStation.value = station
    // 联动画笔颜色为该联盟工位代表色
    const colorMap: Record<StationType, string> = {
      red1: '#ef4444',
      red2: '#f97316',
      blue1: '#3b82f6',
      blue2: '#06b6d4'
    }
    activeColor.value = colorMap[station]
    if (switchToDetail) {
      sidebarMode.value = 'detail'
      showSidebar.value = true
    }
  }

  function pulseHighlightStation(station: StationType) {
    highlightedStation.value = station
    setTimeout(() => {
      if (highlightedStation.value === station) {
        highlightedStation.value = null
      }
    }, 1800)
  }

  function updateTacticalNotes(notes: string) {
    currentPlan.value.tacticalNotes = notes
    currentPlan.value.updatedAt = Date.now()
    savePlansToStorage()
  }

  // 初始化与监听赛事/赛程变化
  watch(
    () => eventId.value,
    (newEvtId) => {
      loadPlansFromStorage(newEvtId)
      if (initialMatch?.value) {
        selectMatchByNumber(initialMatch.value.matchNumber, initialMatch.value.tournamentLevel)
      } else if (availableMatches.value.length > 0) {
        const first = availableMatches.value[0]!
        selectMatchByNumber(first.matchNumber, first.tournamentLevel)
      } else {
        selectMatch('CUSTOM')
      }
    },
    { immediate: true }
  )

  watch(
    () => initialMatch?.value,
    (target) => {
      if (target && target.matchNumber > 0) {
        selectMatchByNumber(target.matchNumber, target.tournamentLevel)
      }
    },
    { deep: true }
  )

  watch(
    () => availableMatches.value.length,
    (newLen, oldLen) => {
      if (newLen > 0 && (!oldLen || selectedMatchKey.value === 'CUSTOM')) {
        if (initialMatch?.value && initialMatch.value.matchNumber > 0) {
          selectMatchByNumber(initialMatch.value.matchNumber, initialMatch.value.tournamentLevel)
        } else {
          const first = availableMatches.value[0]!
          selectMatchByNumber(first.matchNumber, first.tournamentLevel)
        }
      }
    }
  )

  return {
    activePhase,
    activeTool,
    activeColor,
    activeStrokeWidth,
    fieldRotation,
    fieldFlipH,
    showGridCoords,
    snapToGrid,
    isFullscreen,
    showSidebar,
    sidebarMode,
    selectedStation,
    highlightedStation,
    filterTeamQuery,
    availableMatches,
    filteredMatches,
    selectedMatchKey,
    currentPlan,
    currentPhaseBoard,
    currentTeams,
    canUndo,
    canRedo,
    selectMatch,
    selectMatchByNumber,
    stepMatch,
    setCustomMatchTeams,
    addStroke,
    eraseStrokesAt,
    beginStrokeTranslate,
    translateStrokeById,
    undo,
    redo,
    clearCurrentPhaseStrokes,
    moveRobotToken,
    rotateRobotToken,
    setRobotRole,
    resetCurrentPhaseRobots,
    syncRobotsFromPreviousPhase,
    rotateField,
    toggleFlipField,
    selectStationForDetail,
    pulseHighlightStation,
    updateTacticalNotes
  }
}
