<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { StationType } from '@/types'
import {
  fieldToViewCoords,
  viewToFieldCoords,
  hitTestRobotToken,
  hitTestTopStroke,
  isStrokeHitByEraser,
  formatFieldTileCoord,
  snapToFieldGrid,
  interpolatePointAlongPolyline,
  getStationColor,
  readCssToken,
  toNormalizedHex,
  withAlpha,
  STATION_LIST,
  type WhiteboardPhase,
  type WhiteboardTool,
  type WhiteboardStroke,
  type RobotTokenState,
  type FieldRotation,
  type NormalizedPoint
} from './useTacticalWhiteboard'

interface CanvasTheme {
  style: CSSStyleDeclaration | null
  g950: string
  g900: string
  g850: string
  g800: string
  g100: string
  g50: string
  primary: string
  s200: string
  red300: string
  red400: string
  red900: string
  blue300: string
  blue400: string
  blue900: string
  warning: string
  error: string
  shadowBlack: string
  fontSans: string
  fontNumeric: string
}

function resolveCanvasTheme(): CanvasTheme {
  const style =
    typeof document !== 'undefined' && typeof getComputedStyle === 'function'
      ? getComputedStyle(document.documentElement)
      : null
  return {
    style,
    g950: readCssToken('--g-950', 'rgb(7, 9, 10)', style),
    g900: readCssToken('--g-900', 'rgb(11, 14, 16)', style),
    g850: readCssToken('--g-850', 'rgb(16, 20, 23)', style),
    g800: readCssToken('--g-800', 'rgb(21, 26, 30)', style),
    g100: readCssToken('--g-100', 'rgb(230, 235, 238)', style),
    g50: readCssToken('--g-50', 'rgb(246, 248, 249)', style),
    primary: readCssToken('--primary', 'rgb(57, 255, 20)', style),
    s200: readCssToken('--s-200', 'rgb(184, 255, 163)', style),
    red300: readCssToken('--red-300', 'rgb(255, 143, 135)', style),
    red400: readCssToken('--red-400', 'rgb(255, 93, 82)', style),
    red900: readCssToken('--red-900', 'rgb(42, 19, 17)', style),
    blue300: readCssToken('--blue-300', 'rgb(142, 197, 255)', style),
    blue400: readCssToken('--blue-400', 'rgb(79, 163, 255)', style),
    blue900: readCssToken('--blue-900', 'rgb(14, 27, 46)', style),
    warning: readCssToken('--status-warning', 'rgb(247, 181, 59)', style),
    error: readCssToken('--status-error', 'rgb(255, 85, 119)', style),
    shadowBlack: 'rgb(0, 0, 0)',
    fontSans: readCssToken(
      '--font-sans',
      "'Manrope', 'NotoSansSC', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
      style
    ),
    fontNumeric: readCssToken(
      '--font-numeric',
      "'Orbitron', 'Manrope', 'NotoSansSC', monospace",
      style
    )
  }
}

const props = defineProps<{
  phase: WhiteboardPhase
  tool: WhiteboardTool
  color: string
  strokeWidth: number
  rotation: FieldRotation
  flipH: boolean
  showGridCoords: boolean
  snapToGrid?: boolean
  strokes: WhiteboardStroke[]
  robots: Record<StationType, RobotTokenState>
  selectedStation: StationType
  highlightedStation: StationType | null
  matchLabel: string
}>()

const emit = defineEmits<{
  (e: 'addStroke', stroke: WhiteboardStroke): void
  (e: 'eraseAt', pt: NormalizedPoint): void
  (e: 'beginStrokeDrag', strokeId: string): void
  (e: 'moveStroke', payload: { strokeId: string; dx: number; dy: number }): void
  (e: 'moveRobot', payload: { station: StationType; x: number; y: number }): void
  (e: 'rotateRobot', station: StationType): void
  (e: 'selectStation', station: StationType): void
  (e: 'simulationChange', isPlaying: boolean): void
}>()

const { t } = useI18n()

const containerRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const canvasSize = ref<number>(600)

// 正在绘制中的临时笔画与高级交互状态
const draftPoints = ref<NormalizedPoint[]>([])
const isPointerDown = ref(false)
const draggingStation = ref<StationType | null>(null)
const draggingStrokeId = ref<string | null>(null)
const hoveredStrokeId = ref<string | null>(null)
const dragStartViewPt = ref<NormalizedPoint | null>(null)
const lastDragFieldPt = ref<NormalizedPoint | null>(null)
const robotDragMoved = ref(false)
const hoverViewPt = ref<NormalizedPoint | null>(null)
const hoverFieldPt = ref<NormalizedPoint | null>(null)
const activeSnapPt = ref<NormalizedPoint | null>(null)

// 战术轨迹推演回放状态 (0..1)
const isSimulating = ref(false)
const simProgress = ref(1)
let simRafId: number | null = null
let simStartTime = 0
const SIM_DURATION_MS = 2800

// 声呐脉冲水波纹动效队列
interface CanvasRipple {
  fx: number
  fy: number
  color: string
  bornAt: number
}
const ripples = ref<CanvasRipple[]>([])
let rippleRafId: number | null = null

// 机器人平滑弹簧插值坐标（用于切换阶段/重置机位时的丝滑过渡）
const displayRobotCoords = ref<Record<StationType, { x: number; y: number }>>({
  red1: { x: 0.14, y: 0.30 },
  red2: { x: 0.14, y: 0.70 },
  blue1: { x: 0.86, y: 0.30 },
  blue2: { x: 0.86, y: 0.70 }
})
let robotSpringRafId: number | null = null

function syncDisplayRobotsImmediate() {
  for (const st of STATION_LIST) {
    const r = props.robots[st]
    if (r) {
      displayRobotCoords.value[st] = { x: r.x, y: r.y }
    }
  }
}
syncDisplayRobotsImmediate()

