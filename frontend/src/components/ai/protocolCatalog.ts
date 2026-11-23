import type { AiProtocol } from '@/types'

export interface OpenAiPreset {
  id: string
  name: string
  protocol?: AiProtocol
  baseUrl: string
  defaultModel: string
  models: string[]
  apiKeyUrl?: string
  requiresApiKey?: boolean
  description?: string
}

export interface ProtocolMetadata {
  protocol: AiProtocol
  badge: string
  labelZh: string
  labelEn: string
  defaultBaseUrl: string
  authHeader: string
  keyFormatHintZh: string
  keyFormatHintEn: string
  keyPlaceholder: string
  vendorsSummaryZh: string
  vendorsSummaryEn: string
}

export interface VendorProtocolGuideRow {
  vendor: string
  vendorZh: string
  vendorEn: string
  protocol: AiProtocol
  protocolLabelZh: string
  protocolLabelEn: string
  baseUrl: string
  keyFormat: string
  notesZh: string
  notesEn: string
}

export const GEMINI_DEFAULT_MODELS: string[] = [
  'gemini-flash-latest',
  'gemini-pro-latest',
  'gemini-flash-lite-latest'
]

export const GEMINI_MODEL_TIERS: Record<string, { zh: string; en: string }> = {
  'gemini-flash-latest': { zh: 'Flash · 均衡主力', en: 'Flash · Balanced' },
  'gemini-pro-latest': { zh: 'Pro · 旗舰深思', en: 'Pro · Flagship' },
  'gemini-flash-lite-latest': { zh: 'Lite · 极速轻量', en: 'Lite · Fast Lite' }
}

export const PROTOCOL_META: Record<AiProtocol, ProtocolMetadata> = {
  OPENAI: {
    protocol: 'OPENAI',
    badge: 'GPT',
    labelZh: 'OpenAI / GPT 兼容流派',
    labelEn: 'OpenAI / GPT Compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    authHeader: 'Authorization: Bearer <KEY>',
    keyFormatHintZh: '常见格式：sk-... / sk-proj-... / sk-or-v1-... / gsk_... / xai-... / <id>.<secret>（本地 Ollama 可留空）',
    keyFormatHintEn: 'Typical keys: sk-... / sk-proj-... / sk-or-v1-... / gsk_... / xai-... / <id>.<secret> (optional for local Ollama)',
    keyPlaceholder: 'sk-... (Ollama local may be empty)',
    vendorsSummaryZh: 'OpenAI 官方、DeepSeek、硅基流动、Kimi、阿里百炼、智谱、火山方舟、OpenRouter、Groq、Ollama',
    vendorsSummaryEn: 'OpenAI, DeepSeek, SiliconFlow, Moonshot Kimi, DashScope, Zhipu, Volcengine Ark, OpenRouter, Groq, Ollama'
  },
  GEMINI: {
    protocol: 'GEMINI',
    badge: 'Gemini',
    labelZh: 'Google Gemini 流派',
    labelEn: 'Google Gemini (v1beta)',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authHeader: 'x-goog-api-key: <KEY>',
    keyFormatHintZh: '官方 KEY 格式：AIza...（常见 AIzaSy...，约 39 位）；支持填写自定义反代 Base URL，并可自由增删模型',
    keyFormatHintEn: 'Official keys start with AIza... (e.g. AIzaSy..., ~39 chars). Custom proxy Base URL and custom model IDs supported.',
    keyPlaceholder: 'AIzaSy...',
    vendorsSummaryZh: 'Google AI Studio 官方（默认 3 个 -latest 滚动模型）、Gemini 反向代理 / 企业网关',
    vendorsSummaryEn: 'Google AI Studio (3 default -latest aliases) & Gemini reverse proxies'
  },
  ANTHROPIC: {
    protocol: 'ANTHROPIC',
    badge: 'Claude',
    labelZh: 'Anthropic / Claude 流派',
    labelEn: 'Anthropic / Claude Messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    authHeader: 'x-api-key: <KEY> + anthropic-version: 2023-06-01',
    keyFormatHintZh: '官方 KEY 格式：sk-ant-...（如 sk-ant-api03-...）；国产厂商 /anthropic 兼容通道则填写该平台自有 Key',
    keyFormatHintEn: 'Official keys start with sk-ant-...; Chinese vendor /anthropic endpoints use that vendor’s own key.',
    keyPlaceholder: 'sk-ant-api03-... or vendor key',
    vendorsSummaryZh: 'Anthropic 官方、DeepSeek (/anthropic)、Kimi (/anthropic)、智谱 (/api/anthropic)、MiniMax、百炼 Coding',
    vendorsSummaryEn: 'Anthropic, DeepSeek /anthropic, Kimi /anthropic, Zhipu /api/anthropic, MiniMax, DashScope Coding'
  }
}

