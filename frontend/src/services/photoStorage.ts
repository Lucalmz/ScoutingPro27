import { uploadPitPhoto } from './api'
import {
  saveMobileCachedPhoto,
  getMobileCachedPhoto,
  getPendingMobilePhotos,
  markMobilePhotoSynced,
  deleteMobileCachedPhoto
} from './mobilePhotoCache'

/**
 * 严格判定当前运行环境是否为电脑端 Host 节点。
 * 电脑端 (PC Host / JCEF) 访问源必定为 localhost / 127.0.0.1。
 * 手机端 (Mobile Client) 访问源为局域网 IP (192.168.x.x / 10.x.x.x)。
 * 严禁使用屏幕宽度判定节点物理身份！
 */
export function isDesktopHost(): boolean {
  if (typeof window === 'undefined') return true
  const host = window.location.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * 保存展位照片
 * 电脑端：100% 物理绝缘 IndexedDB，直接通过已鉴权 API 上传至电脑磁盘；
 * 手机端：存入手机专属 IndexedDB 暂存队列，若在线则即刻静默回传。
 */
export async function savePhoto(key: string, dataUrl: string, eventId: string): Promise<string> {
  if (isDesktopHost()) {
    // 电脑端：直接调用 Java 后端落盘，绝对 0% IndexedDB
    try {
      await uploadPitPhoto(eventId, key, dataUrl)
    } catch (err) {
      console.error('[photoStorage PC] Direct photo disk upload failed:', err)
      throw err
    }
    return key
  }

  // 手机端：写入专属离线安全缓冲区
  await saveMobileCachedPhoto(key, dataUrl, eventId, 'PENDING')

  // 若当前连网，触发静默后台上传
  if (typeof navigator !== 'undefined' && navigator.onLine !== false) {
    uploadPitPhoto(eventId, key, dataUrl)
      .then(() => markMobilePhotoSynced(key))
      .catch((err) => {
        console.warn('[photoStorage Mobile] Background upload deferred:', err)
      })
  }

  return key
}

/**
 * 获取展位照片预览 URL
 * 电脑端：直接返回 HTTP 流式读取地址 /api/events/{eventId}/pit/photos/{key}；
 * 手机端：优先返回本地 IndexedDB 中的数据，不存在则回退请求电脑后端。
 */
export async function getPhotoUrl(key: string, eventId: string): Promise<string | null> {
  if (isDesktopHost()) {
    // 电脑端：原生 HTTP 流式加载，享用 Java 静态服务与浏览器磁盘强缓存
    return `/api/events/${encodeURIComponent(eventId)}/pit/photos/${encodeURIComponent(key)}`
  }

  // 手机端：优先读取本地离线缓存
  const cached = await getMobileCachedPhoto(key)
  if (cached) {
    return cached
  }

  // 本地无缓存时（如查看其他人上传的照片），从电脑端 HTTP 拉取
  return `/api/events/${encodeURIComponent(eventId)}/pit/photos/${encodeURIComponent(key)}`
}

/**
 * 删除展位照片
 */
export async function deletePhoto(key: string, eventId: string): Promise<void> {
  if (!isDesktopHost()) {
    await deleteMobileCachedPhoto(key)
  }
}

/**
 * 手机端离线待上传照片批量回传 (Flush Queue)
 */
export async function flushOfflinePhotos(eventId: string): Promise<number> {
  if (isDesktopHost()) return 0

  const pending = await getPendingMobilePhotos(eventId)
  if (!pending || pending.length === 0) return 0

  console.log(`[photoStorage] Flushing ${pending.length} offline photos for event ${eventId}...`)
  let successCount = 0

  for (const item of pending) {
    try {
      await uploadPitPhoto(item.eventId, item.key, item.dataUrl)
      await markMobilePhotoSynced(item.key)
      successCount++
    } catch (err) {
      console.warn(`[photoStorage] Failed to flush photo ${item.key}:`, err)
    }
  }

  return successCount
}

// 手机端自动注册网络恢复事件监听器
if (typeof window !== 'undefined' && !isDesktopHost()) {
  window.addEventListener('online', () => {
    // 提取当前 URL 或路由中的 eventId 执行自动回传
    const hash = window.location.hash || ''
    const match = hash.match(/\/event\/([^\/?#]+)/)
    if (match && match[1]) {
      flushOfflinePhotos(match[1]).catch(console.error)
    }
  })
}