function animateRobotTransition() {
  if (typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') {
    syncDisplayRobotsImmediate()
    renderCanvas()
    return
  }
  const prefersReduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReduced || draggingStation.value) {
    syncDisplayRobotsImmediate()
    renderCanvas()
    return
  }

  if (robotSpringRafId !== null) cancelAnimationFrame(robotSpringRafId)
  const step = () => {
    let needsMore = false
    for (const st of STATION_LIST) {
      const target = props.robots[st]
      const cur = displayRobotCoords.value[st]
      if (!target || !cur) continue
      const dx = target.x - cur.x
      const dy = target.y - cur.y
      if (Math.hypot(dx, dy) > 0.0015) {
        cur.x += dx * 0.26
        cur.y += dy * 0.26
        needsMore = true
      } else {
        cur.x = target.x
        cur.y = target.y
      }
    }
    renderCanvas()
    if (needsMore) {
      robotSpringRafId = requestAnimationFrame(step)
    } else {
      robotSpringRafId = null
    }
  }
  robotSpringRafId = requestAnimationFrame(step)
}

function spawnRipple(fx: number, fy: number, color = readCssToken('--primary', 'rgb(57, 255, 20)')) {
  ripples.value.push({ fx, fy, color, bornAt: performance.now() })
  if (rippleRafId === null && typeof requestAnimationFrame !== 'undefined') {
    const tickRipples = () => {
      const now = performance.now()
      ripples.value = ripples.value.filter((r) => now - r.bornAt < 650)
      renderCanvas()
      if (ripples.value.length > 0) {
        rippleRafId = requestAnimationFrame(tickRipples)
      } else {
        rippleRafId = null
      }
    }
    rippleRafId = requestAnimationFrame(tickRipples)
  }
}

function startSimulation() {
  if (simRafId !== null && typeof cancelAnimationFrame !== 'undefined') {
    cancelAnimationFrame(simRafId)
  }
  isSimulating.value = true
  simProgress.value = 0
  simStartTime = typeof performance !== 'undefined' ? performance.now() : Date.now()
  emit('simulationChange', true)

  if (typeof requestAnimationFrame === 'undefined') {
    simProgress.value = 1
    isSimulating.value = false
    emit('simulationChange', false)
    renderCanvas()
    return
  }

  const stepSim = (now: number) => {
    const elapsed = Math.max(0, now - simStartTime)
    const prog = Math.min(1, elapsed / SIM_DURATION_MS)
    simProgress.value = prog
    renderCanvas()
    if (prog < 1 && isSimulating.value) {
      simRafId = requestAnimationFrame(stepSim)
    } else {
      simProgress.value = 1
      isSimulating.value = false
      simRafId = null
      emit('simulationChange', false)
      renderCanvas()
    }
  }
  simRafId = requestAnimationFrame(stepSim)
}

function stopSimulation() {
  if (simRafId !== null && typeof cancelAnimationFrame !== 'undefined') {
    cancelAnimationFrame(simRafId)
    simRafId = null
  }
  isSimulating.value = false
  simProgress.value = 1
  emit('simulationChange', false)
  renderCanvas()
}

function toggleSimulation(): boolean {
  if (isSimulating.value) {
    stopSimulation()
    return false
  } else {
    startSimulation()
    return true
  }
}

// 文本标注浮层状态
const textPromptState = ref<{
  visible: boolean
  fieldPt: NormalizedPoint
  viewPt: NormalizedPoint
  text: string
}>({
  visible: false,
  fieldPt: { x: 0.5, y: 0.5 },
  viewPt: { x: 0.5, y: 0.5 },
  text: ''
})
const textInputRef = ref<HTMLInputElement | null>(null)

let resizeObserver: ResizeObserver | null = null

function updateCanvasDimensions() {
  const container = containerRef.value
  const canvas = canvasRef.value
  if (!container || !canvas) return

  const rect = container.getBoundingClientRect()
  const side = Math.max(260, Math.floor(Math.min(rect.width || 600, rect.height || 600)))
  canvasSize.value = side

  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2.5) : 1
  canvas.width = Math.floor(side * dpr)
  canvas.height = Math.floor(side * dpr)
  canvas.style.width = `${side}px`
  canvas.style.height = `${side}px`

  renderCanvas()
}