export const VENDOR_PROTOCOL_GUIDE: VendorProtocolGuideRow[] = [
  {
    vendor: 'OpenAI (Official)',
    vendorZh: 'OpenAI 官方',
    vendorEn: 'OpenAI (Official)',
    protocol: 'OPENAI',
    protocolLabelZh: 'OpenAI 流派',
    protocolLabelEn: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyFormat: 'sk-proj-... / sk-...',
    notesZh: 'GPT-4o, GPT-4.1, o3-mini（推理模型自动省去 temperature）',
    notesEn: 'GPT-4o, GPT-4.1, o3-mini (reasoning models omit temperature)'
  },
  {
    vendor: 'DeepSeek',
    vendorZh: 'DeepSeek (深度求索)',
    vendorEn: 'DeepSeek',
    protocol: 'OPENAI',
    protocolLabelZh: 'OpenAI / Anthropic 双支持',
    protocolLabelEn: 'OpenAI / Anthropic',
    baseUrl: 'https://api.deepseek.com/v1',
    keyFormat: 'sk-...',
    notesZh: 'Anthropic 通道可用 https://api.deepseek.com/anthropic',
    notesEn: 'Also offers https://api.deepseek.com/anthropic'
  },
  {
    vendor: 'SiliconFlow',
    vendorZh: 'SiliconFlow (硅基流动)',
    vendorEn: 'SiliconFlow',
    protocol: 'OPENAI',
    protocolLabelZh: 'OpenAI 流派',
    protocolLabelEn: 'OpenAI',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyFormat: 'sk-...',
    notesZh: '国内高速托管 DeepSeek-V3 / R1 / Qwen',
    notesEn: 'Fast China hosting for DeepSeek-V3 / R1 / Qwen'
  },
  {
    vendor: 'Alibaba DashScope',
    vendorZh: '阿里百炼 DashScope',
    vendorEn: 'Alibaba DashScope',
    protocol: 'OPENAI',
    protocolLabelZh: 'OpenAI / Anthropic Coding',
    protocolLabelEn: 'OpenAI / Anthropic',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyFormat: 'sk-... / sk-ws-...',
    notesZh: 'Coding Anthropic 通道：.../apps/anthropic',
    notesEn: 'Coding Anthropic endpoint: .../apps/anthropic'
  },
  {
    vendor: 'Moonshot Kimi',
    vendorZh: '月之暗面 Moonshot Kimi',
    vendorEn: 'Moonshot Kimi',
    protocol: 'OPENAI',
    protocolLabelZh: 'OpenAI / Anthropic 双支持',
    protocolLabelEn: 'OpenAI / Anthropic',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyFormat: 'sk-...',
    notesZh: 'Anthropic 通道可用 https://api.moonshot.cn/anthropic',
    notesEn: 'Also offers https://api.moonshot.cn/anthropic'
  },
  {
    vendor: 'Zhipu AI (BigModel GLM)',
    vendorZh: '智谱 AI (BigModel GLM)',
    vendorEn: 'Zhipu AI (BigModel GLM)',
    protocol: 'OPENAI',
    protocolLabelZh: 'OpenAI / Anthropic 双支持',
    protocolLabelEn: 'OpenAI / Anthropic',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyFormat: '<id>.<secret>',
    notesZh: 'Anthropic 通道：https://open.bigmodel.cn/api/anthropic',
    notesEn: 'Anthropic endpoint: https://open.bigmodel.cn/api/anthropic'
  },
  {
    vendor: 'Volcengine Ark',
    vendorZh: '火山方舟 Volcengine Ark',
    vendorEn: 'Volcengine Ark',
    protocol: 'OPENAI',
    protocolLabelZh: 'OpenAI 流派',
    protocolLabelEn: 'OpenAI',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyFormat: 'UUID / Ark Key',
    notesZh: '模型栏可自由手填接入点 ID (ep-...) 或模型名',
    notesEn: 'Enter endpoint ID (ep-...) or model ID manually'
  },
  {
    vendor: 'OpenRouter',
    vendorZh: 'OpenRouter (聚合网关)',
    vendorEn: 'OpenRouter',
    protocol: 'OPENAI',
    protocolLabelZh: 'OpenAI 流派',
    protocolLabelEn: 'OpenAI',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyFormat: 'sk-or-v1-...',
    notesZh: '通过 OpenAI 格式调用 Claude / Gemini / GPT',
    notesEn: 'Route Claude / Gemini / GPT via one OpenAI-format key'
  },
  {
    vendor: 'Ollama / LM Studio / vLLM',
    vendorZh: 'Ollama / LM Studio / vLLM',
    vendorEn: 'Ollama / LM Studio / vLLM',
    protocol: 'OPENAI',
    protocolLabelZh: 'OpenAI 本地回环',
    protocolLabelEn: 'OpenAI Local',
    baseUrl: 'http://localhost:11434/v1',
    keyFormat: 'Optional (blank OK)',
    notesZh: '纯离线赛场运行，自动绕过系统 VPN 代理',
    notesEn: 'Offline pit use; automatically bypasses local VPN proxies'
  },
  {
    vendor: 'Google AI Studio (Gemini)',
    vendorZh: 'Google AI Studio (Gemini)',
    vendorEn: 'Google AI Studio (Gemini)',
    protocol: 'GEMINI',
    protocolLabelZh: 'Gemini 流派',
    protocolLabelEn: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyFormat: 'AIzaSy...',
    notesZh: '内置 3 类 -latest 滚动别名，亦支持反代 URL 与自由填模型',
    notesEn: 'Includes 3 -latest aliases; supports custom proxy Base URL'
  },
  {
    vendor: 'Anthropic (Claude Official)',
    vendorZh: 'Anthropic (Claude 官方)',
    vendorEn: 'Anthropic (Claude Official)',
    protocol: 'ANTHROPIC',
    protocolLabelZh: 'Anthropic 流派',
    protocolLabelEn: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    keyFormat: 'sk-ant-api03-...',
    notesZh: '使用 x-api-key + anthropic-version 请求头，支持 Extended Thinking',
    notesEn: 'Uses x-api-key + anthropic-version with Extended Thinking'
  },
  {
    vendor: 'MiniMax (Anthropic Mode)',
    vendorZh: 'MiniMax (Anthropic 模式)',
    vendorEn: 'MiniMax (Anthropic Mode)',
    protocol: 'ANTHROPIC',
    protocolLabelZh: 'Anthropic 流派',
    protocolLabelEn: 'Anthropic',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    keyFormat: 'MiniMax Key',
    notesZh: '国内版 api.minimaxi.com/anthropic（国际版 api.minimax.io/anthropic）',
    notesEn: 'China api.minimaxi.com/anthropic (Global api.minimax.io/anthropic)'
  }
]

