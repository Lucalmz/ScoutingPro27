<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { StationType } from '@/types'
import {
  fieldToViewCoords,
  viewToFieldCoords,
  hitTestRobotToken,
  STATION_LIST,
  type WhiteboardPhase,
  type WhiteboardTool,
  type WhiteboardStroke,
  type RobotTokenState,
  type FieldRotation,
  type NormalizedPoint
} from './useTacticalWhiteboard'

const props = defineProps<{
  phase: WhiteboardPhase
  tool: WhiteboardTool
  color: string
  strokeWidth: number
  rotation: FieldRotation
  flipH: boolean
  showGridCoords: boolean
  strokes: WhiteboardStroke[]
  robots: Record<StationType, RobotTokenState>
  selectedStation: StationType
  highlightedStation: StationType | null
  matchLabel: string
}>()

const emit = defineEmits<{
  (e: 'addStroke', stroke: WhiteboardStroke): void
  (e: 'eraseAt', pt: NormalizedPoint): void
  (e: 'moveRobot', payload: { station: StationType; x: number; y: number }): void
  (e: 'rotateRobot', station: StationType): void
  (e: 'selectStation', station: StationType): void
}>()

const { t } = useI18n()

const containerRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const canvasSize = ref<number>(600)

// 正在绘制中的临时笔画
const draftPoints = ref<NormalizedPoint[]>([])
const isPointerDown = ref(false)
const draggingStation = ref<StationType | null>(null)
const dragStartViewPt = ref<NormalizedPoint | null>(null)
const robotDragMoved = ref(false)
const hoverViewPt = ref<NormalizedPoint | null>(null)

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