function toViewPx(fx: number, fy: number, size: number): { x: number; y: number } {
  const v = fieldToViewCoords(fx, fy, props.rotation, props.flipH)
  return { x: v.x * size, y: v.y * size }
}

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  headLen: number
) {
  const angle = Math.atan2(toY - fromY, toX - fromX)
  ctx.beginPath()
  ctx.moveTo(toX, toY)
  ctx.lineTo(toX - headLen * Math.cos(angle - Math.PI / 6), toY - headLen * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(toX - headLen * Math.cos(angle + Math.PI / 6), toY - headLen * Math.sin(angle + Math.PI / 6))
  ctx.closePath()
  ctx.fill()
}

function drawFtcFieldBase(ctx: CanvasRenderingContext2D, size: number, theme: CanvasTheme) {
  const tile = size / 6

  // 1. 6x6 地垫棋盘格底色
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      const isEven = (row + col) % 2 === 0
      ctx.fillStyle = isEven ? theme.g900 : theme.g850
      ctx.fillRect(col * tile, row * tile, tile, tile)
    }
  }

  // 2. 红方与蓝方联盟边界墙 & 站位半场氛围带（随场地旋转/翻转变换）
  const redWallA = toViewPx(0.0, 0.0, size)
  const redWallB = toViewPx(0.0, 1.0, size)
  const blueWallA = toViewPx(1.0, 0.0, size)
  const blueWallB = toViewPx(1.0, 1.0, size)

  ctx.save()
  ctx.lineWidth = Math.max(6, size * 0.012)
  ctx.strokeStyle = withAlpha(theme.red400, 0.85)
  ctx.beginPath()
  ctx.moveTo(redWallA.x, redWallA.y)
  ctx.lineTo(redWallB.x, redWallB.y)
  ctx.stroke()

  ctx.strokeStyle = withAlpha(theme.blue400, 0.85)
  ctx.beginPath()
  ctx.moveTo(blueWallA.x, blueWallA.y)
  ctx.lineTo(blueWallB.x, blueWallB.y)
  ctx.stroke()
  ctx.restore()

  // 3. BIOBUZZ 角落花园 (A1 红方 / F6 蓝方) 与装载停泊区 (F1 红方 / A6 蓝方)
  const drawPolyField = (pts: Array<[number, number]>, fill: string, stroke: string, dashed = false) => {
    ctx.save()
    ctx.beginPath()
    pts.forEach(([fx, fy], idx) => {
      const p = toViewPx(fx, fy, size)
      if (idx === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    })
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = stroke
    if (dashed) ctx.setLineDash([6, 4])
    ctx.stroke()
    ctx.restore()
  }

  // 红方左上 A1 Corner Garden (狭窄对角角区) & 左下 F1 Loading/Park Zone
  drawPolyField(
    [
      [0, 0],
      [1 / 6, 0],
      [0, 1 / 6]
    ],
    withAlpha(theme.red400, 0.22),
    withAlpha(theme.red400, 0.72),
    true
  )
  drawPolyField(
    [
      [0, 5 / 6],
      [1 / 6, 1],
      [0, 1]
    ],
    withAlpha(theme.red400, 0.14),
    withAlpha(theme.red400, 0.6)
  )

  // 蓝方右下 F6 Corner Garden & 右上 A6 Loading/Park Zone
  drawPolyField(
    [
      [5 / 6, 0],
      [1, 0],
      [1, 1 / 6]
    ],
    withAlpha(theme.blue400, 0.14),
    withAlpha(theme.blue400, 0.6)
  )
  drawPolyField(
    [
      [1, 5 / 6],
      [5 / 6, 1],
      [1, 1]
    ],
    withAlpha(theme.blue400, 0.22),
    withAlpha(theme.blue400, 0.72),
    true
  )

  // 4. 起始自动线与中场分界线
  const drawFieldLine = (
    fx1: number,
    fy1: number,
    fx2: number,
    fy2: number,
    color: string,
    width = 2,
    dash: number[] = []
  ) => {
    const p1 = toViewPx(fx1, fy1, size)
    const p2 = toViewPx(fx2, fy2, size)
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = width
    if (dash.length) ctx.setLineDash(dash)
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
    ctx.stroke()
    ctx.restore()
  }

  // 中场对角线与起始线
  drawFieldLine(0.5, 0, 0.5, 1, withAlpha(theme.g50, 0.16), 2, [8, 6])
  drawFieldLine(1 / 6, 0, 1 / 6, 1, withAlpha(theme.red400, 0.28), 1.5, [4, 4])
  drawFieldLine(5 / 6, 0, 5 / 6, 1, withAlpha(theme.blue400, 0.28), 1.5, [4, 4])

  // 5. 四侧边界花朵目标 (4 Perimeter Flowers along top/bottom side walls)
  const flowerSpots: Array<[number, number]> = [
    [2 / 6, 0.045],
    [4 / 6, 0.045],
    [2 / 6, 0.955],
    [4 / 6, 0.955]
  ]
  const flowerOuterR = Math.max(9, size * 0.024)
  const flowerInnerR = Math.max(4, size * 0.011)
  for (const [fx, fy] of flowerSpots) {
    const fp = toViewPx(fx, fy, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(fp.x, fp.y, flowerOuterR, 0, Math.PI * 2)
    ctx.fillStyle = withAlpha(theme.warning, 0.18)
    ctx.fill()
    ctx.lineWidth = 1.8
    ctx.strokeStyle = withAlpha(theme.warning, 0.85)
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(fp.x, fp.y, flowerInnerR, 0, Math.PI * 2)
    ctx.fillStyle = withAlpha(theme.primary, 0.65)
    ctx.fill()
    ctx.restore()
  }

  // 6. 中央双侧共享蜂巢目标区 (BIOBUZZ Central Dual Hive 2x2 center)
  drawPolyField(
    [
      [2 / 6, 2 / 6],
      [4 / 6, 2 / 6],
      [4 / 6, 4 / 6],
      [2 / 6, 4 / 6]
    ],
    withAlpha(theme.primary, 0.04),
    withAlpha(theme.primary, 0.34)
  )

  const centerPt = toViewPx(0.5, 0.5, size)
  const blueAxisPt = toViewPx(0.6, 0.5, size)
  const blueAngle = Math.atan2(blueAxisPt.y - centerPt.y, blueAxisPt.x - centerPt.x)
  const hiveR = size * 0.088

  ctx.save()
  ctx.beginPath()
  ctx.arc(centerPt.x, centerPt.y, hiveR, 0, Math.PI * 2)
  ctx.fillStyle = withAlpha(theme.g800, 0.9)
  ctx.fill()
  ctx.lineWidth = 2.5
  ctx.strokeStyle = withAlpha(theme.primary, 0.65)
  ctx.stroke()

  // 红侧半弧 vs 蓝侧半弧指示中央蜂巢归属
  ctx.beginPath()
  ctx.arc(centerPt.x, centerPt.y, hiveR * 0.76, blueAngle + Math.PI / 2, blueAngle + (3 * Math.PI) / 2)
  ctx.lineWidth = 3.5
  ctx.strokeStyle = withAlpha(theme.red400, 0.78)
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(centerPt.x, centerPt.y, hiveR * 0.76, blueAngle - Math.PI / 2, blueAngle + Math.PI / 2)
  ctx.lineWidth = 3.5
  ctx.strokeStyle = withAlpha(theme.blue400, 0.78)
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(centerPt.x, centerPt.y, size * 0.036, 0, Math.PI * 2)
  ctx.fillStyle = withAlpha(theme.primary, 0.22)
  ctx.fill()
  ctx.restore()

  // 分区微标签 (HIVE / GARDEN / PARK / FLOWER)
  const drawZoneLabel = (fx: number, fy: number, label: string, color: string) => {
    if (size < 320) return
    const p = toViewPx(fx, fy, size)
    ctx.save()
    ctx.font = `700 ${Math.max(8, Math.floor(size * 0.015))}px ${theme.fontSans}`
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, p.x, p.y)
    ctx.restore()
  }
  drawZoneLabel(0.5, 0.5 + 0.115, 'HIVE', withAlpha(theme.s200, 0.62))
  drawZoneLabel(0.065, 0.065, 'GARDEN', withAlpha(theme.red300, 0.65))
  drawZoneLabel(0.935, 0.935, 'GARDEN', withAlpha(theme.blue300, 0.65))
  drawZoneLabel(0.065, 0.935, 'PARK', withAlpha(theme.red300, 0.55))
  drawZoneLabel(0.935, 0.065, 'PARK', withAlpha(theme.blue300, 0.55))
  if (props.showGridCoords) {
    drawZoneLabel(2 / 6, 0.095, 'FLOWER', withAlpha(theme.warning, 0.62))
    drawZoneLabel(4 / 6, 0.905, 'FLOWER', withAlpha(theme.warning, 0.62))
  }

  // 6. 6x6 地垫网格细线与 A1-F6 坐标标签
  ctx.save()
  ctx.strokeStyle = withAlpha(theme.g50, 0.08)
  ctx.lineWidth = 1
  for (let i = 1; i < 6; i++) {
    ctx.beginPath()
    ctx.moveTo(i * tile, 0)
    ctx.lineTo(i * tile, size)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(0, i * tile)
    ctx.lineTo(size, i * tile)
    ctx.stroke()
  }

  if (props.showGridCoords) {
    const rowLetters = ['A', 'B', 'C', 'D', 'E', 'F']
    ctx.font = `600 ${Math.max(10, Math.floor(size * 0.019))}px ${theme.fontSans}`
    ctx.fillStyle = withAlpha(theme.g100, 0.24)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        const cellCenter = toViewPx((c + 0.5) / 6, (r + 0.5) / 6, size)
        const label = `${rowLetters[r]}${c + 1}`
        ctx.fillText(label, cellCenter.x - tile * 0.42, cellCenter.y - tile * 0.42)
      }
    }
  }
  ctx.restore()
}

