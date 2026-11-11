/**
 * dsh-card-library — host half.
 *
 * 四类卡（画风 / 角色 / 造型 / 环境）的读取、缩略图、以及把勾选的卡拼成一份
 * 出图配方的 HTTP 接口。浏览器半端（client.js）只负责画 UI 和发请求，
 * 一切文件读写都在这里。
 *
 * 设计约定：
 *   1. 库根目录可配（环境变量 CARD_LIBRARY_ROOT 优先），默认本工作区的
 *      `_assets/cards_library`。缺库时不抛异常，接口回 `{ ok:false, error }`，
 *      右侧栏自己显示空态。
 *   2. 所有路径都过 `safeResolve()`：必须在工作区根之下，且只读白名单目录。
 *   3. 路由走 DSH 的信任栅栏 + 本机同源两道，与 dsh-bili-scroll 一致。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, normalize, sep, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'card-library-plugin'
export const inject = ['webServer', 'tools']

// `/api` 前缀被 RPC 网关接管（未带会话凭证直接 401），所以这里用和
// dsh-knowledge-canvas 一样的产品自有前缀，路由由插件独占。
const ROUTE = '/dsh-card-library'
const KINDS = ['style', 'character', 'look', 'scene', 'pose', 'prop']

/** 本文件所在目录（插件根）。 */
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * 库根，按优先级挑第一个存在的：
 *   1. 环境变量 CARD_LIBRARY_ROOT
 *   2. 随包分发的 `library/`（插件根下）
 *   3. 当前工作区的 `_assets/cards_library` / `cards_library`
 * 都没有就返回 (2) —— 接口回空态，不抛异常。
 */
function libraryRoot() {
  if (process.env.CARD_LIBRARY_ROOT) return resolve(process.env.CARD_LIBRARY_ROOT)
  const cwd = process.cwd()
  const candidates = [join(PLUGIN_ROOT, 'library')]
  // 从当前目录往上找三层：工作区根里常见 `<ws>/_assets/cards_library`。
  let dir = cwd
  for (let i = 0; i < 4; i += 1) {
    candidates.push(join(dir, '_assets', 'cards_library'), join(dir, 'cards_library'), join(dir, 'library'))
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  for (const c of candidates) if (existsSync(c)) return resolve(c)
  return resolve(candidates[0])
}

/**
 * 缩略图/预览图的第二基址。卡里的 thumb 有两种写法：库相对（`thumbs/x.jpg`）
 * 和宿主工作区相对（`_assets/style_repro/x.png`）。库根在 `_assets/cards_library`
 * 时工作区根是上两级；随包分发时就是插件根。
 */
function workspaceRoot() {
  const root = libraryRoot()
  const parent = resolve(root, '..')
  if (root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() === 'library') return parent
  return resolve(parent, '..')
}

const log = (msg) => {
  try { console.log('[card-library] ' + msg) } catch { /* 忽略 */ }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

const sendJson = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/**
 * 只读路径解析：越界返回 null。
 *
 * 卡里的 thumb 有两种写法 —— 工作区相对（`_assets/style_repro/x.png`）和库相对
 * （`thumbs/x.jpg`），所以两个基址都试一遍。都不在界内就当没有。
 */
function safeResolve(rel) {
  if (typeof rel !== 'string' || !rel) return null
  if (rel.includes('\0')) return null
  for (const base of [workspaceRoot(), libraryRoot()]) {
    const abs = normalize(resolve(base, rel))
    const withSep = base.endsWith(sep) ? base : base + sep
    if (!abs.startsWith(withSep) && abs !== base) continue
    if (!existsSync(abs)) continue
    try {
      if (!statSync(abs).isFile()) continue
    } catch { continue }
    return abs
  }
  return null
}

function readBody(req) {
  return new Promise((done) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; done(v) } }
    req.on('data', (c) => {
      size += c.length
      if (size > 1_000_000) { finish({}); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return finish({})
      try { finish(JSON.parse(text)) } catch { finish({}) }
    })
    req.on('error', () => finish({}))
  })
}

function sameOriginOk(req) {
  try {
    const host = String(req.headers.host || '')
    if (!host) return true
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
    const pick = String(req.headers.origin || req.headers.referer || '')
    if (!pick) return true
    try {
      const u = new URL(pick)
      const originAuthority = String(u.host || '').toLowerCase()
      const hostAuthority = String(host).toLowerCase()
      if (originAuthority && originAuthority === hostAuthority) return true
      const defaultPort = u.protocol === 'https:' ? '443' : '80'
      return (u.hostname + ':' + (u.port || defaultPort)).toLowerCase() === hostAuthority
    } catch { return false }
  } catch { return false }
}

// ─────────────────────────────────────────────────────────── 库读取（带缓存）
let cache = { stamp: 0, index: null, cards: new Map() }

function indexStamp() {
  const p = join(libraryRoot(), 'index.json')
  try { return statSync(p).mtimeMs } catch { return 0 }
}

function loadIndex() {
  const stamp = indexStamp()
  if (cache.index && cache.stamp === stamp) return cache.index
  const p = join(libraryRoot(), 'index.json')
  if (!existsSync(p)) { cache = { stamp, index: null, cards: new Map() }; return null }
  const idx = readJson(p)
  cache = { stamp, index: idx, cards: new Map() }
  return idx
}

function loadCard(kind, id) {
  if (!KINDS.includes(kind)) return null
  if (typeof id !== 'string' || !/^[\w.-]{1,120}$/.test(id)) return null
  // 缓存必须跟着 index.json 的 mtime 走：直接调 /compose 不会经过 loadIndex，
  // 旧代码里只有 loadIndex 会重置 cache，结果清洗完卡片后仍在返回旧内容。
  const stamp = indexStamp()
  if (cache.stamp !== stamp) cache = { stamp, index: null, cards: new Map() }
  const key = kind + '/' + id
  if (cache.cards.has(key)) return cache.cards.get(key)
  const p = join(libraryRoot(), kind + 's', id + '.json')
  if (!existsSync(p)) return null
  const card = readJson(p)
  cache.cards.set(key, card)
  return card
}

// ─────────────────────────────────────────────────────────── 配方拼装
const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()

/**
 * Anima 格式铁律（知识库 n55）：标签里的下划线必须转空格，否则权重被切碎。
 * 画师 handle 例外 —— `@minaba_hideo` 的下划线是名字的一部分，转了反而失效。
 */