export const DEFAULT_PRESET: OpenAiPreset = {
  id: 'deepseek',
  name: 'DeepSeek',
  protocol: 'OPENAI',
  baseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-chat',
  models: ['deepseek-chat', 'deepseek-reasoner'],
  apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  requiresApiKey: true,
  description: 'High performance and cost efficiency, deepseek-chat or deepseek-reasoner recommended'
}

export const CUSTOM_PRESET: OpenAiPreset = {
  id: 'custom',
  name: 'Custom Provider',
  protocol: 'OPENAI',
  baseUrl: '',
  defaultModel: '',
  models: [],
  requiresApiKey: true,
  description: 'Enter custom Base URL and model name manually'
}

export const OPENAI_PRESETS: OpenAiPreset[] = [
  DEFAULT_PRESET,
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'OPENAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini', 'o1'],
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    requiresApiKey: true,
    description: 'OpenAI official service'
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    protocol: 'OPENAI',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    models: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen2.5-72B-Instruct',
      'meta-llama/Meta-Llama-3.1-70B-Instruct'
    ],
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
    requiresApiKey: true,
    description: 'High-speed model cloud hosting DeepSeek-V3/R1 and more'
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI',
    protocol: 'OPENAI',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-latest',
    models: ['kimi-latest', 'moonshot-v1-32k', 'moonshot-v1-128k', 'moonshot-v1-8k'],
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    requiresApiKey: true,
    description: 'Kimi long-context LLM'
  },
  {
    id: 'zhipu',
    name: 'Zhipu AI',
    protocol: 'OPENAI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air', 'glm-4'],
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    requiresApiKey: true,
    description: 'Zhipu GLM model platform with free tier on glm-4-flash'
  },
  {
    id: 'dashscope',
    name: 'DashScope',
    protocol: 'OPENAI',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwq-plus', 'qwen-turbo'],
    apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    requiresApiKey: true,
    description: 'Alibaba Cloud DashScope OpenAI compatible mode'
  },
  {
    id: 'ark',
    name: 'Volcengine Ark',
    protocol: 'OPENAI',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '',
    models: [],
    apiKeyUrl: 'https://console.volcengine.com/ark',
    requiresApiKey: true,
    description: 'Volcengine Ark (enter your Endpoint ID ep-... or model ID manually)'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'OPENAI',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-flash'],
    apiKeyUrl: 'https://openrouter.ai/keys',
    requiresApiKey: true,
    description: 'Unified OpenAI-format aggregator for GPT, Claude and Gemini'
  },
  {
    id: 'baichuan',
    name: 'Baichuan',
    protocol: 'OPENAI',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    defaultModel: 'Baichuan4',
    models: ['Baichuan4', 'Baichuan3-Turbo'],
    apiKeyUrl: 'https://platform.baichuan-ai.com/console/apikey',
    requiresApiKey: true,
    description: 'Baichuan AI platform'
  },
  {
    id: 'groq',
    name: 'Groq',
    protocol: 'OPENAI',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    apiKeyUrl: 'https://console.groq.com/keys',
    requiresApiKey: true,
    description: 'Ultra-fast LPU inference engine'
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    protocol: 'OPENAI',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    apiKeyUrl: 'https://console.mistral.ai/api-keys/',
    requiresApiKey: true,
    description: 'Leading European open and commercial models'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    protocol: 'OPENAI',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
    models: ['llama3', 'deepseek-r1:8b', 'qwen2.5:7b', 'mistral'],
    apiKeyUrl: 'https://ollama.com',
    requiresApiKey: false,
    description: 'Run open-source models locally and completely offline (no API key needed)'
  },
  CUSTOM_PRESET
]

