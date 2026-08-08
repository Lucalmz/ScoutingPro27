import { createI18n } from 'vue-i18n'
import en from './locales/en.json'
import zh from './locales/zh.json'

// Retrieve saved locale or default to English
const savedLocale = localStorage.getItem('app-locale') || 'en'

export const i18n = createI18n({
  legacy: false,
  locale: savedLocale,
  fallbackLocale: 'en',
  messages: {
    en,
    zh
  }
})

// Helper to switch language
export function switchLanguage(lang: 'en' | 'zh') {
  i18n.global.locale.value = lang
  localStorage.setItem('app-locale', lang)
  document.documentElement.lang = lang
}

// Set initial lang
document.documentElement.lang = savedLocale
