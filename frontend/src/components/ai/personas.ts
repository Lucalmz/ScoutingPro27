import type { MatchScheduleItem, RankingRow } from '@/types'
import { isZhLocale } from '@/components/ai/constants'

export interface AiPersonaDef {
  id: string
  icon: string
  nameZh: string
  nameEn: string
  descZh: string
  descEn: string
  promptInstructionZh: string
  promptInstructionEn: string
}

export interface StarterCardItem {
  id: string
  icon: string
  titleZh: string
  titleEn: string
  descZh: string
  descEn: string
  promptZh: string
  promptEn: string
  focusTeams?: number[]
  focusMatch?: { matchNumber: number; tournamentLevel?: string } | null
}

export interface SlashCommandItem {
  command: string
  labelZh: string
  labelEn: string
  descZh: string
  descEn: string
  templateZh: string
  templateEn: string
}

export const DEFAULT_PERSONA_ID = 'strategist'
export const LEGACY_GENERIC_PROMPT =
  'You are a helpful AI assistant for the ScoutingPro27 application. You help users analyze FTC scouting data.'

export function getBiobuzzRulesBase(locale: string): string {
  const isZh = isZhLocale(locale)
  if (isZh) {
    return [
      '你正在担任 FTC 2026–2027 赛季 BIOBUZZ 赛事的 Pit Wall 商业级战术 AI Copilot。',
      '【BIOBUZZ 核心计分与评分规则】',
      '- 机动与 Swarm RP：离墙 Leave (+3)、自动停泊 Auto Park (+5)、终局停泊 TeleOp Park (+5)，单车机动满分 13 分；联队双车合计 ≥ 16 分可获得 Swarm RP。',
      '- 花朵与 Garden：Nectar 大球 (+2/个)、Bottom Bonus 占底 (+5/朵)、Pollen 小球 (+2/个)、Garden 推进 (+1/个)。',
      '- 关键犯规与高阶指标：G418 允许掏取敌方花底 Pollen 拆台 (Descore)；G410 为比赛剩余时间 >60s 时误投 Nectar 大犯规；Predict Cycle Time（单场需至少 5 次有效周期，剔除最快 1 次后取较短 4 次均值）与 Spread（循环耗时离散度）；Brag Index 吹牛指数（展位自报对比实测得分，~1.0x 真实守信，>1.25x 存在夸大）。',
      '【输出铁律】',
      '1. 请优先使用简洁清晰的中文回答；所有队伍编号必须统一写作 #27570 或 Team 27570 格式（切勿用反引号 ` ` 包裹队号，也不要省略或拆分数字），以便界面高亮为可点击队伍芯片。',
      '2. 严格依据提供的赛事考察数据进行推演；明确区分「展位自述」与「赛场实测」，数据不足时直说样本不足，严禁凭空编造未出现的场次或分数。'
    ].join('\n')
  }
  return [
    'You are the FTC 2026-2027 BIOBUZZ Pit Wall Tactical Copilot.',
    '[BIOBUZZ Key Scoring & Rules]',
    '- Mobility & Swarm RP: Leave (+3) + Auto Park (+5) + TeleOp Park (+5) = max 13 Mobility RP pts per robot; Alliance combined >= 16 pts earns the Swarm RP.',
    '- Flowers & Garden: Nectar (+2/ball), Bottom Bonus (+5/flower), Pollen (+2/ball), Garden (+1/ball).',
    '- Critical Tactics & Metrics: G418 allows descoring enemy bottom Pollen; G410 is an early-Nectar foul when >60s remain in TeleOp; Predict Cycle Time (requires >=5 valid intervals in a match, dropping fastest 1 and averaging next 4) & Cycle Spread (variance); Brag Index (pit claim vs actual max/avg, ~1.0x realistic vs >1.25x overclaimed).',
    '[Grounding & Formatting Rules]',
    '1. Always respond in clear, concise English and format every team number as #27570 or Team 27570 (never wrap team numbers in backticks/code formatting) so the UI renders interactive team chips.',
    '2. Ground all claims strictly in provided scouting data; distinguish pit self-claims from match measurements, never invent missing stats, and state gaps when sample size is small.'
  ].join('\n')
}

