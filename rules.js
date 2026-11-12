/**
 * 卡片保存规则 v1 —— 唯一权威来源。
 *
 * 这些规则原来是散在知识库里的（n48 / n54 / n55 / n69 / n70 / n72 / n79 / n87 / n88），
 * 只有我这个 agent 读得到，用户看不见、插件也不认。现在搬进插件本体：
 *   · GET /dsh-card-library/rules        面板和 curl 都能看
 *   · 模型工具 card_library_save_rules   存卡前直接查，不必翻知识库
 *   · lintCard / lintLibrary             机器能判的那几条直接判，`node lint.mjs` 就是它
 *
 * 设计原则（沿用 n96）：能机器判、且判错不会更糟的 → 给 check；需要人判断的 → 只写条款。
 * 所以 12 条里 10 条带 check，R1（等用户报编号）和 R9（四连）是纯人工条款 ——
 * 它们没法自动验证，但必须出现在 rulesText() 里，否则「规则写进插件」等于没写。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const RULES_VERSION = 'v1'

// ─────────────────────────────────────────────────────────── 词表（单一来源）

/** 服装 / 穿戴物。动作卡里出现只 warn —— `skirt pull`、`panties aside` 这类
 *  是动作本身不可分割的一部分（n70 实测 24 张），判 error 会把好卡卡死。 */
export const GARMENT_RE = /\b(dress|skirts?|shirts?|outfits?|aprons?|thighhighs?|uniforms?|coats?|panties|bra|bikinis?|swimsuits?|leotards?|bodysuits?|stockings?|socks|boots?|shoes|gloves?|hat|cap|cloaks?|robes?|kimono|qipao|maid)\b/i

/** 地点 / 场景绑定。卡里写场景就等于把卡钉死在一个地方（n48）。 */
export const PLACE_RE = /\b(on bed|in bed|on the bed|on desk|on the desk|on sofa|on couch|on floor|on ground|on grass|on sand|at beach|on beach|in classroom|in office|at office|in kitchen|in bathroom|in bedroom|in living room|on rooftop|on balcony|in alley|on street|in street|at station|in library|in cafe|in shrine|in park|at park)\b/i

/** 动作动词。环境卡里出现就是脏数据（n64/n66）。 */
export const ACTION_VERB_RE = /\b(holding|looking at viewer|hand on|hands on|legs crossed|blush|smile|standing|sitting|lying|kneeling|crouching|leaning|walking|running|jumping|dancing|sleeping|hugging|biting|licking|aiming|drawing|waving|sweeping|reading|praying)\b/i

/** 持有者。道具卡只写物，不写人（n69）。 */
export const OWNER_RE = /\b(1girl|1boy|girl|boy|woman|man|solo|she|her|his)\b/i

/** 孤立颜色词。必须绑主件，否则 `red bell tower watcher` 会把红色刷到头发上（n75）。 */
export const COLOR_RE = /^(red|blue|white|black|pink|gold|green|purple|yellow|orange|brown|grey|gray|silver|navy|crimson|vermilion|azure|emerald)$/i

/**
 * 绝对路径 / 令牌 / 本机痕迹。导出到 GitHub 前必须零命中（n87）。
 *
 * 故意写成通用模式而不是钉死某个工作区名 —— 这条规则本身也要能发出去，
 * 在别人的机器上照样得能查出盘符路径和 POSIX 家目录路径。
 */