function drawSingleStroke(
  ctx: CanvasRenderingContext2D,
  stroke: {
    id?: string
    type: Exclude<WhiteboardTool, 'select' | 'eraser'>
    color: string
    width: number
    points: NormalizedPoint[]
    text?: string
  },
  size: number,
  theme: CanvasTheme,
  options?: {
    isHovered?: boolean
    isEraserTarget?: boolean
    simProgress?: number
  }
) {
  let pts = stroke.points
  if (!pts || pts.length === 0) return

  const scaleFactor = size / 600
  const lineWidth = Math.max(2, stroke.width * scaleFactor)
  const prog = options?.simProgress !== undefined ? options.simProgress : 1

  if (
    prog < 1 &&
    (stroke.type === 'pen' || stroke.type === 'arrow' || stroke.type === 'dashed-arrow' || stroke.type === 'line')
  ) {
    const interp = interpolatePointAlongPolyline(pts, prog)
    pts = interp.partialPoints
    if (pts.length === 0) return
  }

  ctx.save()
  const activeStrokeColor = options?.isEraserTarget ? theme.error : stroke.color
  ctx.strokeStyle = activeStrokeColor
  ctx.fillStyle = activeStrokeColor
  ctx.lineWidth = options?.isHovered || options?.isEraserTarget ? lineWidth + 2.5 : lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (options?.isHovered || options?.isEraserTarget) {
    ctx.shadowColor = withAlpha(theme.shadowBlack, 0.5)
    ctx.shadowBlur = 6
    ctx.shadowOffsetY = 2
  }

  if (stroke.type === 'text') {
    const p0 = toViewPx(pts[0]!.x, pts[0]!.y, size)
    const content = stroke.text || ''
    if (!content) {
      ctx.restore()
      return
    }
    const fontSize = Math.max(12, Math.floor(14 * scaleFactor))
    ctx.font = `700 ${fontSize}px ${theme.fontSans}`
    const metrics = ctx.measureText(content)
    const padX = 8 * scaleFactor
    const padY = 5 * scaleFactor
    const boxW = metrics.width + padX * 2
    const boxH = fontSize + padY * 2

    ctx.fillStyle = withAlpha(theme.g900, 0.9)
    ctx.strokeStyle = activeStrokeColor
    ctx.lineWidth = options?.isHovered || options?.isEraserTarget ? 2.5 : 1.5
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(p0.x - boxW / 2, p0.y - boxH / 2, boxW, boxH, 6)
    } else {
      ctx.rect(p0.x - boxW / 2, p0.y - boxH / 2, boxW, boxH)
    }
    ctx.fill()
    ctx.stroke()

    ctx.fillStyle = activeStrokeColor
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(content, p0.x, p0.y)
    ctx.restore()
    return
  }

  if (stroke.type === 'rect') {
    if (pts.length < 2) {
      ctx.restore()
      return
    }
    const a = toViewPx(pts[0]!.x, pts[0]!.y, size)
    const b = toViewPx(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y, size)
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    const w = Math.abs(b.x - a.x)
    const h = Math.abs(b.y - a.y)

    ctx.save()
    ctx.globalAlpha = 0.14 * prog
    ctx.fillRect(x, y, w, h)
    ctx.restore()

    ctx.setLineDash([6, 4])
    ctx.strokeRect(x, y, w, h)
    ctx.restore()
    return
  }

  if (stroke.type === 'circle') {
    if (pts.length < 2) {
      ctx.restore()
      return
    }
    const a = toViewPx(pts[0]!.x, pts[0]!.y, size)
    const b = toViewPx(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y, size)
    const r = Math.hypot(b.x - a.x, b.y - a.y) * prog
    ctx.beginPath()
    ctx.arc(a.x, a.y, r, 0, Math.PI * 2)
    ctx.save()
    ctx.globalAlpha = 0.12
    ctx.fill()
    ctx.restore()
    ctx.stroke()
    ctx.restore()
    return
  }

  if (stroke.type === 'line' || stroke.type === 'arrow' || stroke.type === 'dashed-arrow') {
    if (pts.length < 2) {
      ctx.restore()
      return
    }
    const a = toViewPx(pts[0]!.x, pts[0]!.y, size)
    const b = toViewPx(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y, size)
    if (stroke.type === 'dashed-arrow') {
      ctx.setLineDash([10 * scaleFactor, 6 * scaleFactor])
    }
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()

    if (stroke.type === 'arrow' || stroke.type === 'dashed-arrow') {
      ctx.setLineDash([])
      drawArrowhead(ctx, a.x, a.y, b.x, b.y, Math.max(12, lineWidth * 3.1))
    }
    ctx.restore()
    return
  }

  // Freehand 'pen' with quadratic curve smoothing
  const viewPts = pts.map((p) => toViewPx(p.x, p.y, size))
  ctx.beginPath()
  if (viewPts.length === 1) {
    ctx.arc(viewPts[0]!.x, viewPts[0]!.y, lineWidth / 2, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.moveTo(viewPts[0]!.x, viewPts[0]!.y)
    for (let i = 1; i < viewPts.length - 1; i++) {
      const midX = (viewPts[i]!.x + viewPts[i + 1]!.x) / 2
      const midY = (viewPts[i]!.y + viewPts[i + 1]!.y) / 2
      ctx.quadraticCurveTo(viewPts[i]!.x, viewPts[i]!.y, midX, midY)
    }
    const last = viewPts[viewPts.length - 1]!
    ctx.lineTo(last.x, last.y)
    ctx.stroke()

    // 若处于轨迹推演回放中，在自由画笔前端绘制高亮激光引导点
    if (prog < 1) {
      ctx.beginPath()
      ctx.arc(last.x, last.y, lineWidth * 1.35, 0, Math.PI * 2)
      ctx.fillStyle = theme.primary
      ctx.fill()
    }
  }
  ctx.restore()
}

