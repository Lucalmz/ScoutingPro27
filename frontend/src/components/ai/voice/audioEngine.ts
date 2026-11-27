import { stripMarkdownForSpeech } from './voiceCatalog'

export function computeRmsLevel(samples: Float32Array | Int16Array): number {
  if (!samples || samples.length === 0) return 0
  let sum = 0
  const isInt16 = samples instanceof Int16Array
  for (let i = 0; i < samples.length; i++) {
    const v = isInt16 ? samples[i]! / 32768 : samples[i]!
    sum += v * v
  }
  const rms = Math.sqrt(sum / samples.length)
  return Math.min(1, rms * 3.2)
}

export function downsampleFloat32ToInt16(
  input: Float32Array,
  inputRate: number,
  targetRate: number
): Int16Array {
  if (input.length === 0) return new Int16Array(0)
  if (inputRate <= 0 || targetRate <= 0 || inputRate === targetRate) {
    const out = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) {
      const clamped = Math.max(-1, Math.min(1, input[i]!))
      out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
    }
    return out
  }

  const ratio = inputRate / targetRate
  const outputLength = Math.max(1, Math.floor(input.length / ratio))
  const out = new Int16Array(outputLength)

  for (let i = 0; i < outputLength; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const s0 = input[idx] ?? 0
    const s1 = input[Math.min(idx + 1, input.length - 1)] ?? s0
    const interpolated = s0 + (s1 - s0) * frac
    const clamped = Math.max(-1, Math.min(1, interpolated))
    out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
  }
  return out
}

export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode(...sub)
  }
  return btoa(binary)
}

export function base64ToInt16(base64: string): Int16Array {
  if (!base64) return new Int16Array(0)
  const binary = atob(base64)
  const byteLen = binary.length - (binary.length % 2)
  const bytes = new Uint8Array(byteLen)
  for (let i = 0; i < byteLen; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Int16Array(bytes.buffer)
}

export function encodeWavBase64(chunks: Int16Array[], sampleRate = 16000): string {
  let totalSamples = 0
  for (const c of chunks) {
    totalSamples += c.length
  }
  const dataByteLen = totalSamples * 2
  const buffer = new ArrayBuffer(44 + dataByteLen)
  const view = new DataView(buffer)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i))
    }
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataByteLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // Linear PCM
  view.setUint16(22, 1, true) // Mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // Byte rate = sampleRate * channels * bytesPerSample
  view.setUint16(32, 2, true) // Block align
  view.setUint16(34, 16, true) // Bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataByteLen, true)

  const pcmOut = new Int16Array(buffer, 44, totalSamples)
  let offset = 0
  for (const c of chunks) {
    pcmOut.set(c, offset)
    offset += c.length
  }

  const allBytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < allBytes.length; i += chunkSize) {
    const sub = allBytes.subarray(i, Math.min(i + chunkSize, allBytes.length))
    binary += String.fromCharCode(...sub)
  }
  return btoa(binary)
}

const CAPTURE_WORKLET_CODE = `
class Sp27PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(2048);
    this._offset = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    let i = 0;
    while (i < channel.length) {
      const space = this._buffer.length - this._offset;
      const copyCount = Math.min(space, channel.length - i);
      this._buffer.set(channel.subarray(i, i + copyCount), this._offset);
      this._offset += copyCount;
      i += copyCount;
      if (this._offset >= this._buffer.length) {
        const out = this._buffer.slice(0);
        this.port.postMessage(out, [out.buffer]);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('sp27-pcm-capture-processor', Sp27PcmCaptureProcessor);
`

export interface PcmCaptureOptions {
  targetSampleRate: number
  onChunk: (pcm16: Int16Array) => void
  onLevel?: (level: number) => void
}

export class PcmAudioCapture {
  private readonly targetSampleRate: number
  private readonly onChunk: (pcm16: Int16Array) => void
  private readonly onLevel?: (level: number) => void

  private stream: MediaStream | null = null
  private audioCtx: AudioContext | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private scriptNode: ScriptProcessorNode | null = null
  private muteGain: GainNode | null = null
  private workletBlobUrl: string | null = null
  private muted = false
  private stopped = false

  constructor(options: PcmCaptureOptions) {
    this.targetSampleRate = options.targetSampleRate
    this.onChunk = options.onChunk
    this.onLevel = options.onLevel
  }

