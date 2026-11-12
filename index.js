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
import { SAVE_RULES, RULES_VERSION, THUMB_TEMPLATES, CARD_FIELDS, lintCard, lintLibrary, rulesText } from './rules.js'

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
 *   2. 从插件自身位置往上两级推工作区（`<ws>/_dsh_plugin/dsh-card-library` → `<ws>/_assets/cards_library`）
 *      —— 不依赖 process.cwd()，fiber 重载后 cwd 会变，靠 cwd 推会拿到不存在的路径
 *   3. 当前工作区的 `_assets/cards_library` / `cards_library`
 *   4. 随包分发的 `library/`（插件根下）
 * 都没有就返回 (4) —— 接口回空态，不抛异常。
 */
function libraryRoot() {
  if (process.env.CARD_LIBRARY_ROOT) return resolve(process.env.CARD_LIBRARY_ROOT)
  const candidates = []
  // 插件在 <ws>/_dsh_plugin/<pkg>，往上一级是 _dsh_plugin，再上一级是工作区根。
  for (const up of [resolve(PLUGIN_ROOT, '..', '..'), resolve(PLUGIN_ROOT, '..')]) {
    candidates.push(join(up, '_assets', 'cards_library'), join(up, 'cards_library'))
  }
  const cwd = process.cwd()
  // 从当前目录往上找四层：工作区根里常见 `<ws>/_assets/cards_library`。
  let dir = cwd
  for (let i = 0; i < 4; i += 1) {
    candidates.push(join(dir, '_assets', 'cards_library'), join(dir, 'cards_library'), join(dir, 'library'))
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  candidates.push(join(PLUGIN_ROOT, 'library'))
  for (const c of candidates) if (existsSync(c)) return resolve(c)
  return resolve(join(PLUGIN_ROOT, 'library'))
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
 * 闭眼 / 睡着（v13）。
 *
 * 动作卡写 `closed eyes` / `sleeping` / `eyes shut` 时，正向里那些「必须睁着眼才看得见」
 * 的词全部作废：`heterochromia`（异色瞳）、`symbol-shaped pupils`（瞳孔形状）、
 * `catchlight in both eyes`（眼里的高光）、`detailed eyes`。
 *
 * 这些词不但画不出来，还会**反过来把脸拽向镜头** —— 模型为了把它们表达出来，
 * 只能让角色睁眼或者把脸转正，闭眼/睡着的动作当场废掉。
 * 全库 13 张全闭眼动作卡（另有 13 张只写 `half-closed eyes`）× 16 张画风卡。
 *
 * **只认「全闭」**：`half-closed eyes` / `eyes half closed` 眼睛还露着，虹膜看得见，
 * 异色瞳照样成立，动了反而丢信息 —— 那一档故意不管。
 *
 * v24：这句话以前只是注释，正则其实做不到。`half-closed eyes` 里含 `closed eyes` 子串、
 * `\b` 在连字符后照样成立，于是 11 张半闭眼卡全被当成全闭（异色瞳被剥掉）。
 * `sleeping` 也一样：`sleeping kimono`（睡袍）、`sleeping bag`（睡袋）都不是在睡觉。
 * 现在先剔掉这两族再判，`one eye closed`（眨眼，另一只眼还睁着）也归半闭。
 */
const HALF_EYES_RE = /\b(half[- ]closed eyes?|eyes half[- ]closed|one eye closed)\b/gi
const SLEEPING_NOUN_RE = /\bsleeping\s+(?:kimono|robe|bag|mask|wear|dress|gown|shirt|cap|hat|pillow|beauty|suit|vest)\b/gi
const EYES_SHUT_RE = /\b(closed eyes|eyes closed|eyes shut|eye closed|eyes closed tightly|sleeping|asleep)\b/i

function isEyesShut(text) {
  const s = String(text || '')
  if (!s) return false
  const stripped = s.replace(HALF_EYES_RE, ' ').replace(SLEEPING_NOUN_RE, ' ')
  return EYES_SHUT_RE.test(stripped)
}

/**
 * 词级：任何带 eyes / pupils / irises / catchlight / lashes / heterochromia 的标签都算眼睛专属。
 *
 * 判定前先把下划线换成空格 —— 角色卡 `character_segment_closed_eyes` 里存的是
 * `symbol-shaped_pupils` / `heterochromia` 这种带下划线的原始形式，而 `\b` 不认下划线，
 * 直接测会漏掉（实测漏了 symbol-shaped_pupils）。
 */
const EYE_TOKEN_RE = /\b(eyes?|pupils?|irises?|catchlights?|eyelashes|lashes|heterochromia)\b/i

/**
 * v25：眼周特征不是「眼睛专属词」，闭着眼照样成立，必须豁免。
 *
 * `EYE_TOKEN_RE` 的 `eyes?` 是**子串命中**，`mole under eye`（眼下泪痣）与
 * `close-set eyes`（瞳距）都被它吃掉。但这两件东西跟睁不睁眼无关：
 * 痣长在眼睛下方、眼距是颅骨结构。实测（`_probe_r21.mjs`）闭眼时正向里
 * 这两项**整段消失** —— 而它们是 `crab_vampire` 的招牌特征（n5 专门定的瞳距），
 * 等于每次出闭眼 / 睡着的图，小蟹的泪痣和瞳距都丢。
 *
 * 只在 `stripEyeTokens` 里豁免，不动 `EYE_TOKEN_RE` 本身 —— 那个正则还被
 * 「头出画」与别的分支共用，改它会影响别处。
 */
const EYE_AREA_FEATURE_RE = /^(?:mole under eye|close-set eyes|wide-set eyes|eye shadow|eyeshadow|eyebrows?|thick eyebrows?|eyebrow piercing|eyeliner|eye mask|eye patch|eyepatch|under-eye bags?|eye bags?|tear mole|beauty mark under eye)$/i

function stripEyeTokens(seg) {
  if (!seg) return { text: '', dropped: [] }
  const out = []
  const dropped = []
  for (const raw of String(seg).split(',')) {
    const t = raw.trim()
    if (!t) continue
    const norm = t.replace(/_/g, ' ')
    // 眼周特征（痣 / 眼距 / 眼线 / 眼罩 / 眉毛）先豁免，再判眼睛本体
    if (EYE_AREA_FEATURE_RE.test(norm)) {
      out.push(t)
      continue
    }
    if (EYE_TOKEN_RE.test(norm)) {
      dropped.push(t)
      continue
    }
    out.push(t)
  }
  return { text: out.join(', '), dropped }
}

/**
 * 视线词（视角选择器 viewSegments 产出的那一族）：闭眼 / 睡着时一律让位。
 *
 * v20：`looking at viewer, eye contact` 是在要求角色睁眼看镜头；`looking back`
 * 要转头找镜头；`looking up/down` 要眼球转动。闭着眼这些都做不到，模型唯一的
 * 满足方式是把眼睛睁开 —— 于是 v13 辛苦剥掉的眼睛词，又从视角段漏了回来。
 * 实测（`_probe_r16.mjs`）：睡着 + 视角正面 → 正向同时有 `sleeping` 和
 * `looking at viewer, eye contact`；不选视角（对照组）就没有这问题。
 *
 * 只剥「视线」，机位（from front / from behind）与景别（upper body）一个字不动。
 */
const GAZE_ALL_RE = /^(looking at viewer|eye contact|looking back|looking over shoulder|looking back over shoulder|looking ahead|looking forward|looking to the side|looking away|facing away|looking up|looking down)$/i
function stripGazeWords(seg) {
  if (!seg) return { text: '', dropped: [] }
  const out = []
  const dropped = []
  for (const raw of String(seg).split(',')) {
    const t = raw.trim()
    if (!t) continue
    if (GAZE_ALL_RE.test(t)) {
      dropped.push(t)
      continue
    }
    out.push(t)
  }
  return { text: out.join(', '), dropped }
}

/**
 * 角色卡 → 角色提示词段。
 *
 * v4 起角色卡拆成两半：body_segment（身材/肤色/体型）+ feature_segment（种族特征、
 * 头发、眼睛、耳朵、牙、尾巴）。理由：角色卡原来把 blue_fat_fish 的整套女仆装都
 * 塞在 character_segment 里，换个造型就会跟造型卡打架。
 * character_segment 保留（脚本里拼成 body+feature），老卡没有新字段时直接用它。
 */
function characterSegment(character, closedEyes, backView, eyesShut) {
  if (!character) return ''
  if (closedEyes && character.character_segment_closed_eyes) {
    const seg = clean(character.character_segment_closed_eyes)
    return eyesShut ? stripEyeTokens(seg).text : seg
  }
  const body = clean(character.body_segment || '')
  const feature = clean(character.feature_segment || '')
  if (body || feature) {
    const seg = joinSeg(body, feature)
    // 顺序：先按背影剥脸，再按闭眼剥眼睛 —— 两边都不成立时才原样输出。
    const back = backView ? stripFaceOnly(seg) : seg
    return eyesShut ? stripEyeTokens(back).text : back
  }
  const legacy = clean(character.character_segment || '')
  const back = backView ? stripFaceOnly(legacy) : legacy
  return eyesShut ? stripEyeTokens(back).text : back
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
 * 多道具合成（v4 / v10）。
 *
 * 为什么不能简单拼三遍 `holding X, holding Y`：模型看到多个 holding 只会画一个。
 * 正确写法是合并成一个动词 —— `holding umbrella and sword`。
 * 穿戴类（hold=false）不走 holding，直接各自拼。
 *
 * v10：穿戴类道具如果**造型卡已经穿了同一件**，就不能再拼一遍。
 * 实测 `look_painter`（自带 beret）+ `prop_beret`（beret, wearing beret, knitted beret）
 * 拼出来正向里 beret 出现三次 —— 模型会画出三顶帽子叠在一起。全库 23 组这种重复。
 * 同槽位互斥，按「造型卡是底装、道具是追加」的语义，删掉道具那一份并报 autofix。
 *
 * 上限 4 件：超过 4 件模型必然漏画，宁可少选。
 */
const PROP_MAX = 4

const WEAR_PREFIX_RE = /^(wearing|holding)\b/i

function propMainTokens(tags) {
  return clean(tags)
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t && !WEAR_PREFIX_RE.test(t))
}

/**
 * 动词 / 介词开头的短语不是名词，不能拿来当道具名。
 *
 * v17：`prop_mask_oni` 的 tags 是 `mask, fox mask, kitsune mask` —— 想取更具体的
 * 「kitsune mask」。但 `prop_camera` 的 tags 是 `camera, holding camera, looking
 * through camera`，第三个是动作短语；`prop_skateboard` 是 `standing on skateboard`。
 * 全库 9 张卡会被这种短语误取（riding bicycle / rolling dice / eating doughnut /
 * reading newspaper / hugging pillow …），必须挡掉。
 */
const PROP_PHRASE_RE = /^(holding|wearing|eating|drinking|reading|riding|rolling|looking|standing|sitting|hugging|wrapped|with|on|in|at|through|under|by)\b/i

/**
 * 道具卡 → 手持主名词（v17）。
 *
 * 老实现取「第一个非 holding/wearing 的 token」，等于永远取卡里最泛的那个词：
 * `prop_mask_oni` → `mask`（狐面退化成普通面具）、`prop_cake` → `cake`
 * （草莓奶油蛋糕退化成一块蛋糕）。而卡里明明写着更具体的名词。
 *
 * 新规则：在 token 里挑「以主名词结尾、比主名词长、不是动词短语」的最长那个。
 * - `red apple` 以 `apple` 结尾 → 取它（`apple` → `red apple`）
 * - `candlelight` 不以 `candle` 结尾 → 不取（`prop_candle` 保持不变）
 * - `kitsune mask` 以 `mask` 结尾 → 取它，顺带解决 `prop_mask` / `prop_mask_oni`
 *   同时选中时拼出 `holding mask and mask` 的撞车
 *
 * 实测：81 张手持卡里 30 张变具体、9 张被动词规则挡下、提议后主名词全部唯一。
 */
function propMainNoun(tags) {
  const tokens = clean(tags).split(',').map((t) => t.trim()).filter(Boolean)
  const nouns = tokens.filter((t) => !WEAR_PREFIX_RE.test(t))
  const main = (nouns[0] || tokens[0] || '').trim()
  if (!main) return ''
  const mainLower = main.toLowerCase()
  let best = main
  for (const t of nouns) {
    if (t.length <= best.length) continue
    if (PROP_PHRASE_RE.test(t)) continue
    if (!t.toLowerCase().endsWith(mainLower)) continue
    best = t
  }
  return best
}

/**
 * 造型段里是否已经出现了这个名词。
 *
 * 不能只做整串相等 —— `look_flower_field` 写的是 `flower crown`，道具写的是 `crown`，
 * 整串比对会漏（实测王冠就是这么漏过去的）。所以按词边界比：
 * `flower crown` 含 `crown`、`fingerless gloves` 含 `gloves`。
 *
 * 反过来 `earring` 不会被 `ring` 命中（前面是字母不是空格），这个必须靠词边界保。
 */
function lookHasNoun (lookTokens, noun) {
  if (!noun) return false
  const n = noun.toLowerCase().trim()
  if (!n) return false
  for (const t of lookTokens) {
    if (t === n) return true
    if (t.startsWith(n + ' ') || t.endsWith(' ' + n)) return true
    if (t.includes(' ' + n + ' ')) return true
  }
  return false
}

function propsSegment(props, lookText) {
  const list = (props || []).filter(Boolean).slice(0, PROP_MAX)
  if (!list.length) return { text: '', dropped: [] }
  const lookTokens = propMainTokens(lookText || '')
  const held = []
  const worn = []
  const dropped = []
  for (const p of list) {
    const tags = clean(p.prop_tags || '')
    if (!tags) continue
    if (p.hold) {
      // 卡里的 tags 常常是「umbrella, holding umbrella, open umbrella」这种同义堆叠。
      // 多件合并时只能留主名词，否则会拼出 "holding umbrella, holding umbrella,
      // open umbrella and handbag" —— 模型反而一件都画不清。
      //
      // v17：主名词不能取「第一个」，要取卡里最具体的那一个（propMainNoun）。
      // 否则 `prop_mask_oni` 会退化成 `holding mask`，狐面变普通面具。
      held.push(propMainNoun(tags))
    } else {
      const main = propMainTokens(tags)
      if (main.length && main.some((t) => lookHasNoun(lookTokens, t))) {
        dropped.push(p)
        continue
      }
      worn.push(tags)
    }
  }
  const parts = []
  const heldClean = held.filter(Boolean)
  if (heldClean.length === 1) parts.push('holding ' + heldClean[0])
  else if (heldClean.length > 1) parts.push('holding ' + heldClean.join(' and '))
  parts.push(...worn)
  // v27：把「手里拿的那几件的名字」也带出去 —— 负面里有一批造型卡的
  // `holding cup` / `holding book` / `holding bag` 黑名单，要按这些名字去剔。
  return { text: parts.join(', '), dropped, held: heldClean }
}

/**
 * 超上限的警告（v28）：点名被丢掉的是哪几件。
 *
 * 老实现把这条塞在 `propConflicts(propsAll)` 里，只说「选了 5 件道具」，
 * 不说是哪件被丢 —— 用户得自己数。而真正被砍掉的就是 `slice(PROP_MAX)` 之后的那些。
 */
function propOverflow(propsAll) {
  const out = []
  const all = (propsAll || []).filter(Boolean)
  if (all.length <= PROP_MAX) return out
  const lost = all.slice(PROP_MAX)
  const names = lost.map((p) => p.name || p.id).join(' / ')
  out.push(`选了 ${all.length} 件道具 —— 超过 ${PROP_MAX} 件模型必然漏画，建议减到 3 件以内；已按顺序只保留前 ${PROP_MAX} 件，被丢掉的是：${names}`)
  return out
}

/**
 * 多道具的冲突检测（只说真会画坏的那几种）。
 *
 * v28：入参必须是**真正进配方**的那批道具，不是全集。
 * 老实现传 `propsAll`，于是被 v10 `propdup` 撤掉的道具还在参与「同部位叠」检查 ——
 * 实测 `look_painter`（自带 beret）+ `prop_beret`（已撤）+ `prop_crown`，
 * 正向里只剩 `crown`，却仍报「「贝雷帽」和「王冠」都占头部饰品」。
 * 「手里同时拿了 N 件」同理（5 件时报 5，实际只进 4）。
 */
function propConflicts(props) {
  const out = []
  const list = (props || []).filter(Boolean)
  const held = list.filter((p) => p.hold)
  if (held.length > 2) {
    out.push(`手里同时拿了 ${held.length} 件东西 —— 两只手画不下，模型会丢一两件`)
  }
  // 同部位饰品：项链 + 项圈 / 耳饰 + 耳饰
  //
  // v10 修：原来写 `/ring\b|bracelet|.../` —— 少了左边界，`wear**ing**` 里的 ring
  // 被它命中，124 张道具里 33 张被误判成「手部饰品」，于是围巾+王冠也报
  // 「都占手部饰品」。全部改成 `\b...\b`，并用「去掉 wearing/holding 后的主名词」去匹配。
  const SLOT_RE = [
    [/\bnecklace\b|\bchoker\b|\bnecktie\b|\bbowtie\b|\bscarf\b|\bbrooch\b/i, '颈部饰品'],
    [/\bearring/i, '耳饰'],
    [/\bring\b|\bbracelet\b|\bwristwatch\b|\barmlet\b/i, '手部饰品'],
    [/\bcrown\b|\btiara\b|\bhalo\b|\bberet\b|\bbeanie\b|\bheadband\b|\bhairclip\b|\bveil\b/i, '头部饰品'],
    [/\bboots\b|\bslippers\b/i, '鞋'],
  ]
  const seen = new Map()
  for (const p of list) {
    const t = propMainTokens(p.prop_tags || '').join(', ')
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

  // ④ 脸光：这里只决定「要不要脸光、要不要降级」，不提供脸光词本身（n94）
  //
  // 早先这里直接返回一段通用脸光词，compose 又用 `viewSeg.faceLight || 画风卡的脸光`
  // 取值 —— 于是只要选了视角，画风卡自己的 face_light（半张脸沉在阴影 / 网点脸 /
  // 烛光 / 硬阴影）整段被顶掉，换成通用的「脸全亮 + 双眼高光」。
  // 现在改成只产出模式（none / far / normal），词一律由 resolveFaceLight 从画风卡取。
  //
  // 背影机位（back / back_left / back_right）且视线不是「回头」时，脸光必须整段清空 ——
  // 连降级版里的 `face visible` 都会把脸拽回来。实测（W2/W3）：只留降级版，
  // 出来是侧脸；整段清空才是真背影。
  const far = shot.far || camId === 'back' || camId === 'above'
  const isBackCam = camId === 'back' || camId === 'back_left' || camId === 'back_right'
  const isLookBack = gazePos.indexOf('looking back') >= 0
  const faceMode = (isBackCam && !isLookBack) ? 'none' : (far ? 'far' : 'normal')

  return {
    shotFar: shot.far === true,
    backCam: camId === 'back' || camId === 'back_left' || camId === 'back_right',
    // 脸光不进 pos：视角只负责「机位 + 视线 + 景别」这三件方向性的事。
    // 早先把它拼进 pos，等于逼画风卡让位（n94）。
    pos: [cam.pos, gazePos, shot.pos].filter(Boolean).join(', '),
    neg: [cam.neg, gazeNeg].filter(Boolean).join(', '),
    camera: { shot_size: shot.pos, viewpoint: cam.pos },
    notes,
    warnings,
    flip: view.flip === true,
    faceMode,
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
  // dropShot：景别被动作卡接管（v6）。只丢景别，机位/comp/dof 照旧。
  const dropShot = opts && opts.dropShot
  // dropViewpoint：机位被动作卡接管（v7）。只丢机位，景别/comp/dof 照旧。
  const dropViewpoint = opts && opts.dropViewpoint
  // dropFaceFocus：头不在画框里（v9）。只丢「对焦在脸上」那一档 dof，
  // 其余 dof（景深虚化 / deep focus）照旧 —— 那些跟脸没关系。
  const dropFaceFocus = opts && opts.dropFaceFocus
  // dropDof：景深被动作卡接管（v18）。只在「动作卡要虚化、环境卡要深焦」（或反之）时置位，
  // 两边不冲突就共存 —— 环境卡的景深常常是场景本身的性质，能留就留。
  const dropDof = opts && opts.dropDof
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
    if (dropShot && slot === 'shot_size') continue
    if (dropViewpoint && slot === 'viewpoint') continue
    const v = clean(camera[slot])
    if (!v) continue
    if (dropFaceFocus && slot === 'dof' && isFaceFocus(v)) continue
    if (dropDof && slot === 'dof') continue
    // v23：comp 槽里的「画幅词」必须滤掉（portrait / landscape）。
    // 画幅归 v11 的画幅裁决管（aspect → resolution），不该以构图词的身份进正向；
    // 更糟的是 `portrait` 在 shotWordLevel() 里是「特写」档，混进 comp 槽后会和
    // 动作卡的景别（如 cowboy shot）在正向里并存，模型两边都听 → 构图被撕成两半。
    // 实测：15 张环境卡的 comp 是画幅词（portrait 3 / landscape 12），
    // 交叉 238 张有景别的动作卡 = 3570 组。
    if (slot === 'comp') {
      const keptComp = v.split(',').map((t) => t.trim()).filter((t) => t && !COMP_ASPECT_RE.test(t))
      if (!keptComp.length) continue
      parts.push(keptComp.join(', '))
      continue
    }
    parts.push(v)
  }
  const extra = clean(scene.extra)
  if (extra) parts.push(extra)
  const extraCam = clean(scene.extra_camera)
  // 远景补充同理：skipCam / dropShot 时把里面的景别/视角词滤掉，只留场景描述。
  // 早先这里用的是一张手写白名单，漏了 upper body / close-up / cowboy shot，
  // 于是「环境卡近景 × 动作卡全身」还是会在 extra_camera 里残留一份 —— 现在统一走
  // shotWordLevel()，不再手写。
  if (extraCam) {
    if (skipCam || dropShot || dropViewpoint || dropFaceFocus || dropDof) {
      let kept = extraCam.split(',')
        .map((t) => t.trim())
        .filter((t) => t && !(skipCam && /^(from behind|from above|from below|from side|from front)$/i.test(t)))
        .filter((t) => shotWordLevel(t) == null)
      if (dropViewpoint) {
        kept = kept.filter((t) => viewpointSet(t).length === 0)
      }
      if (dropFaceFocus) {
        kept = kept.filter((t) => !isFaceFocus(t))
      }
      if (dropDof) {
        kept = kept.filter((t) => dofFamilies(t).size === 0)
      }
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

const FAR_FACE_LIGHT = 'face visible, face lit by ambient light, soft light on skin, warm light on cheek, no heavy shadow on face'

function faceLightFor(faceLight, scene) {
  if (!faceLight) return ''
  if (!scene) return faceLight
  const camText = [scene.camera && scene.camera.shot_size, scene.camera && scene.camera.viewpoint,
    scene.extra_camera, scene.extra].filter(Boolean).join(', ')
  if (!FAR_SHOT_RE.test(camText)) return faceLight
  // 远景版：只保留「亮」，去掉所有逼迫近景的词
  return FAR_FACE_LIGHT
}

/**
 * 脸光的唯一出口（n94）。
 *
 * 规则：**脸光归画风卡**。视角只管机位 / 视线 / 景别这三件方向性的事，
 * 不再自带一段通用脸光去顶掉画风卡的描述。
 *
 * 早先的写法是 `viewSeg.faceLight || faceLightFor(style.face_light, scene)`，
 * 而 viewSeg.faceLight 恒为非空 —— 结果只要一选视角，画风卡的
 * 「half of face in shadow」「face drawn with halftone dots」「candle light」
 * 全部消失，换成通用的「脸全亮 + 双眼高光」，暗场画风当场废掉。
 *
 * 唯一的例外是远景 / 背影 / 俯拍（faceMode 由 viewSegments 判定）：
 * 那里必须让位给降级版或清空，否则模型强行拉脸部特写（n64 实测）。
 * 这个例外是有意保留的，不是漏改。
 */
function resolveFaceLight(styleFaceLight, scene, viewSeg, headless, eyesShut) {
  const styleFace = styleFaceLight || ''
  // 画面里根本没有头（动作卡写了 head out of frame）—— 任何脸光词都是纯噪音。
  // 「catchlight in both eyes」在一条只拍腿的构图里只会把模型逼出一个头来（n100）。
  if (headless) return ''
  const done = (text) => {
    // 闭眼 / 睡着（v13）：脸光里只有 `catchlight in both eyes` 这类眼睛词作废，
    // 「candle light / half of face in shadow / halftone dots」这些**光照与画法**必须留着
    // —— 那是画风卡的命根子，一起删掉就等于把画风关了。
    if (!eyesShut) return text
    return stripEyeTokens(text).text
  }
  if (!viewSeg || !viewSeg.pos) return done(faceLightFor(styleFace, scene))
  if (viewSeg.faceMode === 'none') return ''
  if (viewSeg.faceMode === 'far') {
    // 远景：脸的像素本来就不够看清光照细节，此时「不逼特写」比「保住画风光照」重要
    return done(styleFace ? FAR_FACE_LIGHT : '')
  }
  // 正常景别：画风卡说什么就是什么；画风卡没写才用通用兜底
  return done(styleFace || 'face fully lit, catchlight in both eyes, gentle highlight on cheek')
}

/**
 * 「头不在画框里」的动作卡（v8）。
 *
 * `head out of frame` 是 danbooru 原生构图标签，库里 25 张近景卡在用它
 * （feet focus / legs focus / ass focus 那一族）。这类卡一旦配上脸光词，
 * 模型会为了画「catchlight in both eyes」硬塞一个头进来，把构图毁掉。
 *
 * 只认显式声明 —— 光有 `legs focus` / `lower body` 不算：那 6 张卡是
 * 「拍腿但头可能入画」的中景，脸光还得留（n100 实测）。
 */
const HEADLESS_RE = /\bhead out of frame\b|\bhead not (?:visible|in frame)\b|\bno head\b|\bheadless\b|\bhead cropped\b/i

function isHeadless(text) {
  return HEADLESS_RE.test(String(text || ''))
}

/**
 * 「对焦在脸上」—— 和 headless 是同一族冲突（v9）。
 *
 * 场景卡的 camera.dof 里写着 `focus on face` 时，等于在要求「把焦点落在脸上」。
 * 头都不在画框里的时候，这条和 `catchlight in both eyes` 一样，只能靠塞一个头进来满足。
 * 全库 6 张场景卡带这个值 × 25 张 headless 动作卡 = 150 组。
 *
 * 只认「对焦在脸」这一档 —— `depth of field, blurry background` / `deep focus`
 * 跟脸没关系，headless 时照样要留。
 */
const FACE_FOCUS_RE = /\bfocus on (?:the )?face\b|\bface focus\b|\bfacial focus\b|\bfocus on (?:her|his) face\b/i

function isFaceFocus(text) {
  return FACE_FOCUS_RE.test(String(text || ''))
}

/* ════════════════════════════════════════════════════════════════
   景深裁决（v18）：动作卡的 camera.dof 从来没进过配方
   ════════════════════════════════════════════════════════════════

   这是 v6（景别）/ v7（机位）/ v11（画幅）之后的第四个同族毛病：
   `poseSegment()` 只返回 pose_tags，动作卡的 camera.dof 一个词都没进过正向。
   全库 23 张动作卡写了 dof（`focus on face` 11 / `depth of field, blurry background` 9 /
   `deep focus` 3），全部静默丢弃；而环境卡的 dof 会照常进 —— 等于环境卡单方面说了算。

   三族里只有「虚化 ⇄ 深焦」是互斥的：
   - 虚化（`depth of field` / `blurry background` / `bokeh`）要背景糊
   - 深焦（`deep focus` / `everything in focus`）要背景清
   - `focus on face` 与它们都不冲突 —— 「对焦在脸 + 背景虚化」是标准电影语法
   所以 `focus on face` 只受 headless 管（v9 同族，只是这次是动作卡自己写的）。
*/
const DOF_SOFT_RE = /\b(depth of field|blurry background|shallow depth of field|bokeh)\b/i
const DOF_DEEP_RE = /\b(deep focus|everything in focus|sharp background)\b/i

/** 把一段 dof 文本归成 {soft, deep, face} 三个族。 */
function dofFamilies(text) {
  const out = new Set()
  for (const t of String(text || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (DOF_SOFT_RE.test(t)) out.add('soft')
    else if (DOF_DEEP_RE.test(t)) out.add('deep')
    else if (isFaceFocus(t)) out.add('face')
  }
  return out
}

/**
 * 动作卡的 dof 要不要进正向、环境卡的 dof 要不要撤。
 *
 * 优先级跟 v6/v7 一致：动作卡说了算（它是在说「这个镜头怎么拍」）。
 * 只有「虚化 ⇄ 深焦」这一对互斥；其余两边共存，joinSeg 自己去重。
 */
function resolveDof(pose, scene, poseSegText, headless) {
  const raw = clean(pose?.camera?.dof || '')
  if (!raw) return { pos: '', sceneDrop: false, conflict: false, dropped: [], poseFams: [], sceneFams: [] }
  const seg = String(poseSegText || '').toLowerCase()
  const kept = []
  const dropped = []
  for (const t of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    // 动作标签里本来就写了这个词 → 不重复加
    if (seg.indexOf(t.toLowerCase()) >= 0) continue
    // 头都不在画框里，还要求「对焦在脸」→ 只能靠塞一个头来满足（v9 同族）
    if (headless && isFaceFocus(t)) { dropped.push(t); continue }
    kept.push(t)
  }
  const poseFams = dofFamilies(kept.join(', '))
  const sceneFams = dofFamilies(clean(scene?.camera?.dof || ''))
  const clash = (poseFams.has('soft') && sceneFams.has('deep')) || (poseFams.has('deep') && sceneFams.has('soft'))
  return {
    pos: kept.join(', '),
    sceneDrop: clash,
    conflict: clash,
    dropped,
    poseFams: [...poseFams],
    sceneFams: [...sceneFams],
  }
}

/* ════════════════════════════════════════════════════════════════
   构图裁决（v18）：动作卡的 camera.comp 同样从来没进过配方
   ════════════════════════════════════════════════════════════════

   32 张动作卡写了 comp，其中：
   - 16 个是**构图词**（`negative space` 14 / `symmetry` 1 / `profile` 1）→ 该进正向
   - 16 个是**画幅词**（`landscape` / `portrait`）→ 那不是构图，是 aspect 的重复声明，
     归 v11 的画幅裁决管（14 张与 aspect 同值；2 张 aspect=both 只有 comp 声明了 portrait，
     恰恰是面部特写卡，丢掉会让竖图变横图）。
*/
const COMP_ASPECT_RE = /^(landscape|portrait)$/i

function resolveComp(pose, poseSegText) {
  const raw = clean(pose?.camera?.comp || '')
  if (!raw) return { pos: '', dropped: [], aspect: '' }
  const seg = String(poseSegText || '').toLowerCase()
  const kept = []
  const dropped = []
  let aspect = ''
  for (const t of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (COMP_ASPECT_RE.test(t)) {
      if (!aspect) aspect = t.toLowerCase()
      dropped.push(t)
      continue
    }
    if (seg.indexOf(t.toLowerCase()) >= 0) continue
    kept.push(t)
  }
  return { pos: kept.join(', '), dropped, aspect }
}

/* ════════════════════════════════════════════════════════════════
   脚上穿不穿（v21）：动作卡说「赤足」，造型卡说「靴子」
   ════════════════════════════════════════════════════════════════

   和 v10（道具重名）/ v19（人数）同一个形状：两张卡在同一个槽位上给了
   互斥值。脚上要么穿鞋要么赤着，没有第三种。

   实测：25 张动作卡写 `bare feet` / `barefoot`，34 张造型卡写具体鞋款
   （`leather boots` / `mary janes` / `pointe shoes` …），交叉 850 组。

   分两档，因为「脚是不是画面主体」决定删错的代价：
   - **脚不是主体**（19 张：`pose_beach_midsummer` / `pose_poolside_summer` /
     `pose_ccc_cowgirl` …，`bare feet` 只是顺带一句）→ 撤掉造型卡的鞋。
     鞋子在这些构图里只是边角，撤掉不会伤画面；留着反而让模型在脚上
     画出一双靴子，把「沙滩赤脚」这个信息毁掉。
   - **脚是主体**（2 张：`pose_near_foot_bare` / `pose_near_nsfw_soles`，
     带 `feet focus` + `head out of frame`）→ **只 warn 不动配方**。
     这种构图里鞋可能是有意为之（穿鞋的特写也有），撤错了整张图就废，
     和 v5 定的分寸一致：没有唯一正确答案的事只提醒。

   反向（造型卡赤足 × 动作卡带鞋，12 组）：动作卡点名的鞋更具体
   （`pose_sock_*` 那一族就是「袜子/鞋」主题卡），造型卡的赤足让位。

   词表必须排除 `sitting on heels`（跪坐坐在脚跟上）—— `heels` 在这里是
   身体部位不是鞋。n102 的 `ring\b` 栽过一次同样的跟头。
 */
const SHOE_WORD_RE = /\b(boots?|shoes?|sneakers?|mary janes|loafers|oxfords|slippers|geta|zouri|uwabaki|sandals|pointe shoes|ballet slippers|cloth shoes|dress shoes|military boots|hiking boots|snow boots|fur boots|wrapped boots|platform shoes|school shoes|high heels|chunky heels|stiletto heels|ankle boots|thigh boots|knee boots|lace-up boots|fur-trimmed boots)\b/i
const BAREFOOT_WORD_RE = /\b(barefoot|bare feet|bare foot)\b/i
const FOOT_FOCUS_RE = /\b(foot focus|feet focus|footjob|soles|curled toes|toes)\b/i

function hasShoe(text) { return SHOE_WORD_RE.test(String(text || '')) }
function hasBarefoot(text) { return BAREFOOT_WORD_RE.test(String(text || '')) }
function isFootFocus(text) { return FOOT_FOCUS_RE.test(String(text || '')) }

/**
 * 返回 { text, dropped, warn }：
 * - text 是剥过鞋的造型段（或原样）
 * - dropped 是被撤掉的词（给 autofix 用）
 * - warn 非空表示「脚是主体，只提醒不动配方」
 */
function resolveFootwear(lookText, pose, poseSegText) {
  const look = String(lookText || '')
  const poseText = String(poseSegText || '')
  const camText = pose && pose.camera ? Object.values(pose.camera).join(', ') : ''
  if (!look) return { text: look, dropped: [], warn: '' }

  const poseBare = hasBarefoot(poseText)
  const lookShoe = hasShoe(look)

  // 方向一：动作卡赤足 × 造型卡带鞋 → 撤鞋
  if (poseBare && lookShoe) {
    const footFocus = isFootFocus(poseText) || isFootFocus(camText) || isFootFocus(pose && pose.id)
    if (footFocus) {
      return {
        text: look,
        dropped: [],
        warn: '动作卡是脚部特写（`feet focus`）且写着赤足，但造型卡配了鞋 —— 两边都可能是你要的（穿鞋的特写也成立），没有替你决定，请自己选一边',
      }
    }
    const kept = []
    const dropped = []
    for (const raw of look.split(',')) {
      const t = raw.trim()
      if (!t) continue
      if (hasShoe(t)) { dropped.push(t); continue }
      kept.push(t)
    }
    return { text: kept.join(', '), dropped, warn: '' }
  }

  // 方向二：造型卡赤足 × 动作卡带鞋 → 撤造型卡的赤足
  if (hasBarefoot(look) && hasShoe(poseText)) {
    const kept = []
    const dropped = []
    for (const raw of look.split(',')) {
      const t = raw.trim()
      if (!t) continue
      if (hasBarefoot(t)) { dropped.push(t); continue }
      kept.push(t)
    }
    return { text: kept.join(', '), dropped, warn: '' }
  }

  return { text: look, dropped: [], warn: '' }
}

/**
 * 整套装束让位（v22）。
 *
 * 动作卡的 `pose_tags` 里偶尔会带一整套装束词 —— `nurse` / `office lady` /
 * `serafuku` / `maid` / `miko` / `yukata`，那是当初从「某套衣服 + 某个动作」的
 * 组合里拆卡时没拆干净的残留（DESIGN_v4 规定「穿什么」只归造型卡）。
 *
 * 造型卡有装束时，动作卡那份就是在说第二套衣服：
 * - `pose_nurse_rounds`（nurse）× `look_military`（military uniform）
 *   → 正向同时有军装与护士，模型把白大褂糊在军装外面
 * - `pose_jk_bike_ride`（serafuku）× `look_qipao`（qipao）
 *   → 水手服领子长在旗袍上
 *
 * 全库 17 张动作卡带装束族 × 17 张造型卡带装束族 = 289 组，其中**跨族 248 组**。
 * 同族（`pose_pose_shrine_kneel` 的 miko × `look_summer_festival` 的 yukata）不撤 ——
 * 巫女穿浴衣是成立的，那是同一套和服的两种说法。
 *
 * 造型卡没有任何装束族时（33 张，`look_alchemist` / `look_cyberpunk` …）
 * 动作卡那份**必须留着** —— 那时它是唯一的衣服线索（`pose_nurse_rounds` 配冒险者
 * 会真的画出护士装，这是用户可能想要的）。
 *
 * 只撤「装束 token」，同一个 token 里的其它信息（`leg up, embarrassed, blush`）不动。
 */
const OUTFIT_FAMILIES = [
  { label: '护士', re: /\b(nurse|nurse uniform|nurse cap)\b/i },
  { label: '学校', re: /\b(serafuku|sailor uniform|school uniform|gym uniform|buruma|sukumizu|blazer uniform|jk uniform)\b/i },
  { label: '女仆', re: /\b(maid|maid outfit|maid dress|maid headdress)\b/i },
  { label: 'OL', re: /\b(office lady|business suit|blazer suit|office uniform|pencil skirt)\b/i },
  { label: '军警', re: /\b(military uniform|police uniform|policewoman|army uniform)\b/i },
  { label: '和服', re: /\b(kimono|yukata|miko|hakama|japanese clothes|sleeping kimono)\b/i },
  { label: '泳装', re: /\b(swimsuit|bikini|one-piece swimsuit|school swimsuit)\b/i },
  { label: '睡衣', re: /\b(pajamas|nightgown|negligee|sleepwear)\b/i },
  { label: '舞者', re: /\b(leotard|ballet outfit|tutu)\b/i },
  { label: '运动', re: /\b(track suit|racing suit|jersey|sports uniform)\b/i },
  { label: '礼服', re: /\b(wedding dress|evening gown|ball gown)\b/i },
  { label: '中式', re: /\b(qipao|cheongsam|hanfu)\b/i },
  { label: '服务', re: /\b(flight attendant uniform|waitress|bunny girl|cheerleader|idol costume)\b/i },
]

function outfitFamiliesOf(text) {
  const out = new Set()
  for (const raw of String(text || '').split(',')) {
    const t = raw.trim()
    if (!t) continue
    for (const fam of OUTFIT_FAMILIES) if (fam.re.test(t)) out.add(fam.label)
  }
  return out
}

/**
 * 返回 { text, dropped, families, keptFamilies }：
 * - text 是剥过跨族装束的动作段（或原样）
 * - dropped 是被撤掉的 token
 * - families / keptFamilies 给 autofix 与 warning 用
 */
function resolveOutfit(lookText, poseSegText) {
  const poseText = String(poseSegText || '')
  const lookFams = outfitFamiliesOf(lookText)
  if (!poseText || !lookFams.size) return { text: poseText, dropped: [], families: [], keptFamilies: [...lookFams] }

  const kept = []
  const dropped = []
  const families = []
  for (const raw of poseText.split(',')) {
    const t = raw.trim()
    if (!t) continue
    const fams = [...outfitFamiliesOf(t)]
    if (!fams.length) { kept.push(t); continue }
    // 同族（造型卡已经有这一族）→ 撤；跨族 → 也撤（造型卡才是权威）
    // 唯一保留的情况：造型卡没有任何装束族（上面已 return）
    dropped.push(t)
    for (const f of fams) if (families.indexOf(f) < 0) families.push(f)
  }
  if (!dropped.length) return { text: poseText, dropped: [], families: [], keptFamilies: [...lookFams] }
  return { text: kept.join(', '), dropped, families, keptFamilies: [...lookFams] }
}

/**
 * 「穿好衣服」防护词让位（v26）—— v5 只管负面那一半，这一半从来没管过。
 *
 * 4 张造型卡（`look_bell_watcher` / `look_elven_priestess` / `look_night_reader` /
 * `look_tomb_raider`）的 **look_tags（正向）** 里写着 `fully clothed, wearing clothes,
 * covered chest, covered torso`。它们来自「奇幻造型别走光」那套防护（n38/n39），
 * 单人正常姿势下是对的。
 *
 * 但一旦配上要裸露 / 露肤的动作卡，正向里就同时出现「穿好衣服」与「completely nude」：
 * 实测 `look_tomb_raider × pose_ccc_anal` → 正向 = `fully clothed, wearing clothes,
 * covered chest, covered torso … completely nude`，autofix 只报了 `nude`（那是 v5 在
 * 剔**负面**里的 nude），正向这一对没人管。模型只能在「穿」和「不穿」之间瞎猜。
 *
 * 影响面（按槽位）：胸部 4×18=72、腰腹 4×5=20、全身 4×69=276，合计 368 组。
 *
 * 分寸：只撤「防护词」，服装本体（hooded cloak / armored bodysuit）一个字不动 ——
 * 半脱、敞开、露肩都还要靠这些衣服画出来。造型卡自己同时写防护与露肤时不动
 * （那是卡内自相矛盾，不是跨卡冲突）。
 */
const COVER_GUARD_SLOTS = [
  {
    label: '胸部',
    guard: /^(covered chest|covered breasts?|covered nipples|modest chest)$/i,
    trigger: /\b(cleavage|bare chest|exposed chest|topless|see-through|sheer|nipple slip|breasts? out|open shirt|unbuttoned|deep neckline|plunging neckline|sideboob|underboob|wet clothes|soaked clothes|nude with accessories only)\b/i,
  },
  {
    label: '腰腹',
    guard: /^(covered torso|covered navel|covered midriff)$/i,
    trigger: /\b(midriff|navel|bare midriff|shirt lift|clothes pull|midriff peek)\b/i,
  },
  {
    label: '下体',
    guard: /^(covered crotch|covered groin|covered pussy)$/i,
    trigger: /\b(bottomless|no panties|panties aside|completely nude|nude with accessories only|bare crotch|skirt pull)\b/i,
  },
  {
    label: '全身',
    guard: /^(fully clothed|wearing clothes|clothed|dressed)$/i,
    trigger: /\b(nude|naked|bottomless|topless|no panties|completely nude|nude with accessories only|see-through|sheer|open shirt|unbuttoned|shirt lift|clothes pull|panties aside|skirt pull|cleavage|bare chest|bare shoulders?|off shoulder|strapless|tube top|nipple slip|lingerie|underwear|bikini|swimsuit|leotard|wet clothes|soaked clothes|midriff peek)\b/i,
  },
]

function resolveCoverGuard(lookText, actText) {
  const look = String(lookText || '')
  const act = String(actText || '')
  if (!look || !act) return { text: look, dropped: [], slots: [] }
  // 全裸 / 全透明是「所有槽位都露」—— 必须让四个槽一起生效，否则会出现
  // 「completely nude 撤了 fully clothed，却留着 covered chest」这种半吊子结果。
  const ALL_SLOTS_RE = /\b(completely nude|nude with accessories only|naked|nude|see-through|sheer)\b/i
  const active = ALL_SLOTS_RE.test(act)
    ? COVER_GUARD_SLOTS
    : COVER_GUARD_SLOTS.filter((s) => s.trigger.test(act))
  if (!active.length) return { text: look, dropped: [], slots: [] }
  const kept = []
  const dropped = []
  const slots = []
  for (const raw of look.split(',')) {
    const t = raw.trim()
    if (!t) continue
    const hit = active.filter((s) => s.guard.test(t))
    if (hit.length) {
      dropped.push(t)
      for (const s of hit) if (slots.indexOf(s.label) < 0) slots.push(s.label)
      continue
    }
    kept.push(t)
  }
  if (!dropped.length) return { text: look, dropped: [], slots: [] }
  return { text: kept.join(', '), dropped, slots }
}

/**
 * 「画面里没有场景」—— 和 headless / 对焦脸是同一族冲突（v14）。
 *
 * 六张画风卡的 render 里写着 `simple background` / `white background` /
 * `empty background` / `pale gradient background`，那是「没有环境卡时别乱加背景」用的。
 * 一旦选了环境卡（全库 140 张全部带 `tags.place`），这两段就是在互相拆台：
 * 场景段要森林 / 街道 / 教室，render 段同时要求「空背景、白底」。
 *
 * 实测（`_probe_bg2.mjs` 8 画风 × 6 场景 = 48 组）：28 组里正向同时出现
 * 具体场景词与字面空白词。影响面 6 张画风卡 × 140 张环境卡 = 840 组。
 *
 * 只删「字面空白」这一族。`negative space` 是**构图留白**（天野喜孝那档的命根子），
 * 和「背景是什么」无关，一个字不动。
 */
const BLANK_BG_RE = /\b(?:white background|simple background|plain background|empty background|solid background|blank background|pale background|pale pink background|pale gradient background)\b/gi

function stripBlankBg(seg) {
  if (!seg) return { text: '', dropped: [] }
  const dropped = []
  const out = []
  for (const raw of String(seg).split(',')) {
    const t = raw.trim()
    if (!t) continue
    BLANK_BG_RE.lastIndex = 0
    if (BLANK_BG_RE.test(t)) { dropped.push(t); continue }
    out.push(t)
  }
  return { text: out.join(', '), dropped }
}

/**
 * 环境卡到底要不要背景？有 `tags.place` 就算要（全库 140 张都有）。
 * 没选环境卡时返回 false —— 那时候画风卡写白底是对的，不该动。
 */
function sceneWantsBackground(scene) {
  if (!scene) return false
  const place = clean((scene.tags && scene.tags.place) || '')
  return !!place
}

/**
 * 画风卡 render 段里的「具体地点」（v15）—— v14 只处理了「字面空白」那一族，
 * 但 render 里还有另一种背景声明：**写死一个地点**。
 *
 * 全库只有 `style_retro90_cel` 一张：`… sepia tint, aged film, city street,
 * telephone pole, evening, detailed background`。它是 90 年代 OVA 的街景设定，
 * 配街景环境卡时是对的，配卧室 / 浴室 / 海滩时就变成「一边说在卧室、
 * 一边说在街上」。影响面 1 张画风卡 × 130 张非街景环境卡。
 *
 * 和 v14 的区别与分寸：
 * - v14 撤的是「不要背景」，v15 撤的是「背景在别处」—— 同一族的另一半。
 * - **只撤地点词**（city street / telephone pole 这类可指认的地点与街景元素）。
 * - `detailed background` 是**密度词**（`style_manga_ink_v1` 靠它保住信息量），
 *   不是地点，一个字不动 —— 这是本版最容易搞错的地方。
 * - `evening` 这类时间/光词不在这里撤：晚上在卧室并不矛盾，交给 warning 提醒。
 */
const STYLE_PLACE_RE = /\b(?:city street|cityscape|street|alley|telephone pole|power line|rooftop|forest|classroom|bedroom|bathroom|kitchen|cafe|office|beach|flower field|meadow|ruins|shrine|temple|station|train interior|car interior|landscape)\b/gi

/**
 * 环境卡的 place 和这个地点词对不对得上？
 * 双向包含：`street` 认 `city street`，`flower field` 认 `field`。
 * 另外认「同族」：`telephone pole` / `power line` 属于街景，环境卡是 street /
 * alley / crosswalk 时不该被当成「另一个地方」撤掉 —— 它们是街景的构件，
 * 不是别的地点（v15 第一版把电线杆当成冲突撤了，`_probe_v15.mjs` ②组测出）。
 */
const PLACE_FAMILY = {
  'telephone pole': ['street', 'city street', 'alley', 'crosswalk', 'bridge', 'rooftop'],
  'power line': ['street', 'city street', 'alley', 'crosswalk', 'bridge', 'rooftop'],
  street: ['alley', 'crosswalk', 'city street'],
  alley: ['street', 'city street', 'crosswalk'],
  crosswalk: ['street', 'city street', 'alley'],
}

function placeMatchesScene(word, place) {
  const w = String(word || '').toLowerCase().trim()
  const p = String(place || '').toLowerCase().trim()
  if (!w || !p) return false
  if (p === w || p.includes(w) || w.includes(p)) return true
  const fam = PLACE_FAMILY[w]
  if (fam && fam.some((f) => p === f || p.includes(f) || f.includes(p))) return true
  return false
}

/**
 * 撤掉 render 段里与环境卡冲突的地点词。
 * 返回 { text, dropped }，dropped 是真正被撤掉的原文片段（报 autofix 用）。
 */
function stripStylePlace(seg, place) {
  if (!seg || !place) return { text: String(seg || ''), dropped: [] }
  const dropped = []
  const out = []
  for (const raw of String(seg).split(',')) {
    const t = raw.trim()
    if (!t) continue
    STYLE_PLACE_RE.lastIndex = 0
    const m = t.match(STYLE_PLACE_RE)
    if (m && !m.some((w) => placeMatchesScene(w, place))) {
      dropped.push(t)
      continue
    }
    out.push(t)
  }
  return { text: out.join(', '), dropped }
}

/**
 * 配方自检：把「选出来的卡互相打架」这件事在生成前就说清楚。
 * 这些都是实测踩过的（n58–n61、卡片库天台那轮、环境/动作拆分那轮）。
 */
function buildWarnings(scene, style, look, pose, usePose, props, viewSeg, viewFix) {
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
  //
  // 这里原来有一条「没勾带动作就没有 holding 动词」的警告 —— 是假的：
  // propsSegment() 无论 usePose 都会补 holding，实测 prop_uchiwa + includePose:false
  // 出来的正向照样是 `holding uchiwa`。删掉，别再骗人。
  const held = list.filter((p) => p.hold)
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
  // 机位冲突（v7）：特殊机位（pov / fisheye / dutch angle / bird's eye …）不自动裁决，
  // 只在这里提醒 —— 环境卡的 bird's eye view 常常是场景本身的性质（从楼上往下拍），
  // 自动删掉会把场景毁掉；机器分不出「场景性质」和「卡片冲突」，交给人。
  if (viewFix && viewFix.special && viewFix.special.length) {
    const s = viewFix.special.join(' / ')
    out.push(`机位里有特殊手法「${s}」—— 这类机位和环境卡/动作卡耦合很紧，不会自动裁决，请自己确认要不要保留`)
  }
  if (FAR_SHOT_RE.test(camText) && style?.face_light) {
    out.push('远景场景：脸部补光已降级，否则模型会强行拉成脸部特写')
  }
  if (/from behind/i.test(camText)) {
    out.push('背影视角会吃掉异色瞳 —— 想露脸就把视角换成 from side / three-quarter view')
  }
  return out
}

/* ════════════════════════════════════════════════════════════════
   冲突自动处理（v5）
   ════════════════════════════════════════════════════════════════
   冲突分两种，处理方式完全不同：

     auto —— 机械可判、修了不会更糟。直接改配方，并把「改了什么」报出来。
             典型：画风卡的负面里写着 `nude`，造型卡却声明了 bottomless；
             动作卡自己同时写着 `looking at viewer` 和 `looking back`。

     warn —— 没有唯一正确答案，猜错比不猜更糟。只提醒，绝不动配方。
             典型：手里拿了 4 件东西（该丢哪件？）、动作卡原本在床边现在配街边。

   为什么 warn 不自动修：自动修意味着替用户做审美判断。前面 n85/n93 那些教训
   已经说明，模型对「删词」的响应远非线性 —— 删错一个词整张图就废了。
   所以只自动修「同一个槽位出现两个互斥值」这类不可能两全的情况。
*/

/** 造型卡正向里出现这些词 = 它要裸露。 */
const NUDE_POS_RE = /\b(nude|naked|bottomless|topless|no panties|completely nude|bare crotch)\b/i

/**
 * 画风卡负面里这些词会压死裸露。
 *
 * n85 实测：明亮全彩画风卡的负面写了 `nude, naked`，配 bottomless 造型卡出图时
 * 人物莫名穿好衣服 —— 而且 minusPositive 剔不掉，因为造型卡写的是
 * `bottomless, no panties`，跟 `nude` 不是同一个词。
 * 所以这里按「语义槽位」剔，不按字面剔。
 *
 * 两头都要放宽：`blue panties` / `white panties` 前面带颜色，`underwear only`
 * 后面带 only —— 严格的 `^...$` 整词匹配会把它们全漏掉，实测 amano + 床上裸
 * 就残留了这两个。
 */
const NUDE_NEG_RE = /^(?:[a-z]+\s+)?(nude|naked|topless|bottomless|nipples?|areola|cleavage|deep cleavage|sideboob|underboob|exposed (?:chest|breasts?)|bare (?:chest|shoulders?|breasts?)|covered (?:crotch|groin|ass|pussy)|clothing|clothed|partially clothed|underwear|panties|bikini bottom|swimsuit|thong)(?:\s+only)?$/i

/**
 * 露肤让位：造型卡自己声明了「露」，画风卡负面里逼着「遮」的词就得让位。
 *
 * 和裸露那条不是一回事。裸露是「一件不穿」，这里说的是「穿了但要露」——
 * 吊带、露肩、低胸、开襟、连体紧身衣、比基尼、浴巾。
 *
 * 实测（shadowverse 负面最狠，24 个压制词）：`look_ballet` 的 leotard、
 * `look_tomb_raider` 的 bodysuit、`look_tribal_hunter` 的 bikini、`nsfw_towel_slip`
 * 的 bare shoulders，全被 `bare shoulders / open shirt / cleavage` 压成高领长袖。
 *
 * 注意只剔「遮」的那一批，`nipples / areola / topless / nude` 不剔 ——
 * 那些是防意外裸体的，造型卡没说要裸就得留着。
 */
const REVEAL_POS_RE = /\b(cleavage|bare shoulders?|bare chest|off shoulder|strapless|tube top|low cut|deep neckline|plunging neckline|open shirt|unbuttoned|open robe|open collar|see-through|sheer|no bra|lingerie|underwear|bikini|swimsuit|leotard|bodysuit|sports bra|camisole|slip dress)\b/i

const COVER_NEG_RE = /^(open shirt|unbuttoned shirt|open robe|undone clothes|open collar|bare shoulders?|off shoulder|strapless|tube top|chest window|collarbone window|exposed chest|exposed breasts|breasts out|cleavage|deep cleavage|low cut|deep neckline|plunging neckline|sideboob|underboob)$/i

/**
 * 环境卡说了什么光，画风卡负面里压这种光的词就得让位。
 *
 * 同一个道理：`neon colors` 与 `neon lights` 不是同一个词，minusPositive 剔不掉，
 * 但模型读到负面里的 neon 就会把霓虹压掉 —— 夜景卡选了个「禁霓虹」的画风，
 * 出来一片死黑。
 */
const LIGHT_RULES = [
  {
    label: '夜景',
    scene: /\b(night|midnight|nighttime)\b/i,
    drop: /^(night|dark background|black background|dark navy background|dark image|dark photo|underexposed|low key lighting)$/i,
  },
  {
    label: '霓虹',
    scene: /\b(neon lights?|neon signs?|lantern|festival lights|illuminated)\b/i,
    drop: /^(neon|neon colors|neon pink|hot pink|magenta|vivid cyan|electric blue|fluorescent|neon laser)$/i,
  },
  {
    label: '暖光',
    scene: /\b(sunset|golden hour|dusk|warm light|sunrise)\b/i,
    drop: /^(blue tint|cold color cast|cyan lighting|blue dominant|teal and orange|cyan skin)$/i,
  },
]

/**
 * 画法族（v12）：同一族里的词指向同一种画法。
 *
 * 造型卡的 negative_extra 是历史遗留 —— 19 张「柔光半写实 (基准)」卡共用同一段
 * 样板负面，开头 12 词一字不差：`… cel shading, flat colors, painterly, 3d render …`
 * 这段是给柔光厚涂配的（那时候只有一档画风），可一旦换上赛璐璐 / 平涂 / 水彩画风卡，
 * 负面里这几个词就等于「不要你这种画法」。
 *
 * 为什么 minusPositive 救不了：它只按整串包含剔。负面 `flat colors` 与正向
 * `flat color areas` 差一个 s，剔不掉；负面 `painterly` 碰上正向 `painterly rendering`
 * 才碰巧命中。实测 38 组合里只有 2 个冲突对会被它处理。
 *
 * 判定原则（关键）：**只有画风卡自己主张的族才剔**。
 * 画风卡正向里没有的那一族，负面留着是对的 —— `style_shadowverse_crisp`
 * 正向写 `cel shading` 却把 `flat colors` 写进自己的负面，意思是「要赛璐璐的
 * 分色、但不要平涂」，这是它刻意的取舍，不能碰。
 * 所以：只剔造型卡那一侧的负面，且只剔画风卡主张的族。
 */
const MEDIUM_FAMILIES = [
  { label: '赛璐璐', words: ['cel shading', 'cel shaded', 'anime cel', 'cel style', 'cel coloring', 'cel outline'] },
  { label: '平涂', words: ['flat colors', 'flat color', 'flat color areas', 'crisp flat colors', 'flat colouring', 'flat color with soft airbrush'] },
  { label: '厚涂', words: ['painterly', 'painterly rendering', 'painterly style', 'painted look', 'brush strokes', 'visible brush strokes', 'brushwork', 'visible brushwork', 'impasto', 'thick paint'] },
  { label: '线稿', words: ['lineart', 'line art', 'thin lineart', 'crisp lineart', 'colored lineart', 'thin sharp lineart', 'clean lineart', 'black lineart', 'fine ink lineart'] },
  { label: '水彩', words: ['watercolor', 'watercolor (medium)', 'wet on wet', 'color bleeding', 'gouache'] },
  { label: '半调', words: ['halftone', 'halftone dots', 'screentone', 'screen print', 'silkscreen print'] },
  { label: '版画', words: ['ukiyo-e', 'woodblock print', 'woodcut'] },
  { label: '渐变', words: ['gradient', 'pastel gradient', 'color gradient', 'gradient shading'] },
]

/** 这个词属于哪个画法族（精确 token 匹配，不做包含）。 */
function mediumFamilyOf(token) {
  const t = String(token || '').trim().toLowerCase()
  if (!t) return null
  for (const fam of MEDIUM_FAMILIES) if (fam.words.indexOf(t) >= 0) return fam
  return null
}

/** 画风卡主张了哪些画法族（正向任一变体出现即算主张）。 */
function mediumFamiliesClaimed(style) {
  const pos = [style?.artist_segment, style?.render, style?.face_light, style?.quality_prefix]
    .filter(Boolean).join(', ').toLowerCase()
  const out = new Set()
  if (!pos) return out
  for (const fam of MEDIUM_FAMILIES) {
    if (fam.words.some((w) => pos.indexOf(w) >= 0)) out.add(fam.label)
  }
  return out
}

/**
 * 剔掉造型卡负面里「压制画风卡主张画法」的裸词。返回 { kept, dropped, families }。
 * 只喂造型卡自己的 negative_extra —— 画风卡的负面是它自己的取舍，一律不动。
 */
function dropMediumConflicts(negSeg, style) {
  const claimed = mediumFamiliesClaimed(style)
  if (!claimed.size) return { kept: String(negSeg || ''), dropped: [], families: [] }
  const families = []
  const r = dropNegativeSlots(negSeg, (t) => {
    const fam = mediumFamilyOf(t)
    if (!fam || !claimed.has(fam.label)) return false
    if (families.indexOf(fam.label) < 0) families.push(fam.label)
    return true
  })
  return { kept: r.kept, dropped: r.dropped, families }
}

/** 视线词分两组：看镜头 / 回头。同一张动作卡里两组并存 = 互斥。 */const GAZE_VIEWER_RE = /^(looking at viewer|eye contact)$/i
const GAZE_BACK_RE = /^(looking back|looking over shoulder|looking back over shoulder)$/i

/**
 * 动作卡内部视线矛盾 → 按机位裁决。
 *
 * 实测两张卡中招：`pose_from_school_rooftop_wave`（looking at viewer + looking back）、
 * `pose_postman`（同样两个，但 camera 写了 from behind）。
 * 规则：机位在背后就留「回头」，否则留「看镜头」—— 因为 from behind + 看镜头
 * 是模型唯一无法同时满足的组合，它会牺牲机位去画脸。
 */
function dedupePoseGaze(poseTags, viewpoint) {
  const text = clean(poseTags)
  if (!text) return { text: '', dropped: [] }
  const toks = text.split(',').map((t) => t.trim()).filter(Boolean)
  const hasViewer = toks.some((t) => GAZE_VIEWER_RE.test(t))
  const hasBack = toks.some((t) => GAZE_BACK_RE.test(t))
  if (!hasViewer || !hasBack) return { text, dropped: [] }
  const keepBack = /from behind/i.test(clean(viewpoint))
  const kill = keepBack ? GAZE_VIEWER_RE : GAZE_BACK_RE
  const dropped = toks.filter((t) => kill.test(t))
  const kept = toks.filter((t) => !kill.test(t))
  return { text: kept.join(', '), dropped }
}

/* ════════════════════════════════════════════════════════════════
   景别裁决（v6）
   ════════════════════════════════════════════════════════════════
   动作卡的 camera.shot_size 一直被静默丢掉 —— poseSegment() 只返回 pose_tags，
   景别词一个都进不了正向。于是「动作卡要全身（standing, jumping）＋ 环境卡写 upper body」
   拼出来的正向里只有 upper body：动作被截掉半截，而且不报任何错。

   全库统计：环境卡带近景 17 张 × 动作卡带中远景 160 张 = 2720 组会中招。

   优先级和视角系统保持一致：**视角 > 动作卡 > 环境卡**。
   理由：视角是用户当场选的；动作卡是显式选的，而且景别是「动作画不画得出来」的
   必要条件；环境卡的 shot_size 只是「这张场景通常怎么拍」，属于默认值。

   只接管景别，不接管机位 —— 动作卡里 `full body / from side` 的 from side 部分
   仍然丢掉，机位归环境卡和视角管。
   ════════════════════════════════════════════════════════════════ */
const SHOT_WORDS = [
  { re: /^wide shot$/i, level: 5 },
  { re: /^small figure$/i, level: 5 },
  { re: /^full body$/i, level: 4 },
  { re: /^cowboy shot$/i, level: 3 },
  { re: /^upper body$/i, level: 2 },
  { re: /^(close-up|portrait|bust shot)$/i, level: 1 },
  { re: /^(extreme close-up|very close-up)$/i, level: 0 },
]

const SHOT_CN = ['大特写', '特写', '上半身', '七分身', '全身', '远景']

/** 档位 → 代表词（做远景判定用，别从正则里反向抠字符串）。 */
const SHOT_REP_BY_LEVEL = {
  5: 'wide shot',
  4: 'full body',
  3: 'cowboy shot',
  2: 'upper body',
  1: 'close-up',
  0: 'extreme close-up',
}

/** 按 / 和逗号拆开 —— 卡里的 shot_size 写成 `full body / from side` 这种复合值。 */
function shotTokens(text) {
  return String(text || '').split(/[/,]/).map((t) => t.trim()).filter(Boolean)
}

function shotWordLevel(tok) {
  for (const w of SHOT_WORDS) if (w.re.test(tok)) return w.level
  return null
}

/** 取最宽的那一档：`wide shot / full body / small figure` 应该算远景。 */
function shotLevel(text) {
  let best = null
  for (const t of shotTokens(text)) {
    const lv = shotWordLevel(t)
    if (lv == null) continue
    if (best == null || lv > best) best = lv
  }
  return best
}

function shotWords(text) {
  const out = []
  for (const t of shotTokens(text)) {
    if (shotWordLevel(t) == null) continue
    if (out.indexOf(t) < 0) out.push(t)
  }
  return out
}

/** 从一段提示词里剔掉景别词（环境卡的 extra_camera 会混进来）。 */
function stripShotWords(seg) {
  if (!seg) return ''
  const out = []
  for (const raw of String(seg).split(',')) {
    const t = raw.trim()
    if (!t) continue
    if (shotWordLevel(t) != null) continue
    out.push(t)
  }
  return out.join(', ')
}

/**
 * 景别裁决（v6）：视角 > 动作卡 > 环境卡。
 *
 * 返回 { pos, level, source, sceneDrop, conflict }
 *   pos       —— 要补进正向的景别词（可能为空）
 *   sceneDrop —— 环境卡的 shot_size 是否要让位
 *   conflict  —— 动作卡与环境卡景别不一致（用于 autofix 文案）
 *
 * 只在「没选视角」时调用：选了视角，景别已经由视角段决定，环境卡早就不出 shot_size。
 */
function resolveShotSize(pose, scene, poseSegText) {
  const poseShot = clean(pose?.camera?.shot_size || '')
  const sceneShot = clean(scene?.camera?.shot_size || '')
  // 有 14 张老动作卡把景别写在 pose_tags 里、camera.shot_size 是空的
  // （pose_ballet 的 full body、pose_detective 的 cowboy shot …）。
  // 那些词本来就会经 poseSegment 进正向，所以这里也要认，否则冲突检测看不见它们。
  const poseLv = shotLevel(poseShot) != null ? shotLevel(poseShot) : shotLevel(poseSegText)
  const sceneLv = shotLevel(sceneShot)
  if (poseLv == null) {
    return { pos: '', level: sceneLv, source: sceneLv == null ? 'none' : 'scene', sceneDrop: false, conflict: false }
  }
  const conflict = sceneLv != null && sceneLv !== poseLv
  const words = shotWords(poseShot)
  return {
    pos: words.join(', '),
    level: poseLv,
    source: 'pose',
    sceneDrop: true,
    conflict,
    poseLevel: poseLv,
    sceneLevel: sceneLv,
  }
}

/* ════════════════════════════════════════════════════════════════
   机位裁决（v7）：视角 > 动作卡 > 环境卡
   ════════════════════════════════════════════════════════════════

   v6 只修了景别。机位（camera.viewpoint）有一模一样的毛病：
   `poseSegment()` 只返回 pose_tags，动作卡的 camera.viewpoint 从来没进过正向。
   全库 240 张动作卡有 viewpoint，其中只有 21 张把词也写进了 pose_tags ——
   另外 219 张的机位是**静默丢弃**的（`pose_balcony_laundry` 的 bird's eye view、
   `pose_cam_dutch_wall` 的 dutch angle、`pose_cam_low_stretch` 的 from below …）。
   动作卡 × 环境卡交叉 25833 组，机位互斥 19685 组（76.2%）。

   但机位比景别危险得多，所以裁决分两档：

   · **基础机位**（from front / from side / from behind / from above / from below）
     —— 自动裁决，动作卡说了算，环境卡让位。
     理由：这类机位和姿势是耦合的（`from below` 的姿势换 `from above` 会变形），
     动作卡是用户显式选的、并且是照着它出的图，所以以它为准。

   · **特殊机位**（pov / fisheye / dutch angle / bird's eye / worm's eye /
     over-the-shoulder / foreshortening / panorama）—— **只 warn，不动配方**。
     理由：这类机位是「摄影手法」而不是「从哪边看」，环境卡的
     `bird's eye view` 常常就是场景本身的性质（从楼上往下拍），
     自动删掉会把场景整个毁掉。机器分不出「场景性质」和「卡片冲突」，交给人。
   ════════════════════════════════════════════════════════════════ */

/** 基础机位：可自动裁决的那一档。key 是归一化后的方位，值是代表词。 */
const VIEWPOINT_BASE = [
  { id: 'front', re: /^from front$|^straight-on$|^facing viewer$/i, cn: '正面' },
  { id: 'side', re: /^from side$|^profile$|^side view$/i, cn: '侧面' },
  { id: 'behind', re: /^from behind$|^back view$|^seen from behind$/i, cn: '背面' },
  { id: 'above', re: /^from above$|^high angle$|^overhead$/i, cn: '俯拍' },
  { id: 'below', re: /^from below$|^low angle$|^from down below$/i, cn: '仰拍' },
]

/** 特殊机位：只 warn。命中即视为「摄影手法」，不参与自动让位。 */
const VIEWPOINT_SPECIAL_RE = /\bpov\b|first-person|fisheye|dutch angle|bird'?s eye|worm'?s eye|over-the-shoulder|foreshortening|panorama|selfie|^pov\b/i

/** 把一段机位文本拆成归一化的基础机位 id 集合（`from side, from behind` → {side, behind}）。 */
function viewpointSet(text) {
  const out = []
  for (const tok of String(text || '').split(/[/,]/).map((t) => t.trim()).filter(Boolean)) {
    for (const v of VIEWPOINT_BASE) {
      if (v.re.test(tok) && out.indexOf(v.id) < 0) out.push(v.id)
    }
  }
  return out
}

function viewpointCN(ids) {
  return (ids || []).map((id) => (VIEWPOINT_BASE.find((v) => v.id === id) || {}).cn || id).join('+')
}

/** 从一段文本里剔掉基础机位词（环境卡的 extra_camera 会混进来）。 */
function stripViewpointWords(seg) {
  if (!seg) return ''
  const out = []
  for (const raw of String(seg).split(',')) {
    const t = raw.trim()
    if (!t) continue
    if (viewpointSet(t).length) continue
    out.push(t)
  }
  return out.join(', ')
}

/**
 * 机位裁决。返回：
 *   pos        —— 要补进正向的机位词（动作卡声明的机位，除非选了视角）
 *   sceneDrop  —— 环境卡的 viewpoint 是否要让位
 *   conflict   —— 两边基础机位互斥（用于 autofix 文案）
 *   special    —— 命中的特殊机位（只用于 warn，不影响 sceneDrop）
 *
 * 关键取舍：**动作卡的机位永远进正向**（只要没选视角），哪怕其中一方是特殊机位 ——
 * 早先写成「任一方特殊就两边都不动」，结果环境卡是 `bird's eye view` 时
 * 动作卡的 `from side` 也跟着丢了，等于把 v7 想修的问题又制造了一遍。
 * 特殊机位只影响「环境卡的机位要不要被撤」，不影响「动作卡的机位要不要进」。
 */
function resolveViewpoint(pose, scene) {
  const poseVp = clean(pose?.camera?.viewpoint || '')
  const sceneVp = clean(scene?.camera?.viewpoint || '')
  const poseSpecial = !!poseVp && VIEWPOINT_SPECIAL_RE.test(poseVp)
  const sceneSpecial = !!sceneVp && VIEWPOINT_SPECIAL_RE.test(sceneVp)
  const special = [poseSpecial ? poseVp : '', sceneSpecial ? sceneVp : ''].filter(Boolean)

  // 特殊机位不参与「撤环境卡机位」的裁决 —— 那类机位常常是场景本身的性质
  if (poseSpecial || sceneSpecial) {
    return { pos: poseVp, sceneDrop: false, conflict: false, special, poseVp, sceneVp }
  }

  const poseIds = viewpointSet(poseVp)
  const sceneIds = viewpointSet(sceneVp)
  if (!poseIds.length) {
    return { pos: '', sceneDrop: false, conflict: false, special: [], poseVp, sceneVp }
  }
  const overlap = poseIds.some((id) => sceneIds.indexOf(id) >= 0)
  const conflict = sceneIds.length > 0 && !overlap
  return {
    pos: poseVp,
    sceneDrop: true,
    conflict,
    special: [],
    poseVp,
    sceneVp,
    poseIds,
    sceneIds,
  }
}

/* ════════════════════════════════════════════════════════════════
   画幅裁决（v11）：环境卡（具体值）> 动作卡（具体值）> 画风卡参数
   ════════════════════════════════════════════════════════════════

   aspect 是 'portrait' / 'landscape' / 'both'。全库 140 张环境卡、319 张动作卡
   都声明了 aspect，但代码只读过环境卡那一份 —— 没选环境卡时一律 832x1216，
   74 张横构图动作卡（all fours / cowgirl position 这类）被硬塞进竖画布，
   两侧直接裁掉。这跟 v6/v7 是同一个毛病：字段声明了，但从来没进配方。

   优先级：
   - 环境卡声明了具体画幅 → 用它（环境决定空间，动作让步）
   - 环境卡是 both 或没选 → 用动作卡的（这不是裁决，是「补上被丢弃的声明」）
   - 两边都声明具体且不同 → 环境卡赢，只 warn。换画布会毁掉环境构图，
     和 v5 的分寸一致：没有唯一正确答案的事不动配方，只提醒。
*/
function resolveAspect(pose, scene) {
  const norm = (v) => {
    const s = clean(v || '').toLowerCase()
    return s === 'portrait' || s === 'landscape' ? s : ''
  }
  const poseAspect = norm(pose?.aspect)
  const sceneAspect = norm(scene?.aspect)
  if (sceneAspect) {
    return {
      aspect: sceneAspect,
      source: 'scene',
      conflict: !!poseAspect && poseAspect !== sceneAspect,
      poseAspect,
      sceneAspect,
    }
  }
  if (poseAspect) {
    return { aspect: poseAspect, source: 'pose', conflict: false, poseAspect, sceneAspect }
  }
  return { aspect: '', source: 'none', conflict: false, poseAspect, sceneAspect }
}

const ASPECT_CN = { portrait: '竖构图', landscape: '横构图' }
const ASPECT_RES = { portrait: '832x1216', landscape: '1216x832' }

// ── v16：params 只收「采样键」 ────────────────────────────────────
// 卡里的 params 混着元数据：safe_composition（一句提示词）、denoise_note / note
// （中文说明）、seed（和顶层 seed 打架）。这些键混进 params 后，下游按「键=值」
// 喂采样器时会被中文长句噎住，也会让 params.seed 和顶层 seed 说两套话。
const PARAM_KEYS = ['model', 'lora', 'clip', 'vae', 'steps', 'cfg', 'sampler', 'scheduler', 'resolution', 'denoise']

/** 只挑采样键，其余（元数据 / 说明）一律不搬。 */
function pickSamplingParams(src) {
  const out = {}
  if (!src || typeof src !== 'object') return out
  for (const k of PARAM_KEYS) {
    const v = src[k]
    if (v === undefined || v === null || v === '') continue
    out[k] = v
  }
  return out
}

/** 列出某个 params 里被丢弃的键名（给 autofix 用）。 */
function nonSamplingKeys(src) {
  if (!src || typeof src !== 'object') return []
  return Object.keys(src).filter((k) => PARAM_KEYS.indexOf(k) < 0)
}


/* ═══════════════════════════════════════════════════════════════════
   人数裁决（v19）

   `count_lock` 从建库起就在每张环境卡 / 动作卡上（140 + 319 张全有），
   但 index.js 里**一次都没读过** —— grep `count_lock` 是 0 次引用。

   于是「画面里有几个人」只有一个来源在说话：角色卡 `feature_segment`
   里钉死的 `1girl, solo`。而动作卡的 pose_tags 写的是 `2girls, yuri` /
   `group sex` / `two boys`。两边直接对撞：

     正向 = "… 1girl, solo, … standing, 2girls, yuri, …"
     负面 = "… 2girls, multiple girls, 1boy, multiple boys …"

   负面那几个词来自 23 张造型卡的样板负面和 15 张画风卡的负面，本意是
   「别画成多人」—— 单人场景下是对的；一旦选了双人动作卡，就成了
   正向要 2girls、负面压 2girls（同 v12 画法让位的病根，只是换了个族）。

   三条一起修：
   ① 档位（solo / duo / group）统一裁决：动作卡 pose_tags > 动作卡 count_lock
      > 环境卡 count_lock。pose_tags 里的人数词是真进正向的那一份，最可信。
   ② 非单人档时，从角色段剥掉 `1girl, solo` —— 同槽位互斥，只能二选一。
   ③ 非单人档时，从负面剔掉「压多人」的词 —— 否则正向要、负面压。

   单人档（占全库绝大多数）一个字都不动。画风卡负面这次**也一起剔** ——
   人数不像画法，画风卡对「画几个人」没有主张权。
   ═══════════════════════════════════════════════════════════════════ */

// 人数档：取「最大档」而不是「先遇到就返回」——
// `1girl, 1boy, hetero` 三个 token 分别是 solo/duo/duo，结果必须是 duo。
const COUNT_WORD_TIERS = [
  { tier: 'group', re: /^(3girls|4girls|multiple girls|multiple boys|2boys|group|group sex|threesome|orgy|surrounded|two boys)$/i },
  { tier: 'duo', re: /^(2girls|1boy|hetero|yuri|couple|pair|both girls in frame)$/i },
  { tier: 'solo', re: /^(1girl|solo)$/i },
]
const COUNT_TIER_RANK = { solo: 1, duo: 2, group: 3 }
const COUNT_TIER_CN = { solo: '单人', duo: '双人', group: '多人' }

function countTierOf(text) {
  let best = 0
  for (const raw of String(text || '').split(',')) {
    const t = raw.trim()
    if (!t) continue
    for (const row of COUNT_WORD_TIERS) {
      if (!row.re.test(t)) continue
      const v = COUNT_TIER_RANK[row.tier]
      if (v > best) best = v
      break
    }
  }
  return ['', 'solo', 'duo', 'group'][best]
}

// 角色段里「锁定单人」的那两个词。
const SOLO_CHAR_RE = /^(1girl|1girls|solo)$/i
// 负面里「压多人」的那一族。`male` / `person` / `people` 也算 ——
// hetero 与 group 都要男人，双人百合要第二个人，留着就是拆台。
const MULTI_NEG_RE = /^(2girls|3girls|multiple girls|1boy|2boys|multiple boys|group sex|group|hetero|yuri|couple|pair|male|person|people)$/i

function resolveCount(pose, scene, poseSegText) {
  const poseTagsTier = countTierOf(poseSegText)
  const poseLockTier = countTierOf(pose && pose.count_lock)
  const sceneLockTier = countTierOf(scene && scene.count_lock)
  const poseTier = poseTagsTier || poseLockTier
  // 档位只由动作卡决定。环境卡的 count_lock 是「成对生成」留下的溯源元数据
  // （140 张里 18 张多人），不是用户意图 —— 让它定人数会把单人动作卡画成双人。
  // 动作卡什么都没说时，按单人算：角色段本来就钉着 `1girl, solo`。
  const tier = poseTier || 'solo'
  // 只有「两边都声明了具体档位且不同」才算冲突，且只 warn。
  const conflict = !!(poseTier && sceneLockTier && poseTier !== sceneLockTier)
  // 正向补词：档位不是单人、且动作卡 pose_tags 自己没说时，把 count_lock 拼进去。
  // 这是「补上被丢弃的声明」，不是裁决。
  const lockText = clean((pose && pose.count_lock) || '')
  const pos = tier !== 'solo' && !poseTagsTier ? lockText : ''
  return { tier, pos, conflict, poseTier, sceneTier: sceneLockTier, poseTagsTier }
}

/** 按槽位剔负面词，返回 { kept, dropped }。 */
function dropNegativeSlots(negSeg, shouldDrop) {
  const out = []
  const dropped = []
  for (const raw of String(negSeg || '').split(',')) {
    const t = raw.trim()
    if (!t) continue
    if (shouldDrop(t)) dropped.push(t)
    else out.push(t)
  }
  return { kept: out.join(', '), dropped }
}

/**
 * 手持物让位（v27）：造型卡 / 画风卡的负面里常有一串「别在手里多出东西」的黑名单
 * （19 张造型卡共用的 `holding cup, holding mug, coffee cup, holding phone,
 * holding book, holding bag`，以及 `sword` / `thermoses` 这类裸名词）。
 *
 * 单人场景下这条黑名单是对的 —— 它就是用来防「造型卡莫名多出一只手拿着杯子」的。
 * 但用户**明确选了道具卡**时，正向是 `holding ceramic cup`，负面是 `holding cup`：
 * `minusPositive` 只做整串子串包含，`" holding cup "` 不在 `" holding ceramic cup "`
 * 里 —— 剔不掉，于是正向要杯子、负面同时压杯子。
 *
 * v17 把主名词从 `cup` 升级成 `ceramic cup` 之后，这个缝反而变宽了：
 * 81 张手持道具里有 30 张的主名词含空格，全都躲得过这条整串匹配。
 *
 * 分寸：**只剔「压的正是用户选的这件东西」的那几条**，不动其余黑名单
 * （`holding phone` 留着 —— 用户没选手机，那条仍然在防「多出一只手」）。
 */
function dropPropNegatives(negSeg, heldNouns) {
  const nouns = (heldNouns || []).map((n) => String(n || '').toLowerCase().trim()).filter(Boolean)
  if (!nouns.length) return { kept: String(negSeg || ''), dropped: [] }
  const hits = (t) => {
    const low = String(t || '').toLowerCase().trim()
    if (!low) return false
    const bare = low.replace(/^holding\s+/, '')
    for (const n of nouns) {
      // 整串相等：负面 `cup` ⇢ 正向 `cup`
      if (bare === n) return true
      // 负面是泛词、正向是具体词：负面 `cup` ⇢ 正向 `ceramic cup`
      if (n.endsWith(' ' + bare)) return true
      // 负面是具体词、正向是泛词（少见，但对称处理）：负面 `ceramic cup` ⇢ 正向 `cup`
      if (bare.endsWith(' ' + n)) return true
    }
    return false
  }
  return dropNegativeSlots(negSeg, hits)
}

function compose(input) {
  const style = input.styleId ? loadCard('style', input.styleId) : null
  const character = input.characterId ? loadCard('character', input.characterId) : null
  const look = input.lookId ? loadCard('look', input.lookId) : null
  const scene = input.sceneId ? loadCard('scene', input.sceneId) : null
  const pose = input.poseId ? loadCard('pose', input.poseId) : null

  // 道具支持多选（v4）。propIds 优先，老字段 propId 兼容成单元素数组。
  //
  // v17：重复 id 必须先去重。面板的 toggle 逻辑本身不会产生重复，但 API / 模型工具 /
  // 手写脚本会 —— 实测 `["prop_uchiwa","prop_uchiwa"]` 拼出 `holding uchiwa and uchiwa`，
  // 三件时更荒谬（还触发「两只手画不下」的警告，而实际只有一只手在拿东西）。
  const propIdsRaw = Array.isArray(input.propIds) && input.propIds.length
    ? input.propIds.filter((x) => typeof x === 'string' && x)
    : (input.propId ? [input.propId] : [])
  const propIds = []
  const propDupIds = []
  for (const id of propIdsRaw) {
    if (propIds.indexOf(id) >= 0) { if (propDupIds.indexOf(id) < 0) propDupIds.push(id); continue }
    propIds.push(id)
  }
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
  // 闭眼 / 睡着（v13）：必须在这里先判，因为角色段、脸光、render 三段都要让位。
  // 来源取「动作卡 pose_tags + 造型卡动作 + 显式 closedEyes」，不用 pose_nl（散文不进提示词）。
  const eyesShut = input.closedEyes === true
    || isEyesShut(poseSegment(pose))
    || isEyesShut(lookPoseSegment(look))
  // 背影机位（back / back_left / back_right）下剥掉脸部专属特征，否则模型为了画
  // 异色瞳会把脸强行转过来（bisect 实测：角色段是唯一把背影翻成正脸的那一段）。
  const viewBack = !!(view && (view.angle === 'back' || view.angle === 'back_left' || view.angle === 'back_right'))
  const charSeg = characterSegment(character, input.closedEyes === true, viewBack, eyesShut)
  const lookCloth = lookClothSegment(look)
  const lookPose = lookPoseSegment(look)
  // 动作来源优先级：动作卡 > 造型卡 legacy_pose_ref（v4 迁出的那批）> 造型卡自带 pose_tags。
  // 动作卡是显式选的，一旦选了就以它为准；造型卡的动作默认不进配方，
  // 因为它会和用户选的环境/动作卡打架（更衣间那张就是典型：卡里写 walking + crossed arms）。
  // 动作卡的视线互斥（看镜头 vs 回头）：先按机位裁决，别让它俩同时进正向。
  // 动作卡自己的 camera.viewpoint 优先，其次看视角选择器。
  const poseGazeFix = dedupePoseGaze(poseSegment(pose), (pose?.camera && pose.camera.viewpoint) || '')
  const poseSeg = poseGazeFix.text
  const usePose = input.includePose !== false && (!!poseSeg || input.includePose === true)
  let actSeg = ''
  if (usePose && poseSeg) actSeg = poseSeg
  else if (usePose && lookPose) actSeg = lookPose
  // 视角选了之后由视角段说了算：把动作段里的视线/机位/景别词剥掉，避免两套指令打架
  const viewTakeover = !!(input.view && typeof input.view === 'object' && input.view.angle)
  const actSegForRecipe = viewTakeover ? stripViewTakeover(actSeg) : actSeg

  // 脚上穿不穿（v21）：动作卡说赤足、造型卡配了鞋 → 同槽位互斥，只能二选一。
  // 脚不是画面主体时撤鞋（鞋只是边角，留着会把「赤脚」毁掉）；
  // 脚是主体（feet focus）时只 warn，因为穿鞋的特写也成立。
  const footFix = resolveFootwear(lookCloth, pose, actSegForRecipe)
  const lookClothFixed = footFix.text

  // 整套装束让位（v22）：动作卡里残留的装束词（nurse / office lady / serafuku …）
  // 遇上造型卡的装束时是第二套衣服，撤掉动作卡那份。造型卡没有任何装束族时保留 ——
  // 那时它是唯一的衣服线索。同族（miko × yukata）也撤，造型卡才是权威。
  const outfitFix = resolveOutfit(lookClothFixed, actSegForRecipe)
  const actSegOutfit = outfitFix.text

  // 「穿好衣服」防护词让位（v26）：4 张奇幻造型卡的 look_tags 里钉着
  // `fully clothed, wearing clothes, covered chest, covered torso`（防走光），
  // 配上要裸露 / 露肤的动作卡时，正向会同时要「穿好」和「completely nude」。
  // v5 只剔负面里的裸词，正向这一对从来没管过。只撤防护词，衣服本体不动。
  const guardFix = resolveCoverGuard(lookClothFixed, actSegOutfit)
  const lookClothGuarded = guardFix.text
  const lookSeg = joinSeg(lookClothGuarded, actSegOutfit)

  // 人数裁决（v19）：档位统一由动作卡说话（pose_tags > count_lock > 环境卡 count_lock）。
  // 非单人档时，角色段里钉死的 `1girl, solo` 必须剥掉 —— 它和 `2girls, yuri` /
  // `group sex` 是同槽位互斥，只能二选一。单人档（全库绝大多数）一个字不动。
  const countFix = resolveCount(pose, scene, actSegForRecipe)
  const multiPerson = !!countFix.tier && countFix.tier !== 'solo'
  const charSegCounted = multiPerson
    ? dropNegativeSlots(charSeg, (t) => SOLO_CHAR_RE.test(t)).kept
    : charSeg

  // 道具跟在动作后面：先说明「在做什么」，再说明「手里拿着什么」
  // v10：穿戴类道具若造型卡已经穿了同一件，就删掉道具那一份（否则同一件东西进正向两三次）
  const propFix = propsSegment(props, lookCloth)
  const propSeg = propFix.text
  // v28：真正进配方的道具 = 前 PROP_MAX 件里、没有被 propdup 撤掉的那些。
  // 「同部位叠」和「手里拿几件」必须按这一批算 —— 早先按 propsAll 算，
  // 于是被撤掉的道具还在参与检查，报出「「贝雷帽」和「王冠」都占头部饰品」这种
  // 正向里根本没有贝雷帽的假警告。
  const propDroppedIds = new Set((propFix.dropped || []).map((p) => p && p.id))
  const propsEffective = props.filter((p) => p && !propDroppedIds.has(p.id))
  const viewSegRaw = viewSegments(view)
  // 闭眼 / 睡着时视角段的视线词也要让位（v20）：`looking at viewer` 是在要求睁眼，
  // 留着它模型就会把眼睛睁开，把 v13 剥掉的眼睛词从这条缝里漏回来。
  const viewGazeFix = eyesShut ? stripGazeWords(viewSegRaw.pos) : { text: viewSegRaw.pos, dropped: [] }
  const viewSeg = { ...viewSegRaw, pos: viewGazeFix.text }
  const viewSegGazeDropped = viewGazeFix.dropped
  // 景别裁决（v6）：视角 > 动作卡 > 环境卡。
  // 没选视角时动作卡的 shot_size 才有机会进正向 —— 早先它被整个丢掉，
  // 于是「动作卡要全身 + 环境卡写 upper body」出来永远只有上半身。
  const shotFix = viewSeg.pos ? null : resolveShotSize(pose, scene, poseSeg)
  const poseShotSeg = shotFix ? shotFix.pos : ''
  // 机位裁决（v7）：视角 > 动作卡 > 环境卡。
  // 和景别同理 —— 动作卡的 camera.viewpoint 早先也没进正向，219 张卡静默丢弃。
  const viewFix = viewSeg.pos ? null : resolveViewpoint(pose, scene)
  const poseViewSeg = viewFix ? viewFix.pos : ''
  // 头在不在画框里（v8）：看真正进正向的动作段 + 视角。
  // 动作卡写了 `head out of frame`，脸光就该清空 —— 否则模型为了画眼睛硬塞一个头。
  // 视角接管时动作段会被剥掉视线/机位词，但 `head out of frame` 不在剥离名单里，所以照样能判。
  // v9 起这个判定要提前到 sceneSegment 之前 —— 场景段的 dof 也得跟着让位。
  const headless = isHeadless(actSegForRecipe) || isHeadless(viewSeg.pos)
  // 景深裁决（v18）：动作卡的 camera.dof 早先也没进正向（23 张全丢），
  // 而环境卡的 dof 照常进 —— 等于环境卡单方面说了算。
  const dofFix = resolveDof(pose, scene, poseSeg, headless)
  const poseDofSeg = dofFix.pos
  // 构图裁决（v18）：动作卡的 camera.comp 里的构图词（negative space / symmetry / profile）
  // 同样从来没进过正向。里面的画幅词（landscape / portrait）不进正向，交给画幅裁决。
  const compFix = resolveComp(pose, poseSeg)
  const poseCompSeg = compFix.pos
  // 选了视角时，环境卡的机位/景别让位给视角，只保留 comp / dof
  const sceneSeg = sceneSegment(scene, {
    skipCamera: !!viewSeg.pos,
    dropShot: !!(shotFix && shotFix.sceneDrop),
    dropViewpoint: !!(viewFix && viewFix.sceneDrop),
    dropFaceFocus: headless,
    dropDof: !!(dofFix && dofFix.sceneDrop),
  })
  // 脸光：归画风卡。视角只提供 faceMode（正常 / 远景降级 / 背影清空），不提供词。
  // 景别被动作卡接管后，远景判定也要跟着改 —— 否则动作卡要全身、环境卡写 upper body，
  // 脸光会按 upper body 判成「不降级」，把画面硬拉回特写（n64 那个坑）。
  // 机位接管同理：动作卡要 from behind，脸光必须按背影判，否则正面脸会被拽回来。
  const sceneForFace = (() => {
    if (!shotFix || !shotFix.sceneDrop) {
      if (!(viewFix && viewFix.sceneDrop)) return scene
    }
    const cam = {}
    if (shotFix && shotFix.sceneDrop && shotFix.level != null) cam.shot_size = SHOT_REP_BY_LEVEL[shotFix.level] || ''
    if (viewFix && viewFix.sceneDrop && viewFix.pos) cam.viewpoint = viewFix.pos
    return {
      camera: cam,
      extra_camera: stripShotWords(stripViewpointWords(clean(scene?.extra_camera))),
    }
  })()
  const faceLight = resolveFaceLight(style?.face_light || '', sceneForFace, viewSeg, headless, eyesShut)
  // render 段也有眼睛词（`detailed eyes` / `glossy eyes` / `catchlight`），闭眼时同样作废。
  // 只剥眼睛标签，`smooth digital painting` / `cel shading` / `bloom` 这些画法词一个不动。
  // 场景让位（v14）：选了带 place 的环境卡时，render 里的「空白背景」族同样作废 ——
  // 场景段要森林/街道，render 段要求白底，等于一边要背景一边不要。
  // `negative space`（构图留白）不在此列，那是画风卡的一部分，一个字不动。
  const sceneBgWanted = sceneWantsBackground(scene)
  const renderRaw = style?.render || ''
  const blankBgFix = sceneBgWanted ? stripBlankBg(renderRaw) : { text: renderRaw, dropped: [] }
  // 具体地点让位（v15）：render 里写死的地点（`city street` / `telephone pole`），
  // 和环境卡的 place 对不上就撤掉。只撤地点词，`detailed background`（密度词）不动。
  const scenePlace = clean((scene && scene.tags && scene.tags.place) || '')
  const placeFix = scenePlace
    ? stripStylePlace(blankBgFix.text, scenePlace)
    : { text: blankBgFix.text, dropped: [] }
  const render = eyesShut ? stripEyeTokens(placeFix.text).text : placeFix.text

  // 拼装顺序：视角段紧跟在场景之后 —— 场景说明「在哪」，视角说明「从哪儿看、往哪儿看」。
  // 放在场景之前会被场景的 camera 词盖掉，放在最后又压不住 render 段的 detailed eyes。
  // 动作卡景别/机位跟在动作段后面（它是在说「这个动作要拍多宽、从哪边拍」）。
  const positive = joinSeg(q, art, charSegCounted, lookSeg, countFix.pos, poseShotSeg, poseViewSeg, poseCompSeg, poseDofSeg, propSeg, sceneSeg, viewSeg.pos, faceLight, render)
  // 画幅裁决（v11）：环境卡 > 动作卡 > 画风卡参数。
  // 动作卡的 aspect 早先从来没读过 —— 74 张横构图动作卡（all fours / cowgirl position）
  // 没配环境卡时被塞进 832x1216 竖画布，左右两侧直接裁掉。
  // 声明必须在这里：下面 autofix 与 warning 两段都要用 aspectFix。
  const aspectFix = resolveAspect(pose, scene)
  // 参数优先级：画风卡最硬。
  //
  // 底模 + 加速 LoRA + steps/cfg 是画风卡的采样档（miaomiaoHarem 8step 必须配
  // 12步 cfg2.0），角色卡里存的是老底模 anima-base 的 45步 cfg4.5 —— 那个一旦
  // 盖过来，8step 模型就跑废了。所以只拿画风卡当基座，别的卡只补它没有的键。
  //
  // v16：只搬「采样键」。卡里的 params 混着元数据 —— `safe_composition`
  // （"sitting, upper body, cowboy shot" 一句提示词）、`denoise_note`（一段中文说明）、
  // `note`、`seed`。之前无条件 copy，结果是下游按「键=值」喂采样器时被中文长句噎住，
  // 而且 seed 会和顶层 seed 打架（params 里 650000、顶层 null）。
  // 声明必须在这里：下面 autofix 段要用 droppedParamKeys。
  const params = Object.assign({}, pickSamplingParams(style?.params))
  const droppedParamKeys = []
  for (const [src, extra] of [['look', look?.params], ['character', character?.params]]) {
    if (!extra || typeof extra !== 'object') continue
    for (const k of Object.keys(extra)) {
      if (!PARAM_KEYS.includes(k) && !droppedParamKeys.some((d) => d.key === k)) {
        droppedParamKeys.push({ key: k, from: src })
      }
    }
    for (const [k, v] of Object.entries(pickSamplingParams(extra))) {
      if (params[k] === undefined || params[k] === null || params[k] === '') params[k] = v
    }
  }
  // 画幅落到参数上（v11）。放在 params 合并之后 —— 画风卡参数里也有 resolution，
  // 合并时会被 look/character 的 params 补空，画幅裁决必须最后拍板。
  if (aspectFix.aspect) {
    params.resolution = ASPECT_RES[aspectFix.aspect]
    // img2img 专用画风卡的分辨率是「必须这么高」的硬约束（1280x1807 才能保住分镜框），
    // 不能被横构图改成 1216x832 —— 那会同时把分镜和长宽比一起毁掉。
    if (style && style.mode === 'img2img') params.resolution = style?.params?.resolution || params.resolution
  }

  // ── 自动冲突处理：负面按语义槽位让位 ────────────────────────────
  //
  // 顺序要紧：先做「裸露让位」，再做「光照让位」，最后才 minusPositive。
  // 前者是把不该在负面里的词删掉，后者是删正负交集 —— 顺序反了，交集删完
  // 就分不清某个词是被谁删的。
  const autofixes = []
  const wantsNude = NUDE_POS_RE.test(positive)
  const wantsReveal = REVEAL_POS_RE.test(positive)
  const sceneLightText = [sceneSeg, scene?.env_hint || '', scene?.env_nl || ''].join(', ')
  const lightDrops = []
  for (const rule of LIGHT_RULES) {
    if (rule.scene.test(sceneLightText)) lightDrops.push(rule)
  }

  // 画法让位（v12）：非画风卡的负面里，那些「裸类目词」在压制画风卡主张的画法。
  //
  // 真凶不只是造型卡 —— 角色卡 `crab_vampire` 的 negative 也带着
  // `cel shading, flat colors, painterly`（早期从柔光厚涂那套复制来的）。
  // 所以这里清的是「角色 + 造型 + 视角」这一整串，画风卡自己那份一律不动：
  // 它的负面是它刻意的取舍（shadowverse 要赛璐璐分色、却把 flat colors 压掉）。
  const mediumFix = dropMediumConflicts(
    joinSeg(character?.negative || '', look?.negative_extra || '', viewSeg.neg),
    style
  )
  if (mediumFix.dropped.length) {
    // v23：文案要分清「从哪一段剔的」。画风卡自己那份 negative 是刻意的取舍
    // （style_anime_cel 主张赛璐璐、负面却也压 cel shading 来防「糊成一片」），
    // 一个字都不动。但早先文案只说「已剔掉：cel shading」，用户去负面里一搜
    // 发现还在，会以为规则没生效 —— 必须写明「剔的是角色/造型/视角那一份」。
    const stillInStyle = mediumFix.dropped.filter((t) => new RegExp(`(^|,\\s*)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*,|$)`, 'i').test(String(style?.negative || '')))
    const tail = stillInStyle.length
      ? `（画风卡自己的负面里还留着 ${stillInStyle.join(' / ')} —— 那是它刻意的取舍，不动）`
      : ''
    autofixes.push({
      kind: 'medium',
      auto: true,
      message: `角色/造型卡的负面在压制画风卡要的画法（${mediumFix.families.join(' / ')}），已从角色 / 造型 / 视角那一段剔掉：${mediumFix.dropped.join(' / ')}${tail}`,
    })
  }
  const negParts = [
    style?.negative || '',
    mediumFix.kept,
  ]
  const negJoined = joinSeg(...negParts)
  // 手持物让位（v27）：用户明确选了道具卡，负面里那条「别在手里多出东西」的
  // 黑名单就变成了正向要、负面压。只剔「压的正是这件」的那几条，其余不动。
  const propNegFix = dropPropNegatives(negJoined, propFix.held)
  if (propNegFix.dropped.length) {
    const uniq = [...new Set(propNegFix.dropped)]
    autofixes.push({
      kind: 'propneg',
      auto: true,
      message: `你选了道具「${(propFix.held || []).join(' / ')}」，但造型卡 / 画风卡的负面里钉着压它的黑名单：${uniq.join(' / ')} —— 已剔掉这几条（其余「别在手里多出东西」的黑名单原样保留；否则正向要这件、负面同时压这件）`,
    })
  }
  // 人数让位（v19）：非单人档时，负面里「压多人」的那一族必须剔掉。
  // 它们来自 23 张造型卡的样板负面 + 15 张画风卡的负面，本意是「别画成多人」——
  // 单人场景下是对的，选了双人 / 群体动作卡就成了正向要、负面压。
  // 画风卡那份这次也一起剔：人数不像画法，画风卡对「画几个人」没有主张权。
  let negCountFixed = propNegFix.kept
  if (multiPerson) {
    const cr = dropNegativeSlots(negJoined, (t) => MULTI_NEG_RE.test(t))
    if (cr.dropped.length) {
      negCountFixed = cr.kept
      const uniq = [...new Set(cr.dropped)]
      autofixes.push({
        kind: 'count',
        auto: true,
        message: `动作卡是${COUNT_TIER_CN[countFix.tier]}（${countFix.tier}），已从负面剔掉 ${uniq.length} 个「压多人」的词：${uniq.slice(0, 6).join(' / ')}` +
          (uniq.length > 6 ? ' …' : '') + '（否则正向要几个人、负面同时压几个人）',
      })
    }
  }
  const nudeFixed = dropNegativeSlots(negCountFixed, (t) => wantsNude && NUDE_NEG_RE.test(t))
  if (nudeFixed.dropped.length) {
    autofixes.push({
      kind: 'nude',
      auto: true,
      message: `造型要裸露，已从负面剔掉 ${nudeFixed.dropped.length} 个压制词：${nudeFixed.dropped.slice(0, 6).join(' / ')}` +
        (nudeFixed.dropped.length > 6 ? ' …' : ''),
    })
  }
  // 露肤让位：只在「要露但没全裸」时做。全裸时上一步已经把整片都删了。
  let negAfterNude = nudeFixed.kept
  if (wantsReveal && !wantsNude) {
    const r = dropNegativeSlots(negAfterNude, (t) => COVER_NEG_RE.test(t))
    if (r.dropped.length) {
      negAfterNude = r.kept
      autofixes.push({
        kind: 'reveal',
        auto: true,
        message: `造型声明了露肤（露肩/低胸/开襟/连体衣），已从负面剔掉 ${r.dropped.length} 个「逼着遮」的词：${r.dropped.slice(0, 6).join(' / ')}`,
      })
    }
  }
  for (const rule of lightDrops) {
    const r = dropNegativeSlots(negAfterNude, (t) => rule.drop.test(t))
    if (!r.dropped.length) continue
    negAfterNude = r.kept
    autofixes.push({
      kind: 'light',
      auto: true,
      message: `场景是${rule.label}，已从负面剔掉压这档光的词：${r.dropped.join(' / ')}`,
    })
  }
  if (poseGazeFix.dropped.length) {
    autofixes.push({
      kind: 'gaze',
      auto: true,
      message: `动作卡自己同时写了「看镜头」和「回头」，按机位留了一组，删掉：${poseGazeFix.dropped.join(' / ')}`,
    })
  }
  // 景别让位：动作卡的 shot_size 进正向，环境卡的 shot_size 撤掉。
  // 只在两边不一致时报 —— 一致时用户看不出配方有变化，报了反而噪音。
  if (shotFix && shotFix.conflict) {
    const a = SHOT_CN[shotFix.sceneLevel] || '?'
    const b = SHOT_CN[shotFix.poseLevel] || '?'
    autofixes.push({
      kind: 'shot',
      auto: true,
      message: `景别冲突：环境卡是「${a}」，动作卡是「${b}」—— 按动作卡取「${b}」，已撤掉环境卡的景别词（否则动作被截掉半截）`,
    })
  }
  // 机位让位（v7）：动作卡的基础机位进正向，环境卡的机位撤掉。
  // 同样只在不一致时报。
  if (viewFix && viewFix.conflict) {
    const a = viewpointCN(viewFix.sceneIds) || '?'
    const b = viewpointCN(viewFix.poseIds) || '?'
    autofixes.push({
      kind: 'viewpoint',
      auto: true,
      message: `机位冲突：环境卡是「${a}」，动作卡是「${b}」—— 按动作卡取「${b}」，已撤掉环境卡的机位词（否则动作被拍变形）`,
    })
  }

  // 景深让位（v18）：动作卡的 camera.dof 进正向；只有「虚化 ⇄ 深焦」互斥时
  // 才撤掉环境卡的 dof。两边不冲突就共存（环境卡的景深常常是场景性质）。
  if (dofFix && dofFix.conflict) {
    const a = dofFix.sceneFams.includes('deep') ? '深焦（背景清晰）' : '虚化（背景糊）'
    const b = dofFix.poseFams.includes('deep') ? '深焦（背景清晰）' : '虚化（背景糊）'
    autofixes.push({
      kind: 'dof',
      auto: true,
      message: `景深冲突：环境卡是「${a}」，动作卡是「${b}」—— 按动作卡取「${b}」，已撤掉环境卡的景深词（背景不能同时既糊又清晰）`,
    })
  }
  // 头出画时动作卡自己的「对焦在脸」（v18，v9 的同族另一侧）：
  // 早先只查环境卡那一份，动作卡写的 focus on face 从来没进过正向，所以看不见；
  // 现在动作卡 dof 进正向，就必须同样让位，否则等于把 v9 修过的坑从另一边开回来。
  if (dofFix && dofFix.dropped.length && dofFix.dropped.some((t) => isFaceFocus(t))) {
    autofixes.push({
      kind: 'facefocus',
      auto: true,
      message: '动作卡自己写了「对焦在脸上」，但它也说头不在画框里 —— 已撤掉这条对焦（否则它会把镜头拉回来找脸）',
    })
  }

  // 头出画（v8）：动作卡写了 head out of frame，脸光整段清空。
  // 必须报出来 —— 「已自动处理」块的作用就是让用户看见配方和卡里不一样了。
  if (headless && (style?.face_light || '').trim()) {
    autofixes.push({
      kind: 'headless',
      auto: true,
      message: '动作卡写了「头不在画框里」—— 已清空脸光段（否则模型为了画眼睛会硬塞一个头进来，把构图毁掉）',
    })
  }
  // 对焦在脸上（v9）：环境卡的 camera.dof 写着 focus on face，但头不在画框里。
  // 和脸光同族 —— 它同样是在要求「把焦点落在脸上」，只能靠塞一个头进来满足。
  // 只丢这一档 dof，景深虚化 / deep focus 跟脸无关，照旧保留。
  if (headless && isFaceFocus(clean(scene?.camera?.dof)) ) {
    autofixes.push({
      kind: 'facefocus',
      auto: true,
      message: '环境卡要求「对焦在脸上」，但动作卡说头不在画框里 —— 已撤掉这条对焦（否则它会把镜头拉回来找脸）',
    })
  }
  // 穿戴道具重复（v10）：造型卡已经穿了同一件，道具卡又声明一次。
  // 实测 look_painter（自带 beret）+ prop_beret 拼出来 beret 出现三次 —— 模型会画三顶帽子。
  // 同槽位互斥，按「造型卡是底装、道具是追加」删掉道具那一份。
  if (propFix.dropped.length) {
    const names = propFix.dropped.map((p) => p.name || p.id).join(' / ')
    autofixes.push({
      kind: 'propdup',
      auto: true,
      message: `「${names}」造型卡已经穿了 —— 已撤掉道具那一份（否则同一件东西会进正向两三次，模型画出双份）`,
    })
  }
  // 重复道具 id（v17）：面板的 toggle 不会产生重复，但 API / 模型工具 / 手写脚本会。
  // 实测 ["prop_uchiwa","prop_uchiwa"] 拼出 `holding uchiwa and uchiwa`，三件时更荒谬，
  // 而且还会触发「手里同时拿了 3 件东西」的假警告（实际只有一只手在拿）。
  if (propDupIds.length) {
    const names = propDupIds.map((id) => (propsAll.find((p) => p && p.id === id) || {}).name || id).join(' / ')
    autofixes.push({
      kind: 'propdup_id',
      auto: true,
      message: `「${names}」被重复选了 —— 已按一件处理（否则会拼出 holding A and A，还会误报「拿了多件东西」）`,
    })
  }

  // 脚上穿不穿（v21）：动作卡写 `bare feet`、造型卡配了靴子 → 同槽位互斥。
  // 撤掉造型卡的鞋（脚不是画面主体时鞋只是边角，留着会把「赤脚」毁掉）。
  if (footFix.dropped.length) {
    autofixes.push({
      kind: 'footwear',
      auto: true,
      message: `动作卡写着赤足（${hasBarefoot(actSegForRecipe) ? 'bare feet' : 'barefoot'}），造型卡却配了鞋：${footFix.dropped.join(' / ')} —— 已撤掉造型卡的鞋（脚上要么穿要么不穿，留着模型会在赤脚上画出一双靴子）`,
    })
  }

  // 整套装束让位（v22）：动作卡里残留的装束词遇上造型卡的装束 = 第二套衣服。
  if (outfitFix.dropped.length) {
    autofixes.push({
      kind: 'outfit',
      auto: true,
      message: `动作卡里带着整套装束（${outfitFix.dropped.join(' / ')}），但造型卡已经穿了「${outfitFix.keptFamilies.join(' / ')}」—— 已撤掉动作卡那份（否则两套衣服会糊在一起：军装外面套白大褂、水手服领子长在旗袍上）`,
    })
  }

  // 「穿好衣服」防护词让位（v26）：造型卡正向里的 `fully clothed` / `covered chest`
  // 遇上要裸露 / 露肤的动作卡 —— 这是 v5 漏掉的那一半（v5 只剔负面里的裸词）。
  if (guardFix.dropped.length) {
    autofixes.push({
      kind: 'coverguard',
      auto: true,
      message: `动作卡要露（${guardFix.slots.join(' / ')}），造型卡却钉着「穿好衣服」的防护词：${guardFix.dropped.join(' / ')} —— 已撤掉造型卡的防护词（否则正向一边要裸、一边要捂，模型只能瞎猜；衣服本体一个字没动）`,
    })
  }

  // 参数元数据（v16）：卡里的 params 除了采样键还混着元数据 ——
  // `safe_composition`（"sitting, upper body, cowboy shot" 一句提示词）、
  // `denoise_note`（一段中文说明）、`note`、`seed`。无条件 copy 的后果是
  // 下游按「键=值」喂采样器时被中文长句噎住，且 params.seed 与顶层 seed 说两套话。
  if (droppedParamKeys.length) {
    const desc = droppedParamKeys.map((d) => `${d.key}（来自 ${d.from} 卡）`).join(' / ')
    autofixes.push({
      kind: 'param',
      auto: true,
      message: `参数里混进了非采样键：${desc} —— 已从采样参数里剔掉（它们不是采样值，下游按「键=值」喂采样器会被中文长句噎住；seed 也改由顶层 seed 统一管）`,
    })
  }

  // 闭眼 / 睡着（v13）：眼睛专属词在角色段、脸光段、render 段里都作废。
  // 这三段都是「必须睁眼才成立」的描述，留着只会把脸拽正 / 逼角色睁眼。
  if (eyesShut) {
    const rawEye = [
      clean(character?.body_segment || ''),
      clean(character?.feature_segment || ''),
      clean(character?.character_segment || ''),
      clean(character?.character_segment_closed_eyes || ''),
      style?.face_light || '',
      style?.render || '',
    ].join(', ')
    const seenEye = new Set()
    const eyeDropped = stripEyeTokens(rawEye).dropped.filter((t) => {
      const k = t.toLowerCase()
      if (seenEye.has(k)) return false
      seenEye.add(k)
      return true
    })
    if (eyeDropped.length) {
      autofixes.push({
        kind: 'eyes',
        auto: true,
        message: `动作卡写了闭眼 / 睡着 —— 已撤掉眼睛专属词：${eyeDropped.join(' / ')}（闭着眼画不出异色瞳和瞳孔高光，留着只会把脸拽回正面、逼角色睁眼）`,
      })
    }
  }

  // 闭眼 × 视角视线（v20）：视角段的 `looking at viewer` 同样是在要求睁眼。
  // 单独报一条，因为它的来源是「视角选择器」而不是卡，用户改卡改不掉它。
  if (viewSegGazeDropped.length) {
    autofixes.push({
      kind: 'gaze',
      auto: true,
      message: `动作卡写了闭眼 / 睡着，视角选择器却要求「${viewSegGazeDropped.join(' / ')}」—— 已撤掉视角段的视线词（机位与景别不动；闭着眼做不到「看镜头 / 回头」，留着只会逼角色睁眼）`,
    })
  }

  // 场景让位（v14）：选了带 place 的环境卡时，画风卡 render 里的「空白背景」族作废。
  // 全库 6 张画风卡写着 simple/white/empty/pale gradient background（无环境卡时防乱加背景用），
  // 140 张环境卡全部带 place —— 两边同时存在就是「要森林」和「要白底」互相拆台。
  if (blankBgFix.dropped.length) {
    autofixes.push({
      kind: 'bgblank',
      auto: true,
      message: `选了环境卡（有具体场景），已从画风卡的渲染段撤掉空白背景词：${blankBgFix.dropped.join(' / ')}（否则场景段要森林/街道，渲染段同时要求白底，两边拆台）`,
    })
  }

  // 地点让位（v15）：render 里写死的地点与环境卡对不上。
  // 全库只有 `style_retro90_cel`（`city street` / `telephone pole`）这一张，
  // 配卧室 / 浴室 / 海滩时会变成「一边说在卧室、一边说在街上」。
  if (placeFix.dropped.length) {
    autofixes.push({
      kind: 'place',
      auto: true,
      message: `画风卡的渲染段写着「${placeFix.dropped.join(' / ')}」，但环境卡是「${scenePlace}」—— 已撤掉渲染段的地点词（否则两段各说一个地方，模型会挑一个或画出拼接背景）`,
    })
  }

  // 画幅冲突（v11）：环境卡说横、动作卡说竖（或反过来）。
  // 这是唯一一个「不自动改」的画幅情况 —— 换画布会毁掉环境构图，
  // 和 v5 的分寸一致：没有唯一正确答案的事只提醒。
  const aspectWarnings = []
  if (aspectFix.conflict) {
    aspectWarnings.push(
      `画幅冲突：环境卡是「${ASPECT_CN[aspectFix.sceneAspect] || aspectFix.sceneAspect}」，动作卡是「${ASPECT_CN[aspectFix.poseAspect] || aspectFix.poseAspect}」—— 按环境卡取 ${ASPECT_RES[aspectFix.sceneAspect]}，动作卡那份画幅已忽略`,
    )
  }

  // 人数档位冲突（v19）：动作卡与环境卡都声明了具体档位且不同。
  // 按动作卡取（人物是动作的主体），只 warn —— 换掉场景的人数设定会毁构图。
  if (countFix.conflict) {
    aspectWarnings.push(
      `人数冲突：环境卡是「${COUNT_TIER_CN[countFix.sceneTier] || countFix.sceneTier}」，动作卡是「${COUNT_TIER_CN[countFix.poseTier] || countFix.poseTier}」—— 按动作卡取「${COUNT_TIER_CN[countFix.tier] || countFix.tier}」`,
    )
  }

  // 脚部特写 × 赤足 × 造型卡配了鞋（v21）：脚是画面主体，穿鞋的特写也成立，
  // 没有唯一正确答案 → 只 warn 不动配方（与 v5 的分寸一致）。
  if (footFix.warn) {
    aspectWarnings.push(`脚上穿不穿：${footFix.warn}`)
  }

  // 环境卡 comp 槽里的画幅词（v23）：已在 sceneSegment 里滤掉，这里报一声。
  // 画幅归画幅裁决管，但环境卡把它写在「构图」槽里 —— 用户看不出来为什么
  // 正向少了一个词，得说清楚。
  // 注意：实际画幅要看 aspectFix 的结果（环境卡 aspect=both 时由动作卡决定），
  // 不能拿 comp 槽里的词去推 —— 那是两套声明，会给出自相矛盾的提示。
  const sceneCompAspect = clean((scene?.camera && scene.camera.comp) || '')
    .split(',').map((t) => t.trim()).filter((t) => t && COMP_ASPECT_RE.test(t))
  if (sceneCompAspect.length) {
    const realAspect = aspectFix.aspect ? `${ASPECT_CN[aspectFix.aspect]} ${ASPECT_RES[aspectFix.aspect]}` : '按画风卡默认'
    aspectWarnings.push(
      `环境卡的构图槽里写着画幅词（${sceneCompAspect.join(' / ')}）—— 已不把它当构图词用` +
      `（画幅归「画幅裁决」管，实际取 ${realAspect}）；留在正向会变成景别词，和动作卡的景别打架`,
    )
  }

  // 最后一道保险：负向里凡是正向已经写了的词，全部剔除。
  // 两段有交集时模型会二选一，「正面看镜头」比「背影回头」强势，实测直接翻脸。
  const negative = minusPositive(negAfterNude, positive)

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
      character: clean(charSegCounted),
      character_body: clean(character?.body_segment || ''),
      character_feature: clean(character?.feature_segment || ''),
      count: clean(countFix.pos),
      count_tier: countFix.tier || '',
      look: clean(lookSeg),
      look_cloth: clean(lookClothGuarded),
      look_pose: clean(lookPose),
      pose: clean(poseSeg),
      action: clean(actSegOutfit),
      action_raw: clean(actSegForRecipe),
      prop: clean(propSeg),
      prop_held: (propFix.held || []).slice(),
      props: props.map((p) => ({ id: p.id, name: p.name, tags: clean(p.prop_tags || ''), hold: !!p.hold })),
      scene: sceneSeg,
      shot: clean(poseShotSeg),
      viewpoint: clean(poseViewSeg),
      dof: clean(poseDofSeg),
      comp: clean(poseCompSeg),
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
    // autofixes = 已经自动改掉的冲突（配方里确实变了）
    // warnings   = 只提醒、没动的冲突
    // 两者分开，客户端和配方文本都能分别显示，不会混成一片。
    autofixes,
    warnings: buildWarnings(scene, style, look, pose, usePose, props, viewSeg, viewFix)
      .concat(propOverflow(propsAll))
      .concat(propConflicts(propsEffective))
      .concat(viewSeg.warnings)
      .concat(aspectWarnings),
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
  // 自动处理过的冲突放在最前：用户得先知道配方已经不是卡里的原样了。
  if (r.autofixes && r.autofixes.length) {
    lines.push('')
    lines.push('已自动处理（配方已改）：')
    for (const f of r.autofixes) lines.push('✔ ' + f.message)
  }
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

  // 存卡规则：面板的「规则」页直接读这份，不用把规则抄在 client.js 里。
  if (path === ROUTE + '/rules') {
    return sendJson(res, 200, {
      ok: true,
      version: RULES_VERSION,
      rules: SAVE_RULES.map((r) => ({
        id: r.id,
        title: r.title,
        why: r.why,
        kinds: r.kinds,
        severity: r.severity,
        manual: !!r.manual,
      })),
      fields: CARD_FIELDS,
      thumbs: THUMB_TEMPLATES,
      text: rulesText(),
    })
  }

  // 全库体检：默认跑活库，也可以指到别处（导出包上线前自检用）。
  if (path === ROUTE + '/lint') {
    const rel = url.searchParams.get('root') || ''
    const target = rel ? safeResolve(rel) : libraryRoot()
    if (!target) return sendJson(res, 400, { ok: false, error: 'bad root' })
    const r = lintLibrary(target, { exportMode: url.searchParams.get('export') === '1' })
    return sendJson(res, 200, Object.assign({ ok: r.ok, root: target, version: RULES_VERSION }, r))
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

    // 存卡规则本身也要能被模型读到 —— 否则下次写存卡脚本还是靠记忆。
    try {
      ctx.tools.register({
        name: 'card_library_save_rules',
        description: '读取「往卡片库存新卡」的硬性规则：六类卡职责边界、id 命名、缩略图规格、Anima 格式（下划线转空格 + 画师加 @）、存卡四连、以及每条规则的严重级（error 会阻塞、warn 只提示、manual 要人来判断）。写任何存卡/拆卡脚本之前先读它。',
        parameters: {
          type: 'object',
          properties: {
            verbose: { type: 'boolean', description: 'true 时连字段白名单与缩略图模板一起返回' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        isConcurrencySafe: () => true,
        execute: (args) => {
          const verbose = !!(args && args.verbose)
          const lines = [rulesText()]
          if (verbose) {
            lines.push('', '── 字段白名单 ──')
            for (const [k, v] of Object.entries(CARD_FIELDS)) lines.push(k + '：' + v.join(', '))
            lines.push('', '── 缩略图规格 ──')
            for (const [k, v] of Object.entries(THUMB_TEMPLATES)) {
              lines.push(k + '：' + (typeof v === 'string' ? v : JSON.stringify(v)))
            }
          }
          return lines.join('\n')
        },
      })
      log('已注册工具 card_library_save_rules')
    } catch (e) {
      log('规则工具注册失败：' + String(e?.message ?? e))
    }

    // 全库体检工具：出完一批卡、或往 GitHub 导出之前跑一次。
    try {
      ctx.tools.register({
        name: 'card_library_lint',
        description: '体检卡片库：按存卡规则逐张检查，返回 errors（必须修）/ warnings（历史遗留，人工判断）/ 缩略图 md5 撞图。写完卡、拆完卡、导出到 GitHub 之前都应该跑一次。默认检查当前工作区的 _assets/cards_library。',
        parameters: {
          type: 'object',
          properties: {
            root: { type: 'string', description: '可选：库目录（工作区相对路径）。默认活库 _assets/cards_library' },
            exportMode: { type: 'boolean', description: '导出模式：额外检查 preview 是否指向库外' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        isConcurrencySafe: () => true,
        execute: (args) => {
          const a = args || {}
          const rel = typeof a.root === 'string' && a.root ? a.root : ''
          const target = rel ? safeResolve(rel) : libraryRoot()
          if (!target) return '库目录不存在：' + rel
          const r = lintLibrary(target, { exportMode: !!a.exportMode })
          const out = [
            `库根：${target}`,
            `共 ${r.total} 张 · errors ${r.errors.length} · warnings ${r.warnings.length} · ${r.ok ? 'PASS' : 'FAIL'}`,
          ]
          if (r.errors.length) {
            out.push('', '── errors（必须修）──')
            for (const e of r.errors) out.push(`✗ [${e.rule}] ${e.kind}/${e.id} — ${e.msg}`)
          }
          if (r.warnings.length) {
            out.push('', '── warnings（历史遗留，人工判断）──')
            for (const w of r.warnings) out.push(`! [${w.rule}] ${w.kind}/${w.id} — ${w.msg}`)
          }
          if (r.md5Dup && r.md5Dup.length) {
            out.push('', '── 缩略图 md5 撞图 ──')
            for (const g of r.md5Dup) out.push('= ' + g.join(' == '))
          }
          return out.join('\n')
        },
      })
      log('已注册工具 card_library_lint')
    } catch (e) {
      log('体检工具注册失败：' + String(e?.message ?? e))
    }
  }
}
