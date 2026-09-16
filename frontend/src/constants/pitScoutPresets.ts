export interface PresetOption {
  key: string
  zh: string
  en: string
}

export const LAUNCHER_PRESETS: PresetOption[] = [
  { key: 'dual_flywheel', zh: '差速双飞轮', en: 'Dual Flywheel' },
  { key: 'single_flywheel', zh: '单飞轮抛射', en: 'Single Flywheel' },
  { key: 'curved_rail', zh: '曲面滑轨', en: 'Curved Guide Rail' },
  { key: 'spring_punch', zh: '弹簧敲击', en: 'Spring Striker' }
]

export const FLOWER_PRESETS: PresetOption[] = [
  { key: 'vertical_lift', zh: '垂直级联高抬升', en: 'Vertical Cascading Lift' },
  { key: 'bottom_chute', zh: '底部滑槽', en: 'Bottom Chute' },
  { key: 'angled_launcher', zh: '仰角抛射', en: 'Angled Ejection' },
  { key: 'none', zh: '无', en: 'None' }
]