function resolveSimulatedRobotPose(
  st: StationType,
  baseRobot: RobotTokenState,
  theme: CanvasTheme
): {
  x: number
  y: number
  heading: number
} {
  if (!isSimulating.value || simProgress.value >= 1) {
    const smooth = displayRobotCoords.value[st]
    return {
      x: draggingStation.value === st || !smooth ? baseRobot.x : smooth.x,
      y: draggingStation.value === st || !smooth ? baseRobot.y : smooth.y,
      heading: baseRobot.heading || 0
    }
  }

  const rawStationColor = getStationColor(st, theme.style)
  const stationColor = toNormalizedHex(rawStationColor, rawStationColor)

  // 寻找属于该机器人的路径笔画（起点靠近该机器人或颜色匹配该工位）
  const candidate = props.strokes.find((s) => {
    if (s.type !== 'arrow' && s.type !== 'dashed-arrow' && s.type !== 'pen' && s.type !== 'line') {
      return false
    }
    if (!s.points || s.points.length < 2) return false
    const p0 = s.points[0]!
    const nearStart = Math.hypot(p0.x - baseRobot.x, p0.y - baseRobot.y) <= 0.14
    const sameColor = toNormalizedHex(s.color, s.color).toLowerCase() === stationColor.toLowerCase()
    return nearStart || sameColor
  })

  if (!candidate) {
    return { x: baseRobot.x, y: baseRobot.y, heading: baseRobot.heading || 0 }
  }

  const interp = interpolatePointAlongPolyline(candidate.points, simProgress.value)
  // 将切线角度 (0° = +X) 映射为白板机头角度 (0° = -Y / 上方, 90° = +X / 右方)
  const headingFromTangent = ((Math.round(interp.angleDeg + 90) % 360) + 360) % 360
  return {
    x: interp.x,
    y: interp.y,
    heading: headingFromTangent
  }
}

function drawRipplesAndSnapTarget(ctx: CanvasRenderingContext2D, size: number, theme: CanvasTheme) {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  for (const rp of ripples.value) {
    const age = Math.max(0, Math.min(1, (now - rp.bornAt) / 650))
    const p = toViewPx(rp.fx, rp.fy, size)
    const radius = size * (0.04 + age * 0.095)
    ctx.save()
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
    ctx.strokeStyle = rp.color
    ctx.globalAlpha = Math.max(0, (1 - age) * 0.78)
    ctx.lineWidth = 2.5 * (1 - age * 0.5)
    ctx.stroke()
    ctx.restore()
  }

  // 磁吸格心目标准星预览
  if (draggingStation.value && activeSnapPt.value) {
    const sp = toViewPx(activeSnapPt.value.x, activeSnapPt.value.y, size)
    ctx.save()
    ctx.strokeStyle = withAlpha(theme.primary, 0.85)
    ctx.lineWidth = 1.5
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.arc(sp.x, sp.y, size * 0.056, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(sp.x - 8, sp.y)
    ctx.lineTo(sp.x + 8, sp.y)
    ctx.moveTo(sp.x, sp.y - 8)
    ctx.lineTo(sp.x, sp.y + 8)
    ctx.stroke()
    ctx.restore()
  }
}

function drawRobotTokens(ctx: CanvasRenderingContext2D, size: number, theme: CanvasTheme) {
  const tokenSize = Math.max(38, size * 0.086)
  const half = tokenSize / 2

  for (const st of STATION_LIST) {
    const r = props.robots[st]
    if (!r) continue

    const simPose = resolveSimulatedRobotPose(st, r, theme)
    const pos = toViewPx(simPose.x, simPose.y, size)
    const isRed = st.startsWith('red')
    const isSelected = props.selectedStation === st
    const isHighlighted = props.highlightedStation === st
    const isDraggingThis = draggingStation.value === st

    const primaryColor = getStationColor(st, theme.style)

    ctx.save()
    ctx.translate(pos.x, pos.y)
    if (isDraggingThis) {
      ctx.scale(1.12, 1.12)
      ctx.shadowColor = withAlpha(theme.shadowBlack, 0.55)
      ctx.shadowBlur = 12
      ctx.shadowOffsetY = 4
    }

    // 高亮脉冲环或选中环
    if (isHighlighted || isSelected || isDraggingThis) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(0, 0, half * 1.38, 0, Math.PI * 2)
      ctx.strokeStyle = isHighlighted ? theme.primary : primaryColor
      ctx.lineWidth = isHighlighted ? 3.5 : 2
      if (!isHighlighted && !isDraggingThis) ctx.setLineDash([4, 3])
      ctx.stroke()
      ctx.restore()
    }

    // 机器人底盘方块
    ctx.fillStyle = isRed ? withAlpha(theme.red900, 0.94) : withAlpha(theme.blue900, 0.94)
    ctx.strokeStyle = primaryColor
    ctx.lineWidth = isSelected || isDraggingThis ? 3 : 2.2
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(-half, -half, tokenSize, tokenSize, 9)
    } else {
      ctx.rect(-half, -half, tokenSize, tokenSize)
    }
    ctx.fill()
    ctx.stroke()

    // 机头朝向小圆点指示器 (计算视图旋转与镜像后的角度)
    let viewHeading = ((simPose.heading || 0) + props.rotation) % 360
    if (props.flipH) {
      viewHeading = (360 - viewHeading) % 360
    }
    const rad = ((viewHeading - 90) * Math.PI) / 180
    const indicatorDist = half - 5
    const ix = Math.cos(rad) * indicatorDist
    const iy = Math.sin(rad) * indicatorDist
    ctx.beginPath()
    ctx.arc(ix, iy, 3.8, 0, Math.PI * 2)
    ctx.fillStyle = theme.primary
    ctx.fill()

    // 工位徽标 (R1 / R2 / B1 / B2)
    const stationLabel = st.toUpperCase().replace('RED', 'R').replace('BLUE', 'B')
    ctx.fillStyle = primaryColor
    ctx.font = `800 ${Math.max(10, Math.floor(tokenSize * 0.25))}px ${theme.fontNumeric}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(stationLabel, 0, -1)

    // 队伍编号
    const teamText = r.teamNumber > 0 ? `#${r.teamNumber}` : 'TBD'
    ctx.fillStyle = theme.g50
    ctx.font = `700 ${Math.max(10, Math.floor(tokenSize * 0.25))}px ${theme.fontNumeric}`
    ctx.textBaseline = 'top'
    ctx.fillText(teamText, 0, 1)

    // 拖拽时顶部悬浮实时网格坐标与车头角度胶囊 (如: C3 · 90°)
    if (isDraggingThis) {
      const tileLabel = formatFieldTileCoord(r.x, r.y)
      const hudText = `${activeSnapPt.value ? '🧲 ' : ''}${tileLabel} · ${r.heading}°`
      ctx.font = `700 11px ${theme.fontSans}`
      const tw = ctx.measureText(hudText).width + 14
      const th = 20
      const ty = -half - 24
      ctx.fillStyle = withAlpha(theme.g950, 0.94)
      ctx.strokeStyle = theme.primary
      ctx.lineWidth = 1.2
      ctx.beginPath()
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(-tw / 2, ty, tw, th, 6)
      } else {
        ctx.rect(-tw / 2, ty, tw, th)
      }
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = theme.primary
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(hudText, 0, ty + th / 2)
    }

    ctx.restore()
  }
}

