import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as api from '../services/api'
import * as mobileCache from '../services/mobilePhotoCache'
import {
  isDesktopHost,
  savePhoto,
  getPhotoUrl,
  deletePhoto,
  flushOfflinePhotos
} from '../services/photoStorage'

vi.mock('../services/api', () => ({
  uploadPitPhoto: vi.fn().mockResolvedValue({ status: 'ok', key: 'test_key' }),
  deletePitPhoto: vi.fn().mockResolvedValue({ success: true })
}))

describe('photoStorage Service', () => {
  const originalLocation = window.location

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: originalLocation
    })
  })

  function setHostname(hostname: string) {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        hostname
      }
    })
  }

  function setOnline(online: boolean) {
    Object.defineProperty(window.navigator, 'onLine', {
      writable: true,
      configurable: true,
      value: online
    })
  }

  describe('isDesktopHost detection', () => {
    it('identifies localhost, 127.0.0.1, and ::1 as desktop host', () => {
      setHostname('localhost')
      expect(isDesktopHost()).toBe(true)

      setHostname('127.0.0.1')
      expect(isDesktopHost()).toBe(true)

      setHostname('::1')
      expect(isDesktopHost()).toBe(true)
    })

    it('identifies LAN IP addresses as mobile client', () => {
      setHostname('192.168.1.105')
      expect(isDesktopHost()).toBe(false)

      setHostname('10.0.0.12')
      expect(isDesktopHost()).toBe(false)

      setHostname('scout.local')
      expect(isDesktopHost()).toBe(false)
    })
  })

  describe('Desktop Host Flow (Zero IndexedDB)', () => {
    beforeEach(() => {
      setHostname('localhost')
    })

    it('saves photo directly to backend via HTTP upload without writing to mobile cache', async () => {
      const eventId = 'evt_desktop_1'
      const key = 'photo_pc_1'
      const dataUrl = 'data:image/webp;base64,DesktopImageData'

      const savedKey = await savePhoto(key, dataUrl, eventId)
      expect(savedKey).toBe(key)
      expect(api.uploadPitPhoto).toHaveBeenCalledTimes(1)
      expect(api.uploadPitPhoto).toHaveBeenCalledWith(eventId, key, dataUrl)

      // Verify mobile cache was not populated
      const inCache = await mobileCache.getMobileCachedPhoto(key)
      expect(inCache).toBeNull()
    })

    it('returns public HTTP streaming URL directly for desktop previews', async () => {
      const eventId = 'evt_desktop_1'
      const key = 'photo_pc_2'

      const url = await getPhotoUrl(key, eventId)
      expect(url).toBe(`/api/events/${encodeURIComponent(eventId)}/pit/photos/${encodeURIComponent(key)}`)
    })

    it('calls backend deletePitPhoto and does not touch mobile cache when deleting photo on desktop', async () => {
      const eventId = 'evt_desktop_1'
      const key = 'photo_pc_3'
      const spyDelete = vi.spyOn(mobileCache, 'deleteMobileCachedPhoto')

      await deletePhoto(key, eventId)
      expect(spyDelete).not.toHaveBeenCalled()
      expect(api.deletePitPhoto).toHaveBeenCalledWith(eventId, key)
    })

    it('returns 0 when flushing offline photos on desktop', async () => {
      const count = await flushOfflinePhotos('evt_desktop_1')
      expect(count).toBe(0)
      expect(api.uploadPitPhoto).not.toHaveBeenCalled()
    })
  })

  describe('Mobile Client Flow (IndexedDB Buffering & Background Sync)', () => {
    beforeEach(() => {
      setHostname('192.168.1.55')
      setOnline(true)
    })

    it('saves photo to mobile cache and triggers background upload when online', async () => {
      const eventId = 'evt_mobile_1'
      const key = 'photo_mobile_1'
      const dataUrl = 'data:image/webp;base64,MobileImageData1'

      const savedKey = await savePhoto(key, dataUrl, eventId)
      expect(savedKey).toBe(key)

      // Verified stored in mobile cache
      const cached = await mobileCache.getMobileCachedPhoto(key)
      expect(cached).toBe(dataUrl)

      // Background upload was called
      expect(api.uploadPitPhoto).toHaveBeenCalledWith(eventId, key, dataUrl)
    })

    it('buffers photo in mobile cache without failing when offline', async () => {
      setOnline(false)
      const eventId = 'evt_mobile_1'
      const key = 'photo_mobile_offline'
      const dataUrl = 'data:image/webp;base64,MobileOfflineData'

      const savedKey = await savePhoto(key, dataUrl, eventId)
      expect(savedKey).toBe(key)

      const cached = await mobileCache.getMobileCachedPhoto(key)
      expect(cached).toBe(dataUrl)

      // Should not trigger immediate upload when offline
      expect(api.uploadPitPhoto).not.toHaveBeenCalled()

      // Should be listed in pending photos
      const pending = await mobileCache.getPendingMobilePhotos(eventId)
      const found = pending.find((p) => p.key === key)
      expect(found).toBeDefined()
      expect(found?.syncStatus).toBe('PENDING')
    })

    it('returns cached dataUrl first on mobile, fallback to HTTP URL if not cached', async () => {
      const eventId = 'evt_mobile_1'
      const key = 'photo_mobile_cached'
      const dataUrl = 'data:image/webp;base64,CachedData'

      await mobileCache.saveMobileCachedPhoto(key, dataUrl, eventId)

      // Present in cache
      const url1 = await getPhotoUrl(key, eventId)
      expect(url1).toBe(dataUrl)

      // Not present in cache (e.g., photo taken by another scout)
      const url2 = await getPhotoUrl('photo_unknown_peer', eventId)
      expect(url2).toBe(`/api/events/${encodeURIComponent(eventId)}/pit/photos/photo_unknown_peer`)
    })

    it('flushes pending photos when network recovers', async () => {
      const eventId = 'evt_flush_test'
      const key1 = 'photo_flush_1'
      const key2 = 'photo_flush_2'

      await mobileCache.saveMobileCachedPhoto(key1, 'data:1', eventId, 'PENDING')
      await mobileCache.saveMobileCachedPhoto(key2, 'data:2', eventId, 'PENDING')

      const count = await flushOfflinePhotos(eventId)
      expect(count).toBe(2)
      expect(api.uploadPitPhoto).toHaveBeenCalledWith(eventId, key1, 'data:1')
      expect(api.uploadPitPhoto).toHaveBeenCalledWith(eventId, key2, 'data:2')

      const remainingPending = await mobileCache.getPendingMobilePhotos(eventId)
      expect(remainingPending.length).toBe(0)
    })

    it('deletes from mobile cache and also calls backend deletePitPhoto', async () => {
      const eventId = 'evt_mobile_1'
      const key = 'photo_mobile_del'
      await mobileCache.saveMobileCachedPhoto(key, 'data:del', eventId)

      await deletePhoto(key, eventId)
      const cached = await mobileCache.getMobileCachedPhoto(key)
      expect(cached).toBeNull()
      expect(api.deletePitPhoto).toHaveBeenCalledWith(eventId, key)
    })
  })
})