export const AI_PERSONAS: AiPersonaDef[] = [
  {
    id: 'strategist',
    icon: 'military_tech',
    nameZh: '联队策略总监',
    nameEn: 'Alliance Strategist',
    descZh: '1st/2nd Pick 互补测算、Swarm RP 补齐与淘汰赛联队组合',
    descEn: '1st/2nd Pick complementarity, Swarm RP math & playoff pairings',
    promptInstructionZh:
      '【当前角色：联队策略总监】\n请聚焦 Alliance Selection 决策：评估得分上限、Auto/TeleOp/Flower 分工互补、双车机动分能否稳定凑够 ≥16 拿 Swarm RP，以及淘汰赛抗故障稳定性。使用结构化 Markdown 对比表与清晰顺位建议。',
    promptInstructionEn:
      '[Persona: Alliance Strategist]\nFocus on Alliance Selection: score ceilings, Auto/TeleOp/Flower role complementarity, whether paired Mobility RP totals >= 16 for Swarm RP, and playoff reliability. Use structured Markdown comparison tables and clear pick rankings.'
  },
  {
    id: 'match_coach',
    icon: 'sports',
    nameZh: '赛前战术教练',
    nameEn: 'Pre-Match Coach',
    descZh: '针对具体场次红蓝四队推演 Auto 避让、拆台与防 G410 叮嘱',
    descEn: 'Matchup breakdown: Auto deconfliction, descore & G410 prevention',
    promptInstructionZh:
      '【当前角色：赛前战术教练】\n请围绕指定场次或对位四队输出可执行的赛前简报：1) 双车 Auto 启动点与路线错峰避让；2) TeleOp 循环节奏与花朵分工；3) 我方/敌方拆台 (G418) 与防误投犯规 (G410) 风险提示；4) 终局停泊与 Swarm RP 保底线。',
    promptInstructionEn:
      '[Persona: Pre-Match Coach]\nDeliver an actionable pre-match brief for the targeted matchup: 1) Auto lane deconfliction; 2) TeleOp cycle cadence & flower roles; 3) G418 descore threats and G410 foul prevention; 4) Endgame Park & Swarm RP floor.'
  },
  {
    id: 'brag_auditor',
    icon: 'fact_check',
    nameZh: '吹牛审计侦探',
    nameEn: 'Brag & Risk Auditor',
    descZh: '交叉核对展位自报、Brag Index、故障率、离散度与主观标签',
    descEn: 'Cross-audit Pit claims vs Brag Index, breakdowns, spread & tags',
    promptInstructionZh:
      '【当前角色：吹牛审计与风险侦探】\n请对目标队伍进行冷酷的数据打假与风险排查：对比 Pit 自述总分/自动/停泊/花朵能力与实测最高/均值、列出 Brag Index、Broken 故障率、Predict Cycle Spread（波动度）、G410 犯规率及 Scouter 主观标签中的异常信号，并给出「可信任 / 谨慎观察 / 高风险避坑」评级。',
    promptInstructionEn:
      '[Persona: Brag & Risk Auditor]\nRigorously audit target teams: cross-check Pit claims against actual match scores/flower/park verification, report Brag Index, breakdown rate, Predict Cycle Spread, G410 foul rate, and Scouter tags, and conclude with a Trustworthy / Watch / High-Risk verdict.'
  },
  {
    id: 'concise_brief',
    icon: 'bolt',
    nameZh: 'Pit 15秒极简速报',
    nameEn: '15-Sec Pit Brief',
    descZh: '队列边快看：仅输出核心对比表 + 3 条红绿灯行动要点',
    descEn: 'Queue-side rapid read: 1 key table + 3 traffic-light bullets',
    promptInstructionZh:
      '【当前角色：Pit 15秒极简速报】\n严格控制篇幅在 200 字以内：只输出「核心结论（一句话）+ 紧凑对比小表（如有对位）+ 3 条红/黄/绿灯行动要点」，不要废话和铺垫。',
    promptInstructionEn:
      '[Persona: 15-Sec Pit Brief]\nKeep total output strictly under 150 words: 1-sentence bottom line + compact comparison table (if applicable) + 3 green/amber/red action bullets. No filler.'
  },
  {
    id: 'custom',
    icon: 'tune',
    nameZh: '自定义提示词',
    nameEn: 'Custom Prompt',
    descZh: '完全遵循档案设置中的系统提示词',
    descEn: 'Use your profile’s custom system prompt directly',
    promptInstructionZh: '',
    promptInstructionEn: ''
  }
]