function normalizeTags(segment) {
  const text = clean(segment)
  if (!text) return ''
  return text
    .split(',')
    .map((tok) => {
      const t = tok.trim()
      if (!t) return ''
      return t.startsWith('@') ? t : t.replace(/_/g, ' ')
    })
    .filter(Boolean)
    .join(', ')
}

/** 拼段并去重（保序、忽略大小写），避免同一张卡的正负段互相叠词。 */
function joinSeg(...parts) {
  const seen = new Set()
  const out = []
  for (const part of parts) {
    const text = normalizeTags(part)
    if (!text) continue
    for (const tok of text.split(',')) {
      const t = tok.trim()
      if (!t) continue
      const key = t.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(t)
    }
  }
  return out.join(', ')
}

/**
 * 环境卡 → 场景提示词段。
 *
 * 环境卡只该管「在哪儿、什么天气、什么光、什么相机」，不管人物做什么。
 * 271 张卡清洗过一遍（_clean_scene_cards3.py）：动作/服装/表情/身体部位全部剥离，
 * 相机信息单独放进 camera / extra_camera。所以这里只拼：
 *   tags  → place, weather, light_fx, texture_fx, prop
 *   camera → viewpoint, shot_size, comp, dof
 *   extra / extra_camera → 场景物件与景别补充
 */
const SCENE_SLOT_ORDER = ['place', 'weather', 'light_fx', 'texture_fx', 'prop']
const SCENE_CAMERA_ORDER = ['shot_size', 'viewpoint', 'comp', 'dof']

/**
 * 造型卡拆成两半（_split_look_pose.py 写回每张卡）：
 *   look_tags = 穿什么（衣服/鞋袜/配饰/材质/皮肤质感）
 *   pose_tags = 做什么（姿势/动作/表情/视线/景别）
 *
 * 为什么要拆：这两半会和环境卡的场景描述打架。更衣间那张环境卡要「单腿站立
 * 抬另一条腿拉袜口」，造型卡却写着 `walking, crossed arms` —— 拼在一起模型
 * 只能二选一，通常选错。默认只拼 look_tags，动作由调用方显式决定。
 *
 * 老卡没有 look_tags 字段时退回原 tags，保证不炸。
 */
function lookClothSegment(look) {
  if (!look) return ''
  return clean(look.look_tags != null ? look.look_tags : look.tags)
}

function lookPoseSegment(look) {
  if (!look) return ''
  return clean(look.pose_tags || '')
}

/**
 * 背影机位下，角色卡里「必须看得见脸才能表现」的词全部剥掉。
 *
 * 实测（bisect 七张，同 seed 只加一段）：裸配方能出真背影；加画师段、render 段、
 * 造型段、场景段都还是背影；**一加角色段就翻脸** —— 而且翻成了「三张脸并排」的
 * 分镜图。原因是 feature_segment 里全是 `heterochromia / blue eyes / red eyes /
 * symbol-shaped pupils / mole under eye / fang` 这类只在正面才成立的识别特征，
 * 模型为了把它们画出来，必须把脸转过来。
 *
 * 能从背后看见的（头发、耳朵、牙项链、尾巴、身材）一律保留。
 */
const FACE_ONLY_RE = /^(heterochromia|different colored eyes|one blue eye|one red eye|blue eyes|red eyes|blue_eyes|red_eyes|symbol-shaped pupils|symbol shaped pupils|heart-shaped pupils|star-shaped pupils|mole under eye|mole_under_eye|close-set eyes|close set eyes|wide-set eyes|fang|fang_out|fang out|sharp teeth|teeth|eye contact|catchlight in both eyes|detailed eyes|glowing eyes|Long nails|long nails)$/i

function stripFaceOnly(seg) {
  if (!seg) return ''
  const out = []
  for (const raw of String(seg).split(',')) {
    const t = raw.trim()
    if (!t) continue
    if (FACE_ONLY_RE.test(t)) continue
    out.push(t)
  }
  return out.join(', ')
}

/**
 * 角色卡 → 角色提示词段。
 *
 * v4 起角色卡拆成两半：body_segment（身材/肤色/体型）+ feature_segment（种族特征、
 * 头发、眼睛、耳朵、牙、尾巴）。理由：角色卡原来把 blue_fat_fish 的整套女仆装都
 * 塞在 character_segment 里，换个造型就会跟造型卡打架。
 * character_segment 保留（脚本里拼成 body+feature），老卡没有新字段时直接用它。
 */
function characterSegment(character, closedEyes, backView) {
  if (!character) return ''
  if (closedEyes && character.character_segment_closed_eyes) {
    return clean(character.character_segment_closed_eyes)
  }
  const body = clean(character.body_segment || '')
  const feature = clean(character.feature_segment || '')
  if (body || feature) {
    const seg = joinSeg(body, feature)
    return backView ? stripFaceOnly(seg) : seg
  }
  const legacy = clean(character.character_segment || '')
  return backView ? stripFaceOnly(legacy) : legacy
}

/**
 * 动作卡（poses/）→ 动作提示词段。
 *
 * 环境卡和动作卡是两件事：环境卡只说「在哪儿、什么光」，动作卡说「在做什么」。
 * 原来这两半混在一张「环境卡」里（AnimaV5 的 scene_nl 自带一整套人物描述），
 * 拼配方时动作会盖掉造型卡、也会跟用户选的环境打架。现在拆开：
 *   环境卡 = scenes/  纯地点/天气/光线/相机
 *   动作卡 = poses/   姿势/动作/表情/视线/服装/身体
 * 动作卡的 suggest_place 只是「原本在哪儿」，用户可以忽略它换别的地点。
 */
// 视角系统接管「往哪儿看」之后，动作卡里自带的视线/机位/景别词必须让位。
// 实测（V2 背面+回头）出图仍是正脸：正向里同时有动作卡的 `looking at viewer`
// 和视角段的 `from behind, looking back`，模型听了前者的。
const VIEW_TAKEOVER_RE = /^(looking (at viewer|back|back over shoulder|over shoulder|to the side|down|up|away|ahead|afar|at object)|eye contact|facing away|facing viewer|from (above|below|behind|side|front|outside)|three-quarter view|profile|dutch angle|bird's eye view|worm's eye view|pov hands|foreshortening|wide shot|full body|cowboy shot|upper body|close-up|extreme close-up|portrait|negative space)$/i