export const GEMINI_PRESETS: OpenAiPreset[] = [
  {
    id: 'gemini-official',
    name: 'Google AI Studio (Official)',
    protocol: 'GEMINI',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-flash-latest',
    models: [...GEMINI_DEFAULT_MODELS],
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
    requiresApiKey: true,
    description: 'Google official Gemini v1beta API with 3 rolling -latest aliases'
  },
  {
    id: 'gemini-custom',
    name: 'Custom Gemini Proxy',
    protocol: 'GEMINI',
    baseUrl: '',
    defaultModel: 'gemini-flash-latest',
    models: [...GEMINI_DEFAULT_MODELS],
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
    requiresApiKey: true,
    description: 'Custom reverse proxy keeping native Gemini v1beta format'
  }
]

export const ANTHROPIC_PRESETS: OpenAiPreset[] = [
  {
    id: 'anthropic-official',
    name: 'Anthropic Claude (Official)',
    protocol: 'ANTHROPIC',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
    models: [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3-7-sonnet-latest',
      'claude-3-5-haiku-latest'
    ],
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    requiresApiKey: true,
    description: 'Official Anthropic Messages API with Extended Thinking'
  },
  {
    id: 'anthropic-deepseek',
    name: 'DeepSeek (Anthropic Mode)',
    protocol: 'ANTHROPIC',
    baseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    requiresApiKey: true,
    description: 'DeepSeek official Anthropic-compatible endpoint'
  },
  {
    id: 'anthropic-moonshot',
    name: 'Moonshot Kimi (Anthropic Mode)',
    protocol: 'ANTHROPIC',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    defaultModel: 'kimi-k2-turbo-preview',
    models: ['kimi-k2-turbo-preview', 'moonshot-v1-32k'],
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    requiresApiKey: true,
    description: 'Moonshot official Anthropic-compatible endpoint'
  },
  {
    id: 'anthropic-zhipu',
    name: 'Zhipu GLM (Anthropic Mode)',
    protocol: 'ANTHROPIC',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    defaultModel: 'glm-4.5',
    models: ['glm-4.5', 'glm-4-plus'],
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    requiresApiKey: true,
    description: 'Zhipu GLM Anthropic-compatible endpoint (Intl: api.z.ai/api/anthropic)'
  },
  {
    id: 'anthropic-minimax',
    name: 'MiniMax (Anthropic Mode)',
    protocol: 'ANTHROPIC',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    defaultModel: 'MiniMax-M2.5',
    models: ['MiniMax-M2.5', 'MiniMax-Text-01'],
    apiKeyUrl: 'https://platform.minimaxi.com',
    requiresApiKey: true,
    description: 'MiniMax official Anthropic-compatible endpoint'
  },
  {
    id: 'anthropic-dashscope',
    name: 'DashScope Coding (Anthropic)',
    protocol: 'ANTHROPIC',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max'],
    apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    requiresApiKey: true,
    description: 'Alibaba Cloud DashScope Coding Anthropic endpoint'
  },
  {
    id: 'anthropic-custom',
    name: 'Custom Anthropic / Relay',
    protocol: 'ANTHROPIC',
    baseUrl: '',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    description: 'Custom Anthropic Messages relay or mirror URL'
  }
]