export function getPersonaById(id?: string): AiPersonaDef {
  return AI_PERSONAS.find(p => p.id === id) || AI_PERSONAS[0]!
}

export function assembleSystemPrompt(params: {
  personaId?: string
  profileSystemPrompt?: string
  dataContext?: string
  locale?: string
}): string {
  const locale = params.locale || 'zh'
  const isZh = isZhLocale(locale)
  const persona = getPersonaById(params.personaId)
  const customNote = (params.profileSystemPrompt || '').trim()
  const parts: string[] = []

  if (persona.id === 'custom') {
    if (customNote) {
      parts.push(customNote)
    } else {
      parts.push(getBiobuzzRulesBase(locale))
      parts.push(AI_PERSONAS[0]![isZh ? 'promptInstructionZh' : 'promptInstructionEn'])
    }
  } else {
    parts.push(getBiobuzzRulesBase(locale))
    const personaPrompt = isZh ? persona.promptInstructionZh : persona.promptInstructionEn
    if (personaPrompt) parts.push(personaPrompt)
    if (customNote && customNote !== LEGACY_GENERIC_PROMPT) {
      parts.push(isZh ? `【用户档案附加要求】\n${customNote}` : `[Profile Custom Instructions]\n${customNote}`)
    }
  }

  if (params.dataContext && params.dataContext.trim()) {
    parts.push(params.dataContext.trim())
  }

  return parts.join('\n\n')
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    command: '/pick',
    labelZh: '选联队推荐',
    labelEn: 'Alliance Pick Advice',
    descZh: '综合输出 1st / 2nd Pick 互补候选排名',
    descEn: 'Rank top 1st / 2nd Pick alliance partner candidates',
    templateZh: '请根据当前赛事数据，从得分上限、Swarm RP（双车 ≥16）和稳定性出发，推荐最值得选择的 3 个联队搭档及避坑名单。',
    templateEn: 'Recommend the top 3 alliance partner candidates and teams to avoid based on score ceiling, Swarm RP (>=16 combined), and reliability.'
  },
  {
    command: '/match',
    labelZh: '赛前战术简报',
    labelEn: 'Pre-Match Brief',
    descZh: '分析四队交锋路线、Swarm RP 与拆台/犯规风险',
    descEn: 'Analyze 2v2 matchup lanes, Swarm RP, descore & foul risks',
    templateZh: '请为目标场次生成赛前战术简报：红蓝双方实力对比、Auto 路线避让、Swarm RP 凑分方案及需重点防范的 G410/拆台风险。',
    templateEn: 'Generate a pre-match tactical brief: red vs blue strength comparison, Auto deconfliction, Swarm RP target, and G410/descore alerts.'
  },
  {
    command: '/compare',
    labelZh: '多队横向对比',
    labelEn: 'Compare Teams',
    descZh: '对焦点队伍或前排强队做逐维度对比表',
    descEn: 'Side-by-side table comparing focus teams or top seeds',
    templateZh: '请用 Markdown 表格横向对比目标队伍的 Auto、TeleOp、Endgame、Predict Cycle、机动 RP、G410 犯规率、故障率与 Brag Index。',
    templateEn: 'Create a Markdown table comparing the target teams across Auto, TeleOp, Endgame, Predict Cycle, Mobility RP, G410 rate, breakdowns, and Brag Index.'
  },
  {
    command: '/audit',
    labelZh: '吹牛与风险审计',
    labelEn: 'Brag & Risk Audit',
    descZh: '找出展位自述严重夸大（Brag > 1.25x）与高故障队伍',
    descEn: 'Spot overclaimed pit specs (Brag > 1.25x) & unreliable robots',
    templateZh: '请审计全场队伍的展位自述与赛场实测差异，列出 Brag Index 偏高、故障率高或单轮耗时波动 (Spread) 过大的重点排查名单。',
    templateEn: 'Audit pit claims vs actual match outputs across all tracked teams, flagging high Brag Index, high breakdown rates, or large cycle Spread.'
  },
  {
    command: '/brief',
    labelZh: '15秒极简速报',
    labelEn: '15-Sec Rapid Brief',
    descZh: '极简红绿灯结论，适合场边排队速读',
    descEn: 'Ultra-compact traffic-light takeaways for queue-side reading',
    templateZh: '请用不超过 150 字的 15 秒极简速报格式，总结当前聚焦队伍的核心优势与 3 条赛场红绿灯行动要点。',
    templateEn: 'Give a <=120-word 15-second brief summarizing key strengths and 3 green/amber/red action bullets for our current focus.'
  }
]