function stripViewTakeover(seg) {
  if (!seg) return ''
  const out = []
  for (const raw of String(seg).split(',')) {
    const t = raw.trim()
    if (!t) continue
    if (VIEW_TAKEOVER_RE.test(t)) continue
    out.push(t)
  }
  return out.join(', ')
}

function poseSegment(pose) {
  if (!pose) return ''
  return clean(pose.pose_tags || '')
}

/**
 * 道具卡 = 手里拿什么 / 身上挂什么。
 *
 * 和造型卡的区别是 n50 那条界线：换个场景还跟着的东西算道具（地图、弓、锅、项链），
 * 背景环境不算。道具卡本身只写「物」，不写持有者、不写场景、不写服装 —— 否则又变回造型卡。
 * hold=true 的道具通常要配一个 holding 动词，所以拼进正向时补一句 holding，
 * 否则模型可能把雨伞放在墙角而不是拿在手里。
 */
function propSegment(prop) {
  if (!prop) return ''
  const tags = clean(prop.prop_tags || '')
  if (!tags) return ''
  if (!prop.hold) return tags
  // 已经有 holding 就别重复（用 indexOf：这张卡是脚本生成的，正则转义容易写成双反斜杠）
  if (tags.toLowerCase().indexOf('holding') >= 0) return tags
  // 已经有 holding 动词就别重复
  if (/\bholding\b/i.test(tags)) return tags
  return 'holding ' + tags
}

/**
 * 多道具合成（v4）。
 *
 * 为什么不能简单拼三遍 `holding X, holding Y`：模型看到多个 holding 只会画一个。
 * 正确写法是合并成一个动词 —— `holding umbrella and sword`。
 * 穿戴类（hold=false）不走 holding，直接各自拼。
 *
 * 上限 4 件：超过 4 件模型必然漏画，宁可少选。
 */
const PROP_MAX = 4

function propsSegment(props) {
  const list = (props || []).filter(Boolean).slice(0, PROP_MAX)
  if (!list.length) return ''
  const held = []
  const worn = []
  for (const p of list) {
    const tags = clean(p.prop_tags || '')
    if (!tags) continue
    if (p.hold) {
      // 卡里的 tags 常常是「umbrella, holding umbrella, open umbrella」这种同义堆叠。
      // 多件合并时只能留主名词，否则会拼出 "holding umbrella, holding umbrella,
      // open umbrella and handbag" —— 模型反而一件都画不清。
      const tokens = tags.split(',').map((t) => t.trim()).filter(Boolean)
      const nouns = tokens.filter((t) => !/^holding\b/i.test(t) && !/^wearing\b/i.test(t))
      held.push((nouns[0] || tokens[0] || '').trim())
    } else {
      worn.push(tags)
    }
  }
  const parts = []
  const heldClean = held.filter(Boolean)
  if (heldClean.length === 1) parts.push('holding ' + heldClean[0])
  else if (heldClean.length > 1) parts.push('holding ' + heldClean.join(' and '))
  parts.push(...worn)
  return parts.join(', ')
}

/** 多道具的冲突检测（只说真会画坏的那几种）。 */
function propConflicts(props) {
  const out = []
  const list = (props || []).filter(Boolean)
  if (list.length > PROP_MAX) {
    out.push(`选了 ${list.length} 件道具 —— 超过 ${PROP_MAX} 件模型必然漏画，建议减到 3 件以内`)
  }
  const held = list.filter((p) => p.hold)
  if (held.length > 2) {
    out.push(`手里同时拿了 ${held.length} 件东西 —— 两只手画不下，模型会丢一两件`)
  }
  // 同部位饰品：项链 + 项圈 / 耳饰 + 耳饰
  const SLOT_RE = [
    [/necklace|choker|necktie|bowtie|scarf|brooch/i, '颈部饰品'],
    [/earring/i, '耳饰'],
    [/ring\b|bracelet|wristwatch|armlet/i, '手部饰品'],
    [/crown|tiara|halo|beret|beanie|headband|hairclip|veil/i, '头部饰品'],
    [/boots|slippers/i, '鞋'],
  ]
  const seen = new Map()
  for (const p of list) {
    const t = clean(p.prop_tags || '')
    for (const [re, label] of SLOT_RE) {
      if (!re.test(t)) continue
      if (seen.has(label)) {
        out.push(`「${seen.get(label)}」和「${p.name}」都占${label} —— 会叠在一起`)
      } else {
        seen.set(label, p.name)
      }
    }
  }
  return out
}

/* ════════════════════════════════════════════════════════════════
   视角（v4）：机位方位 + 视线方位 → 真正的提示词
   ════════════════════════════════════════════════════════════════
   为什么不做成第七类卡：卡是可以叠加的，视角是关系 —— 同一时刻只能有一个机位、
   一个视线方向。做成卡就会出现「正面 + 背面」这种非法态，还得再写一套互斥逻辑。
   做成一个对象（view）就没有这个问题。

   关键设计：用户选的不是 tag，是「往哪儿看」。同一句「往右看」，机位在正面时
   是 looking to the side，机位在背后时就成了 looking back —— 这个换算由代码做。
   ════════════════════════════════════════════════════════════════ */
const VIEW_AZIMUTH = {
  front: 0, front_right: 45, right: 90, back_right: 135,
  back: 180, back_left: 225, left: 270, front_left: 315,
  above: 0, below: 0,
}

const VIEW_CAM = {
  front:       { pos: 'from front, straight-on, facing viewer', neg: 'from behind, facing away' },
  front_right: { pos: 'from side, three-quarter view',          neg: 'profile, straight-on' },
  right:       { pos: 'from side, profile',                     neg: 'straight-on, facing viewer' },
  back_right:  { pos: 'from behind, from side, back view',                 neg: 'from front, looking at viewer' },
  back:        { pos: 'from behind, back view, seen from behind',               neg: 'from front, looking at viewer, eye contact' },
  back_left:   { pos: 'from behind, from side, back view',                 neg: 'from front, looking at viewer' },
  left:        { pos: 'from side, profile',                     neg: 'straight-on, facing viewer' },
  front_left:  { pos: 'from side, three-quarter view',          neg: 'profile, straight-on' },
  above:       { pos: 'from above, high angle',                 neg: 'from below' },
  below:       { pos: 'from below, low angle',                  neg: 'from above' },
}