function renderCanvas() {
  const canvas = canvasRef.value
  if (!canvas) return
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx) return

  const size = canvasSize.value
  const dpr = canvas.width / size
  const theme = resolveCanvasTheme()

  ctx.save()
  if (typeof ctx.setTransform === 'function') {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  if (typeof ctx.clearRect === 'function') {
    ctx.clearRect(0, 0, size, size)
  }

  // 1. 绘制 FTC 场地底图
  drawFtcFieldBase(ctx, size, theme)

  // 2. 绘制声呐水波纹与磁吸准星
  drawRipplesAndSnapTarget(ctx, size, theme)

  // 3. 绘制已保存笔画（支持悬停高亮、橡皮擦预警与轨迹推演动画）
  for (const stroke of props.strokes) {
    const isEraserHit =
      props.tool === 'eraser' &&
      hoverFieldPt.value !== null &&
      isStrokeHitByEraser(stroke, hoverFieldPt.value, 0.032)
    const isHovered =
      props.tool === 'select' &&
      (hoveredStrokeId.value === stroke.id || draggingStrokeId.value === stroke.id)

    drawSingleStroke(ctx, stroke, size, theme, {
      isHovered,
      isEraserTarget: isEraserHit,
      simProgress: isSimulating.value ? simProgress.value : 1
    })
  }

  // 4. 绘制正在拖拽中的预览笔画
  if (
    isPointerDown.value &&
    draftPoints.value.length > 0 &&
    props.tool !== 'select' &&
    props.tool !== 'eraser' &&
    props.tool !== 'text'
  ) {
    drawSingleStroke(
      ctx,
      {
        type: props.tool,
        color: props.color,
        width: props.strokeWidth,
        points: draftPoints.value
      },
      size,
      theme
    )
  }

  // 5. 绘制四台机器人机位 Token
  drawRobotTokens(ctx, size, theme)

  // 6. 橡皮擦光标圈预览
  if (props.tool === 'eraser' && hoverViewPt.value) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(hoverViewPt.value.x * size, hoverViewPt.value.y * size, size * 0.032, 0, Math.PI * 2)
    ctx.strokeStyle = withAlpha(theme.g50, 0.9)
    ctx.fillStyle = withAlpha(theme.error, 0.22)
    ctx.lineWidth = 1.5
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  ctx.restore()
}

function getNormalizedFromPointerEvent(e: PointerEvent | MouseEvent): {
  viewPt: NormalizedPoint
  fieldPt: NormalizedPoint
} {
  const canvas = canvasRef.value
  if (!canvas) {
    return { viewPt: { x: 0.5, y: 0.5 }, fieldPt: { x: 0.5, y: 0.5 } }
  }
  const rect = canvas.getBoundingClientRect()
  const vx = rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0.5
  const vy = rect.height > 0 ? Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) : 0.5
  const fieldPt = viewToFieldCoords(vx, vy, props.rotation, props.flipH)
  return { viewPt: { x: vx, y: vy }, fieldPt }
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 && e.pointerType === 'mouse') return
  if (isSimulating.value) {
    stopSimulation()
  }
  const canvas = canvasRef.value
  if (canvas && typeof canvas.setPointerCapture === 'function') {
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {}
  }

  const { viewPt, fieldPt } = getNormalizedFromPointerEvent(e)
  hoverViewPt.value = viewPt
  hoverFieldPt.value = fieldPt

  // 优先检测是否点中机器人机位 Token（除橡皮擦外，任意工具下直接按住机位棋子均可丝滑拖拽！）
  const hitStation = hitTestRobotToken(props.robots, fieldPt.x, fieldPt.y, 0.058)
  if (hitStation && props.tool !== 'eraser') {
    isPointerDown.value = true
    draggingStation.value = hitStation
    dragStartViewPt.value = viewPt
    robotDragMoved.value = false
    const stColor = getStationColor(hitStation)
    spawnRipple(props.robots[hitStation].x, props.robots[hitStation].y, stColor)
    emit('selectStation', hitStation)
    return
  }

  // 在 select 工具下，检测是否点中已有笔画并允许整体拖拽平移
  if (props.tool === 'select') {
    const hitStroke = hitTestTopStroke(props.strokes, fieldPt, 0.032)
    if (hitStroke) {
      isPointerDown.value = true
      draggingStrokeId.value = hitStroke
      lastDragFieldPt.value = fieldPt
      emit('beginStrokeDrag', hitStroke)
      renderCanvas()
    }
    return
  }

  if (props.tool === 'text') {
    textPromptState.value = {
      visible: true,
      fieldPt,
      viewPt,
      text: ''
    }
    nextTick(() => {
      textInputRef.value?.focus()
    })
    return
  }

  isPointerDown.value = true

  if (props.tool === 'eraser') {
    emit('eraseAt', fieldPt)
    renderCanvas()
    return
  }

  draftPoints.value = [fieldPt]
  renderCanvas()
}