export function buildStarterCards(params: {
  rankings: RankingRow[]
  schedule: MatchScheduleItem[]
  myTeamNumber?: number | null
}): StarterCardItem[] {
  const { rankings, schedule, myTeamNumber } = params
  const top1 = rankings[0]?.teamNumber
  const top2 = rankings[1]?.teamNumber
  const nextUnplayed = schedule.find(m => m.scoreRedFinal == null && m.scoreBlueFinal == null) || schedule[0]

  const card1: StarterCardItem = myTeamNumber
    ? {
        id: 'starter-alliance',
        icon: 'handshake',
        titleZh: `为 #${myTeamNumber} 物色最佳联队搭档`,
        titleEn: `Best Partners for #${myTeamNumber}`,
        descZh: '测算 Swarm RP (≥16) 凑分与花朵/自动阶段互补率',
        descEn: 'Find complementary picks hitting Swarm RP (>=16)',
        promptZh: `我方是 #${myTeamNumber}。请结合目前实时排名、机动分与花朵表现，帮我筛选 3 支最适配 #${myTeamNumber} 的联队搭档（重点测算双车机动是否 ≥16 拿 Swarm RP 及避免内线抢点）。`,
        promptEn: `Our team is #${myTeamNumber}. Based on current rankings, Mobility RP, and flower scoring, recommend the top 3 alliance partners for #${myTeamNumber} ensuring combined Mobility >= 16 for Swarm RP without Auto collisions.`,
        focusTeams: [myTeamNumber]
      }
    : {
        id: 'starter-alliance',
        icon: 'handshake',
        titleZh: '联队选择 Top 候选与黑马',
        titleEn: 'Alliance Selection Top Picks & Sleepers',
        descZh: '基于实测均值、Swarm RP 与稳定性筛选第一/二顺位',
        descEn: 'Rank 1st/2nd pick candidates by consistency & Swarm RP',
        promptZh: '请综合当前全场排名、Predict Cycle、机动 RP 与稳定性，推荐联队选择阶段的 Top 4 强队与 2 支被低估的高性价比二选黑马。',
        promptEn: 'Analyze all tracked teams and recommend the top 4 first-pick candidates plus 2 underrated high-value second-pick sleepers.'
      }

  const card2: StarterCardItem =
    top1 && top2
      ? {
          id: 'starter-compare',
          icon: 'compare_arrows',
          titleZh: `强队对比：#${top1} vs #${top2}`,
          titleEn: `Top Seed Clash: #${top1} vs #${top2}`,
          descZh: '自动/手动循环耗时、离散度与终局上限拆解',
          descEn: 'Break down Auto, Predict Cycle, spread & ceiling',
          promptZh: `请横向对比榜首强队 #${top1} 与 #${top2} 的实测得分结构、Predict Cycle、离散度、G410 犯规率及展位硬件差异，判断谁更适合做淘汰赛主攻手？`,
          promptEn: `Compare #${top1} and #${top2} side-by-side on scoring splits, Predict Cycle, spread, G410 foul rate, and pit hardware. Who is the stronger playoff anchor?`,
          focusTeams: [top1, top2]
        }
      : {
          id: 'starter-compare',
          icon: 'compare_arrows',
          titleZh: '对比最强得分手与效率王',
          titleEn: 'Compare Top Scorers & Cycle Leaders',
          descZh: '拆解 Auto、TeleOp 循环效率与花朵贡献',
          descEn: 'Compare Auto ceilings, TeleOp cycle rates & flowers',
          promptZh: '请对比目前表现突出的队伍在自动阶段、TeleOp 循环效率及终局花朵得分上的差距，用清晰对比表呈现。',
          promptEn: 'Compare leading teams on Auto scoring, TeleOp cycle efficiency, and Endgame flower execution using a clear table.'
        }

  const card3: StarterCardItem = nextUnplayed
    ? {
        id: 'starter-match',
        icon: 'event_note',
        titleZh: `下一场战术简报 (${(nextUnplayed.tournamentLevel || '').toUpperCase() === 'PLAYOFF' ? 'P' : 'Q'}${nextUnplayed.matchNumber})`,
        titleEn: `Next Match Brief (${(nextUnplayed.tournamentLevel || '').toUpperCase() === 'PLAYOFF' ? 'P' : 'Q'}${nextUnplayed.matchNumber})`,
        descZh: `红 #${nextUnplayed.red1}/#${nextUnplayed.red2} vs 蓝 #${nextUnplayed.blue1}/#${nextUnplayed.blue2}`,
        descEn: `Red #${nextUnplayed.red1}/#${nextUnplayed.red2} vs Blue #${nextUnplayed.blue1}/#${nextUnplayed.blue2}`,
        promptZh: `请针对第 ${nextUnplayed.matchNumber} 场（红方 #${nextUnplayed.red1} + #${nextUnplayed.red2} vs 蓝方 #${nextUnplayed.blue1} + #${nextUnplayed.blue2}）生成赛前战术简报，预测胜负面并给出双方 Auto 路线与 Swarm RP / 防 G410 策略。`,
        promptEn: `Prepare a pre-match tactical brief for Match ${nextUnplayed.matchNumber} (Red #${nextUnplayed.red1} & #${nextUnplayed.red2} vs Blue #${nextUnplayed.blue1} & #${nextUnplayed.blue2}), including projected edge, Auto plan, Swarm RP & G410 risk alerts.`,
        focusTeams: [nextUnplayed.red1, nextUnplayed.red2, nextUnplayed.blue1, nextUnplayed.blue2],
        focusMatch: { matchNumber: nextUnplayed.matchNumber, tournamentLevel: nextUnplayed.tournamentLevel }
      }
    : {
        id: 'starter-match',
        icon: 'sports',
        titleZh: 'BIOBUZZ 关键胜负手与防犯规清单',
        titleEn: 'BIOBUZZ Win Conditions & Foul Checklist',
        descZh: '围绕 Swarm RP、Bottom Bonus 与 G410 梳理拿分路径',
        descEn: 'Synthesize Swarm RP, Bottom Bonus & G410 strategy',
        promptZh: '结合当前赛事整体数据，总结本届比赛夺冠级联队在 Auto 停泊、Nectar 占底、G418 拆台与规避 G410 大犯规上的核心胜负公式。',
        promptEn: 'Summarize the winning BIOBUZZ formula in this event across Auto Park, Bottom Bonus, G418 descoring, and G410 foul discipline.'
      }

  const card4: StarterCardItem = {
    id: 'starter-audit',
    icon: 'fact_check',
    titleZh: '吹牛审计与高风险排雷清单',
    titleEn: 'Brag Index & Breakdown Risk Audit',
    descZh: '核查展位自报注水、高故障与高 G410 犯规队伍',
    descEn: 'Flag overclaimed pit specs, breakdowns & G410 fouls',
    promptZh: '请对当前所有有数据的队伍执行一次全面的“展位吹牛指数 (Brag Index) 与稳定性排雷审计”：指出哪些队伍存在明显夸大自报、高故障率、大离散度或 G410 犯规隐患。',
    promptEn: 'Run a full Brag Index and reliability audit across all teams, listing any overclaimed pit specs, high breakdown rates, erratic cycle spreads, or G410 foul risks.'
  }

  return [card1, card2, card3, card4]
}