const VIEW_SHOTS = [
  { id: 'extreme_close', pos: 'extreme close-up, close-up, focus on face', far: false },
  { id: 'close',         pos: 'close-up, portrait',                        far: false },
  { id: 'upper',         pos: 'upper body',                                far: false },
  { id: 'cowboy',        pos: 'cowboy shot',                               far: false },
  { id: 'full',          pos: 'full body',                                 far: true },
  { id: 'wide',          pos: 'wide shot, full body, small figure',        far: true },
]

/** 角度差归一到 -180..180 */
function viewDiff(a, b) {
  let d = (a - b) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

/**
 * view = { angle, gaze, shot, flip }
 *   angle / gaze 都是方位 id（front / right / back … / above / below）
 *   shot 是景别下标 0..5，flip 是左右镜像
 */
function viewSegments(view) {
  if (!view || !view.angle) return { pos: '', neg: '', notes: [], warnings: [], flip: false }
  const camId = view.angle
  const gazeId = view.gaze || 'front'
  const shotIdx = Number.isFinite(view.shot) ? Math.max(0, Math.min(5, view.shot)) : 3
  const shot = VIEW_SHOTS[shotIdx]
  const cam = VIEW_CAM[camId]
  if (!cam) return { pos: '', neg: '', notes: [], warnings: [], flip: false }

  const notes = []
  const warnings = []
  let gazePos = ''
  let gazeNeg = ''

  // ① 竖直优先：头顶/脚下就是抬头/低头，与水平角无关
  if (gazeId === 'above') {
    gazePos = 'looking up'
    gazeNeg = 'looking down'
    notes.push('视线取「抬头」')
  } else if (gazeId === 'below') {
    gazePos = 'looking down'
    gazeNeg = 'looking up, eye contact'
    notes.push('视线取「低头」')
  } else {
    // ② 水平：算视线方位与机位方位的夹角
    const rel = viewDiff(VIEW_AZIMUTH[gazeId], VIEW_AZIMUTH[camId])
    const a = Math.abs(rel)
    // 阈值放宽到 60°：front_right / front_left 这类三分之四侧机位，
    // 视线朝正前方时和机位只差 45°，实际观感仍是「看镜头」。
    if (a < 60) {
      if (Math.abs(VIEW_AZIMUTH[camId] - 180) < 60) {
        gazePos = 'looking back, looking over shoulder'
        gazeNeg = 'looking ahead, looking forward'
        notes.push('机位在背后 + 视线朝机位 → 自动取「回头」')
      } else {
        gazePos = 'looking at viewer, eye contact'
        gazeNeg = 'looking away, looking to the side, looking back'
        notes.push('视线朝机位 → 看镜头')
      }
    } else if (a < 135) {
      gazePos = 'looking to the side'
      gazeNeg = 'looking at viewer, eye contact'
      notes.push(`视线偏离镜头 ${Math.round(a)}° → 侧看`)
    } else {
      gazePos = 'looking away, facing away'
      gazeNeg = 'looking at viewer, eye contact'
      notes.push('视线背对镜头 → 别开')
    }
  }

  // ③ 冲突检测
  // 背面机位只有「回头」能看见眼睛；背对镜头、侧看、别开都看不到
  if (camId === 'back' && gazePos.indexOf('looking back') < 0) {
    warnings.push('背面机位看不到眼睛 —— 异色瞳会消失；想露脸把视线改成「后」= 回头（n64）')
  }
  // 实测（6 张对照）：这个底模 + wlop 画风 + semi-realistic render 下，
  // 纯背影（back 机位 + 背对镜头）几乎出不来 —— 剥掉脸光、剥掉 render 眼部高光、
  // 剥掉 character 的异色瞳/mole、把 from behind 提到最前、负面堆满 front view，
  // 出来仍是半侧身回头。back_right / back_left 这种「侧后 45°」反而稳。
  if (camId === 'back' && shotIdx <= 2) {
    warnings.push('实测：这个画风组合下「正后方 + 半身以内」背影不稳定，模型会自己转成半侧身回头；要稳定背影请用「后右 / 后左」机位，或把景别拉到全身以上')
  }
  if (camId === 'above' && gazeId === 'below') {
    warnings.push('俯拍 + 低头 = 只看到头顶，脸完全不可见')
  }
  if (camId === 'below' && gazeId === 'above') {
    warnings.push('仰拍 + 抬头 = 下巴挡住眼睛')
  }
  if (shot.far && gazePos.indexOf('looking at viewer') >= 0) {
    warnings.push('远景里「看镜头」几乎看不出来，建议推到七分身以内')
  }
  if ((camId === 'above' || camId === 'below') && shotIdx <= 1) {
    warnings.push('俯拍/仰拍做大特写，透视会严重变形')
  }

  // ④ 脸光：远景/背影自动降级（n64）
  //
  // 背影机位（back / back_left / back_right）且视线不是「回头」时，脸光必须整段清空 ——
  // 连降级版里的 `face visible` 都会把脸拽回来。实测（W2/W3）：只留降级版，
  // 出来是侧脸；整段清空才是真背影。
  const far = shot.far || camId === 'back' || camId === 'above'
  const isBackCam = camId === 'back' || camId === 'back_left' || camId === 'back_right'
  const isLookBack = gazePos.indexOf('looking back') >= 0
  const faceLight = (isBackCam && !isLookBack)
    ? ''
    : (far
      ? 'face visible, face lit by ambient light, soft light on skin, warm light on cheek, no heavy shadow on face'
      : 'face fully lit, catchlight in both eyes, gentle highlight on cheek')

  return {
    shotFar: shot.far === true,
    backCam: camId === 'back' || camId === 'back_left' || camId === 'back_right',
    pos: [cam.pos, gazePos, shot.pos, faceLight].filter(Boolean).join(', '),
    neg: [cam.neg, gazeNeg].filter(Boolean).join(', '),
    camera: { shot_size: shot.pos, viewpoint: cam.pos },
    notes,
    warnings,
    flip: view.flip === true,
    faceLight,
    far,
  }
}


/**
 * 负向段与正向段不能有交集：同一串词同时出现在两边，模型只能二选一，
 * 实测「正面看镜头」赢过「背影回头」。这里把正向已含的短语从负向里剔掉。
 */
function minusPositive(negSeg, posText) {
  if (!negSeg) return ''
  // 注意：不能只补空格 —— 词之间是逗号分隔，" looking at viewer " 在
  // "..., looking at viewer, eye contact, ..." 里永远匹配不到（viewer 后面是逗号）。
  // 必须先把逗号也换成空格再比，否则交集根本剔不掉。
  const norm = (x) => ' ' + String(x || '').toLowerCase().replace(/[,\n]+/g, ' ').replace(/\s+/g, ' ') + ' '
  const pos = norm(posText)
  const out = []
  for (const raw of String(negSeg).split(',')) {
    const t = raw.trim()
    if (!t) continue
    if (pos.indexOf(norm(t)) >= 0) continue
    out.push(t)
  }
  return out.join(', ')
}

function sceneSegment(scene, opts) {
  if (!scene) return ''
  const skipCam = opts && opts.skipCamera
  const tags = scene.tags || {}
  const camera = scene.camera || {}
  const parts = []
  for (const slot of SCENE_SLOT_ORDER) {
    const v = clean(tags[slot])
    if (v) parts.push(v)
  }
  for (const slot of SCENE_CAMERA_ORDER) {
    // 选了视角时，机位/景别由视角决定，环境卡只补 comp / dof
    if (skipCam && (slot === 'shot_size' || slot === 'viewpoint')) continue
    const v = clean(camera[slot])
    if (v) parts.push(v)
  }
  const extra = clean(scene.extra)
  if (extra) parts.push(extra)
  const extraCam = clean(scene.extra_camera)
  // 远景补充同理：skipCam 时把里面的景别/视角词滤掉，只留场景描述
  if (extraCam) {
    if (skipCam) {
      const kept = extraCam.split(',')
        .map((t) => t.trim())
        .filter((t) => t && !/^(wide shot|full body|small figure|from behind|from above|from below|from side|from front)$/i.test(t))
      if (kept.length) parts.push(kept.join(', '))
    } else {
      parts.push(extraCam)
    }
  }
  return parts.join(', ')
}

/**
 * 远景场景和「脸光」天生互斥。
 *
 * FACE_LIGHT 那一段（face fully lit / catchlight in both eyes …）是治脸黑写的，
 * 但只要它在，模型就必须给大特写 —— wide shot / from behind / small figure 全被压掉。
 * 所以场景一旦是远景，就把脸光降级成不强迫近景的版本。
 */
const FAR_SHOT_RE = /wide shot|full body|small figure|vast landscape|distant view|wide landscape|from behind|from outside|sense of scale/i

function faceLightFor(faceLight, scene) {
  if (!faceLight) return ''
  if (!scene) return faceLight
  const camText = [scene.camera && scene.camera.shot_size, scene.camera && scene.camera.viewpoint,
    scene.extra_camera, scene.extra].filter(Boolean).join(', ')
  if (!FAR_SHOT_RE.test(camText)) return faceLight
  // 远景版：只保留「亮」，去掉所有逼迫近景的词
  return 'face visible, face lit by ambient light, soft light on skin, warm light on cheek, no heavy shadow on face'
}

/**
 * 配方自检：把「选出来的卡互相打架」这件事在生成前就说清楚。
 * 这些都是实测踩过的（n58–n61、卡片库天台那轮、环境/动作拆分那轮）。
 */
function buildWarnings(scene, style, look, pose, usePose, props, viewSeg) {
  const out = []
  const list = (props || []).filter(Boolean)
  // 画风卡声明了 mode=img2img（init_required）时，text2img 直跑画不出它的画法 ——
  // 实测：这个底模从零画不出真墨线稿，必须给底图（n81/n82）。
  if (style && style.mode === 'img2img') {
    const dn = (style.params && style.params.denoise) || 0.85
    const wf = (style.init_hint && style.init_hint.workflow) || ''
    out.push('这张画风卡是 img2img 专用：正向词只能压出黑白，画法必须靠底图继承' + (wf ? '（' + wf + '）' : '') + '，denoise ' + dn)
  }
  if (pose) {
    if (!usePose) {
      out.push('选了动作卡但没勾「带动作」—— 动作卡的姿势不会进配方')
    }
    if (look && lookPoseSegment(look)) {
      out.push('造型卡自己也带一套动作（pose_tags）—— 会跟动作卡抢，冲突时以动作卡为准，建议关掉造型动作')
    }
    const want = clean(pose.suggest_place)
    const got = clean(scene?.tags?.place)
    if (want && got && want !== got) {
      out.push(`动作卡原本发生在「${want}」，现在配的是「${got}」—— 动作可能需要调整（例如床上的动作放到街边）`)
    }
    if (want && !got) {
      out.push(`动作卡原本发生在「${want}」，当前没选环境卡 —— 环境需要另给`)
    }
  } else if (look && !usePose && lookPoseSegment(look)) {
    out.push('造型卡的动作/表情/景别默认没进配方（会和场景打架）—— 需要就勾「带动作」')
  }
  // 道具：hold 需要动词，穿戴类怕手部动作
  const held = list.filter((p) => p.hold)
  if (held.length && !usePose) {
    out.push('道具卡是需要拿在手里的（hold），但没勾「带动作」—— 没有 holding 动词，道具可能被摆到墙角')
  }
  for (const p of list) {
    if (!p.hold && usePose && /holding|hands?\b/i.test(clean(pose?.pose_tags))) {
      out.push(`「${p.name}」是穿戴类（hold=false），但动作里有手部动作 —— 两者可能打架`)
      break
    }
  }
  // 选了视角时，机位/景别由视角决定，环境卡的 camera 已经不参与拼装 ——
  // 再拿它报警就是假警报（实际测过：视角选了正面，仍报「背影会吃异色瞳」）。
  if (viewSeg && viewSeg.pos) {
    if (viewSeg.far && style?.face_light) {
      // far 不只指远景：背影、俯拍也会降级脸光，文案要说清楚是哪个原因
      const why = viewSeg.shotFar ? '远景' : (viewSeg.backCam ? '背影机位' : '俯拍机位')
      out.push(`${why}：脸部补光已自动降级（否则模型会强行拉成脸部特写）`)
    }
    return out
  }
  if (!scene) return out
  const cam = scene.camera || {}
  const camText = [cam.shot_size, cam.viewpoint, scene.extra_camera].filter(Boolean).join(', ')
  if (FAR_SHOT_RE.test(camText) && style?.face_light) {
    out.push('远景场景：脸部补光已降级，否则模型会强行拉成脸部特写')
  }
  if (/from behind/i.test(camText)) {
    out.push('背影视角会吃掉异色瞳 —— 想露脸就把视角换成 from side / three-quarter view')
  }
  return out
}

function compose(input) {
  const style = input.styleId ? loadCard('style', input.styleId) : null
  const character = input.characterId ? loadCard('character', input.characterId) : null
  const look = input.lookId ? loadCard('look', input.lookId) : null
  const scene = input.sceneId ? loadCard('scene', input.sceneId) : null
  const pose = input.poseId ? loadCard('pose', input.poseId) : null

  // 道具支持多选（v4）。propIds 优先，老字段 propId 兼容成单元素数组。
  const propIds = Array.isArray(input.propIds) && input.propIds.length
    ? input.propIds.filter((x) => typeof x === 'string' && x)
    : (input.propId ? [input.propId] : [])
  // 全部读出来（缺卡检测要看全集），但真正进配方的只有前 PROP_MAX 件
  const propsAll = propIds.map((id) => loadCard('prop', id)).filter(Boolean)
  const props = propsAll.slice(0, PROP_MAX)

  // 视角（v4）：{ angle, gaze, shot, flip }
  const view = input.view && typeof input.view === 'object' ? input.view : null

  const missing = []
  if (input.styleId && !style) missing.push('style:' + input.styleId)
  if (input.characterId && !character) missing.push('character:' + input.characterId)
  if (input.lookId && !look) missing.push('look:' + input.lookId)
  if (input.sceneId && !scene) missing.push('scene:' + input.sceneId)
  if (input.poseId && !pose) missing.push('pose:' + input.poseId)
  for (const id of propIds) {
    if (!loadCard('prop', id)) missing.push('prop:' + id)
  }

  const q = style?.quality_prefix || 'masterpiece, best quality, score_7, score_9, very aesthetic, ultra detailed, '
  const art = style?.artist_segment || ''
  // 背影机位（back / back_left / back_right）下剥掉脸部专属特征，否则模型为了画
  // 异色瞳会把脸强行转过来（bisect 实测：角色段是唯一把背影翻成正脸的那一段）。
  const viewBack = !!(view && (view.angle === 'back' || view.angle === 'back_left' || view.angle === 'back_right'))
  const charSeg = characterSegment(character, input.closedEyes === true, viewBack)
  const lookCloth = lookClothSegment(look)
  const lookPose = lookPoseSegment(look)
  // 动作来源优先级：动作卡 > 造型卡 legacy_pose_ref（v4 迁出的那批）> 造型卡自带 pose_tags。
  // 动作卡是显式选的，一旦选了就以它为准；造型卡的动作默认不进配方，
  // 因为它会和用户选的环境/动作卡打架（更衣间那张就是典型：卡里写 walking + crossed arms）。
  const poseSeg = poseSegment(pose)
  const usePose = input.includePose !== false && (!!poseSeg || input.includePose === true)
  let actSeg = ''
  if (usePose && poseSeg) actSeg = poseSeg
  else if (usePose && lookPose) actSeg = lookPose
  // 视角选了之后由视角段说了算：把动作段里的视线/机位/景别词剥掉，避免两套指令打架
  const viewTakeover = !!(input.view && typeof input.view === 'object' && input.view.angle)
  const actSegForRecipe = viewTakeover ? stripViewTakeover(actSeg) : actSeg
  const lookSeg = joinSeg(lookCloth, actSegForRecipe)

  // 道具跟在动作后面：先说明「在做什么」，再说明「手里拿着什么」
  const propSeg = propsSegment(props)
  const viewSeg = viewSegments(view)
  // 选了视角时，环境卡的机位/景别让位给视角，只保留 comp / dof
  const sceneSeg = sceneSegment(scene, { skipCamera: !!viewSeg.pos })
  // 脸光：视角优先（视角自己会算远景降级），没视角才走环境卡判定
  const faceLight = viewSeg.faceLight || faceLightFor(style?.face_light || '', scene)
  const render = style?.render || ''

  // 拼装顺序：视角段紧跟在场景之后 —— 场景说明「在哪」，视角说明「从哪儿看、往哪儿看」。
  // 放在场景之前会被场景的 camera 词盖掉，放在最后又压不住 render 段的 detailed eyes。
  const positive = joinSeg(q, art, charSeg, lookSeg, propSeg, sceneSeg, viewSeg.pos, faceLight, render)
  const negParts = [
    style?.negative || '',
    character?.negative || '',
    look?.negative_extra || '',
    viewSeg.neg,
  ]
  // 最后一道保险：负向里凡是正向已经写了的词，全部剔除。
  // 两段有交集时模型会二选一，「正面看镜头」比「背影回头」强势，实测直接翻脸。
  const negative = minusPositive(joinSeg(...negParts), positive)

  // 参数优先级：画风卡最硬。
  //
  // 底模 + 加速 LoRA + steps/cfg 是画风卡的采样档（miaomiaoHarem 8step 必须配
  // 12步 cfg2.0），角色卡里存的是老底模 anima-base 的 45步 cfg4.5 —— 那个一旦
  // 盖过来，8step 模型就跑废了。所以只拿画风卡当基座，别的卡只补它没有的键。
  const params = Object.assign({}, style?.params || {})
  for (const extra of [look?.params, character?.params]) {
    if (!extra || typeof extra !== 'object') continue
    for (const [k, v] of Object.entries(extra)) {
      if (params[k] === undefined || params[k] === null || params[k] === '') params[k] = v
    }
  }
  // 场景推荐画幅
  if (scene?.aspect === 'landscape') params.resolution = '1216x832'
  else if (scene?.aspect === 'portrait') params.resolution = params.resolution || '832x1216'

  const seed = Number.isFinite(input.seed) ? Math.trunc(input.seed) : null

  return {
    ok: missing.length === 0,
    missing,
    selection: {
      style: style ? { id: style.id, name: style.name } : null,
      character: character ? { id: character.id, name: character.name, default_look: character.default_look || null } : null,
      look: look ? { id: look.id, name: look.name } : null,
      scene: scene ? { id: scene.id, name: scene.name, aspect: scene.aspect } : null,
      pose: pose ? { id: pose.id, name: pose.name, suggest_place: clean(pose.suggest_place) } : null,
      props: props.map((p) => ({ id: p.id, name: p.name, hold: !!p.hold })),
      view: viewSeg.pos ? { angle: view.angle, gaze: view.gaze || 'front', shot: view.shot, flip: viewSeg.flip } : null,
    },
    segments: {
      quality: clean(q),
      artist: clean(art),
      character: clean(charSeg),
      character_body: clean(character?.body_segment || ''),
      character_feature: clean(character?.feature_segment || ''),
      look: clean(lookSeg),
      look_cloth: clean(lookCloth),
      look_pose: clean(lookPose),
      pose: clean(poseSeg),
      action: clean(actSegForRecipe),
      prop: clean(propSeg),
      props: props.map((p) => ({ id: p.id, name: p.name, tags: clean(p.prop_tags || ''), hold: !!p.hold })),
      scene: sceneSeg,
      view: clean(viewSeg.pos),
      view_negative: clean(viewSeg.neg),
      view_notes: viewSeg.notes,
      face_light: clean(faceLight),
      render: clean(render),
      scene_nl: scene?.scene_nl || '',
      // env_hint 是「纯环境，可直接用」那一段 —— 必须跟 scene 段保持一致，
      // 否则选了视角后 recipeText 里还会露出环境卡的老机位（from behind 之类）。
      env_hint: sceneSeg || scene?.env_hint || '',
      env_nl: scene?.env_nl || '',
      pose_nl: pose?.pose_nl || '',
      prop_nl: props.map((p) => p.prop_nl || '').filter(Boolean).join(' / '),
    },
    includePose: usePose,
    flip: viewSeg.flip,
    warnings: buildWarnings(scene, style, look, pose, usePose, props, viewSeg)
      .concat(propConflicts(propsAll))
      .concat(viewSeg.warnings),
    positive,
    negative,
    params,
    seed,
    post: style?.post || null,
  }
}

/** 给模型读的配方文本：一段话 + 可直接用的 prompt/negative。 */
function recipeText(r) {
  const lines = []
  lines.push('【卡片库配方】')
  const s = r.selection
  lines.push(`画风：${s.style ? s.style.name + ' (' + s.style.id + ')' : '（未选）'}`)
  lines.push(`角色：${s.character ? s.character.name + ' (' + s.character.id + ')' : '（未选）'}`)
  lines.push(`造型：${s.look ? s.look.name + ' (' + s.look.id + ')' : '（未选）'}`)
  lines.push(`环境：${s.scene ? s.scene.name + ' (' + s.scene.id + ')' : '（未选）'}`)
  lines.push(`动作：${s.pose ? s.pose.name + ' (' + s.pose.id + ')' : '（未选）'}`)
  if (s.props && s.props.length) {
    lines.push(`道具：${s.props.map((p) => p.name + ' (' + p.id + ')').join(' + ')}`)
  } else {
    lines.push('道具：（未选）')
  }
  if (s.view) {
    const VZ = { front:'正面', front_right:'右前', right:'右侧', back_right:'右后', back:'背面',
                 back_left:'左后', left:'左侧', front_left:'左前', above:'头顶', below:'脚下' }
    const SH = ['大特写', '特写', '上半身', '七分身', '全身', '远景']
    lines.push(`视角：机位 ${VZ[s.view.angle] || s.view.angle} · 视线 ${VZ[s.view.gaze] || s.view.gaze} · 景别 ${SH[s.view.shot] || '?'}` + (s.view.flip ? ' · 镜像' : ''))
  }
  if (r.missing.length) lines.push(`缺失：${r.missing.join(', ')}`)
  if (r.seed != null) lines.push(`seed：${r.seed}`)
  lines.push('')
  lines.push('正向提示词：')
  lines.push(r.positive)
  lines.push('')
  lines.push('负面提示词：')
  lines.push(r.negative)
  lines.push('')
  const p = r.params || {}
  lines.push(`参数：${p.model || '?'} / LoRA ${p.lora || '?'} / ${p.steps || '?'}步 cfg${p.cfg || '?'} ${p.sampler || '?'}/${p.scheduler || '?'} / ${p.resolution || '?'}`)
  if (r.flip) lines.push('后期：需要左右镜像（ImageOps.mirror）')
  if (r.warnings && r.warnings.length) {
    lines.push('')
    lines.push('注意：')
    for (const w of r.warnings) lines.push('- ' + w)
  }
  if (r.segments.view) {
    lines.push('')
    lines.push('视角段（已进正向提示词）：')
    lines.push(r.segments.view)
    if (r.segments.view_notes && r.segments.view_notes.length) {
      lines.push('推导：')
      for (const n of r.segments.view_notes) lines.push('· ' + n)
    }
  }
  if (r.segments.env_hint) {
    lines.push('')
    lines.push('场景（纯环境，可直接用）：')
    lines.push(r.segments.env_hint)
  }
  if (r.segments.pose) {
    lines.push('')
    lines.push('动作（来自动作卡，已进正向提示词）：')
    lines.push(r.segments.pose)
  }
  if (r.segments.pose_nl) {
    lines.push('')
    lines.push('动作描述（自然语言，只作参考）：')
    lines.push(r.segments.pose_nl)
  }
  if (r.segments.prop) {
    lines.push('')
    lines.push('道具（已进正向提示词）：')
    lines.push(r.segments.prop)
  }
  if (r.segments.prop_nl) {
    lines.push('')
    lines.push('道具描述（自然语言，只作参考）：')
    lines.push(r.segments.prop_nl)
  }
  if (r.segments.scene_nl) {
    lines.push('')
    lines.push('原始场景描述（含动作，只作氛围参考，别照抄）：')
    lines.push(r.segments.scene_nl)
  }
  if (r.post) {
    // 后期步骤按画风卡自己的 post 字段列，别写死 —— 柔光那套是 lift+haze，
    // Cygames 那套是 lift+glow+crisp+grain，漫画墨线那套只有 crisp（套 haze 会把网点糊掉）。
    const steps = Object.keys(r.post).filter((k) => k !== 'note' && r.post[k] && typeof r.post[k] === 'object')
    lines.push('')
    if (steps.length) {
      lines.push('后期（按画风卡的 post 字段）：' + steps.join(' → '))
      if (r.post.note) lines.push('说明：' + r.post.note)
    } else {
      lines.push('后期：不做（这张画风卡没有 post 步骤）')
    }
  }
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────── HTTP 处理
async function handle(req, res, url) {
  const path = url.pathname

  if (path === ROUTE + '/index') {
    const idx = loadIndex()
    if (!idx) return sendJson(res, 200, { ok: false, error: '卡片库还没建：缺 index.json', root: libraryRoot() })
    return sendJson(res, 200, { ok: true, root: libraryRoot(), index: idx })
  }

  if (path === ROUTE + '/card') {
    const kind = url.searchParams.get('kind') || ''
    const id = url.searchParams.get('id') || ''
    const card = loadCard(kind, id)
    if (!card) return sendJson(res, 404, { ok: false, error: '找不到卡片 ' + kind + '/' + id })
    return sendJson(res, 200, { ok: true, card })
  }

  if (path === ROUTE + '/thumb') {
    const kind = url.searchParams.get('kind') || ''
    const id = url.searchParams.get('id') || ''
    if (!/^[\w.-]{1,120}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad id' })
    // 先按卡片自己声明的 thumb 找（画风卡指向 _assets/style_repro/…，其余指向 thumbs/…），
    // 找不到再退回 thumbs/<id>.jpg —— 库里不是每张卡都写全了 thumb。
    let abs = null
    const idx = loadIndex()
    const LIST_KEY = { style: 'styles', character: 'characters', look: 'looks', scene: 'scenes', pose: 'poses', prop: 'props' }
    const listKey = LIST_KEY[kind] || ''
    const entry = listKey ? (idx?.[listKey] || []).find((it) => it && it.id === id) : null
    if (entry && typeof entry.thumb === 'string' && entry.thumb) abs = safeResolve(entry.thumb)
    if (!abs && entry && typeof entry.preview === 'string' && entry.preview) abs = safeResolve(entry.preview)
    if (!abs) {
      const card = loadCard(kind, id)
      // 画风卡把预览图存在 preview 里，其余卡用 thumb —— 两个都认。
      const rel = (card && typeof card.thumb === 'string' && card.thumb)
        || (card && typeof card.preview === 'string' && card.preview)
        || ''
      if (rel) abs = safeResolve(rel)
    }
    if (!abs) abs = safeResolve(`thumbs/${id}.jpg`)
    if (!abs) return sendJson(res, 404, { ok: false, error: 'no thumb' })
    const ext = extname(abs).toLowerCase()
    const buf = readFileSync(abs)
    res.writeHead(200, {
      'content-type': MIME[ext] || 'image/jpeg',
      'cache-control': 'max-age=60',
    })
    return res.end(buf)
  }

  if (path === ROUTE + '/image') {
    const rel = url.searchParams.get('path') || ''
    const abs = safeResolve(rel)
    if (!abs) return sendJson(res, 404, { ok: false, error: 'no image' })
    const ext = extname(abs).toLowerCase()
    const mime = MIME[ext]
    if (!mime) return sendJson(res, 415, { ok: false, error: 'unsupported ' + ext })
    const buf = readFileSync(abs)
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'max-age=60' })
    return res.end(buf)
  }

  if (path === ROUTE + '/compose') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const r = compose(body || {})
    return sendJson(res, 200, Object.assign({ ok: r.ok, missing: r.missing }, r, { text: recipeText(r) }))
  }

  return sendJson(res, 404, { ok: false, error: 'unknown ' + req.method + ' ' + path })
}

