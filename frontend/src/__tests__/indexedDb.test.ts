import { describe, it, expect } from 'vitest'
import { savePitPhoto, getPitPhoto, deletePitPhoto } from '../services/indexedDb'

describe('IndexedDB Photo Storage Service', () => {
  it('saves, retrieves, and deletes photos via memory fallback / indexeddb', async () => {
    const key = 'photo_test_1'
    const dataUrl = 'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2QAA'

    const savedKey = await savePitPhoto(key, dataUrl)
    expect(savedKey).toBe(key)

    const retrieved = await getPitPhoto(key)
    expect(retrieved).toBe(dataUrl)

    await deletePitPhoto(key)
    const afterDelete = await getPitPhoto(key)
    expect(afterDelete).toBeNull()
  })
})