export function generateFollowUpSuggestions(
  lastAssistantText: string,
  knownTeams: Set<string>,
  myTeamNumber: number | null | undefined,
  locale: string
): Array<{ label: string; prompt: string }> {
  if (!lastAssistantText || !lastAssistantText.trim()) return []
  const isZh = isZhLocale(locale)

  // Extract candidate team numbers present in knownTeams in order of appearance
  const mentioned: number[] = []
  const tokenMatches = lastAssistantText.match(/(?<!\d)\d{3,6}(?!\d)/g) || []
  for (const raw of tokenMatches) {
    if (!knownTeams.has(raw)) continue
    const num = Number(raw)
    if (!mentioned.includes(num)) {
      mentioned.push(num)
      if (mentioned.length >= 3) break
    }
  }

  const suggestions: Array<{ label: string; prompt: string }> = []
  if (mentioned.length >= 2) {
    const a = mentioned[0]!
    const b = mentioned[1]!
    suggestions.push({
      label: isZh ? `对比 #${a} 与 #${b} 联队互补性` : `Compare #${a} & #${b} synergy`,
      prompt: isZh
        ? `请深入对比 #${a} 和 #${b} 的 Auto/TeleOp/Swarm RP 互补性及潜在场地路线冲突。`
        : `Compare #${a} and #${b} on Auto/TeleOp/Swarm RP synergy and any lane conflicts.`
    })
  }
  if (mentioned.length >= 1) {
    const first = mentioned[0]!
    suggestions.push({
      label: isZh ? `核查 #${first} 故障与吹牛风险` : `Audit #${first} risk & Brag`,
      prompt: isZh
        ? `请重点核查 #${first} 的逐场发挥波动、Broken 故障原因、G410 犯规率及 Pit 自述是否注水。`
        : `Audit #${first}'s match consistency, breakdown notes, G410 foul rate, and Pit vs match Brag Index.`
    })
  }
  if (myTeamNumber && (!mentioned.includes(myTeamNumber) || mentioned.length === 0)) {
    const partner = mentioned[0]
    suggestions.push({
      label: partner
        ? isZh ? `测算我方 #${myTeamNumber} + #${partner}` : `Test #${myTeamNumber} + #${partner}`
        : isZh ? `结合我方 #${myTeamNumber} 给出结论` : `Tailor to #${myTeamNumber}`,
      prompt: partner
        ? isZh
          ? `如果我方 #${myTeamNumber} 与 #${partner} 组成联队，合计机动分、Swarm RP 把握度和短板分别是什么？`
          : `If our #${myTeamNumber} pairs with #${partner}, what is our projected Mobility RP, Swarm RP odds, and weakest phase?`
        : isZh
          ? `请站在我方 #${myTeamNumber} 的视角，把刚才的分析压缩为 3 条可直接执行的比赛决策。`
          : `Reframe the above analysis from #${myTeamNumber}'s perspective into 3 actionable decisions.`
    })
  } else {
    suggestions.push({
      label: isZh ? '压缩成 Pit 3条要点' : 'Condense to 3 Pit bullets',
      prompt: isZh
        ? '请把以上分析浓缩成适合发给场边操作手的 3 条红绿灯执行要点。'
        : 'Condense the above into 3 driver-ready traffic-light action bullets.'
    })
  }

  return suggestions.slice(0, 3)
}

