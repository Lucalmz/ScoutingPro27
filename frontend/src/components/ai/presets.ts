export interface OpenAiPreset {
  id: string
  name: string
  baseUrl: string
  defaultModel: string
  models: string[]
  apiKeyUrl?: string
  description?: string
}

export const DEFAULT_PRESET: OpenAiPreset = {
  id: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-chat',
  models: ['deepseek-chat', 'deepseek-reasoner'],
  apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  description: 'High performance and cost efficiency, deepseek-chat or deepseek-reasoner recommended'
}

export const CUSTOM_PRESET: OpenAiPreset = {
  id: 'custom',
  name: 'Custom Provider',
  baseUrl: '',
  defaultModel: '',
  models: [],
  description: 'Enter custom Base URL and model name manually'
}

export const OPENAI_PRESETS: OpenAiPreset[] = [
  DEFAULT_PRESET,
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1'],
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    description: 'OpenAI official service'
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    models: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen2.5-72B-Instruct',
      'meta-llama/Meta-Llama-3.1-70B-Instruct'
    ],
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
    description: 'High-speed model cloud hosting DeepSeek-V3/R1 and more'
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    description: 'Kimi long-context LLM'
  },
  {
    id: 'zhipu',
    name: 'Zhipu AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air', 'glm-4'],
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    description: 'Zhipu GLM model platform with free tier on glm-4-flash'
  },
  {
    id: 'dashscope',
    name: 'DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen2.5-72b-instruct'],
    apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    description: 'Alibaba Cloud DashScope OpenAI compatible mode'
  },
  {
    id: 'baichuan',
    name: 'Baichuan',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    defaultModel: 'Baichuan4',
    models: ['Baichuan4', 'Baichuan3-Turbo'],
    apiKeyUrl: 'https://platform.baichuan-ai.com/console/apikey',
    description: 'Baichuan AI platform'
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    apiKeyUrl: 'https://console.groq.com/keys',
    description: 'Ultra-fast LPU inference engine'
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    apiKeyUrl: 'https://console.mistral.ai/api-keys/',
    description: 'Leading European open and commercial models'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
    models: ['llama3', 'deepseek-r1:8b', 'qwen2.5:7b', 'mistral'],
    apiKeyUrl: 'https://ollama.com',
    description: 'Run open-source models locally and completely offline'
  },
  CUSTOM_PRESET
]

/**
 * Normalizes URL for comparison by trimming, removing trailing slashes, and lowercasing.
 */
function normalizeUrl(url?: string): string {
  if (!url) return ''
  return url.trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * Finds matching preset by baseUrl.
 */
export function findPresetByBaseUrl(baseUrl?: string): OpenAiPreset {
  if (!baseUrl || !baseUrl.trim()) {
    return DEFAULT_PRESET
  }

  const normalized = normalizeUrl(baseUrl)

  // Direct match
  const direct = OPENAI_PRESETS.find(p => p.id !== 'custom' && normalizeUrl(p.baseUrl) === normalized)
  if (direct) return direct

  // Domain heuristic matching
  if (normalized.includes('api.deepseek.com')) {
    return getPresetById('deepseek')
  }
  if (normalized.includes('siliconflow')) {
    return getPresetById('siliconflow')
  }
  if (normalized.includes('moonshot.cn')) {
    return getPresetById('moonshot')
  }
  if (normalized.includes('bigmodel.cn')) {
    return getPresetById('zhipu')
  }
  if (normalized.includes('dashscope.aliyuncs.com')) {
    return getPresetById('dashscope')
  }
  if (normalized.includes('baichuan-ai.com')) {
    return getPresetById('baichuan')
  }
  if (normalized.includes('api.groq.com')) {
    return getPresetById('groq')
  }
  if (normalized.includes('mistral.ai')) {
    return getPresetById('mistral')
  }
  if (normalized.includes('11434')) {
    return getPresetById('ollama')
  }
  if (normalized.includes('api.openai.com')) {
    return getPresetById('openai')
  }

  return CUSTOM_PRESET
}

export function getPresetById(id: string): OpenAiPreset {
  const matched = OPENAI_PRESETS.find(p => p.id === id)
  return matched ?? DEFAULT_PRESET
}
