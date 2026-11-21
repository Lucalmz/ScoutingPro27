import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMergeableStore, getHlcFunctions } from 'tinybase'
import { createCustomSynchronizer, type Receive } from 'tinybase/synchronizers'
import { createIndexedDbPersister } from 'tinybase/persisters/persister-indexed-db'

const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000

describe('TinyBase v10.1+ MergeableStore & HLC Smoke Tests', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('merges concurrent distinct-cell updates without overwriting sibling fields', () => {
    const fakeNow = 1_700_000_000_000
    const storeA = createMergeableStore('device-a', () => fakeNow, 300)
    const storeB = createMergeableStore('device-b', () => fakeNow, 300)

    storeA.setCell('pit_records', '27570', 'weightLbs', 31.5)
    storeB.setCell('pit_records', '27570', 'launcherType', 'Turret')

    storeA.merge(storeB)

    expect(storeA.getTables()).toEqual({
      pit_records: {
        '27570': {
          weightLbs: 31.5,
          launcherType: 'Turret',
        },
      },
    })
    expect(storeB.getTables()).toEqual(storeA.getTables())
  })

  it('preserves soft-delete boolean tombstones against stale snapshot resurrection', () => {
    let fakeNow = 1_700_000_000_000
    const storeA = createMergeableStore('device-a', () => fakeNow, 300)
    const storeB = createMergeableStore('device-b', () => fakeNow, 300)
    const stalePeer = createMergeableStore('stale-peer', () => fakeNow, 300)

    storeA.setRow('team_tags', '27570::fast', {
      teamNumber: 27570,
      tag: 'fast',
      active: true,
    })

    // Sync active tag to both peer B and stalePeer before B goes offline
    storeB.merge(storeA)
    stalePeer.setMergeableContent(storeA.getMergeableContent())
    expect(stalePeer.getCell('team_tags', '27570::fast', 'active')).toBe(true)

    // Later, device B writes LWW soft-delete tombstone (never calling delRow)
    fakeNow += 5_000
    storeB.setCell('team_tags', '27570::fast', 'active', false)

    // Old stale snapshot re-merges into B and A -> tombstone MUST hold
    storeB.merge(stalePeer)
    storeA.merge(storeB)

    expect(storeB.getCell('team_tags', '27570::fast', 'active')).toBe(false)
    expect(storeA.getCell('team_tags', '27570::fast', 'active')).toBe(false)
    expect(stalePeer.getCell('team_tags', '27570::fast', 'active')).toBe(false)
  })

  it('drops future-skewed cells beyond maxClockSkewSeconds=300 without poisoning local clock', () => {
    const baseNow = 1_700_000_000_000
    let evilNow = baseNow + 10_000
    const receiver = createMergeableStore('receiver', () => baseNow, 300)
    const maliciousPeer = createMergeableStore('evil-peer', () => evilNow, 300)

    maliciousPeer.setCell('pit_records', '27570', 'validField', 'ok')

    evilNow = baseNow + TEN_YEARS_MS
    maliciousPeer.setCell('pit_records', '27570', 'poisonedField', 'evil-2036')

    receiver.applyMergeableChanges(maliciousPeer.getMergeableContent())

    expect(receiver.getCell('pit_records', '27570', 'validField')).toBe('ok')
    expect(receiver.getCell('pit_records', '27570', 'poisonedField')).toBeUndefined()

    // Confirm receiver's next write HLC stays anchored near baseNow (not pulled to 2036)
    receiver.setCell('pit_records', '27570', 'localAfterAttack', 'clean')
    const [, , , decodeHlc] = getHlcFunctions()
    const content = receiver.getMergeableContent()
    const localCellStamp = content[0][0].pit_records?.[0]?.['27570']?.[0]?.localAfterAttack
    expect(localCellStamp).toBeDefined()
    const [logicalTime] = decodeHlc(localCellStamp![1])
    expect(logicalTime).toBeLessThanOrEqual(baseNow + 10_000)
    expect(logicalTime).toBeGreaterThanOrEqual(baseNow)
  })

  it('decodes TinyBase 16-char HLC stamps accurately via getHlcFunctions().decodeHlc', () => {
    const fakeNow = 1_700_000_123_456
    const store = createMergeableStore('device-hlc', () => fakeNow, 300)
    store.setCell('pit_records', '27570', 'weightLbs', 30)

    const [, , encodeHlc, decodeHlc] = getHlcFunctions('device-hlc', () => fakeNow, 300)
    const content = store.getMergeableContent()
    const cellStamp = content[0][0].pit_records?.[0]?.['27570']?.[0]?.weightLbs
    expect(cellStamp).toBeDefined()

    const cellHlc = cellStamp![1]
    expect(cellHlc).toHaveLength(16)
    const [logicalTime, counter] = decodeHlc(cellHlc)
    expect(logicalTime).toBe(fakeNow)
    expect(counter).toBeGreaterThanOrEqual(0)

    const futureHlc = encodeHlc(fakeNow + TEN_YEARS_MS, 0, 'rogue-device')
    const [decodedFutureTime] = decodeHlc(futureHlc)
    expect(decodedFutureTime).toBe(fakeNow + TEN_YEARS_MS)
    expect(decodedFutureTime - fakeNow).toBeGreaterThan(300_000)
  })

  it('keeps HLC immune to runtime Date.now tampering when wired to calibrated getNow', () => {
    const calibratedNow = 1_700_000_000_000
    const store = createMergeableStore('quartz-device', () => calibratedNow, 300)

    vi.spyOn(Date, 'now').mockReturnValue(calibratedNow + TEN_YEARS_MS)
    store.setCell('pit_records', '27570', 'notes', 'quartz-anchored')

    const [, , , decodeHlc] = getHlcFunctions()
    const content = store.getMergeableContent()
    const cellHlc = content[0][0].pit_records?.[0]?.['27570']?.[0]?.notes?.[1]
    expect(cellHlc).toBeDefined()

    const [logicalTime] = decodeHlc(cellHlc!)
    expect(logicalTime).toBe(calibratedNow)
    expect(Math.abs(logicalTime - Date.now())).toBeGreaterThan(TEN_YEARS_MS - 1_000)
  })

  it('synchronizes two stores over custom JSON message framing', async () => {
    const fakeNow = 1_700_000_500_000
    const store1 = createMergeableStore('sync-1', () => fakeNow, 300)
    const store2 = createMergeableStore('sync-2', () => fakeNow, 300)

    let receive1: Receive | undefined
    let receive2: Receive | undefined

    const sync1 = createCustomSynchronizer(
      store1,
      (_toClientId, requestId, message, body) => {
        const cloned = JSON.parse(JSON.stringify({ requestId, message, body }))
        queueMicrotask(() => receive2?.('sync-1', cloned.requestId, cloned.message, cloned.body))
      },
      (receive) => {
        receive1 = receive
      },
      () => {},
      2,
    )

    const sync2 = createCustomSynchronizer(
      store2,
      (_toClientId, requestId, message, body) => {
        const cloned = JSON.parse(JSON.stringify({ requestId, message, body }))
        queueMicrotask(() => receive1?.('sync-2', cloned.requestId, cloned.message, cloned.body))
      },
      (receive) => {
        receive2 = receive
      },
      () => {},
      2,
    )

    await sync1.startSync()
    await sync2.startSync()

    store1.setCell('schedules', 'Q_1', 'red1', 27570)
    store2.setCell('assignments', 'Q_1_R1', 'scoutName', 'Alice')

    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(store2.getCell('schedules', 'Q_1', 'red1')).toBe(27570)
    expect(store1.getCell('assignments', 'Q_1_R1', 'scoutName')).toBe('Alice')
    expect(typeof createIndexedDbPersister).toBe('function')

    await sync1.destroy()
    await sync2.destroy()
  })
})