export function buildTeamAnalysisPrompt(teamNumber: number, locale = 'zh'): string {
  return isZhLocale(locale)
    ? `请深度剖析 #${teamNumber} 在当前赛事的实测表现、Predict Cycle 与离散度、Pit 吹牛指数与稳定性，并评估其在联队选择/对抗中的战略价值。`
    : `Analyze Team #${teamNumber}'s event performance, Predict Cycle & spread, Pit Brag Index reliability, and alliance pick/matchup strategy.`
}

export function buildMatchBriefPrompt(sched: MatchScheduleItem, locale = 'zh'): string {
  const prefix = (sched.tournamentLevel || '').toUpperCase() === 'PLAYOFF' ? 'P' : 'Q'
  return isZhLocale(locale)
    ? `请生成 ${prefix}${sched.matchNumber} 赛前战术简报：红方 #${sched.red1} + #${sched.red2} vs 蓝方 #${sched.blue1} + #${sched.blue2}。请评估双方战力、Auto 启动避让、Swarm RP (≥16) 把握度、G418 拆台与防 G410 叮嘱。`
    : `Generate a pre-match brief for ${prefix}${sched.matchNumber}: Red #${sched.red1} & #${sched.red2} vs Blue #${sched.blue1} & #${sched.blue2}. Compare strengths, Auto deconfliction, Swarm RP (>=16) odds, G418 descore & G410 risk alerts.`
}