  async start(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('MEDIA_DEVICES_UNAVAILABLE')
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    })
    if (this.stopped) {
      stream.getTracks().forEach(t => t.stop())
      return
    }
    this.stream = stream

    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new AudioCtx()
      this.audioCtx = ctx
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }
      if (this.stopped) {
        this.stop()
        return
      }

      const source = ctx.createMediaStreamSource(stream)
      this.sourceNode = source
      const silentSink = ctx.createGain()
      silentSink.gain.value = 0
      this.muteGain = silentSink

      const handleFloatFrame = (samples: Float32Array) => {
        if (this.stopped) return
        const level = this.muted ? 0 : computeRmsLevel(samples)
        this.onLevel?.(level)
        if (!this.muted) {
          const resampled = downsampleFloat32ToInt16(samples, ctx.sampleRate, this.targetSampleRate)
          if (resampled.length > 0) {
            this.onChunk(resampled)
          }
        }
      }

      if (typeof AudioWorkletNode !== 'undefined' && ctx.audioWorklet) {
        try {
          const blob = new Blob([CAPTURE_WORKLET_CODE], { type: 'application/javascript' })
          this.workletBlobUrl = URL.createObjectURL(blob)
          await ctx.audioWorklet.addModule(this.workletBlobUrl)
          URL.revokeObjectURL(this.workletBlobUrl)
          this.workletBlobUrl = null

          if (this.stopped) {
            this.stop()
            return
          }
          const node = new AudioWorkletNode(ctx, 'sp27-pcm-capture-processor')
          node.port.onmessage = evt => {
            if (evt.data instanceof Float32Array) {
              handleFloatFrame(evt.data)
            }
          }
          source.connect(node)
          node.connect(silentSink)
          silentSink.connect(ctx.destination)
          this.workletNode = node
          return
        } catch {
          if (this.workletBlobUrl) {
            URL.revokeObjectURL(this.workletBlobUrl)
            this.workletBlobUrl = null
          }
        }
      }

      // Fallback for environments where AudioWorklet is unavailable
      const proc = ctx.createScriptProcessor(2048, 1, 1)
      proc.onaudioprocess = evt => {
        const data = evt.inputBuffer.getChannelData(0)
        handleFloatFrame(new Float32Array(data))
      }
      source.connect(proc)
      proc.connect(silentSink)
      silentSink.connect(ctx.destination)
      this.scriptNode = proc
    } catch (err) {
      this.stop()
      throw err
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (muted) {
      this.onLevel?.(0)
    }
  }

  stop(): void {
    this.stopped = true
    this.onLevel?.(0)
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl)
      this.workletBlobUrl = null
    }
    try {
      this.workletNode?.port.close()
      this.workletNode?.disconnect()
    } catch {}
    try {
      this.scriptNode?.disconnect()
    } catch {}
    try {
      this.sourceNode?.disconnect()
    } catch {}
    try {
      this.muteGain?.disconnect()
    } catch {}
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop()
        } catch {}
      }
      this.stream = null
    }
    if (this.audioCtx) {
      try {
        void this.audioCtx.close()
      } catch {}
      this.audioCtx = null
    }
    this.workletNode = null
    this.scriptNode = null
    this.sourceNode = null
    this.muteGain = null
  }
}

export class PcmAudioPlayer {
  private audioCtx: AudioContext | null = null
  private nextPlayTime = 0
  private readonly activeSources = new Set<AudioBufferSourceNode>()
  private readonly onLevel?: (level: number) => void
  private readonly onPlayingChange?: (playing: boolean) => void
  private closed = false

  constructor(options?: {
    onLevel?: (level: number) => void
    onPlayingChange?: (playing: boolean) => void
  }) {
    this.onLevel = options?.onLevel
    this.onPlayingChange = options?.onPlayingChange
  }

  async warmup(): Promise<void> {
    if (this.closed) return
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }
  }

  enqueue(base64Pcm: string, sampleRate = 24000): void {
    if (this.closed || !base64Pcm) return
    const pcm = base64ToInt16(base64Pcm)
    if (pcm.length === 0) return

    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }

    const floatSamples = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) {
      floatSamples[i] = pcm[i]! / 32768
    }
    this.onLevel?.(computeRmsLevel(floatSamples))

    const audioBuffer = ctx.createBuffer(1, floatSamples.length, sampleRate)
    audioBuffer.copyToChannel(floatSamples, 0)

    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(ctx.destination)

    const now = ctx.currentTime
    if (this.nextPlayTime < now + 0.015) {
      this.nextPlayTime = now + 0.025
    }

    const wasEmpty = this.activeSources.size === 0
    this.activeSources.add(source)
    if (wasEmpty) {
      this.onPlayingChange?.(true)
    }

    source.onended = () => {
      this.activeSources.delete(source)
      if (this.activeSources.size === 0) {
        this.onLevel?.(0)
        this.onPlayingChange?.(false)
      }
    }

    source.start(this.nextPlayTime)
    this.nextPlayTime += audioBuffer.duration
  }

  interrupt(): void {
    for (const src of this.activeSources) {
      try {
        src.onended = null
        src.stop()
        src.disconnect()
      } catch {}
    }
    this.activeSources.clear()
    this.nextPlayTime = 0
    this.onLevel?.(0)
    this.onPlayingChange?.(false)
  }

  close(): void {
    this.closed = true
    this.interrupt()
    if (this.audioCtx) {
      try {
        void this.audioCtx.close()
      } catch {}
      this.audioCtx = null
    }
  }

  private ensureContext(): AudioContext {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.audioCtx = new AudioCtx()
    }
    return this.audioCtx
  }
}

