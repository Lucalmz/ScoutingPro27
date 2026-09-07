import type { WebRtcDirectMessage } from '@/types'
import type { QueuedOfflineMessage } from './types'

export class OfflineMessageManager {
  private static readonly MAX_OFFLINE_PER_TARGET = 50
  private static readonly MAX_TOTAL_OFFLINE_TARGETS = 100
  private static readonly OFFLINE_MSG_TTL_MS = 10 * 60 * 1000 // 10 minutes
  private offlineMessages = new Map<string, QueuedOfflineMessage[]>()

  cleanupExpiredOfflineMessages(): void {
    const now = Date.now()
    for (const [targetId, queue] of this.offlineMessages.entries()) {
      const active = queue.filter((item) => now - item.queuedAt < OfflineMessageManager.OFFLINE_MSG_TTL_MS)
      if (active.length === 0) {
        this.offlineMessages.delete(targetId)
      } else {
        this.offlineMessages.set(targetId, active)
      }
    }
  }

  enqueue(targetId: string, directMsg: WebRtcDirectMessage): void {
    this.cleanupExpiredOfflineMessages()
    if (!this.offlineMessages.has(targetId) && this.offlineMessages.size >= OfflineMessageManager.MAX_TOTAL_OFFLINE_TARGETS) {
      const oldestKey = this.offlineMessages.keys().next().value
      if (oldestKey) this.offlineMessages.delete(oldestKey)
    }
    const queue = this.offlineMessages.get(targetId) || []
    queue.push({ message: directMsg, queuedAt: Date.now() })
    if (queue.length > OfflineMessageManager.MAX_OFFLINE_PER_TARGET) {
      queue.splice(0, queue.length - OfflineMessageManager.MAX_OFFLINE_PER_TARGET)
    }
    this.offlineMessages.set(targetId, queue)
  }

  flush(targetId: string): QueuedOfflineMessage[] {
    this.cleanupExpiredOfflineMessages()
    const queue = this.offlineMessages.get(targetId) || []
    this.offlineMessages.delete(targetId)
    return queue
  }

  clear(): void {
    this.offlineMessages.clear()
  }
}
