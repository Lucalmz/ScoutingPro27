import { optimizeCandidatePriority, sortCandidatesPreferIpv6 } from './connectivity'

export function toSessionDescription(init: any): RTCSessionDescriptionInit {
  if (typeof RTCSessionDescription !== 'undefined' && init instanceof RTCSessionDescription) {
    return init
  }
  return typeof RTCSessionDescription !== 'undefined' ? new RTCSessionDescription(init) : init
}

export function toIceCandidate(init: any): RTCIceCandidateInit {
  if (typeof RTCIceCandidate !== 'undefined' && init instanceof RTCIceCandidate) {
    return init
  }
  return typeof RTCIceCandidate !== 'undefined' ? new RTCIceCandidate(init) : init
}

/** 判断一个待处理候选载荷是否仍是密文信封 */
export function isEncryptedCandidatePayload(payload: any): boolean {
  return Boolean(payload && typeof payload === 'object' && payload.ciphertext && !payload.candidate)
}

/**
 * 归一化「待处理候选队列」：先解密 → 再重写 IPv6 优先级 → 最后排序。
 *
 * 旧实现在 hostSession / clientSession 里是先对队列调用 sortCandidatesPreferIpv6、
 * 再在循环体内解密。由于信令载荷在 ECDH 建链后是加密的 ({ciphertext,iv,tag})，
 * 排序函数读不到 candidate 字段、所有条目评分都是 0，
 * “IPv6 候选优先入队”这一整条优化路径实际上是 no-op。
 *
 * @param queue    原始待处理队列（可能混合明文与密文载荷）
 * @param decrypt  可选解密器；返回 null 表示该条解密失败应丢弃
 */
export async function normalizePendingCandidates<T = any>(
  queue: T[],
  decrypt?: (payload: T) => Promise<T | null>
): Promise<T[]> {
  if (!Array.isArray(queue) || queue.length === 0) return []

  const plaintext: any[] = []
  for (const entry of queue) {
    let candidateObj: any = entry
    if (decrypt && isEncryptedCandidatePayload(candidateObj)) {
      try {
        const decrypted = await decrypt(candidateObj)
        if (!decrypted) continue
        candidateObj = decrypted
      } catch {
        continue
      }
    }
    if (!candidateObj || typeof candidateObj !== 'object') continue
    if (!candidateObj.candidate) continue
    // 只对发给对端/交给本地 ICE agent 的候选文本做 IPv6 提权
    candidateObj = { ...candidateObj, candidate: optimizeCandidatePriority(candidateObj.candidate) }
    plaintext.push(candidateObj)
  }

  return sortCandidatesPreferIpv6(plaintext)
}
