/**
 * Global Feature Flags Configuration
 * 
 * 终端与现场网络诊断控制台 (WebRTC Diagnostics Console):
 * - 当前测试与联调阶段：默认开启 (true)，为现场网络诊断和问题排查提供实时可视化工具
 * - 正式上线部署：
 *   方式 A (免改代码)：在构建命令或 .env 中设置 VITE_ENABLE_DIAGNOSTICS=false
 *   方式 B (单开关关闭)：将下方 ENABLE_DIAGNOSTICS 改为 false
 *   方式 C (物理彻底清理)：运行 npm run purge:diagnostics，一键自动安全移除所有诊断组件文件
 */
export const ENABLE_DIAGNOSTICS: boolean =
  typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_ENABLE_DIAGNOSTICS !== undefined
    ? import.meta.env.VITE_ENABLE_DIAGNOSTICS === 'true'
    : true