function drawFtcFieldBase(ctx: CanvasRenderingContext2D, size: number) {
  const tile = size / 6

  // 1. 6x6 地垫棋盘格底色
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      const isEven = (row + col) % 2 === 0
      ctx.fillStyle = isEven ? '#111210' : '#151714'
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
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)'
  ctx.beginPath()
  ctx.moveTo(redWallA.x, redWallA.y)
  ctx.lineTo(redWallB.x, redWallB.y)
  ctx.stroke()

  ctx.strokeStyle = 'rgba(59, 130, 246, 0.85)'
  ctx.beginPath()
  ctx.moveTo(blueWallA.x, blueWallA.y)
  ctx.lineTo(blueWallB.x, blueWallB.y)
  ctx.stroke()
  ctx.restore()

  // 3. 角落停泊 / 观察区 (Corner Park / Observation Zones)
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

  // 红方左上停泊区 & 左下花坛补给区
  drawPolyField(
    [
      [0, 0],
      [1 / 6, 0],
      [0, 1 / 6]
    ],
    'rgba(239, 68, 68, 0.16)',
    'rgba(239, 68, 68, 0.65)'
  )
  drawPolyField(
    [
      [0, 5 / 6],
      [1 / 6, 1],
      [0, 1]
    ],
    'rgba(239, 68, 68, 0.12)',
    'rgba(239, 68, 68, 0.5)',
    true
  )

  // 蓝方右上停泊区 & 右下花坛补给区
  drawPolyField(
    [
      [5 / 6, 0],
      [1, 0],
      [1, 1 / 6]
    ],
    'rgba(59, 130, 246, 0.16)',
    'rgba(59, 130, 246, 0.65)'
  )
  drawPolyField(
    [
      [1, 5 / 6],
      [5 / 6, 1],
      [1, 1]
    ],
    'rgba(59, 130, 246, 0.12)',
    'rgba(59, 130, 246, 0.5)',
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

  // 中场对角线与中轴线
  drawFieldLine(0.5, 0, 0.5, 1, 'rgba(255, 255, 255, 0.16)', 2, [8, 6])
  drawFieldLine(1 / 6, 0, 1 / 6, 1, 'rgba(239, 68, 68, 0.28)', 1.5, [4, 4])
  drawFieldLine(5 / 6, 0, 5 / 6, 1, 'rgba(59, 130, 246, 0.28)', 1.5, [4, 4])

  // 5. 中央核心目标区（Submersible / Central Flower Hub 2x2 tiles center）
  drawPolyField(
    [
      [2 / 6, 2 / 6],
      [4 / 6, 2 / 6],
      [4 / 6, 4 / 6],
      [2 / 6, 4 / 6]
    ],
    'rgba(57, 255, 20, 0.05)',
    'rgba(57, 255, 20, 0.38)'
  )

  // 中央花坛/发射圆环
  const centerPt = toViewPx(0.5, 0.5, size)
  ctx.save()
  ctx.beginPath()
  ctx.arc(centerPt.x, centerPt.y, size * 0.085, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(20, 22, 19, 0.88)'
  ctx.fill()
  ctx.lineWidth = 2.5
  ctx.strokeStyle = 'rgba(57, 255, 20, 0.65)'
  ctx.stroke()

  // 红蓝分侧弧形指示
  ctx.beginPath()
  ctx.arc(centerPt.x, centerPt.y, size * 0.042, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(57, 255, 20, 0.18)'
  ctx.fill()
  ctx.restore()

  // 6. 6x6 地垫网格细线与 A1-F6 坐标标签
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
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
    ctx.font = `600 ${Math.max(10, Math.floor(size * 0.019))}px "Manrope", sans-serif`
    ctx.fillStyle = 'rgba(240, 239, 233, 0.24)'
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
    type: Exclude<WhiteboardTool, 'select' | 'eraser'>
    color: string
    width: number
    points: NormalizedPoint[]
    text?: string
  },
  size: number
) {
  const pts = stroke.points
  if (!pts || pts.length === 0) return

  const scaleFactor = size / 600
  const lineWidth = Math.max(2, stroke.width * scaleFactor)

  ctx.save()
  ctx.strokeStyle = stroke.color
  ctx.fillStyle = stroke.color
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (stroke.type === 'text') {
    const p0 = toViewPx(pts[0]!.x, pts[0]!.y, size)
    const content = stroke.text || ''
    if (!content) {
      ctx.restore()
      return
    }
    const fontSize = Math.max(12, Math.floor(14 * scaleFactor))
    ctx.font = `700 ${fontSize}px "Manrope", "Noto Sans SC", sans-serif`
    const metrics = ctx.measureText(content)
    const padX = 8 * scaleFactor
    const padY = 5 * scaleFactor
    const boxW = metrics.width + padX * 2
    const boxH = fontSize + padY * 2

    ctx.fillStyle = 'rgba(12, 13, 12, 0.88)'
    ctx.strokeStyle = stroke.color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.roundRect(p0.x - boxW / 2, p0.y - boxH / 2, boxW, boxH, 6)
    ctx.fill()
    ctx.stroke()

    ctx.fillStyle = stroke.color
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
    ctx.globalAlpha = 0.14
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
    const r = Math.hypot(b.x - a.x, b.y - a.y)
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
  }
  ctx.restore()
}

function drawRobotTokens(ctx: CanvasRenderingContext2D, size: number) {
  const tokenSize = Math.max(38, size * 0.086)
  const half = tokenSize / 2

  for (const st of STATION_LIST) {
    const r = props.robots[st]
    if (!r) continue

    const pos = toViewPx(r.x, r.y, size)
    const isRed = st.startsWith('red')
    const isSelected = props.selectedStation === st
    const isHighlighted = props.highlightedStation === st

    const primaryColor =
      st === 'red1' ? '#ef4444' : st === 'red2' ? '#f97316' : st === 'blue1' ? '#3b82f6' : '#06b6d4'

    ctx.save()
    ctx.translate(pos.x, pos.y)

    // 高亮脉冲光晕或选中光环
    if (isHighlighted || isSelected) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(0, 0, half * 1.38, 0, Math.PI * 2)
      ctx.strokeStyle = isHighlighted ? '#39ff14' : primaryColor
      ctx.lineWidth = isHighlighted ? 3.5 : 2
      if (!isHighlighted) ctx.setLineDash([4, 3])
      ctx.stroke()
      ctx.restore()
    }

    // 机器人底盘方块
    ctx.fillStyle = isRed ? 'rgba(32, 12, 12, 0.94)' : 'rgba(11, 22, 38, 0.94)'
    ctx.strokeStyle = primaryColor
    ctx.lineWidth = isSelected ? 3 : 2.2
    ctx.beginPath()
    ctx.roundRect(-half, -half, tokenSize, tokenSize, 9)
    ctx.fill()
    ctx.stroke()

    // 机头朝向小三角指示器 (计算视图旋转与镜像后的角度)
    let viewHeading = ((r.heading || 0) + props.rotation) % 360
    if (props.flipH) {
      viewHeading = (360 - viewHeading) % 360
    }
    const rad = ((viewHeading - 90) * Math.PI) / 180
    const indicatorDist = half - 5
    const ix = Math.cos(rad) * indicatorDist
    const iy = Math.sin(rad) * indicatorDist
    ctx.beginPath()
    ctx.arc(ix, iy, 3.5, 0, Math.PI * 2)
    ctx.fillStyle = '#39ff14'
    ctx.fill()

    // 工位徽标 (R1 / R2 / B1 / B2)
    const stationLabel = st.toUpperCase().replace('RED', 'R').replace('BLUE', 'B')
    ctx.fillStyle = primaryColor
    ctx.font = `800 ${Math.max(10, Math.floor(tokenSize * 0.25))}px "Orbitron", "Manrope", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(stationLabel, 0, -1)

    // 队伍编号
    const teamText = r.teamNumber > 0 ? `#${r.teamNumber}` : 'TBD'
    ctx.fillStyle = '#f8fafc'
    ctx.font = `700 ${Math.max(10, Math.floor(tokenSize * 0.25))}px "Manrope", sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillText(teamText, 0, 1)

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

  ctx.save()
  if (typeof ctx.setTransform === 'function') {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  if (typeof ctx.clearRect === 'function') {
    ctx.clearRect(0, 0, size, size)
  }

  // 1. 绘制 FTC 场地底图
  drawFtcFieldBase(ctx, size)

  // 2. 绘制已保存笔画
  for (const stroke of props.strokes) {
    drawSingleStroke(ctx, stroke, size)
  }

  // 3. 绘制正在拖拽中的预览笔画
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
      size
    )
  }

  // 4. 绘制四台机器人机位 Token
  drawRobotTokens(ctx, size)

  // 5. 橡皮擦光标圈预览
  if (props.tool === 'eraser' && hoverViewPt.value) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(hoverViewPt.value.x * size, hoverViewPt.value.y * size, size * 0.032, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.85)'
    ctx.fillStyle = 'rgba(239, 68, 68, 0.18)'
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
  const canvas = canvasRef.value
  if (canvas && typeof canvas.setPointerCapture === 'function') {
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {}
  }

  const { viewPt, fieldPt } = getNormalizedFromPointerEvent(e)
  hoverViewPt.value = viewPt

  // 优先检测是否点中机器人机位 Token（在 select 工具下或任意工具下点中机位中心均可选中/在 select 下拖拽）
  const hitStation = hitTestRobotToken(props.robots, fieldPt.x, fieldPt.y, 0.058)
  if (hitStation && props.tool === 'select') {
    isPointerDown.value = true
    draggingStation.value = hitStation
    dragStartViewPt.value = viewPt
    robotDragMoved.value = false
    emit('selectStation', hitStation)
    return
  }

  if (props.tool === 'select') {
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

  if (!isPointerDown.value) {
    if (props.tool === 'eraser') renderCanvas()
    return
  }

  if (draggingStation.value) {
    if (
      dragStartViewPt.value &&
      Math.hypot(viewPt.x - dragStartViewPt.value.x, viewPt.y - dragStartViewPt.value.y) > 0.008
    ) {
      robotDragMoved.value = true
    }
    emit('moveRobot', {
      station: draggingStation.value,
      x: fieldPt.x,
      y: fieldPt.y
    })
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
    draggingStation.value = null
    dragStartViewPt.value = null
    robotDragMoved.value = false
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
  renderCanvas
})

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
    props.robots,
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
  border: 1px solid var(--border, #262624);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
  background: #0d0e0d;
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

.wb-text-popover {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: rgba(14, 15, 14, 0.96);
  border: 1px solid var(--primary, #39ff14);
  border-radius: 10px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.75);
  z-index: 20;
}

.wb-text-input {
  width: 190px;
  padding: 5px 8px;
  font-size: 13px;
  background: #181917;
  color: var(--foreground, #f0efe9);
  border: 1px solid var(--border, #2c2d2a);
  border-radius: 6px;
  outline: none;
}

.wb-text-input:focus {
  border-color: var(--primary, #39ff14);
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
  background: var(--primary, #39ff14);
  color: #080807;
}

.wb-text-btn.cancel {
  background: #262724;
  color: #a1a19a;
  padding: 4px 6px;
}
</style>