// ─────────────────────────────────────────────────────────── 挂载
export function apply(ctx) {
  const root = libraryRoot()
  log(`库根：${root}${existsSync(root) ? '' : '（不存在 —— 面板会显示空态）'}`)

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        if (!sameOriginOk(req)) {
          try { sendJson(res, 403, { ok: false, error: '只接受本机同源请求' }) } catch { /* 忽略 */ }
          return
        }
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (err) {
          try { sendJson(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch { /* 忽略 */ }
        }
      },
    }), 'card-library: 卡片库路由')
    log('路由已挂载 ' + ROUTE)
  } catch (e) {
    log('路由没挂上：' + String(e?.message ?? e))
  }

  // 给模型用的工具：把四类卡拼成配方，返回可直接粘进脚本的 prompt/negative/参数。
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    log('ctx.tools.register 不可用 —— 只提供 UI')
  } else {
    try {
      ctx.tools.register({
        name: 'card_library_compose',
        description: '把卡片库里的画风卡/角色卡/造型卡/环境卡/动作卡/道具卡组合成一份出图配方：返回正向提示词、负面提示词、采样参数与后期参数。用于用户说「用这几张卡出一张图」时。',
        parameters: {
          type: 'object',
          properties: {
            styleId: { type: 'string', description: '画风卡 id，例如 style_wlop_warm_soft' },
            characterId: { type: 'string', description: '角色卡 id，例如 crab_vampire' },
            lookId: { type: 'string', description: '造型卡 id，例如 look_red_hoodie' },
            sceneId: { type: 'string', description: '环境卡 id，例如 sc_convenience_night（纯地点/天气/光线/相机）' },
            poseId: { type: 'string', description: '动作卡 id，例如 pose_sock_change_legup（姿势/动作/表情）' },
            propId: { type: 'string', description: '道具卡 id（单件，兼容老写法）。多选用 propIds' },
            propIds: {
              type: 'array',
              items: { type: 'string' },
              description: '道具卡 id 数组，最多 4 件，例如 ["prop_umbrella","prop_sword"]。握持类会合并成一个 holding 动词',
            },
            view: {
              type: 'object',
              description: '视角：angle=机位方位，gaze=视线方位，shot=景别 0..5，flip=左右镜像。方位取值 front/front_right/right/back_right/back/back_left/left/front_left/above/below',
              properties: {
                angle: { type: 'string' },
                gaze: { type: 'string' },
                shot: { type: 'number' },
                flip: { type: 'boolean' },
              },
              additionalProperties: false,
            },
            includePose: { type: 'boolean', description: '是否把动作带进配方。选了动作卡时默认 true；只有造型卡动作时默认 false' },
            seed: { type: 'number', description: '可选随机种子' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        isConcurrencySafe: () => true,
        execute: (args) => {
          const r = compose(args || {})
          return recipeText(r)
        },
      })
      log('已注册工具 card_library_compose')
    } catch (e) {
      log('工具注册失败：' + String(e?.message ?? e))
    }
  }
}
