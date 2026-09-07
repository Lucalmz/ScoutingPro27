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
