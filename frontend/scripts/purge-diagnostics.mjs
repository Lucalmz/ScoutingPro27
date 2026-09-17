#!/usr/bin/env node
/**
 * Automated Purge Script for Diagnostics Console
 * 
 * 作用：在正式上线发布（Go-Live）时，一键彻底物理移除前端诊断控制台与所有相关测试文件，
 *       并关闭相关 Feature Flag，使发布包达到 100% 纯净状态。
 * 
 * 用法：
 *   node scripts/purge-diagnostics.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const frontendRoot = path.resolve(__dirname, '..')

console.log('🚀 [Purge Diagnostics] 开始执行诊断系统物理清理...')

// 1. 删除模态框组件
const modalPath = path.join(frontendRoot, 'src/components/common/ConnectionDiagnosticsModal.vue')
if (fs.existsSync(modalPath)) {
  fs.unlinkSync(modalPath)
  console.log('✅ 已删除组件: src/components/common/ConnectionDiagnosticsModal.vue')
} else {
  console.log('ℹ️ 组件文件已不存在，跳过')
}

// 2. 删除专项测试
const testPath = path.join(frontendRoot, 'src/__tests__/diagnostics.test.ts')
if (fs.existsSync(testPath)) {
  fs.unlinkSync(testPath)
  console.log('✅ 已删除测试: src/__tests__/diagnostics.test.ts')
} else {
  console.log('ℹ️ 专项测试文件已不存在，跳过')
}

// 3. 将 features.ts 中的 ENABLE_DIAGNOSTICS 改为常数 false
const featuresPath = path.join(frontendRoot, 'src/config/features.ts')
if (fs.existsSync(featuresPath)) {
  const content = `/**
 * Global Feature Flags Configuration (Production Release)
 * 诊断功能已物理剔除
 */
export const ENABLE_DIAGNOSTICS: boolean = false
`
  fs.writeFileSync(featuresPath, content, 'utf-8')
  console.log('✅ 已更新配置: src/config/features.ts -> ENABLE_DIAGNOSTICS = false')
}

console.log('🔍 执行严格类型检查与编译自检 (vue-tsc & vite build)...')
try {
  execSync('npm run build', { cwd: frontendRoot, stdio: 'inherit' })
  console.log('🎉 [Purge Diagnostics] 成功物理清理诊断系统并完成纯净发布构建！')
} catch (err) {
  console.error('❌ 编译检查失败:', err)
  process.exit(1)
}