function onPointerMove(e: PointerEvent) {
  const { viewPt, fieldPt } = getNormalizedFromPointerEvent(e)
  hoverViewPt.value = viewPt
  hoverFieldPt.value = fieldPt

  if (!isPointerDown.value) {
    if (props.tool === 'select') {
      const nextHover = hitTestTopStroke(props.strokes, fieldPt, 0.032)
      if (nextHover !== hoveredStrokeId.value) {
        hoveredStrokeId.value = nextHover
        renderCanvas()
      }
    } else if (props.tool === 'eraser') {
      renderCanvas()
    }
    return
  }

  if (draggingStation.value) {
    if (
      dragStartViewPt.value &&
      Math.hypot(viewPt.x - dragStartViewPt.value.x, viewPt.y - dragStartViewPt.value.y) > 0.008
    ) {
      robotDragMoved.value = true
    }
    const shouldSnap = Boolean(props.snapToGrid || e.shiftKey)
    const targetPt = shouldSnap ? snapToFieldGrid(fieldPt.x, fieldPt.y, 12) : fieldPt
    activeSnapPt.value = shouldSnap ? targetPt : null
    displayRobotCoords.value[draggingStation.value] = { x: targetPt.x, y: targetPt.y }
    emit('moveRobot', {
      station: draggingStation.value,
      x: targetPt.x,
      y: targetPt.y
    })
    renderCanvas()
    return
  }

  if (draggingStrokeId.value && lastDragFieldPt.value) {
    const dx = fieldPt.x - lastDragFieldPt.value.x
    const dy = fieldPt.y - lastDragFieldPt.value.y
    lastDragFieldPt.value = fieldPt
    emit('moveStroke', { strokeId: draggingStrokeId.value, dx, dy })
    renderCanvas()
    return
  }

  if (props.tool === 'eraser') {
    emit('eraseAt', fieldPt)
    renderCanvas()
    return
  }

  if (props.tool === 'pen') {
    const last = draftPoints.value[draftPoints.value.length - 1]
    if (!last || Math.hypot(fieldPt.x - last.x, fieldPt.y - last.y) >= 0.004) {
      draftPoints.value.push(fieldPt)
    }
  } else {
    // 几何图形保留起点与当前终点
    if (draftPoints.value.length === 0) {
      draftPoints.value = [fieldPt]
    } else {
      draftPoints.value = [draftPoints.value[0]!, fieldPt]
    }
  }
  renderCanvas()
}

function onPointerUp(e: PointerEvent) {
  const canvas = canvasRef.value
  if (canvas && typeof canvas.releasePointerCapture === 'function') {
    try {
      canvas.releasePointerCapture(e.pointerId)
    } catch {}
  }

  if (!isPointerDown.value) return
  isPointerDown.value = false

  if (draggingStation.value) {
    const st = draggingStation.value
    const r = props.robots[st]
    if (r && robotDragMoved.value) {
      spawnRipple(r.x, r.y)
    }
    draggingStation.value = null
    dragStartViewPt.value = null
    activeSnapPt.value = null
    robotDragMoved.value = false
    renderCanvas()
    return
  }

  if (draggingStrokeId.value) {
    draggingStrokeId.value = null
    lastDragFieldPt.value = null
    renderCanvas()
    return
  }

  if (props.tool === 'eraser' || props.tool === 'select' || props.tool === 'text') {
    draftPoints.value = []
    renderCanvas()
    return
  }

  if (draftPoints.value.length > 0) {
    const pts = [...draftPoints.value]
    // 若直线/箭头/框/圆只点了一下没有拖动，忽略零长度图形
    if (props.tool !== 'pen' && pts.length >= 2) {
      const dist = Math.hypot(pts[pts.length - 1]!.x - pts[0]!.x, pts[pts.length - 1]!.y - pts[0]!.y)
      if (dist < 0.012) {
        draftPoints.value = []
        renderCanvas()
        return
      }
    } else if (props.tool !== 'pen' && pts.length < 2) {
      draftPoints.value = []
      renderCanvas()
      return
    }

    emit('addStroke', {
      id: `wb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: props.tool,
      color: props.color,
      width: props.strokeWidth,
      points: pts,
      createdAt: Date.now()
    })
  }

  draftPoints.value = []
  renderCanvas()
}

function onDoubleClick(e: MouseEvent) {
  const { fieldPt } = getNormalizedFromPointerEvent(e)
  const hitStation = hitTestRobotToken(props.robots, fieldPt.x, fieldPt.y, 0.058)
  if (hitStation) {
    spawnRipple(props.robots[hitStation].x, props.robots[hitStation].y)
    emit('rotateRobot', hitStation)
  }
}

function confirmTextAnnotation() {
  const content = textPromptState.value.text.trim()
  if (content) {
    emit('addStroke', {
      id: `wb-txt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'text',
      color: props.color,
      width: props.strokeWidth,
      points: [textPromptState.value.fieldPt],
      text: content,
      createdAt: Date.now()
    })
  }
  textPromptState.value.visible = false
  textPromptState.value.text = ''
}

function cancelTextAnnotation() {
  textPromptState.value.visible = false
  textPromptState.value.text = ''
}

function exportAsPng(): string | null {
  const canvas = canvasRef.value
  if (!canvas) return null
  try {
    renderCanvas()
    const dataUrl = canvas.toDataURL('image/png')
    if (typeof document !== 'undefined') {
      const link = document.createElement('a')
      const safeName = (props.matchLabel || 'match').replace(/[^a-zA-Z0-9_-]/g, '_')
      link.download = `SP27_Whiteboard_${safeName}_${props.phase.toUpperCase()}.png`
      link.href = dataUrl
      link.click()
    }
    return dataUrl
  } catch {
    return null
  }
}

defineExpose({
  exportAsPng,
  renderCanvas,
  startSimulation,
  stopSimulation,
  toggleSimulation
})

watch(
  () => props.robots,
  () => {
    animateRobotTransition()
  },
  { deep: true }
)

watch(
  () => props.highlightedStation,
  (st) => {
    if (st && props.robots[st]) {
      spawnRipple(props.robots[st].x, props.robots[st].y)
    }
  }
)

