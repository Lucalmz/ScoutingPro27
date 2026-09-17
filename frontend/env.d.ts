/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 开启/关闭现场网络诊断控制台，详见 src/config/features.ts */
  readonly VITE_ENABLE_DIAGNOSTICS?: string
  /**
   * TURN 中继兜底配置。中继是 IPv6 / NAT 打洞全部失败后的唯一逃生通道，
   * 而 Metered.ca 等服务商的凭据会过期轮换，务必在部署构建时注入有效值。
   * 详见 src/services/webrtc/connectivity.ts。
   */
  readonly VITE_TURN_HOST?: string
  readonly VITE_TURN_USERNAME?: string
  readonly VITE_TURN_CREDENTIAL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
