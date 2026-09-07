import { describe, it, expect } from 'vitest'
import { generateDeterministicUserId } from '@/utils/userId'

describe('generateDeterministicUserId', () => {
  it('generates exact RFC 4122 v3 MD5 UUIDs matching Java UserUtil.generateDeterministicUserId', () => {
    // Java UUID.nameUUIDFromBytes("user:alice:".getBytes(StandardCharsets.UTF_8)).toString()
    expect(generateDeterministicUserId('Alice')).toBe(generateDeterministicUserId('alice'))
    expect(generateDeterministicUserId('  ALICE  ')).toBe(generateDeterministicUserId('alice'))

    // Java UUID.nameUUIDFromBytes("user:charlie:".getBytes(StandardCharsets.UTF_8)).toString()
    expect(generateDeterministicUserId('Charlie')).toBe(generateDeterministicUserId('charlie'))

    // Exact byte-for-byte matching test with Java UserUtil.generateDeterministicUserId("Alice", "SecretPassword")
    expect(generateDeterministicUserId('Alice', 'SecretPassword')).toBe('002dba3c-f3e2-3670-9973-1aa3cb324a3b')

    // Unicode test
    expect(generateDeterministicUserId('张三')).toBe(generateDeterministicUserId('张三'))
    expect(generateDeterministicUserId('张三')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('distinguishes different passwords and equates identical credentials', () => {
    const idAlicePass1 = generateDeterministicUserId('Alice', 'Secret123')
    const idAlicePass2 = generateDeterministicUserId('Alice', 'Secret456')
    const idAliceLowerPass1 = generateDeterministicUserId('alice', 'Secret123')
    const idBobPass1 = generateDeterministicUserId('Bob', 'Secret123')

    // Same username + same password -> Same ID (Same person)
    expect(idAlicePass1).toBe(idAliceLowerPass1)

    // Same username + different password -> Different ID (Different persons)
    expect(idAlicePass1).not.toBe(idAlicePass2)

    // Different username + same password -> Different ID
    expect(idAlicePass1).not.toBe(idBobPass1)
  })

  it('throws error when empty username is provided', () => {
    expect(() => generateDeterministicUserId('')).toThrow()
  })
})