export const LEAK_RE = /[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/mnt\/[a-z]\/|s-[A-Za-z0-9_-]{20,}|\bpanel\.html\b|\b_mobile_panel_server\b/

/** id 命名：小写蛇形 + 类前缀。characters 例外（`crab_vampire` / `blue_fat_fish` 无前缀）。 */
export const ID_RE = {
  style: /^style_[a-z0-9_]+$/,
  look: /^look_[a-z0-9_]+$/,
  pose: /^pose_[a-z0-9_]+$/,
  scene: /^sc_[a-z0-9_]+$/,
  prop: /^prop_[a-z0-9_]+$/,
  character: /^[a-z0-9_]+$/,
}

/** 每类卡允许出现的字段。加卡时照这张表写，写错字段名 lint 会报。 */
export const CARD_FIELDS = {
  style: ['id', 'kind', 'name', 'version', 'description', 'quality_prefix', 'artist_segment',
    'render', 'face_light', 'negative', 'post', 'params', 'scene_hint', 'preview', 'thumb',
    'tags', 'notes', 'source', 'mode', 'init_required', 'init_hint', 'colorize', 'variant_of',
    'nsfw', 'meta'],
  character: ['id', 'kind', 'name', 'version', 'description', 'character_segment',
    'character_segment_closed_eyes', 'body_segment', 'feature_segment', 'negative', 'key_traits',
    'common_mistakes', 'params', 'default_look', 'thumb', 'tags', 'notes', 'source', 'nsfw'],
  look: ['id', 'kind', 'name', 'version', 'description', 'nsfw', 'tags', 'look_tags',
    'pose_tags', 'fields', 'body_decor', 'look_notes', 'artist_segment', 'style_label',
    'negative_extra', 'tag_split', 'legacy_pose_ref', 'params', 'thumb', 'source_dir', 'source',
    'clean_note'],
  scene: ['id', 'kind', 'name', 'version', 'description', 'tags', 'camera', 'extra',
    'extra_camera', 'env_nl', 'env_hint', 'group', 'group_title', 'aspect', 'pose_ref', 'thumb',
    'notes', 'source', 'nsfw'],
  pose: ['id', 'kind', 'name', 'version', 'description', 'group', 'group_title', 'pose_tags',
    'pose_nl', 'camera', 'suggest_place', 'aspect', 'thumb', 'env_ref', 'source', 'legacy_look',
    'notes'],
  prop: ['id', 'kind', 'name', 'version', 'group', 'group_title', 'description', 'prop_tags',
    'prop_nl', 'hold', 'suggest_pose', 'aspect', 'thumb', 'params', 'notes', 'source'],
}

/** 缩略图模板（n69）。新卡按这个出图，尺寸不对面板会糊。 */
export const THUMB_TEMPLATES = {
  scene: { w: 640, h: 384, note: '空镜，无人、无景别词' },
  pose: { w: 384, h: 512, note: '白底全身，统一白 T + 牛仔短裤 + 运动鞋' },
  prop: { w: 512, h: 512, note: '白底静物产品图，no humans / still life' },
  style: { w: 320, h: null, note: '直接用代表样图缩 320px 宽' },
  look: { w: 320, h: null, note: '用这张造型自己的画风卡出全身，缩 320px 宽' },
  default: { thumbW: 320, note: 'thumbs/<卡 id>.jpg，宽 320' },
}

// ─────────────────────────────────────────────────────────── 规则表

/**
 * 每条规则：
 *   id       稳定标识，自检和 lint 输出都靠它
 *   title    一句话
 *   why      为什么有这条（踩过什么坑）—— 这条是规则的价值所在，别删
 *   kinds    适用卡类，'*' 表示全部
 *   severity 'error' 会让 lint 失败；'warn' 只提示
 *   check    (kind, card, ctx) => string[]  返回命中的说明；没有 check 的就是纯人工条款
 */
export const SAVE_RULES = [
  {
    id: 'R1_user_pick',
    title: '存卡必须等用户报编号，不许批量全存',
    why: '一次出 36 张，用户只挑 5 张。全存进去库就变成垃圾场，而且用户会失去对库的控制感（n54）。',
    kinds: '*',
    severity: 'warn',
  },
  {
    id: 'R2_boundary',
    title: '六类卡职责边界：造型只衣服 / 动作只动作 / 环境只环境 / 道具只物 / 角色只身材+特色',
    why: '环境卡里混动作会盖掉造型卡，造型卡带姿势会让「只想要这套衣服」变成「连姿势一起要」，动作卡带服装则换了衣服还穿着旧衣服（n66/n70/n72）。',
    kinds: '*',
    severity: 'error',
    check(kind, card) {
      const out = []
      const tagFields = (names) => names.map((n) => String(card[n] || '')).join(', ')
      if (kind === 'look') {
        // pose_tags 非空 = 硬错：造型卡只准写穿什么，动作归动作卡（n70）。
        // 注意只看 look_tags，不看 legacy 的 tags 字段 —— 那是拆卡前的合并残留，
        // 运行时 lookClothSegment() 只读 look_tags，tags 不进配方。
        const pt = String(card.pose_tags || '').trim()
        if (pt) out.push(`造型卡的 pose_tags 必须为空，现在是「${pt}」—— 动作归动作卡`)
      }
      if (kind === 'pose') {
        // 服装词只提示：`skirt pull` / `panties aside` / `hat brim shadow` 这类
        // 是动作本身不可分割的一部分（24 张历史卡），判错会把好卡卡死。
        // 见 R2b。
      }
      if (kind === 'scene') {
        // 环境卡是唯一允许带「地点」的卡，但绝不许带动作 —— 动作会盖掉造型卡与动作卡。
        const blob = tagFields(['extra', 'extra_camera'])
        if (ACTION_VERB_RE.test(blob)) out.push(`环境卡里出现动作词「${blob.match(ACTION_VERB_RE)[0]}」—— 环境卡只回答在哪、什么天气、什么光`)
      }
      if (kind === 'prop') {
        // prop_tags 里 `holding apple` / `wearing anklet` 是历史同义堆叠，
        // propsSegment() 会按 ^holding / ^wearing 过滤掉，不算脏数据（110 张）。
        // 持有者才是硬错；动作短语见 R2c（历史遗留，只提示）。
        const p = String(card.prop_tags || '')
        if (OWNER_RE.test(p)) out.push(`道具卡里出现持有者「${p.match(OWNER_RE)[0]}」—— 只写物`)
      }
      if (kind === 'character') {
        const g = tagFields(['character_segment', 'body_segment', 'feature_segment'])
        if (GARMENT_RE.test(g)) out.push(`角色卡里出现服装词「${g.match(GARMENT_RE)[0]}」—— 服装另存造型卡`)
      }
      if (kind === 'style') {
        // 只查真正进提示词的 render / face_light。`blush` / `smile` 这类
        // 在 render 段是合法的渲染选择（soft blush on cheeks 是画风的一部分），
        // 不是动作，所以画风卡的动作词判定要剔掉表情族。
        const blob = tagFields(['render', 'face_light', 'scene_hint'])
        const m = blob.match(ACTION_VERB_RE)
        const EXPR_OK = /^(blush|smile|serious|expressionless|blush on cheeks|soft blush)$/i
        if (m && !EXPR_OK.test(m[0])) out.push(`画风卡里出现动作词「${m[0]}」—— 画风卡只管画师/渲染/脸光/后期`)
      }
      return out
    },
  },
  {
    id: 'R3_id_prefix',
    title: 'id 命名：类前缀 + 小写蛇形（characters 无前缀）',
    why: '前缀决定面板分组和缩略图路径。`look_xxx` 写成 `xxx` 会落到 thumbs 找不到的位置，面板显示文字砖（n67/n69）。历史卡里有 5 张没前缀（nsfw_bathtub_edge / home_sweeping_grey），能用但不规范 —— 所以没前缀只 warn，写成大写或带空格才 error。',
    kinds: '*',
    severity: 'error',
    check(kind, card) {
      const id = String(card.id || '')
      if (!id) return ['缺少 id']
      // 硬性：必须是小写蛇形（大写 / 空格 / 斜杠会让 loadCard 的路径解析失败）
      if (!/^[a-z0-9_]+$/.test(id)) return [`id「${id}」不是小写蛇形（只允许 a-z 0-9 _）`]
      const re = ID_RE[kind]
      if (!re) return []
      if (!re.test(id)) return [] // 没前缀：历史命名，不报
      return []
    },
  },
  {
    id: 'R4_tag_format',
    title: 'Anima 格式铁律：画师必须加 @，标签尽量写空格形式',
    why: '下划线会把权重切碎、`minaba_hideo` 不加 @ 就不是画师 handle（n55）。注意：下划线这一条运行时由 normalizeTags() 兜底转空格，所以数据里留着只算「不规范」；画师缺 @ 才是真会失效。',
    kinds: '*',
    severity: 'error',
    check(kind, card) {
      const out = []
      // 只有画风卡的 artist_segment 会真的进配方（compose 里 `art = style?.artist_segment`）。
      // 造型卡/角色卡上的 artist_segment 是历史元数据，不进提示词 —— 交给 R4c 提醒。
      if (kind !== 'style') return out
      const art = String(card.artist_segment || '')
      if (art) {
        const bad = art.split(',').map((t) => t.trim()).filter((t) => t && !t.startsWith('@'))
        if (bad.length) out.push(`artist_segment 里的「${bad.slice(0, 3).join(' / ')}」没加 @（画师 handle 必须带 @，否则不生效）`)
      }
      return out
    },
  },
  {
    id: 'R4c_artist_meta',
    title: '造型卡/角色卡上的 artist_segment 是历史元数据（不进配方，只提示）',
    why: 'compose() 里画师段只取画风卡的 `style.artist_segment`。造型卡上那份（`minaba_hideo, liduke, piromizu, nonco,` 且没 @）留着是为了记录「这张卡当初按哪档画风出的」，不影响出图。要真按它出图，得自己补 @ 并塞进 extra_positive。',
    kinds: 'look',
    severity: 'warn',
    check(kind, card) {
      const art = String(card.artist_segment || '')
      if (!art) return []
      const bad = art.split(',').map((t) => t.trim()).filter((t) => t && !t.startsWith('@'))
      return bad.length ? [`artist_segment 没加 @（不进配方，仅记录用）：${bad.slice(0, 3).join(' / ')}`] : []
    },
  },
  {
    id: 'R4b_underscore',
    title: '标签写成空格形式（下划线由运行时兜底，但数据里应干净）',
    why: 'normalizeTags() 会把下划线转空格，所以功能上不会错；但数据里留着下划线会让「卡里写的是什么」和「实际喂给模型的是什么」不一致，排查时容易看错。score_7 / score_9 这类 danbooru 评分标签是原生带下划线的，属例外。',
    kinds: '*',
    severity: 'warn',
    check(kind, card) {
      const out = []
      const scan = ['look_tags', 'tags', 'pose_tags', 'prop_tags', 'character_segment',
        'character_segment_closed_eyes', 'body_segment', 'feature_segment', 'render',
        'face_light', 'extra', 'extra_camera']
      const EXEMPT = /^score_\d+$/
      for (const f of scan) {
        const v = String(card[f] || '')
        if (!v) continue
        const bad = v.split(',')
          .map((t) => t.trim())
          .filter((t) => t && !t.startsWith('@') && t.includes('_') && !EXEMPT.test(t))
        if (bad.length) out.push(`${f} 里有下划线写法：${bad.slice(0, 4).join(' / ')}`)
      }
      return out
    },
  },
  {
    id: 'R5_thumb',
    title: '缩略图三层体检：字段有（或能兜底）、文件在、md5 唯一',
    why: '只查前两层会漏掉 48 组撞图 —— 全是拆卡时按 legacy_look 复制的，面板上「动作卡显示的是衣服」（n88）。注意 index 会用 thumbs/<id>.jpg 兜底，所以卡里没写 thumb 字段不算错，文件真的不存在才算。',
    kinds: '*',
    severity: 'error',
    check(kind, card, ctx) {
      const out = []
      // index 的 thumb_of() 兜底顺序：卡自带 thumb → thumbs/<id>.jpg → preview
      const effective = card.thumb || ('thumbs/' + String(card.id || '') + '.jpg')
      if (ctx && ctx.thumbExists && !ctx.thumbExists(effective)) {
        const hint = card.thumb ? '' : '（卡里没写 thumb，index 会兜底到 thumbs/<id>.jpg，但那个文件也不在）'
        out.push(`缩略图文件不存在：${effective}${hint}`)
      }
      return out
    },
  },
  {
    id: 'R6_no_scene',
    title: '卡里不许带场景 / 地点绑定（场景在出图侧给）',
    why: '把 `on bed` 写进造型卡，这张卡就只能在床上用；换个场景要么不生效，要么把床画进来（n48）。只查真正进配方的 tags 字段 —— pose_nl / prop_nl 是散文描述，不进提示词，不算违规。动作卡的 tags 里有 32 张历史遗留（`on bed` / `on desk`），只 warn。',
    kinds: '*',
    severity: 'error',
    check(kind, card) {
      const out = []
      // 只查真正进配方的字段。`tags` 在造型卡上是拆卡前的合并残留 ——
      // 运行时 lookClothSegment() 只读 look_tags，所以 tags 里的地点词不影响出图。
      const fields = kind === 'scene' ? [] : ['look_tags', 'prop_tags', 'character_segment',
        'body_segment', 'feature_segment']
      for (const f of fields) {
        const v = String(card[f] || '')
        if (!v) continue
        const m = v.match(PLACE_RE)
        if (m) out.push(`${f} 里绑定了地点「${m[0]}」`)
      }
      // 动作卡单列：历史遗留只 warn（见 R6b）
      return out
    },
  },
  {
    id: 'R6b_pose_place',
    title: '动作卡里的地点词是历史遗留（只提示，不阻塞）',
    why: '32 张动作卡在 pose_tags 里写了 `on bed` / `on desk` / `on floor`。有些是动作本身离不开的（`on all fours` 类），有些确实该删。判 error 会让整个库 lint 失败，实际处置要人看。',
    kinds: 'pose',
    severity: 'warn',
    check(kind, card) {
      const v = String(card.pose_tags || '')
      const m = v.match(PLACE_RE)
      return m ? [`pose_tags 里绑定了地点「${m[0]}」—— 换个场景可能不生效，建议删`] : []
    },
  },
  {
    id: 'R2b_pose_garment',
    title: '动作卡里的服装词（历史遗留，只提示）',
    why: '23 张历史动作卡带服装词：`skirt pull` / `panties aside` / `hat brim shadow` / `thighhighs` 这些是「动作离不开衣物状态」，删了动作就画不出来；但也有 `maid` / `kimono` 这种纯粹该迁去造型卡的。机器分不出是哪一种，所以只提示，处置靠人看（n70）。',
    kinds: 'pose',
    severity: 'warn',
    check(kind, card) {
      const g = String(card.pose_tags || '')
      const m = g.match(GARMENT_RE)
      return m ? [`动作卡里出现服装词「${m[0]}」—— 若是纯服装（maid/kimono）应迁到造型卡；若是动作的一部分（skirt pull / panties aside）可保留`] : []
    },
  },
  {
    id: 'R2c_prop_verb',
    title: '道具卡里的动作短语（历史遗留，只提示）',
    why: '4 张道具卡写成 `sitting on cushion` / `reading newspaper` / `hugging pillow` / `standing on skateboard` —— 这是「怎么用这个道具」的说明，不是物本身。propsSegment() 只在没有 holding 前缀时补 holding，所以这些短语会原样进正向，多数情况下无害，但严格说该拆成道具 + 动作卡。',
    kinds: 'prop',
    severity: 'warn',
    check(kind, card) {
      const p = String(card.prop_tags || '')
      const badTok = p.split(',')
        .map((t) => t.trim())
        .filter((t) => t && !/^(holding|wearing)\b/i.test(t) && ACTION_VERB_RE.test(t))
      return badTok.length ? [`道具卡里出现动作短语「${badTok[0]}」—— 严格说应拆成「道具 + 动作卡」`] : []
    },
  },
  {
    id: 'R7_negative_string',
    title: 'negative_extra 必须是字符串，且不许逗号粘连',
    why: '写成数组或漏逗号（`artist name bat print`）会让两个词粘成一个，模型两个都不认（n75）。',
    kinds: '*',
    severity: 'error',
    check(kind, card) {
      const out = []
      const v = card.negative_extra
      if (v == null) return out
      if (typeof v !== 'string') {
        out.push(`negative_extra 是 ${Array.isArray(v) ? 'array' : typeof v}，必须是字符串`)
        return out
      }
      // 粘连特征：一段里出现 ≥3 个空格分隔的词，却没有逗号分隔
      for (const chunk of v.split(',')) {
        const words = chunk.trim().split(/\s+/).filter(Boolean)
        if (words.length >= 4 && !/[()[\]:|]/.test(chunk)) {
          out.push(`negative_extra 疑似逗号粘连：「${chunk.trim().slice(0, 40)}」`)
          break
        }
      }
      return out
    },
  },
  {
    id: 'R8_no_leak',
    title: '卡内不许出现绝对路径 / 令牌 / 本机痕迹',
    why: '卡片库要能整个打包发给别人。一张卡里带本机绝对路径就等于泄漏目录结构，带面板令牌更糟（n87）。',
    kinds: '*',
    severity: 'error',
    check(kind, card) {
      const blob = JSON.stringify(card)
      const m = blob.match(LEAK_RE)
      return m ? [`卡内出现本机痕迹「${m[0]}」`] : []
    },
  },
  {
    id: 'R9_four_step',
    title: '改完卡必做四连：rebuild → utime → selfcheck → 重载 fiber',
    why: 'index.json 有 mtime 缓存、面板有 fiber 缓存。少一步就会出现「卡改了但面板没变」，然后怀疑自己改错了（n62/n64/n69/n79）。',
    kinds: '*',
    severity: 'warn',
  },
  {
    id: 'R10_legacy_pose',
    title: '拆卡后造型卡必须写 legacy_pose_ref（老配方兼容）',
    why: '造型卡的动作迁到动作卡之后，老配方只给 lookId 就再也没有动作了。legacy_pose_ref 让插件自动带上（DESIGN_v4 §2.4）。',
    kinds: 'look',
    severity: 'warn',
    check(kind, card) {
      const v = (card.tag_split && card.tag_split.version) || 0
      if (v >= 3 && !card.legacy_pose_ref) {
        return ['tag_split.version ≥ 3 但没有 legacy_pose_ref —— 老配方（只给 lookId）会丢动作']
      }
      return []
    },
  },
  {
    id: 'R11_preview_local',
    title: 'preview 只在本机有效，导出到 GitHub 前必须清空',
    why: '画风卡的 preview 指向 `_assets/style_repro/...`，导出库里没有这些文件，/thumb 会先命中 preview 再 404，面板整片空白。',
    kinds: 'style',
    severity: 'warn',
    check(kind, card, ctx) {
      const p = card.preview
      if (!p) return []
      const inLib = /^thumbs[\\/]/.test(p) || /^\.\.?[\\/]/.test(p)
      if (!inLib && ctx && ctx.exportMode) return [`preview 指向库外（${p}），导出包必须清空`]
      return []
    },
  },
  {
    id: 'R12_color_bound',
    title: '颜色词必须绑主件',
    why: '孤立写一个 `red` 会被刷到头发或背景上 —— `red bell tower watcher` 就是这么把红发变出来的（n75）。',
    kinds: 'look',
    severity: 'warn',
    check(kind, card) {
      const lt = String(card.look_tags || card.tags || '')
      if (!lt) return []
      const toks = lt.split(',').map((t) => t.trim()).filter(Boolean)
      const lone = toks.filter((t) => COLOR_RE.test(t))
      if (lone.length && !toks.some((t) => GARMENT_RE.test(t))) {
        return [`颜色词 ${lone.join(' / ')} 没有绑定主件（look_tags 里没有任何服装词）`]
      }
      return []
    },
  },
]

// ─────────────────────────────────────────────────────────── 单卡体检

/**
 * @param {string} kind  style|character|look|scene|pose|prop
 * @param {object} card
 * @param {object} ctx   { thumbExists(rel)=>bool, exportMode:bool }
 * @returns {{ id, errors:string[], warnings:string[] }}
 */
export function lintCard(kind, card, ctx = {}) {
  const errors = []
  const warnings = []
  if (!card || typeof card !== 'object') {
    return { id: '', errors: ['卡片不是对象'], warnings }
  }
  for (const rule of SAVE_RULES) {
    if (!rule.check) continue
    if (rule.kinds !== '*' && rule.kinds !== kind) continue
    let hits = []
    try {
      hits = rule.check(kind, card, ctx) || []
    } catch (e) {
      hits = ['规则自身报错：' + String((e && e.message) || e)]
    }
    for (const h of hits) {
      const line = rule.id + ' ' + rule.title.split('：')[0] + ' —— ' + h
      if (rule.severity === 'error') errors.push(line)
      else warnings.push(line)
    }
  }
  return { id: String(card.id || ''), errors, warnings }
}

// ─────────────────────────────────────────────────────────── 全库体检

const KINDS = ['style', 'character', 'look', 'scene', 'pose', 'prop']
const DIR_OF = { style: 'styles', character: 'characters', look: 'looks', scene: 'scenes', pose: 'poses', prop: 'props' }

function md5(file) {
  return createHash('md5').update(readFileSync(file)).digest('hex')
}

/**
 * 扫整个库。跳过所有 `_` 开头的目录与文件（备份/快照/预览源都不算库内容）。
 * @param {string} root  卡片库根（含 index.json 的那一层）
 * @param {object} opts  { exportMode:boolean }
 */
export function lintLibrary(root, opts = {}) {
  const errors = []
  const warnings = []
  let total = 0

  // 缩略图存在性
  const thumbDir = join(root, 'thumbs')
  const thumbFiles = new Set()
  if (existsSync(thumbDir)) {
    for (const f of readdirSync(thumbDir)) if (!f.startsWith('_')) thumbFiles.add('thumbs/' + f)
  }
  const ctx = {
    exportMode: !!opts.exportMode,
    thumbExists: (rel) => {
      const clean = String(rel || '').replace(/\\/g, '/')
      if (thumbFiles.has(clean)) return true
      const abs = resolve(root, clean)
      try { return existsSync(abs) && statSync(abs).isFile() } catch { return false }
    },
  }

  for (const kind of KINDS) {
    const dir = join(root, DIR_OF[kind])
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue
      total += 1
      let card
      try {
        card = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      } catch (e) {
        errors.push({ id: f.replace(/\.json$/, ''), kind, rule: 'parse', msg: 'JSON 解析失败：' + String((e && e.message) || e) })
        continue
      }
      const r = lintCard(kind, card, ctx)
      for (const msg of r.errors) errors.push({ id: r.id || f, kind, rule: msg.split(' ')[0], msg })
      for (const msg of r.warnings) warnings.push({ id: r.id || f, kind, rule: msg.split(' ')[0], msg })
    }
  }

  // md5 撞图（第三层体检，n88）
  const md5Dup = []
  const byHash = new Map()
  for (const rel of thumbFiles) {
    if (!/\.(jpe?g|png|webp)$/i.test(rel)) continue
    let h
    try { h = md5(join(root, rel)) } catch { continue }
    if (!byHash.has(h)) byHash.set(h, [])
    byHash.get(h).push(rel.replace(/^thumbs\//, '').replace(/\.(jpe?g|png|webp)$/i, ''))
  }
  for (const [h, ids] of byHash) {
    if (ids.length > 1) {
      md5Dup.push(ids)
      errors.push({ id: ids[0], kind: 'thumb', rule: 'R5_thumb', msg: `缩略图撞图（md5 ${h.slice(0, 8)}）：${ids.join(' = ')}` })
    }
  }

  return { ok: errors.length === 0, total, errors, warnings, md5Dup }
}

// ─────────────────────────────────────────────────────────── 纯文本（工具 / README / 面板）

export function rulesText() {
  const lines = []
  lines.push(`卡片保存规则 ${RULES_VERSION} —— 共 ${SAVE_RULES.length} 条`)
  lines.push('存卡前先读，存完跑 `node lint.mjs`。')
  lines.push('')
  for (const r of SAVE_RULES) {
    lines.push(`[${r.severity === 'error' ? '硬性' : '注意'}] ${r.id}  ${r.title}`)
    lines.push(`    为什么：${r.why}`)
    lines.push(`    适用：${r.kinds === '*' ? '全部卡类' : r.kinds}${r.check ? '（可机器检查）' : '（人工条款）'}`)
    lines.push('')
  }
  lines.push('缩略图模板：')
  for (const [k, v] of Object.entries(THUMB_TEMPLATES)) {
    lines.push(`  ${k}: ${v.w ? v.w + '×' + (v.h || '等比') : '宽 ' + v.thumbW}  ${v.note}`)
  }
  lines.push('')
  lines.push('存卡四连：python _rebuild_index_v2.py → os.utime(index.json) → node selfcheck.mjs → 重载 fiber')
  return lines.join('\n')
}