watch(
  () => [
    props.phase,
    props.tool,
    props.color,
    props.strokeWidth,
    props.rotation,
    props.flipH,
    props.showGridCoords,
    props.strokes,
    props.selectedStation,
    props.highlightedStation
  ],
  () => {
    renderCanvas()
  },
  { deep: true }
)

onMounted(() => {
  updateCanvasDimensions()
  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      updateCanvasDimensions()
    })
    resizeObserver.observe(containerRef.value)
  }
  window.addEventListener('resize', updateCanvasDimensions)
})

onUnmounted(() => {
  if (simRafId !== null && typeof cancelAnimationFrame !== 'undefined') {
    cancelAnimationFrame(simRafId)
  }
  if (rippleRafId !== null && typeof cancelAnimationFrame !== 'undefined') {
    cancelAnimationFrame(rippleRafId)
  }
  if (robotSpringRafId !== null && typeof cancelAnimationFrame !== 'undefined') {
    cancelAnimationFrame(robotSpringRafId)
  }
  resizeObserver?.disconnect()
  window.removeEventListener('resize', updateCanvasDimensions)
})
</script>

<template>
  <div ref="containerRef" class="wb-canvas-stage">
    <div class="wb-canvas-frame" :style="{ width: `${canvasSize}px`, height: `${canvasSize}px` }">
      <canvas
        ref="canvasRef"
        data-testid="whiteboard-canvas"
        class="wb-field-canvas"
        :class="`cursor-${tool}`"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @mouseleave="hoverViewPt = null; renderCanvas()"
        @dblclick="onDoubleClick"
      ></canvas>

      <!-- 战术轨迹推演回放 HUD 状态条（含可键盘触达的停止按钮，符合 WCAG 2.2.2） -->
      <div v-if="isSimulating" class="wb-sim-hud" data-testid="wb-sim-hud">
        <span class="wb-sim-dot" aria-hidden="true"></span>
        <span class="wb-sim-text">{{ t('whiteboard.sim_playing_badge') }} ({{ Math.round(simProgress * 100) }}%)</span>
        <button
          type="button"
          class="wb-sim-stop-btn"
          :title="t('whiteboard.btn_stop_sim')"
          @click="stopSimulation"
        >
          <span class="material-icons" aria-hidden="true" style="font-size: 14px;">stop</span>
        </button>
      </div>

      <!-- 浮动文字标注输入框 -->
      <div
        v-if="textPromptState.visible"
        class="wb-text-popover"
        :style="{
          left: `${Math.min(82, Math.max(18, textPromptState.viewPt.x * 100))}%`,
          top: `${Math.min(85, Math.max(15, textPromptState.viewPt.y * 100))}%`
        }"
        @pointerdown.stop
      >
        <input
          ref="textInputRef"
          v-model="textPromptState.text"
          type="text"
          class="wb-text-input"
          :placeholder="t('whiteboard.text_prompt_placeholder')"
          maxlength="36"
          @keydown.enter.prevent="confirmTextAnnotation"
          @keydown.esc.prevent="cancelTextAnnotation"
        />
        <button type="button" class="wb-text-btn confirm" @click="confirmTextAnnotation">
          {{ t('whiteboard.text_confirm') }}
        </button>
        <button type="button" class="wb-text-btn cancel" :aria-label="t('dashboard.btn_cancel')" @click="cancelTextAnnotation">
          <span class="material-icons" aria-hidden="true" style="font-size: 16px;">close</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wb-canvas-stage {
  flex: 1;
  min-width: 0;
  min-height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  position: relative;
  user-select: none;
}

.wb-canvas-frame {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid var(--border);
  box-shadow: var(--shadow-2);
  background: var(--background);
}

.wb-field-canvas {
  display: block;
  touch-action: none;
  cursor: crosshair;
}

.wb-field-canvas.cursor-select {
  cursor: grab;
}

.wb-field-canvas.cursor-select:active {
  cursor: grabbing;
}

.wb-field-canvas.cursor-eraser {
  cursor: cell;
}

.wb-field-canvas.cursor-text {
  cursor: text;
}

.wb-sim-hud {
  position: absolute;
  top: 10px;
  right: 10px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 999px;
  background: var(--popover);
  border: 1px solid var(--status-success-border);
  color: var(--primary);
  font-size: 11px;
  font-weight: 700;
  box-shadow: var(--shadow-2);
  z-index: 15;
}

.wb-sim-text {
  font-variant-numeric: tabular-nums;
}

.wb-sim-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
}

@media (prefers-reduced-motion: no-preference) {
  .wb-sim-dot {
    animation: wb-sim-pulse var(--motion-duration-slow) var(--motion-ease-in-out) infinite alternate;
  }
}

@keyframes wb-sim-pulse {
  from {
    opacity: 0.45;
  }
  to {
    opacity: 1;
  }
}

.wb-sim-stop-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--status-error-border);
  background: var(--status-error-bg);
  color: var(--status-error);
  cursor: pointer;
}

.wb-sim-stop-btn:hover {
  background: var(--status-error);
  color: var(--g-950);
}

.wb-text-popover {
  position: absolute;
  transform: translate(-50%, -50%);
  transform-origin: center center;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--popover);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-3);
  z-index: 20;
  animation: wb-pop-fade var(--motion-duration-fast) var(--motion-ease-out) both;
}

@media (prefers-reduced-motion: no-preference) {
  .wb-text-popover {
    animation:
      wb-pop-spring var(--motion-duration-normal) var(--motion-ease-spring) both,
      wb-pop-fade var(--motion-duration-fast) var(--motion-ease-out) both;
  }
}

@keyframes wb-pop-spring {
  from {
    scale: 0.88;
  }
}

@keyframes wb-pop-fade {
  from {
    opacity: 0;
  }
}

.wb-text-input {
  width: 190px;
  padding: 5px 8px;
  font-size: 13px;
  background: var(--input);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
}

.wb-text-input:focus {
  border-color: var(--primary);
  box-shadow: var(--focus-ring-sm);
}

.wb-text-btn {
  min-block-size: 28px;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 700;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.wb-text-btn.confirm {
  background: var(--primary);
  color: var(--on-primary);
}

.wb-text-btn.cancel {
  background: var(--surface-hover);
  color: var(--g-200);
  padding: 4px 6px;
}
</style>
