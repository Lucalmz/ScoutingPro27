/**
 * Scout 成员本地持久化存储服务 (LocalStorage 兜底与离线防丢)
 * 解决移动端成员连入后未打分即离线时，主机刷新页面丢失成员的问题。
 */

export interface KnownScoutItem {
  id: string
  name: string
  lastSeen?: number
}

const STORAGE_PREFIX = 'sp27_known_scouts_'

function getStorageKey(eventId: string): string {
  return `${STORAGE_PREFIX}${eventId.trim()}`
}

/**
 * 获取指定赛事已记录的所有已知 Scout（按最后活跃时间降序）
 */
export function getKnownScouts(eventId: string): KnownScoutItem[] {
  if (!eventId || typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(getStorageKey(eventId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
    }
  } catch (err) {
    console.warn('[scoutStorage] Failed to read known scouts:', err)
  }
  return []
}

/**
 * 保存或更新一个已知 Scout 到指定赛事的本地存储
 */
export function saveKnownScout(eventId: string, scout: { id: string; name: string; lastSeen?: number }): void {
  if (!eventId || !scout.id || typeof localStorage === 'undefined') return
  try {
    const list = getKnownScouts(eventId)
    const existingIdx = list.findIndex((item) => item.id === scout.id)
    const updatedItem: KnownScoutItem = {
      id: scout.id,
      name: scout.name || scout.id,
      lastSeen: scout.lastSeen ?? Date.now()
    }

    if (existingIdx >= 0) {
      list[existingIdx] = updatedItem
    } else {
      list.push(updatedItem)
    }

    localStorage.setItem(getStorageKey(eventId), JSON.stringify(list))
  } catch (err) {
    console.warn('[scoutStorage] Failed to save known scout:', err)
  }
}

/**
 * 从指定赛事的本地存储中彻底移除单个 Scout（防僵尸成员复活）
 */
export function removeKnownScout(eventId: string, scoutId: string): void {
  if (!eventId || !scoutId || typeof localStorage === 'undefined') return
  try {
    const list = getKnownScouts(eventId)
    const filtered = list.filter((item) => item.id !== scoutId)
    localStorage.setItem(getStorageKey(eventId), JSON.stringify(filtered))
  } catch (err) {
    console.warn('[scoutStorage] Failed to remove known scout:', err)
  }
}

/**
 * 清空指定赛事的所有已知 Scout 缓存
 */
export function clearKnownScouts(eventId: string): void {
  if (!eventId || typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(getStorageKey(eventId))
  } catch (err) {
    console.warn('[scoutStorage] Failed to clear known scouts:', err)
  }
}