let activeSpeechSynthesizer: StreamingSpeechSynthesizer | null = null

export class StreamingSpeechSynthesizer {
  private buffer = ''
  private queue: string[] = []
  private speaking = false
  private locale = 'zh'
  private onSpeakingChange?: (speaking: boolean) => void
  private activeUtterance: SpeechSynthesisUtterance | null = null

  constructor(options?: { locale?: string; onSpeakingChange?: (speaking: boolean) => void }) {
    if (options?.locale) this.locale = options.locale
    this.onSpeakingChange = options?.onSpeakingChange
  }

  setLocale(locale: string): void {
    this.locale = locale || 'zh'
  }

  pushDelta(delta: string): void {
    if (!delta) return
    this.buffer += delta
    const sentenceEndRe = /^([\s\S]*?[。！？.!?]+(?:\s+|$)|[\s\S]*?\n+)/
    while (true) {
      const m = this.buffer.match(sentenceEndRe)
      if (!m || !m[1]) break
      const chunk = m[1]
      this.buffer = this.buffer.slice(chunk.length)
      const clean = stripMarkdownForSpeech(chunk)
      if (clean.length > 0) {
        this.enqueueSentence(clean)
      }
    }
  }

  flush(): void {
    const clean = stripMarkdownForSpeech(this.buffer)
    this.buffer = ''
    if (clean.length > 0) {
      this.enqueueSentence(clean)
    }
  }

  speakText(fullText: string): void {
    this.stop()
    const clean = stripMarkdownForSpeech(fullText)
    if (!clean) return
    // Split long prose into sentence chunks so Chromium speechSynthesis doesn't stall mid-utterance
    const parts = clean.split(/(?<=[。！？.!?])\s*/).filter(s => s.trim().length > 0)
    if (parts.length === 0) {
      this.enqueueSentence(clean)
    } else {
      for (const p of parts) {
        this.enqueueSentence(p.trim())
      }
    }
  }

  stop(): void {
    this.buffer = ''
    this.queue = []
    this.activeUtterance = null
    if (activeSpeechSynthesizer === this) {
      activeSpeechSynthesizer = null
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel()
      } catch {}
    }
    if (this.speaking) {
      this.speaking = false
      this.onSpeakingChange?.(false)
    }
  }

  private enqueueSentence(sentence: string): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      return
    }
    this.queue.push(sentence)
    if (!this.speaking) {
      this.pumpNext()
    }
  }

  private pumpNext(): void {
    if (this.queue.length === 0) {
      this.activeUtterance = null
      if (activeSpeechSynthesizer === this) {
        activeSpeechSynthesizer = null
      }
      if (this.speaking) {
        this.speaking = false
        this.onSpeakingChange?.(false)
      }
      return
    }

    if (activeSpeechSynthesizer && activeSpeechSynthesizer !== this) {
      activeSpeechSynthesizer.stop()
    }
    activeSpeechSynthesizer = this

    const next = this.queue.shift()!
    const utter = new SpeechSynthesisUtterance(next)
    const isZh = this.locale.toLowerCase().startsWith('zh')
    utter.lang = isZh ? 'zh-CN' : 'en-US'
    utter.rate = isZh ? 1.05 : 1.0

    try {
      const voices = window.speechSynthesis.getVoices()
      const matched = voices.find(v =>
        isZh ? v.lang.toLowerCase().startsWith('zh') : v.lang.toLowerCase().startsWith('en')
      )
      if (matched) utter.voice = matched
    } catch {}

    utter.onend = () => {
      if (this.activeUtterance === utter) {
        this.pumpNext()
      }
    }
    utter.onerror = () => {
      if (this.activeUtterance === utter) {
        this.pumpNext()
      }
    }

    this.activeUtterance = utter
    if (!this.speaking) {
      this.speaking = true
      this.onSpeakingChange?.(true)
    }
    window.speechSynthesis.speak(utter)
  }
}
