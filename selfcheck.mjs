/**
 * 离线自测：不启 DSH，直接 import 宿主半端，用一个假 ctx 把路由抓下来，
 * 然后逐条打真实请求，检查 index / card / thumb / compose 是否按预期工作。
 * 跑：node _dsh_plugin/dsh-card-library/selfcheck.mjs
 */
import { apply } from './index.js'

const routes = []
const tools = []
const ctx = {
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  webServer: {
    register(def) { routes.push(def); return () => {} },
  },
  tools: {
    register(def) { tools.push(def); return () => {} },
  },
}

apply(ctx)

if (routes.length !== 1) {
  console.error('FAIL 路由没挂上，routes =', routes.length)
  process.exit(1)
}
const route = routes[0]
console.log('route:', route.kind, route.path)
console.log('tools:', tools.map((t) => t.name).join(', ') || '(none)')

/** 起一个假 req/res，走一遍真实 handler。*/
function call(pathname, { method = 'GET', body = null } = {}) {
  return new Promise((resolve) => {
    const chunks = []
    const res = {
      statusCode: 200,
      headers: null,
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this },
      end(buf) {
        if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)))
        const raw = Buffer.concat(chunks)
        resolve({ status: this.statusCode, headers: this.headers, raw, json: tryJson(raw) })
      },
    }
    const req = {
      method,
      url: pathname,
      headers: { host: '127.0.0.1:3080' },
      on(ev, fn) {
        if (ev === 'data' && body) fn(Buffer.from(JSON.stringify(body)))
        if (ev === 'end') fn()
        return req
      },
      destroy() {},
    }
    route.handler(req, res).catch((e) => {
      resolve({ status: 500, headers: null, raw: Buffer.alloc(0), json: { ok: false, error: String(e) } })
    })
  })
}

function tryJson(buf) {
  try { return JSON.parse(buf.toString('utf8')) } catch { return null }
}

let failures = 0
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ←' + JSON.stringify(extra)))
  if (!cond) failures += 1
}

const idx = await call('/dsh-card-library/index')
check('GET /index 200', idx.status === 200, idx.status)
check('GET /index ok', idx.json?.ok === true, idx.json?.error)
const counts = idx.json?.index?.counts || {}
// img2img 专用画风卡（漫画墨线）—— 必须给出「要底图」的警告
const mangaR = await call('/dsh-card-library/compose', { method: 'POST', body: { styleId: 'style_manga_ink_v1', characterId: 'crab_vampire' } })
const mangaW = mangaR.json
check('counts 齐全', counts.kinds === 6 && counts.styles === 16 && counts.characters === 2 && counts.looks === 50 && counts.scenes === 140 && counts.poses === 319 && counts.props === 124, counts)

const one = await call('/dsh-card-library/card?kind=style&id=style_wlop_warm_soft')
check('GET /card 画风卡', one.status === 200 && one.json?.card?.artist_segment?.includes('@wlop'), one.json?.error)
check('画风卡带 post', Boolean(one.json?.card?.post?.haze), one.json?.card?.post)

const sceneCard = await call('/dsh-card-library/card?kind=scene&id=sc_rain_street_lookback')
check('GET /card 环境卡', sceneCard.status === 200 && Boolean(sceneCard.json?.card?.env_nl), sceneCard.json?.error)
// 环境卡必须是纯环境：不许再带动作/服装/表情的键
const sceneTags = sceneCard.json?.card?.tags || {}
check('环境卡 tags 只有环境键',
  Object.keys(sceneTags).every((k) => ['place', 'weather', 'light_fx', 'texture_fx', 'prop'].includes(k)),
  Object.keys(sceneTags))
check('环境卡没有 scene_nl 残留', sceneCard.json?.card?.scene_nl === undefined, sceneCard.json?.card?.scene_nl)

const poseCard = await call('/dsh-card-library/card?kind=pose&id=pose_rain_street_lookback')
check('GET /card 动作卡', poseCard.status === 200 && Boolean(poseCard.json?.card?.pose_tags), poseCard.json?.error)
check('动作卡指向原场景', Boolean(poseCard.json?.card?.env_ref), poseCard.json?.card?.env_ref)

// 缩略图：造型卡（thumbs/ 相对路径）、画风卡（工作区相对路径）、环境卡（没有 thumb）
const tLook = await call('/dsh-card-library/thumb?kind=look&id=look_red_hoodie')
check('thumb 造型卡 200 + jpeg', tLook.status === 200 && tLook.headers?.['content-type'] === 'image/jpeg' && tLook.raw.length > 1000,
  { status: tLook.status, type: tLook.headers?.['content-type'], bytes: tLook.raw.length })

const tStyle = await call('/dsh-card-library/thumb?kind=style&id=style_wlop_warm_soft')
check('thumb 画风卡 200 + 图片', tStyle.status === 200
  && /^image\/(png|jpeg)$/.test(tStyle.headers?.['content-type'] || '') && tStyle.raw.length > 1000,
  { status: tStyle.status, type: tStyle.headers?.['content-type'], bytes: tStyle.raw.length })

const tScene = await call('/dsh-card-library/thumb?kind=scene&id=sc_rain_street_lookback')
check('thumb 环境卡 200 + jpg', tScene.status === 200, tScene.status)

// 越界防护
const escape1 = await call('/dsh-card-library/image?path=' + encodeURIComponent('../../../../Windows/win.ini'))
check('越界路径被拒', escape1.status === 404, escape1.status)
const escape2 = await call('/dsh-card-library/image?path=' + encodeURIComponent('_assets/../python/python.exe'))
check('工作区内的非图片被拒', escape2.status === 404 || escape2.status === 415, escape2.status)

// 配方：四张卡齐全
const full = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_wlop_warm_soft',
    characterId: 'crab_vampire',
    lookId: 'look_red_hoodie',
    sceneId: 'sc_rain_street_lookback',
    seed: 884101,
  },
})
check('POST /compose 200', full.status === 200, full.status)
check('compose ok', full.json?.ok === true, full.json?.missing)
const pos = full.json?.positive || ''
check('正向含画师', pos.includes('@wlop'), pos.slice(0, 120))
check('正向含角色', pos.includes('tooth necklace') || pos.includes('heterochromia'), pos.slice(0, 200))
check('正向含造型', pos.includes('cropped hoodie'), '')
check('正向含场景', pos.includes('rain'), '')
check('正向顺序 quality 在最前', pos.startsWith('masterpiece'), pos.slice(0, 40))
// render 段是最后一段，用它的尾串判断位置（render 本身很长，不能只看末尾 260 字符里有没有关键词）
check('正向顺序 render 在最后', pos.trimEnd().replace(/,$/, '').endsWith('cinematic composition'), pos.slice(-80))
check('负面非空', (full.json?.negative || '').length > 200, (full.json?.negative || '').length)
// 画风卡的采样档不许被角色卡的老底模（anima-base 45 步 cfg4.5）盖掉
check('参数带底模', String(full.json?.params?.model || '').includes('miaomiaoHarem'), full.json?.params?.model)
check('steps/cfg 用画风卡', full.json?.params?.steps === 12 && full.json?.params?.cfg === 2.0,
  { steps: full.json?.params?.steps, cfg: full.json?.params?.cfg })
check('seed 透传', full.json?.seed === 884101, full.json?.seed)
check('text 里有提示词标题', (full.json?.text || '').includes('正向提示词'), (full.json?.text || '').slice(0, 60))

// 动作卡：默认带动作，includePose=false 时不带
const withPose = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_wlop_warm_soft',
    lookId: 'look_red_hoodie',
    sceneId: 'sc_rain_street_lookback',
    poseId: 'pose_rain_street_lookback',
  },
})
check('POST /compose 带动作卡 200', withPose.status === 200 && withPose.json?.ok === true, withPose.json?.missing)
check('动作卡默认进配方', Boolean(withPose.json?.segments?.pose), withPose.json?.segments?.pose)
check('selection 带 pose', withPose.json?.selection?.pose?.id === 'pose_rain_street_lookback', withPose.json?.selection?.pose)

const noPose = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_wlop_warm_soft',
    lookId: 'look_red_hoodie',
    sceneId: 'sc_rain_street_lookback',
    poseId: 'pose_rain_street_lookback',
    includePose: false,
  },
})
check('includePose=false 时不拼动作', noPose.json?.includePose === false, noPose.json?.includePose)
check('includePose=false 时正向不含动作段',
  !String(noPose.json?.positive || '').includes(String(withPose.json?.segments?.pose || '###')),
  String(noPose.json?.positive || '').slice(0, 120))

// 横构图场景要切分辨率
const wide = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', sceneId: 'sc_rain_street_lookback' },
})
check('aspect=both 不动分辨率', wide.json?.params?.resolution === '832x1216', wide.json?.params?.resolution)

// 缺卡要报出来而不是崩
const bad = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', lookId: 'nope_not_here' },
})
check('缺卡时 ok=false 且列出 missing', bad.status === 200 && bad.json?.ok === false && bad.json?.missing?.length === 1, bad.json?.missing)

// 空选也要能拼（只用画风）
const onlyStyle = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_base_seven' },
})
check('只选画风也能拼', onlyStyle.json?.ok === true && onlyStyle.json?.positive?.includes('@mika pikazo'), onlyStyle.json?.missing)

// ── v4：角色卡拆 body/feature、道具多选、视角
const charCard = await call('/dsh-card-library/card?kind=character&id=crab_vampire')
const ch = charCard.json?.card || {}
check('角色卡有 body_segment', Boolean(ch.body_segment), ch.body_segment)
check('角色卡有 feature_segment', Boolean(ch.feature_segment), (ch.feature_segment || '').slice(0, 60))
check('角色卡不再带服装', !/black clothes|dress|apron|maid outfit/i.test(String(ch.body_segment || '') + ' ' + String(ch.feature_segment || '')),
  (ch.feature_segment || '').slice(0, 80))

const lookSplit = await call('/dsh-card-library/card?kind=look&id=look_red_hoodie')
const lk = lookSplit.json?.card || {}
check('造型卡 pose_tags 已清空', !lk.pose_tags || String(lk.pose_tags).trim() === '', lk.pose_tags)
check('造型卡留着 legacy_pose_ref', Boolean(lk.legacy_pose_ref), lk.legacy_pose_ref)

const fromLook = await call('/dsh-card-library/card?kind=pose&id=' + encodeURIComponent(lk.legacy_pose_ref || 'pose_from_red_hoodie'))
check('迁出的动作卡能读', fromLook.status === 200 && Boolean(fromLook.json?.card?.pose_tags), fromLook.json?.card?.pose_tags)

// 道具多选：两件手持合并成一个 holding
const multi = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_wlop_warm_soft',
    lookId: 'look_red_hoodie',
    sceneId: 'sc_rain_street_lookback',
    poseId: 'pose_rain_street_lookback',
    propIds: ['prop_umbrella', 'prop_handbag'],
  },
})
check('propIds 多选 200', multi.status === 200 && multi.json?.ok === true, multi.json?.missing)
check('selection.props 是数组', Array.isArray(multi.json?.selection?.props) && multi.json.selection.props.length === 2,
  multi.json?.selection?.props)
const propSeg = String(multi.json?.segments?.prop || '')
check('两件手持合并成 holding A and B', propSeg.includes('holding') && propSeg.includes(' and '), propSeg)
check('只出现一次 holding 动词', (propSeg.match(/holding/g) || []).length === 1, propSeg)

// 视角：正面机位 + 看镜头
const viewFront = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', lookId: 'look_red_hoodie', view: { angle: 'front', gaze: 'front', shot: 2 } },
})
const vseg = String(viewFront.json?.segments?.view || '')
check('视角段非空', vseg.length > 0, vseg)
check('正面机位出 from front', vseg.includes('from front'), vseg)
check('视线朝机位出 looking at viewer', vseg.includes('looking at viewer'), vseg)
check('景别用视角的（半身）', vseg.includes('upper body'), vseg)
check('view_notes 有推导', Array.isArray(viewFront.json?.segments?.view_notes) && viewFront.json.segments.view_notes.length > 0,
  viewFront.json?.segments?.view_notes)

// 视角优先于环境卡的 camera
const viewOverride = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', sceneId: 'sc_rain_street_lookback', view: { angle: 'back', gaze: 'front', shot: 5 } },
})
const sceneSegV = String(viewOverride.json?.segments?.scene || '')
check('选了视角后场景段不带 from behind', !sceneSegV.includes('from behind'), sceneSegV)
check('选了视角后场景段不带景别', !/\b(wide shot|full body|upper body|cowboy shot)\b/.test(sceneSegV), sceneSegV)

// 背面机位 + 看镜头→回头，且警告异色瞳
const viewBack = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', view: { angle: 'back', gaze: 'back', shot: 3 } },
})
check('背面机位自动取回头', String(viewBack.json?.segments?.view || '').includes('looking back'),
  viewBack.json?.segments?.view)

// 背面机位 + 视线朝前（背对镜头）→眼睛看不到，要警告异色瞳会消失
const viewBackAway = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', view: { angle: 'back', gaze: 'front', shot: 3 } },
})
check('背面背对镜头有异色瞳警告', (viewBackAway.json?.warnings || []).some((w) => w.includes('异色瞳')),
  viewBackAway.json?.warnings)

// 俯拍 + 低头 = 看不见脸
const viewAbove = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', view: { angle: 'above', gaze: 'below', shot: 2 } },
})
check('俯拍+低头有警告', (viewAbove.json?.warnings || []).some((w) => w.includes('脸')), viewAbove.json?.warnings)

// 远景自动降级脸光
const viewWide = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', view: { angle: 'front', gaze: 'front', shot: 5 } },
})
check('远景脸光降级', String(viewWide.json?.segments?.face_light || '').includes('ambient light'),
  viewWide.json?.segments?.face_light)

// 脸光归画风卡：选了视角也要保住画风卡自己的 face_light（n94）
const viewKeepsFace = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_gothic_baroque', view: { angle: 'front', gaze: 'front', shot: 2 } },
})
const keptFace = String(viewKeepsFace.json?.segments?.face_light || '')
check('选视角后保留画风卡脸光（烛光半脸阴影）', keptFace.includes('half of face in shadow'), keptFace)
check('选视角后不再塞通用脸光', !keptFace.includes('face fully lit'), keptFace)

const viewKeepsFace2 = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_halftone_poster', view: { angle: 'right', gaze: 'front', shot: 3 } },
})
check('选视角后保留网点脸', String(viewKeepsFace2.json?.segments?.face_light || '').includes('halftone dots'),
  viewKeepsFace2.json?.segments?.face_light)

// 视角段本身不该再夹带脸光词
check('视角段不夹带脸光', !/catchlight|face fully lit|ambient light/.test(vseg), vseg)

// ── v5：冲突自动处理
//
// 裸露让位：画风卡负面里的压制词按语义槽位剔掉（不是按字面，minusPositive 剔不动）
const nudeFix = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_shadowverse_crisp', lookId: 'nsfw_bathtub_edge' },
})
const nudeNeg = String(nudeFix.json?.negative || '')
check('裸露造型：负面里没有 nipples', !/\bnipples\b/.test(nudeNeg), nudeNeg.slice(0, 120))
check('裸露造型：负面里没有 bare shoulders', !/bare shoulders/.test(nudeNeg), nudeNeg.slice(0, 120))
check('裸露造型：报出自动处理', (nudeFix.json?.autofixes || []).some((f) => f.kind === 'nude'),
  nudeFix.json?.autofixes)
check('裸露造型：正向仍保留 bottomless', String(nudeFix.json?.positive || '').includes('bottomless'),
  nudeFix.json?.segments?.look)
// 带颜色前缀 / 后缀 only 的变体也要剔（`blue panties` / `underwear only`）
const nudeNeg2 = String(nudeFix.json?.negative || '')
check('裸露造型：负面不留任何 panties 变体', !/panties/.test(nudeNeg2), nudeNeg2.slice(0, 120))
check('裸露造型：负面不留 underwear only', !/underwear/.test(nudeNeg2), nudeNeg2.slice(0, 120))

// 不裸的时候不许乱删画风卡负面 —— 否则会把画风的约束一起削掉
const noNudeFix = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_amano_ethereal', lookId: 'look_red_hoodie' },
})
check('非裸露造型：不触发裸露让位', !(noNudeFix.json?.autofixes || []).some((f) => f.kind === 'nude'),
  noNudeFix.json?.autofixes)
check('非裸露造型：画风卡负面保持完整（有 nude 词）',
  /\bnude\b/.test(String(noNudeFix.json?.negative || '')), String(noNudeFix.json?.negative || '').slice(0, 120))

// 露肤让位：造型卡声明了「穿了但要露」，画风卡负面里逼着遮的词要剔掉
const revealFix = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_shadowverse_crisp', lookId: 'look_ballet' },
})
const revealNeg = String(revealFix.json?.negative || '')
check('露肤造型：负面剔掉 bare shoulders', !/bare shoulders/.test(revealNeg), revealNeg.slice(0, 120))
check('露肤造型：负面剔掉 open shirt', !/open shirt/.test(revealNeg), revealNeg.slice(0, 120))
check('露肤造型：报出自动处理', (revealFix.json?.autofixes || []).some((f) => f.kind === 'reveal'),
  revealFix.json?.autofixes)
// 防意外裸体的词不许动 —— 造型卡只说「露」，没说「全裸」
check('露肤造型：防走光的 nipples 仍在负面里', /\bnipples\b/.test(revealNeg), revealNeg.slice(0, 120))
check('露肤造型：正向保留 leotard', String(revealFix.json?.segments?.look_cloth || '').includes('leotard'),
  revealFix.json?.segments?.look_cloth)

// 不露的造型不许触发露肤让位（否则等于把画风卡的约束削掉一半）
const coverFix = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_shadowverse_crisp', lookId: 'look_detective' },
})
check('普通造型：不触发露肤让位', !(coverFix.json?.autofixes || []).some((f) => f.kind === 'reveal'),
  coverFix.json?.autofixes)
check('普通造型：画风卡的 bare shoulders 仍保留', /bare shoulders/.test(String(coverFix.json?.negative || '')),
  String(coverFix.json?.negative || '').slice(0, 120))

// 光照让位：夜景场景 + 压夜景的画风负面
const nightFix = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', sceneId: 'sc_amusement_night' },
})
const nightNeg = String(nightFix.json?.negative || '')
check('夜景：负面剔掉 neon colors', !/neon colors/.test(nightNeg), nightNeg.slice(0, 120))
check('夜景：负面剔掉 dark image', !/dark image/.test(nightNeg), nightNeg.slice(0, 120))
check('夜景：正向保留 neon lights', String(nightFix.json?.positive || '').includes('neon lights'),
  nightFix.json?.segments?.scene)
check('夜景：报出自动处理', (nightFix.json?.autofixes || []).some((f) => f.kind === 'light'),
  nightFix.json?.autofixes)

// 白天场景不许动夜景词（画风卡的暗部约束要留着）
// 注意别拿 sc_rain_street_lookback 当「白天」—— 它的 light_fx 就是 neon lights，
// 触发霓虹让位是正确行为。
const dayFix = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', sceneId: 'sc_balcony_laundry' },
})
check('非夜景：不触发光照让位', !(dayFix.json?.autofixes || []).some((f) => f.kind === 'light'),
  dayFix.json?.autofixes)

// 视线互斥：动作卡自己同时写「看镜头」和「回头」
const gazeA = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', poseId: 'pose_from_school_rooftop_wave' },
})
const gazeSegA = String(gazeA.json?.segments?.pose || '')
check('视线互斥：挥手卡只留一组', !(gazeSegA.includes('looking at viewer') && gazeSegA.includes('looking back')), gazeSegA)
check('视线互斥：挥手卡留看镜头', gazeSegA.includes('looking at viewer'), gazeSegA)

const gazeB = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', poseId: 'pose_postman' },
})
const gazeSegB = String(gazeB.json?.segments?.pose || '')
check('视线互斥：邮差卡（from behind）留回头', gazeSegB.includes('looking back') && !gazeSegB.includes('looking at viewer'), gazeSegB)

// 假警告已删：hold 道具不管有没有勾动作，都自带 holding 动词
const propNoPose = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', propIds: ['prop_uchiwa'], includePose: false },
})
check('道具自带 holding 动词', String(propNoPose.json?.segments?.prop || '').startsWith('holding '),
  propNoPose.json?.segments?.prop)
check('不再报「没勾动作就没 holding」的假警告',
  !(propNoPose.json?.warnings || []).some((w) => w.includes('摆到墙角')), propNoPose.json?.warnings)

// ── v10：穿戴道具与造型重复（propdup）+ 部位槽正则的左边界
const dupHat = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire',
    lookId: 'look_painter', sceneId: 'sc_balcony_laundry', poseId: 'pose_ballet',
    propIds: ['prop_beret'],
  },
})
const dupHatPos = String(dupHat.json?.positive || '')
check('穿戴道具重复：造型已带的贝雷帽只出现一次', (dupHatPos.match(/\bberet\b/gi) || []).length === 1, dupHatPos)
check('穿戴道具重复：报 propdup',
  (dupHat.json?.autofixes || []).some((f) => f.kind === 'propdup'), dupHat.json?.autofixes)
check('穿戴道具重复：道具段被清空', String(dupHat.json?.segments?.prop || '') === '', dupHat.json?.segments?.prop)

// 复合名词：造型写 `flower crown`，道具写 `crown` —— 按词边界也要判成重复
const dupCrown = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire',
    lookId: 'look_flower_field', sceneId: 'sc_balcony_laundry', poseId: 'pose_ballet',
    propIds: ['prop_crown'],
  },
})
check('穿戴道具重复：flower crown 也算已穿（复合名词按词边界比）',
  (dupCrown.json?.autofixes || []).some((f) => f.kind === 'propdup'), dupCrown.json?.autofixes)

// 异款帽子可共存，不能误删
const diffHat = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire',
    lookId: 'look_nurse', sceneId: 'sc_balcony_laundry', poseId: 'pose_ballet',
    propIds: ['prop_beanie'],
  },
})
const diffHatPos = String(diffHat.json?.positive || '')
check('异款帽子共存：护士帽 + 毛线帽都保留',
  /nurse cap/i.test(diffHatPos) && /beanie/i.test(diffHatPos), diffHatPos)
check('异款帽子共存：不报 propdup',
  !(diffHat.json?.autofixes || []).some((f) => f.kind === 'propdup'), diffHat.json?.autofixes)

// 部位槽正则的左边界：围巾 + 王冠不是同一个槽（旧正则把 wearing 里的 ring 当戒指）
const slotFalse = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire',
    lookId: 'look_gothic_candle', sceneId: 'sc_balcony_laundry', poseId: 'pose_ballet',
    propIds: ['prop_scarf', 'prop_crown'],
  },
})
check('部位槽不误报：围巾 + 王冠不算撞槽',
  !(slotFalse.json?.warnings || []).some((w) => w.includes('都占')), slotFalse.json?.warnings)

// 真撞槽必须还报得出来（修左边界不能把功能一起删掉）
const slotTrue = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire',
    lookId: 'look_gothic_candle', sceneId: 'sc_balcony_laundry', poseId: 'pose_ballet',
    propIds: ['prop_necklace', 'prop_choker'],
  },
})
check('部位槽真撞槽仍报警：项链 + 颈环',
  (slotTrue.json?.warnings || []).some((w) => w.includes('都占颈部饰品')), slotTrue.json?.warnings)

// 景别裁决（v6）：视角 > 动作卡 > 环境卡
// 早先 poseSegment() 只返回 pose_tags，动作卡的 camera.shot_size 从没进过正向 ——
// 「动作卡要全身 + 环境卡写 upper body」出来永远只有上半身，而且不报错。
const SHOT_RE = /\b(wide shot|full body|small figure|cowboy shot|upper body|close-up|portrait|bust shot|extreme close-up)\b/gi
const shotWordsOf = (t) => [...new Set((String(t || '').match(SHOT_RE) || []).map((x) => x.toLowerCase()))]

const shotConflict = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', sceneId: 'sc_pov_hands_selfie', poseId: 'pose_amusement_night' },
})
check('景别冲突：按动作卡取 cowboy shot', shotWordsOf(shotConflict.json?.positive).includes('cowboy shot'),
  shotWordsOf(shotConflict.json?.positive))
check('景别冲突：环境卡的 upper body 被撤掉', !shotWordsOf(shotConflict.json?.positive).includes('upper body'),
  shotWordsOf(shotConflict.json?.positive))
check('景别冲突：报出自动处理', (shotConflict.json?.autofixes || []).some((f) => f.kind === 'shot'),
  shotConflict.json?.autofixes)

const shotSame = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', sceneId: 'sc_amusement_night', poseId: 'pose_amusement_night' },
})
check('景别一致：不报自动处理', !(shotSame.json?.autofixes || []).some((f) => f.kind === 'shot'),
  shotSame.json?.autofixes)

const shotPoseOnly = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', poseId: 'pose_beach_midsummer' },
})
check('只有动作卡：景别进正向', shotWordsOf(shotPoseOnly.json?.positive).includes('cowboy shot'),
  shotWordsOf(shotPoseOnly.json?.positive))

// 有 14 张老动作卡把景别写在 pose_tags 里、camera.shot_size 是空的（pose_ballet 就是其一），
// 那些词本来就走 poseSegment 进正向，所以冲突检测也必须认它们。
const shotLegacy = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', poseId: 'pose_ballet' },
})
check('老动作卡：pose_tags 里的景别照样认', shotWordsOf(shotLegacy.json?.positive).includes('full body'),
  shotWordsOf(shotLegacy.json?.positive))

const shotSceneOnly = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', sceneId: 'sc_pov_hands_selfie' },
})
check('只有环境卡：景别照旧', shotWordsOf(shotSceneOnly.json?.positive).includes('upper body'),
  shotWordsOf(shotSceneOnly.json?.positive))

const shotViewWins = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', poseId: 'pose_beach_midsummer', view: { angle: 'front', gaze: 'front', shot: 1 } },
})
check('选了视角：视角景别说了算', shotWordsOf(shotViewWins.json?.positive).includes('close-up'),
  shotWordsOf(shotViewWins.json?.positive))
check('选了视角：动作卡景别不进正向', !shotWordsOf(shotViewWins.json?.positive).includes('cowboy shot'),
  shotWordsOf(shotViewWins.json?.positive))
check('segments 带 shot 段', Boolean(shotPoseOnly.json?.segments?.shot), shotPoseOnly.json?.segments?.shot)

// 镜像
const viewFlip = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', view: { angle: 'right', gaze: 'front', shot: 3, flip: true } },
})
check('flip 透传到返回值', viewFlip.json?.flip === true, viewFlip.json?.flip)

// 道具超 4 件被截断
const tooMany = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_wlop_warm_soft',
    propIds: ['prop_umbrella', 'prop_handbag', 'prop_book', 'prop_cup', 'prop_scarf'],
  },
})
check('道具超 4 件截断', (tooMany.json?.selection?.props || []).length === 4, tooMany.json?.selection?.props)

// 非本机 Host 要被拒
const foreign = await new Promise((resolve) => {
  const res = {
    statusCode: 200,
    writeHead(c, hd) { this.statusCode = c; this.headers = hd; return this },
    end() { resolve({ status: this.statusCode }) },
  }
  route.handler({ method: 'GET', url: '/dsh-card-library/index', headers: { host: 'evil.example.com' }, on() {}, destroy() {} }, res)
})
check('外域 Host 403', foreign.status === 403, foreign.status)

// 工具：直接调 execute，确认它跟路由同一套逻辑
const tool = tools.find((t) => t.name === 'card_library_compose')
if (tool) {
  const out = await tool.execute({ styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire' })
  check('工具输出含画风名', String(out).includes('柔光半写实'), String(out).slice(0, 80))
  check('img2img 画风卡给出底图警告', (Boolean(mangaW && Array.isArray(mangaW.warnings) && mangaW.warnings.some((w) => w.indexOf('img2img') >= 0))), mangaW && mangaW.warnings)
check('工具输出含正向提示词', String(out).includes('正向提示词'), '')
} else {
  check('工具已注册', false, null)
}

// ── 机位裁决（v7）──────────────────────────────────────────────
const vpConflict = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', poseId: 'pose_cam_side_hairflip', sceneId: 'sc_forest_fog' },
})
const vpConflictPos = String(vpConflict.json?.positive || '')
check('机位：动作卡机位进正向', /from side/i.test(vpConflictPos), vpConflictPos.slice(0, 160))
check('机位：环境卡机位被撤掉', !/from behind/i.test(vpConflictPos), vpConflictPos.slice(0, 160))
check('机位：报 viewpoint autofix',
  (vpConflict.json?.autofixes || []).some((a) => a.kind === 'viewpoint'),
  (vpConflict.json?.autofixes || []).map((a) => a.kind))
check('机位：segments 带 viewpoint 段', Boolean(vpConflict.json?.segments?.viewpoint),
  vpConflict.json?.segments?.viewpoint)

const vpAlone = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', poseId: 'pose_cam_low_stretch' },
})
check('机位：只有动作卡时也进正向', /from below/i.test(String(vpAlone.json?.positive || '')),
  String(vpAlone.json?.positive || '').slice(0, 160))
check('机位：只有动作卡不报冲突',
  !(vpAlone.json?.autofixes || []).some((a) => a.kind === 'viewpoint'),
  (vpAlone.json?.autofixes || []).map((a) => a.kind))

// 特殊机位：环境卡是 bird's eye 时，动作卡的 from side 仍要进正向（这是第一版写错的地方）
const vpSpecial = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', poseId: 'pose_cam_side_hairflip', sceneId: 'sc_balcony_laundry' },
})
check('机位：特殊机位下动作卡机位仍进正向',
  /from side/i.test(String(vpSpecial.json?.positive || '')),
  String(vpSpecial.json?.positive || '').slice(0, 160))
check('机位：特殊机位不自动裁决',
  !(vpSpecial.json?.autofixes || []).some((a) => a.kind === 'viewpoint'),
  (vpSpecial.json?.autofixes || []).map((a) => a.kind))
check('机位：特殊机位给 warn', (vpSpecial.json?.warnings || []).some((w) => w.indexOf('特殊手法') >= 0),
  (vpSpecial.json?.warnings || []).slice(0, 4))

// 选了视角时动作卡机位不参与
const vpView = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', poseId: 'pose_cam_side_hairflip', sceneId: 'sc_forest_fog', view: { angle: 'front', gaze: 'front', shot: 3 } },
})
check('机位：选视角后动作卡机位不进', !vpView.json?.segments?.viewpoint, vpView.json?.segments?.viewpoint)
check('机位：选视角后视角机位生效',
  /facing viewer|straight-on/i.test(String(vpView.json?.positive || '')),
  String(vpView.json?.positive || '').slice(0, 200))
check('机位：选视角后不报机位冲突',
  !(vpView.json?.autofixes || []).some((a) => a.kind === 'viewpoint'),
  (vpView.json?.autofixes || []).map((a) => a.kind))

// ── v8：头不在画框里 → 脸光清空 ────────────────────────────────────
const hdA = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_gothic_baroque', characterId: 'crab_vampire', poseId: 'pose_near_hip_back_stand' },
})
check('头出画：脸光清空', String(hdA.json?.segments?.face_light || '').trim() === '',
  hdA.json?.segments?.face_light)
check('头出画：报 headless autofix',
  (hdA.json?.autofixes || []).some((a) => a.kind === 'headless'),
  (hdA.json?.autofixes || []).map((a) => a.kind))
const hdB = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_gothic_baroque', characterId: 'crab_vampire', poseId: 'pose_near_foot_bare' },
})
check('头出画：feet focus 也清空', String(hdB.json?.segments?.face_light || '').trim() === '',
  hdB.json?.segments?.face_light)
// 只有 focus 词、没有显式 head out of frame 的中景必须保住脸光
const hdC = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_gothic_baroque', characterId: 'crab_vampire', poseId: 'pose_near_foot_heel' },
})
check('只有 focus 词：脸光保留', String(hdC.json?.segments?.face_light || '').trim() !== '',
  hdC.json?.segments?.face_light)
check('只有 focus 词：不报 headless',
  !(hdC.json?.autofixes || []).some((a) => a.kind === 'headless'),
  (hdC.json?.autofixes || []).map((a) => a.kind))
// 选视角也压不回头出画
const hdD = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_gothic_baroque', characterId: 'crab_vampire', poseId: 'pose_near_leg_hem',
    view: { angle: 'front', gaze: 'front', shot: 2 },
  },
})
check('头出画：选视角后仍清空', String(hdD.json?.segments?.face_light || '').trim() === '',
  hdD.json?.segments?.face_light)
// 画风卡本来就没脸光时不该空报
const hdE = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_manga_ink_v1', characterId: 'crab_vampire', poseId: 'pose_near_hip_back_stand' },
})
check('无脸光画风：不空报 headless',
  !(hdE.json?.autofixes || []).some((a) => a.kind === 'headless'),
  (hdE.json?.autofixes || []).map((a) => a.kind))

// ── v9：头出画时，环境卡的「对焦在脸上」也要撤 ──────────────────────
const ffA = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_gothic_baroque', characterId: 'crab_vampire',
    poseId: 'pose_near_leg_hem', sceneId: 'sc_bathroom_mirror',
  },
})
check('对焦脸：headless 时场景段不含 focus on face',
  !/focus on face/i.test(String(ffA.json?.segments?.scene || '')),
  ffA.json?.segments?.scene)
check('对焦脸：报 facefocus autofix',
  (ffA.json?.autofixes || []).some((a) => a.kind === 'facefocus'),
  (ffA.json?.autofixes || []).map((a) => a.kind))
const ffB = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_gothic_baroque', characterId: 'crab_vampire',
    poseId: 'pose_ballet', sceneId: 'sc_bathroom_mirror',
  },
})
check('对焦脸：正常动作时 focus on face 保留',
  /focus on face/i.test(String(ffB.json?.segments?.scene || '')),
  ffB.json?.segments?.scene)
check('对焦脸：正常动作时不报 facefocus',
  !(ffB.json?.autofixes || []).some((a) => a.kind === 'facefocus'),
  (ffB.json?.autofixes || []).map((a) => a.kind))
// 景深虚化跟脸无关，headless 时不能一起删
const ffC = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_gothic_baroque', characterId: 'crab_vampire',
    poseId: 'pose_near_leg_hem', sceneId: 'sc_library_quiet',
  },
})
check('对焦脸：headless 时景深词不该被连带删',
  /depth of field|blurry background|deep focus/i.test(String(ffC.json?.segments?.scene || '')) ||
  !/focus on face/i.test(String(ffC.json?.segments?.scene || '')),
  ffC.json?.segments?.scene)

// ── v11：画幅（aspect）裁决 —— 动作卡那份也得算 ─────────────────────
// 改之前只有环境卡的 aspect 被读过：74 张横构图动作卡（all fours / cowgirl
// position 这类）没配环境卡时被塞进 832x1216 竖画布，左右两侧直接裁掉。
const aspA = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_gothic_baroque', characterId: 'crab_vampire', poseId: 'pose_ccc_cowgirl' },
})
check('画幅：横构图动作卡没配环境卡时取横画布',
  aspA.json?.params?.resolution === '1216x832', aspA.json?.params?.resolution)
const aspB = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_gothic_baroque', characterId: 'crab_vampire', poseId: 'pose_ballet' },
})
check('画幅：竖构图动作卡没配环境卡时取竖画布',
  aspB.json?.params?.resolution === '832x1216', aspB.json?.params?.resolution)
const aspC = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_gothic_baroque', characterId: 'crab_vampire',
    poseId: 'pose_ccc_cowgirl', sceneId: 'sc_bathroom_mirror',
  },
})
check('画幅：环境卡与动作卡冲突时按环境卡取',
  aspC.json?.params?.resolution === '832x1216', aspC.json?.params?.resolution)
check('画幅：冲突时报 warning（不是 autofix，配方没改）',
  (aspC.json?.warnings || []).some((w) => /画幅冲突/.test(String(w))) &&
  !(aspC.json?.autofixes || []).some((a) => a.kind === 'aspect'),
  aspC.json?.params?.resolution)
const aspD = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_gothic_baroque', characterId: 'crab_vampire',
    poseId: 'pose_ccc_cowgirl', sceneId: 'sc_ccc_footjob',
  },
})
check('画幅：两边一致时不报画幅冲突',
  !(aspD.json?.warnings || []).some((w) => /画幅冲突/.test(String(w))),
  aspD.json?.params?.resolution)
const aspE = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_manga_ink_v1', characterId: 'crab_vampire',
    poseId: 'pose_ccc_cowgirl', sceneId: 'sc_ccc_footjob',
  },
})
check('画幅：img2img 画风卡的分辨率是硬约束，不被画幅改掉',
  aspE.json?.params?.resolution === '1280x1807', aspE.json?.params?.resolution)

// ── v12：画法让位 —— 非画风卡的负面不许压画风卡主张的画法 ──────────────
// style_mochizuki_cel 主张「赛璐璐 + 平涂 + 线稿」，它自己的负面里没有 cel shading / flat colors。
const medA = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_mochizuki_cel', characterId: 'crab_vampire', lookId: 'look_alchemist' },
})
const medNegA = String(medA.json?.negative || '').toLowerCase()
check('画法：角色卡负面里的 cel shading 被剔掉（画风卡主张赛璐璐）',
  !medNegA.includes('cel shading'), medNegA.includes('cel shading'))
check('画法：角色卡负面里的 flat colors 被剔掉（画风卡主张平涂）',
  !medNegA.includes('flat colors'), medNegA.includes('flat colors'))
check('画法：剔了要报 medium autofix',
  (medA.json?.autofixes || []).some((a) => a.kind === 'medium'),
  (medA.json?.autofixes || []).map((a) => a.kind).join(','))
check('画法：文案说明是角色/造型卡在压画风卡',
  (medA.json?.autofixes || []).some((a) => a.kind === 'medium' && /压制画风卡要的画法/.test(String(a.message))))

// 反向：画风卡没主张的族不许动 —— 造型卡负面里的 painterly 必须留着
const medB = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_mochizuki_cel', characterId: 'crab_vampire', lookId: 'look_flower_field' },
})
check('画法：画风卡没主张的族（厚涂）负面照旧保留',
  String(medB.json?.negative || '').toLowerCase().includes('painterly'),
  String(medB.json?.negative || '').toLowerCase().includes('painterly'))

// 画风卡自己的负面一律不动：shadowverse 自己把 flat colors 压掉，这是它的取舍
const medC = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_shadowverse_crisp', characterId: 'crab_vampire', lookId: 'look_alchemist' },
})
check('画法：画风卡自己的负面不被改（shadowverse 仍压 flat colors）',
  String(medC.json?.negative || '').toLowerCase().includes('flat colors'),
  String(medC.json?.negative || '').toLowerCase().includes('flat colors'))

// 画风卡不主张任何画法族时，一个词都不该动
const medD = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', lookId: 'look_alchemist' },
})
check('画法：画风卡不主张该族时不出 medium autofix',
  !(medD.json?.autofixes || []).some((a) => a.kind === 'medium'),
  (medD.json?.autofixes || []).map((a) => a.kind).join(','))
check('画法：画风卡不主张该族时 cel shading 仍留在负面',
  String(medD.json?.negative || '').toLowerCase().includes('cel shading'),
  String(medD.json?.negative || '').toLowerCase().includes('cel shading'))

// ── v13：闭眼 / 睡着 —— 眼睛专属词必须让位 ────────────────────────
// 动作卡写 closed eyes / sleeping 时，正向里「必须睁眼才看得见」的词全作废：
// heterochromia / symbol-shaped pupils / blue eyes / red eyes / catchlight in both eyes。
// 这些词画不出来，还会把脸拽正、逼角色睁眼。
const shutA = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_gothic_baroque', characterId: 'crab_vampire', poseId: 'pose_sofa_catnap' },
})
const shutPos = String(shutA.json?.positive || '').toLowerCase()
const shutFace = String(shutA.json?.segments?.face_light || '')
check('闭眼：角色段不留异色瞳', !shutPos.includes('heterochromia'), shutPos.slice(0, 200))
check('闭眼：角色段不留瞳孔形状', !shutPos.includes('symbol-shaped pupils'), shutPos.slice(0, 200))
check('闭眼：脸光段不留 catchlight', !/catchlight/i.test(shutFace), shutFace)
check('闭眼：报 eyes autofix', (shutA.json?.autofixes || []).some((a) => a.kind === 'eyes'),
  (shutA.json?.autofixes || []).map((a) => a.kind).join(','))
check('闭眼：脸光的烛光与半脸阴影必须留着', /candle light/i.test(shutFace) && /half of face in shadow/i.test(shutFace), shutFace)
check('闭眼：发型与身材不受影响', shutPos.includes('white hair') && shutPos.includes('thick thighs'), shutPos.slice(0, 200))

// 睁眼动作卡（对照）：异色瞳与 catchlight 一个都不许少
const shutB = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_gothic_baroque', characterId: 'crab_vampire', poseId: 'pose_ballet' },
})
const shutBPos = String(shutB.json?.positive || '').toLowerCase()
check('睁眼对照：异色瞳保留', shutBPos.includes('heterochromia'), shutBPos.slice(0, 200))
check('睁眼对照：不报 eyes autofix', !(shutB.json?.autofixes || []).some((a) => a.kind === 'eyes'),
  (shutB.json?.autofixes || []).map((a) => a.kind).join(','))

// 半闭眼不算全闭 —— 虹膜还露着，异色瞳照样成立，动了反而丢信息
const shutC = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_gothic_baroque', characterId: 'crab_vampire', poseId: 'pose_candle_lowgaze' },
})
const shutCPos = String(shutC.json?.positive || '').toLowerCase()
check('半闭眼：异色瞳保留（眼睛还露着）', shutCPos.includes('heterochromia'), shutCPos.slice(0, 200))
check('半闭眼：不报 eyes autofix', !(shutC.json?.autofixes || []).some((a) => a.kind === 'eyes'),
  (shutC.json?.autofixes || []).map((a) => a.kind).join(','))

// 显式开关 closedEyes:true 也走同一条路
const shutD = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_gothic_baroque', characterId: 'crab_vampire', poseId: 'pose_sofa_catnap', closedEyes: true },
})
check('closedEyes 开关：眼睛词同样清掉',
  !String(shutD.json?.positive || '').toLowerCase().includes('heterochromia'),
  String(shutD.json?.positive || '').slice(0, 200))

// ── v20：闭眼 × 视角视线 —— 视角选择器也不许要求睁眼 ────────────────
// v13 只剥了角色段 / 脸光 / render 三段的眼睛词，视角段的 `looking at viewer`
// 是从「视角选择器」漏回来的第四条缝：它同样在要求睁眼看镜头。
const gazeShutA = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_sofa_catnap',
    view: { angle: 'front', gaze: 'front', shot: 2 },
  },
})
const gazeAPos = String(gazeShutA.json?.positive || '').toLowerCase()
check('闭眼×视角：不留 looking at viewer', !gazeAPos.includes('looking at viewer'), gazeAPos.slice(0, 240))
check('闭眼×视角：不留 eye contact', !gazeAPos.includes('eye contact'), gazeAPos.slice(0, 240))
check('闭眼×视角：机位词必须留着', gazeAPos.includes('from front'), String(gazeShutA.json?.segments?.view || ''))
check('闭眼×视角：景别词必须留着', gazeAPos.includes('upper body'), String(gazeShutA.json?.segments?.view || ''))
check('闭眼×视角：报 gaze autofix', (gazeShutA.json?.autofixes || []).some((a) => a.kind === 'gaze'),
  (gazeShutA.json?.autofixes || []).map((a) => a.kind).join(','))

// 回头档同样让位（`looking back` 要转头找镜头）
const gazeShutB = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_sofa_catnap',
    view: { angle: 'front', gaze: 'back', shot: 2 },
  },
})
const gazeBPos = String(gazeShutB.json?.positive || '').toLowerCase()
check('闭眼×回头视角：不留 looking back', !gazeBPos.includes('looking back'), gazeBPos.slice(0, 240))
check('闭眼×回头视角：报 gaze autofix', (gazeShutB.json?.autofixes || []).some((a) => a.kind === 'gaze'),
  (gazeShutB.json?.autofixes || []).map((a) => a.kind).join(','))

// 睁眼动作卡（对照）：视角视线一个字都不许动
const gazeShutC = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: {
    styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_ballet',
    view: { angle: 'front', gaze: 'front', shot: 2 },
  },
})
const gazeCPos = String(gazeShutC.json?.positive || '').toLowerCase()
check('睁眼对照：视角视线保留', gazeCPos.includes('looking at viewer'), gazeCPos.slice(0, 240))
check('睁眼对照：不报 gaze autofix', !(gazeShutC.json?.autofixes || []).some((a) => a.kind === 'gaze'),
  (gazeShutC.json?.autofixes || []).map((a) => a.kind).join(','))


// ── v14：场景让位 —— 选了环境卡时，画风卡的「空白背景」族必须撤 ──────
// 6 张画风卡的 render 写着 simple / white / empty / pale gradient background
// （那是「没环境卡时别乱加背景」用的）。140 张环境卡全部带 place，
// 两边同时存在就是「要森林」和「要白底」互相拆台。
const BLANK_BG_RE = /\b(white background|simple background|plain background|empty background|solid background|blank background|pale background|pale pink background|pale gradient background)\b/i

const bgA = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_amano_ethereal', characterId: 'crab_vampire', sceneId: 'sc_forest_fog' },
})
const bgAPos = String(bgA.json?.positive || '')
const bgARender = String(bgA.json?.segments?.render || '')
check('场景让位：空白背景词已从正向撤掉', !BLANK_BG_RE.test(bgAPos), bgAPos.slice(0, 200))
check('场景让位：render 段里也不留', !BLANK_BG_RE.test(bgARender), bgARender.slice(0, 200))
check('场景让位：报 bgblank autofix',
  (bgA.json?.autofixes || []).some((a) => a.kind === 'bgblank'),
  (bgA.json?.autofixes || []).map((a) => a.kind).join(','))
check('场景让位：场景段照旧在（森林/雾没被误删）',
  /forest/i.test(String(bgA.json?.segments?.scene || '')), String(bgA.json?.segments?.scene || ''))
check('场景让位：negative space（构图留白）必须留着',
  /negative space/i.test(bgAPos), bgAPos.slice(0, 240))

// 没选环境卡时，白底是画风卡自己的选择，不许动
const bgB = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_amano_ethereal', characterId: 'crab_vampire' },
})
const bgBPos = String(bgB.json?.positive || '')
check('场景让位：没选环境卡时保留白底', BLANK_BG_RE.test(bgBPos), bgBPos.slice(0, 200))
check('场景让位：没选环境卡时不报 bgblank',
  !(bgB.json?.autofixes || []).some((a) => a.kind === 'bgblank'),
  (bgB.json?.autofixes || []).map((a) => a.kind).join(','))

// render 里本来就没有空白词的画风卡不该被报
const bgC = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_gothic_baroque', characterId: 'crab_vampire', sceneId: 'sc_forest_fog' },
})
check('场景让位：无空白词的画风卡不报 bgblank',
  !(bgC.json?.autofixes || []).some((a) => a.kind === 'bgblank'),
  (bgC.json?.autofixes || []).map((a) => a.kind).join(','))

// 水墨 / 望月 / 淡彩 / 全彩条漫 四张也要过
for (const [styleId, sceneId] of [
  ['style_ink_wash', 'sc_wide_forest_path'],
  ['style_mochizuki_cel', 'sc_sock_cafe_crossed'],
  ['style_sketch_wash', 'sc_rain_street_lookback'],
  ['style_manga_fullcolor_v1', 'sc_wide_alley_lookback'],
]) {
  const r = await call('/dsh-card-library/compose', {
    method: 'POST',
    body: { styleId, characterId: 'crab_vampire', sceneId },
  })
  check(`场景让位：${styleId} 空白背景词已撤`,
    !BLANK_BG_RE.test(String(r.json?.positive || '')),
    String(r.json?.positive || '').slice(0, 200))
}

// ── v15：地点让位 —— render 里写死的具体地点要跟环境卡对齐 ──────────
// 全库只有 style_retro90_cel 一张：`city street, telephone pole` 是 90 年代 OVA 的
// 街景设定，配卧室 / 浴室 / 海滩时两段各说一个地方。detailed background 是密度词不是地点。
const STYLE_PLACE_RE = /\b(city street|telephone pole)\b/i

const plA = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_retro90_cel', characterId: 'crab_vampire', sceneId: 'sc_bedroom_sleepshirt' },
})
const plARender = String(plA.json?.segments?.render || '')
check('地点让位：retro90×卧室 render 不再有 city street', !STYLE_PLACE_RE.test(plARender), plARender.slice(-200))
check('地点让位：retro90×卧室 报 place autofix',
  (plA.json?.autofixes || []).some((a) => a.kind === 'place'),
  (plA.json?.autofixes || []).map((a) => a.kind).join(','))
check('地点让位：detailed background（密度词）必须留着',
  /detailed background/i.test(plARender), plARender.slice(-200))
check('地点让位：evening（时间词）不归本规则管，必须留着',
  /evening/i.test(plARender), plARender.slice(-200))
check('地点让位：画法词一个不少（cel shading / flat colors / film grain）',
  /cel shading/i.test(plARender) && /flat colors/i.test(plARender) && /film grain/i.test(plARender),
  plARender.slice(0, 200))

// 街景环境卡 + 街景 render：同族，必须保留且不报
const plB = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_retro90_cel', characterId: 'crab_vampire', sceneId: 'sc_rain_street_lookback' },
})
check('地点让位：街景环境卡时 city street 保留',
  /city street/i.test(String(plB.json?.segments?.render || '')),
  String(plB.json?.segments?.render || '').slice(-200))
check('地点让位：街景环境卡时不报 place（telephone pole 属街景构件，同族不撤）',
  !(plB.json?.autofixes || []).some((a) => a.kind === 'place'),
  (plB.json?.autofixes || []).map((a) => a.kind).join(','))

// 没选环境卡：画风卡自带街景设定是对的，不许动
const plC = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_retro90_cel', characterId: 'crab_vampire' },
})
check('地点让位：没选环境卡时 city street 保留',
  /city street/i.test(String(plC.json?.segments?.render || '')),
  String(plC.json?.segments?.render || '').slice(-200))
check('地点让位：没选环境卡时不报 place',
  !(plC.json?.autofixes || []).some((a) => a.kind === 'place'),
  (plC.json?.autofixes || []).map((a) => a.kind).join(','))

// render 里没有地点词的画风卡不该被报（哥特只有光词、墨线只有密度词）
for (const [styleId, sceneId] of [
  ['style_gothic_baroque', 'sc_beach_midsummer'],
  ['style_manga_ink_v1', 'sc_bedroom_sleepshirt'],
  ['style_ukiyoe_print', 'sc_bedroom_sleepshirt'],
]) {
  const r = await call('/dsh-card-library/compose', {
    method: 'POST',
    body: { styleId, characterId: 'crab_vampire', sceneId },
  })
  check(`地点让位：${styleId} 无地点词不报 place`,
    !(r.json?.autofixes || []).some((a) => a.kind === 'place'),
    (r.json?.autofixes || []).map((a) => a.kind).join(','))
}

// ── v16：params 只收采样键（元数据不许混进采样参数） ────────────────
// 卡里的 params 混着 safe_composition（一句提示词）/ denoise_note / note（中文说明）
// / seed（和顶层 seed 打架）。之前无条件 copy，下游按「键=值」喂采样器会被噎住。
const PARAM_KEYS = ['model', 'lora', 'clip', 'vae', 'steps', 'cfg', 'sampler', 'scheduler', 'resolution', 'denoise']
const nonSampling = (p) => Object.keys(p || {}).filter((k) => PARAM_KEYS.indexOf(k) < 0)

const pmA = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire' },
})
check('参数元数据：crab_vampire 的 safe_composition 不进 params',
  !('safe_composition' in (pmA.json?.params || {})), JSON.stringify(nonSampling(pmA.json?.params)))
check('参数元数据：params 里没有任何非采样键',
  nonSampling(pmA.json?.params).length === 0, JSON.stringify(nonSampling(pmA.json?.params)))
check('参数元数据：报了 param autofix',
  (pmA.json?.autofixes || []).some((a) => a.kind === 'param'),
  (pmA.json?.autofixes || []).map((a) => a.kind).join(','))
check('参数元数据：文案点名「非采样键」',
  (pmA.json?.autofixes || []).some((a) => a.kind === 'param' && /非采样键/.test(a.message)))
check('参数元数据：采样键本身没被误删（12步 cfg2 832x1216）',
  pmA.json?.params?.steps === 12 && pmA.json?.params?.cfg === 2 && pmA.json?.params?.resolution === '832x1216',
  JSON.stringify({ steps: pmA.json?.params?.steps, cfg: pmA.json?.params?.cfg, res: pmA.json?.params?.resolution }))

const pmB = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_manga_ink_v1', characterId: 'crab_vampire' },
})
check('参数元数据：style 的 denoise_note 不进 params',
  !('denoise_note' in (pmB.json?.params || {})))
check('参数元数据：img2img 分辨率硬约束仍是 1280x1807',
  pmB.json?.params?.resolution === '1280x1807', String(pmB.json?.params?.resolution))
check('参数元数据：img2img 仍是 30步 cfg4.5',
  pmB.json?.params?.steps === 30 && pmB.json?.params?.cfg === 4.5,
  JSON.stringify({ steps: pmB.json?.params?.steps, cfg: pmB.json?.params?.cfg }))

const pmC = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', lookId: 'look_alchemist' },
})
check('参数元数据：look 的 params.seed 不被搬进 params',
  !('seed' in (pmC.json?.params || {})), String(pmC.json?.params?.seed))
check('参数元数据：顶层 seed 仍为 null（没有被 params.seed 顶替）',
  pmC.json?.seed === null, String(pmC.json?.seed))
const pmD = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', lookId: 'look_alchemist', seed: 123456 },
})
check('参数元数据：显式 seed 走顶层，params 里不出现第二个 seed',
  pmD.json?.seed === 123456 && !('seed' in (pmD.json?.params || {})),
  JSON.stringify({ top: pmD.json?.seed, inParams: pmD.json?.params?.seed }))
check('参数元数据：配方文本的参数行不含中文说明',
  !/保原图|结构稳|分镜溶解/.test((pmB.json?.text || '').split('\n').find((l) => l.startsWith('参数：')) || ''))

// ── v17：道具 id 去重 + 主名词取「最具体」────────────────────────────
// 重复 id：面板 toggle 不会产生，但 API / 模型工具 / 手写脚本会。
// 主名词：老实现永远取卡里第一个 token，等于永远取最泛的词。
const propOne = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', propIds: ['prop_uchiwa'] },
})
const propDup2 = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', propIds: ['prop_uchiwa', 'prop_uchiwa'] },
})
const propDup3 = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', propIds: ['prop_uchiwa', 'prop_uchiwa', 'prop_uchiwa'] },
})
const propWordCount = (text, w) => (String(text || '').match(new RegExp('\\b' + w + '\\b', 'gi')) || []).length

check('道具 id 去重：重复两件时 uchiwa 只出现一次',
  propWordCount(propDup2.json?.positive, 'uchiwa') === 1, propDup2.json?.segments?.prop)
check('道具 id 去重：不拼出 holding A and A',
  !/uchiwa and uchiwa/i.test(propDup2.json?.positive || ''), propDup2.json?.segments?.prop)
check('道具 id 去重：报 propdup_id',
  (propDup2.json?.autofixes || []).some((a) => a.kind === 'propdup_id'), propDup2.json?.autofixes)
check('道具 id 去重：三件重复也只画一件',
  propWordCount(propDup3.json?.positive, 'uchiwa') === 1, propDup3.json?.segments?.prop)
check('道具 id 去重：不再误报「拿了 3 件东西」',
  !(propDup3.json?.warnings || []).some((w) => /拿了 3 件/.test(w)), propDup3.json?.warnings)
check('道具 id 去重：单件时不报 propdup_id',
  !(propOne.json?.autofixes || []).some((a) => a.kind === 'propdup_id'), propOne.json?.autofixes)

const propOni = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', propIds: ['prop_mask_oni'] },
})
check('道具主名词：狐面取 kitsune mask（不是裸 mask）',
  /holding kitsune mask/i.test(propOni.json?.positive || ''), propOni.json?.segments?.prop)

const propMaskBoth = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', propIds: ['prop_mask', 'prop_mask_oni'] },
})
check('道具主名词：面具 + 狐面拼成 mask and kitsune mask（撞车消失）',
  /holding mask and kitsune mask/i.test(propMaskBoth.json?.positive || ''), propMaskBoth.json?.segments?.prop)

const propCam = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', propIds: ['prop_camera'] },
})
check('道具主名词：动词短语不许当名词（camera 不是 looking through camera）',
  /holding camera\b/i.test(propCam.json?.positive || '') && !/holding looking through/i.test(propCam.json?.positive || ''),
  propCam.json?.segments?.prop)

const propSkate = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', propIds: ['prop_skateboard'] },
})
check('道具主名词：standing on skateboard 被挡下',
  /holding skateboard\b/i.test(propSkate.json?.positive || '') && !/holding standing on/i.test(propSkate.json?.positive || ''),
  propSkate.json?.segments?.prop)

const propCup = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', propIds: ['prop_cup'] },
})
check('道具主名词：cup 变 ceramic cup', /holding ceramic cup/i.test(propCup.json?.positive || ''), propCup.json?.segments?.prop)

const propCandle = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', propIds: ['prop_candle'] },
})
check('道具主名词：candlelight 不被当成 candle 的具体形式',
  /holding candle\b/i.test(propCandle.json?.positive || '') && !/candlelight/i.test(propCandle.json?.segments?.prop || ''),
  propCandle.json?.segments?.prop)

// ── v18：景深裁决（动作卡 dof 进正向 / 冲突时环境卡让位）+ 构图裁决（comp）──
const dofDeep = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_pose_seiza_front' },
})
check('景深：动作卡 deep focus 进正向',
  /deep focus/i.test(dofDeep.json?.positive || ''), dofDeep.json?.segments?.dof)
check('景深：环境卡没 dof 时不报冲突',
  !(dofDeep.json?.autofixes || []).some((a) => a.kind === 'dof'))

const dofSoft = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_cafe_window_rain' },
})
check('景深：动作卡虚化（depth of field / blurry background）进正向',
  /depth of field/i.test(dofSoft.json?.positive || '') && /blurry background/i.test(dofSoft.json?.positive || ''),
  dofSoft.json?.segments?.dof)

const dofClash = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_pose_seiza_front', sceneId: 'sc_cafe_window_rain' },
})
check('景深冲突：动作卡 deep focus 保留',
  /deep focus/i.test(dofClash.json?.positive || ''), dofClash.json?.segments?.dof)
check('景深冲突：环境卡的 blurry background 被撤',
  !/blurry background/i.test(dofClash.json?.positive || ''), dofClash.json?.segments?.scene)
check('景深冲突：报 dof autofix',
  (dofClash.json?.autofixes || []).some((a) => a.kind === 'dof'),
  JSON.stringify((dofClash.json?.autofixes || []).map((a) => a.kind)))

const dofFace = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_pose_seiza_front', sceneId: 'sc_bathroom_mirror' },
})
check('景深不冲突：动作卡 deep focus 与环境卡 focus on face 共存',
  /deep focus/i.test(dofFace.json?.positive || '') && /focus on face/i.test(dofFace.json?.positive || ''))
check('景深不冲突：不报 dof',
  !(dofFace.json?.autofixes || []).some((a) => a.kind === 'dof'))

const dofSame = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_cafe_window_rain', sceneId: 'sc_sock_cafe_crossed' },
})
check('景深两边同族：不报冲突、不撤环境卡',
  !(dofSame.json?.autofixes || []).some((a) => a.kind === 'dof') && /blurry background/i.test(dofSame.json?.positive || ''))

const compNs = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_wide_lighthouse' },
})
check('构图：comp 的 negative space 进正向',
  /negative space/i.test(compNs.json?.positive || ''), compNs.json?.segments?.comp)

const compSym = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_elevator_ride' },
})
check('构图：comp 的 symmetry 进正向',
  /symmetry/i.test(compSym.json?.positive || ''), compSym.json?.segments?.comp)

const compAspect = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_wide_beach_dusk' },
})
check('构图：comp 里的画幅词（landscape）不进正向',
  !/\blandscape\b/i.test(compAspect.json?.positive || ''), compAspect.json?.segments?.comp)

const compProfile = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_near_face_backlight' },
})
check('构图：pose_tags 已有的词不重复加（profile 只出现一次）',
  ((compProfile.json?.positive || '').match(/\bprofile\b/gi) || []).length === 1,
  compProfile.json?.segments?.comp)

const noDof = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_ballet' },
})
check('景深/构图：动作卡没声明时两段都为空',
  !noDof.json?.segments?.dof && !noDof.json?.segments?.comp,
  JSON.stringify({ dof: noDof.json?.segments?.dof, comp: noDof.json?.segments?.comp }))

// ── v19：人数裁决（count_lock 进配方 / 角色段 solo 让位 / 负面压多人让位）──
const cDuo = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_duo_hand_in_hand' },
})
check('人数：count_lock 的 2girls 进正向（pose_tags 没说时）',
  /(^|,\s*)2girls(\s*,|$)/.test(cDuo.json?.positive || ''), cDuo.json?.segments?.count)
check('人数：segments.count_tier 记为 duo', cDuo.json?.segments?.count_tier === 'duo',
  cDuo.json?.segments?.count_tier)
check('人数：非单人档时角色段剥掉 solo',
  !/(^|,\s*)solo(\s*,|$)/.test(cDuo.json?.segments?.character || ''), cDuo.json?.segments?.character)
check('人数：正向不同时出现 solo 与 2girls',
  !(/(^|,\s*)solo(\s*,|$)/.test(cDuo.json?.positive || '') && /2girls/.test(cDuo.json?.positive || '')),
  cDuo.json?.positive)
check('人数：报 count autofix', (cDuo.json?.autofixes || []).some((a) => a.kind === 'count'),
  JSON.stringify(cDuo.json?.autofixes))

const cDuoNeg = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_duo_hand_in_hand', lookId: 'look_alchemist' },
})
check('人数：负面不再压 2girls',
  !/(^|,\s*)2girls(\s*,|$)/.test(cDuoNeg.json?.negative || ''), (cDuoNeg.json?.negative || '').slice(0, 160))
check('人数：负面不再压 multiple girls', !/multiple girls/.test(cDuoNeg.json?.negative || ''))
check('人数：负面不再压 male',
  !/(^|,\s*)male(\s*,|$)/.test(cDuoNeg.json?.negative || ''))
check('人数：画风卡那份的 person 也剔掉',
  !/(^|,\s*)person(\s*,|$)/.test(cDuoNeg.json?.negative || ''))

const cGroup = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_ccc_dp_group' },
})
check('人数：群体档 count_tier = group', cGroup.json?.segments?.count_tier === 'group',
  cGroup.json?.segments?.count_tier)
check('人数：群体档正向含 group sex', /group sex/.test(cGroup.json?.positive || ''),
  cGroup.json?.segments?.count)
check('人数：群体档正向不含 solo', !/(^|,\s*)solo(\s*,|$)/.test(cGroup.json?.positive || ''))

const cSolo = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_ballet', lookId: 'look_alchemist' },
})
check('人数：单人档 count_tier = solo', cSolo.json?.segments?.count_tier === 'solo',
  cSolo.json?.segments?.count_tier)
check('人数：单人档不补人数词', !cSolo.json?.segments?.count, cSolo.json?.segments?.count)
check('人数：单人档角色段仍带 solo', /solo/.test(cSolo.json?.segments?.character || ''),
  cSolo.json?.segments?.character)
check('人数：单人档不出 count autofix',
  !(cSolo.json?.autofixes || []).some((a) => a.kind === 'count'))
check('人数：单人档负面仍压 2girls（该留）', /2girls/.test(cSolo.json?.negative || ''))

const cClash = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_duo_selfie', sceneId: 'sc_bedroom_sleepshirt' },
})
check('人数：冲突按动作卡取 duo', cClash.json?.segments?.count_tier === 'duo',
  cClash.json?.segments?.count_tier)
check('人数：冲突只 warn 不出 autofix',
  !(cClash.json?.autofixes || []).some((a) => a.kind === 'count_conflict'),
  JSON.stringify(cClash.json?.autofixes))

const cSceneOnly = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_wlop_warm_soft', characterId: 'crab_vampire', poseId: 'pose_ballet', sceneId: 'sc_duo_hand_in_hand' },
})
check('人数：动作卡没说时按单人，环境卡人数不构成冲突',
  cSceneOnly.json?.segments?.count_tier === 'solo' &&
  !(cSceneOnly.json?.warnings || []).some((w) => w.includes('人数冲突')),
  JSON.stringify({ tier: cSceneOnly.json?.segments?.count_tier, w: cSceneOnly.json?.warnings }))

// ── v21：脚上穿不穿（动作卡赤足 × 造型卡鞋）────────────────────────
const SHOE_RE_SC = /\b(boots?|shoes?|sneakers?|mary janes|loafers|oxfords|slippers|geta|zouri|uwabaki|sandals|pointe shoes|ballet slippers|cloth shoes|dress shoes|military boots|hiking boots|snow boots|fur boots|wrapped boots|platform shoes|school shoes|high heels|chunky heels|stiletto heels|ankle boots|thigh boots|knee boots|lace-up boots|fur-trimmed boots)\b/i

const footA = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_anime_cel', characterId: 'crab_vampire', lookId: 'look_alchemist', poseId: 'pose_beach_midsummer' },
})
check('脚上穿不穿：赤足动作时造型段的鞋被撤',
  !SHOE_RE_SC.test(footA.json?.segments?.look_cloth || ''),
  String(footA.json?.segments?.look_cloth || '').slice(0, 120))
check('脚上穿不穿：正向里没有鞋', !SHOE_RE_SC.test(footA.json?.positive || ''),
  (String(footA.json?.positive || '').match(SHOE_RE_SC) || [])[0])
check('脚上穿不穿：正向里 bare feet 仍在', /bare feet/i.test(footA.json?.positive || ''))
check('脚上穿不穿：报 footwear autofix',
  (footA.json?.autofixes || []).some((a) => a.kind === 'footwear'),
  (footA.json?.autofixes || []).map((a) => a.kind).join(','))
check('脚上穿不穿：衣服本体不受影响', /long coat/i.test(footA.json?.positive || ''))

const footB = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_anime_cel', characterId: 'crab_vampire', lookId: 'look_alchemist', poseId: 'pose_near_foot_bare' },
})
check('脚上穿不穿：脚部特写时鞋保留（不动配方）',
  SHOE_RE_SC.test(footB.json?.segments?.look_cloth || ''),
  String(footB.json?.segments?.look_cloth || '').slice(0, 120))
check('脚上穿不穿：脚部特写不出 footwear autofix',
  !(footB.json?.autofixes || []).some((a) => a.kind === 'footwear'))
check('脚上穿不穿：脚部特写只 warn',
  (footB.json?.warnings || []).some((w) => w.includes('脚上穿不穿')),
  JSON.stringify((footB.json?.warnings || []).slice(0, 3)))

const footC = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_anime_cel', characterId: 'crab_vampire', lookId: 'look_pajama_block', poseId: 'pose_sock_cafe_crossed' },
})
check('脚上穿不穿：造型卡赤足 × 动作卡带鞋 → 赤足被撤',
  !/bare feet/i.test(footC.json?.segments?.look_cloth || ''),
  String(footC.json?.segments?.look_cloth || '').slice(0, 120))
check('脚上穿不穿：动作卡的鞋还在', /mary janes/i.test(footC.json?.positive || ''))

const footD = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_anime_cel', characterId: 'crab_vampire', lookId: 'look_gothic_candle', poseId: 'pose_poolside_summer' },
})
check('脚上穿不穿：无鞋造型不出 footwear autofix',
  !(footD.json?.autofixes || []).some((a) => a.kind === 'footwear'),
  (footD.json?.autofixes || []).map((a) => a.kind).join(','))
check('脚上穿不穿：无鞋造型时 bare feet 保留', /bare feet/i.test(footD.json?.positive || ''))

const footE = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_anime_cel', characterId: 'crab_vampire', lookId: 'look_gothic_candle', poseId: 'pose_near_leg_kneel' },
})
check('脚上穿不穿：sitting on heels 不算鞋（不触发）',
  !(footE.json?.autofixes || []).some((a) => a.kind === 'footwear'),
  (footE.json?.autofixes || []).map((a) => a.kind).join(','))

const footF = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_anime_cel', characterId: 'crab_vampire', lookId: 'look_alchemist', poseId: 'pose_sock_cafe_crossed' },
})
check('脚上穿不穿：两边都带鞋不报冲突',
  !(footF.json?.autofixes || []).some((a) => a.kind === 'footwear'))
check('脚上穿不穿：两边都带鞋时造型卡的鞋保留',
  SHOE_RE_SC.test(footF.json?.segments?.look_cloth || ''))

// ── v22：整套装束让位（动作卡的装束词 × 造型卡的装束）────────────────
const OUTFIT_RE_SC = /\b(nurse|office lady|serafuku|maid|miko|yukata|kimono|military uniform|qipao|leotard|pajamas)\b/i

const outfitA = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_anime_cel', characterId: 'crab_vampire', lookId: 'look_military', poseId: 'pose_nurse_rounds' },
})
check('整套装束：动作段的 nurse 被撤',
  !/\bnurse\b/i.test(outfitA.json?.segments?.action || ''),
  String(outfitA.json?.segments?.action || '').slice(0, 120))
check('整套装束：正向里 nurse 消失',
  !/\bnurse\b/i.test(outfitA.json?.positive || ''))
check('整套装束：报 outfit autofix',
  (outfitA.json?.autofixes || []).some((a) => a.kind === 'outfit'),
  (outfitA.json?.autofixes || []).map((a) => a.kind).join(','))
check('整套装束：autofix 文案提到造型卡的族',
  (outfitA.json?.autofixes || []).some((a) => a.kind === 'outfit' && /军警/.test(a.message)))
check('整套装束：动作本体不受影响（leg up 还在）',
  /leg up/i.test(outfitA.json?.segments?.action || ''))
check('整套装束：造型卡的军装还在',
  /military uniform/i.test(outfitA.json?.segments?.look_cloth || ''))
check('整套装束：装束 token 之外的词不受影响（embarrassed / white thighhighs）',
  /embarrassed/i.test(outfitA.json?.segments?.action || '') && /white thighhighs/i.test(outfitA.json?.segments?.action || ''))
check('整套装束：action_raw 保留原文',
  /\bnurse\b/i.test(outfitA.json?.segments?.action_raw || ''))

const outfitB = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_anime_cel', characterId: 'crab_vampire', lookId: 'look_qipao', poseId: 'pose_jk_bike_ride' },
})
check('整套装束：跨族 serafuku 被撤（旗袍造型）',
  !/serafuku/i.test(outfitB.json?.segments?.action || ''),
  String(outfitB.json?.segments?.action || '').slice(0, 120))
check('整套装束：旗袍还在', /qipao/i.test(outfitB.json?.segments?.look_cloth || ''))
check('整套装束：报 outfit（旗袍）',
  (outfitB.json?.autofixes || []).some((a) => a.kind === 'outfit'))

const outfitC = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_anime_cel', characterId: 'crab_vampire', lookId: 'look_alchemist', poseId: 'pose_nurse_rounds' },
})
check('整套装束：造型卡无装束族时 nurse 必须保留',
  /\bnurse\b/i.test(outfitC.json?.segments?.action || ''),
  String(outfitC.json?.segments?.action || '').slice(0, 120))
check('整套装束：造型卡无装束族时不报 outfit',
  !(outfitC.json?.autofixes || []).some((a) => a.kind === 'outfit'))

const outfitD = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_anime_cel', characterId: 'crab_vampire', poseId: 'pose_nurse_rounds' },
})
check('整套装束：没选造型卡时 nurse 必须保留',
  /\bnurse\b/i.test(outfitD.json?.segments?.action || ''),
  String(outfitD.json?.segments?.action || '').slice(0, 120))
check('整套装束：没选造型卡时不报 outfit',
  !(outfitD.json?.autofixes || []).some((a) => a.kind === 'outfit'))

const outfitE = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_anime_cel', characterId: 'crab_vampire', lookId: 'look_summer_festival', poseId: 'pose_pose_shrine_kneel' },
})
check('整套装束：同族（miko × 浴衣）也撤，造型卡是权威',
  !/\bmiko\b/i.test(outfitE.json?.segments?.action || ''),
  String(outfitE.json?.segments?.action || '').slice(0, 120))
check('整套装束：浴衣还在', /yukata/i.test(outfitE.json?.segments?.look_cloth || ''))

const outfitF = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_anime_cel', characterId: 'crab_vampire', lookId: 'look_military', poseId: 'pose_ballet' },
})
check('整套装束：动作卡没装束词时不报 outfit',
  !(outfitF.json?.autofixes || []).some((a) => a.kind === 'outfit'))
check('整套装束：军装不受影响', /military uniform/i.test(outfitF.json?.segments?.look_cloth || ''))

// ── v23：环境卡 comp 槽里的画幅词不许当构图词 ───────────────────────
// 病根：comp 槽不过景别过滤，而 `portrait` 在 shotWordLevel() 里是「特写」档，
// 于是「环境卡 portrait + 动作卡 cowboy shot」在正向里并存，模型两边都听。
const SHOT_WORD_V23 = /^(wide shot|small figure|full body|cowboy shot|upper body|close-up|portrait|bust shot|extreme close-up|very close-up)$/i
const shotWordsOfV23 = (pos) => String(pos || '').toLowerCase().split(/[,\n]+/).map((t) => t.trim()).filter((t) => SHOT_WORD_V23.test(t))

const compA = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_amano_softfog', characterId: 'blue_fat_fish', sceneId: 'sc_near_face_classroom', poseId: 'pose_ccc_pov_oral' },
})
check('环境卡 comp 画幅词：portrait 不进正向',
  !/,\s*portrait\s*,|^portrait\s*,|,\s*portrait$/i.test(String(compA.json?.segments?.scene || '')),
  String(compA.json?.segments?.scene || '').slice(0, 160))
check('环境卡 comp 画幅词：正向只剩一个景别词',
  shotWordsOfV23(compA.json?.positive).length === 1,
  JSON.stringify(shotWordsOfV23(compA.json?.positive)))
check('环境卡 comp 画幅词：景别以动作卡为准（cowboy shot）',
  shotWordsOfV23(compA.json?.positive)[0] === 'cowboy shot')
check('环境卡 comp 画幅词：报 warn 说明画幅归画幅裁决',
  (compA.json?.warnings || []).some((w) => w.includes('构图槽里写着画幅词')))
check('环境卡 comp 画幅词：场景其它内容不受影响', /classroom/i.test(String(compA.json?.segments?.scene || '')))

const compB = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_amano_softfog', characterId: 'blue_fat_fish', sceneId: 'sc_wide_beach_dusk', poseId: 'pose_ccc_pov_oral' },
})
check('环境卡 comp 画幅词：landscape 同样不进正向',
  shotWordsOfV23(compB.json?.positive).length === 1,
  JSON.stringify(shotWordsOfV23(compB.json?.positive)))
check('环境卡 comp 画幅词：landscape 时画幅走 1216x832',
  String(compB.json?.params?.resolution || '') === '1216x832',
  String(compB.json?.params?.resolution || ''))

const compC = await call('/dsh-card-library/compose', {
  method: 'POST',
  body: { styleId: 'style_amano_softfog', characterId: 'blue_fat_fish', sceneId: 'sc_forest_fog', poseId: 'pose_ccc_pov_oral' },
})
check('环境卡 comp 画幅词：没有画幅词的 comp 一个字不动（negative space）',
  (compC.json?.warnings || []).every((w) => !w.includes('构图槽里写着画幅词')))

// ── 存卡规则：路由 + 工具 ──────────────────────────────────────────
const rulesRes = await call('/dsh-card-library/rules')
check('规则路由可用', rulesRes.status === 200 && rulesRes.json?.ok === true, rulesRes.status)
check('规则条数 ≥ 12', Array.isArray(rulesRes.json?.rules) && rulesRes.json.rules.length >= 12,
  rulesRes.json?.rules?.length)
check('规则带严重级', (rulesRes.json?.rules || []).every((r) => ['error', 'warn'].includes(r.severity)),
  (rulesRes.json?.rules || []).map((r) => r.severity).join(','))
check('规则含职责边界那条', (rulesRes.json?.rules || []).some((r) => r.id === 'R2_boundary'), '')
check('规则含存卡四连', (rulesRes.json?.rules || []).some((r) => r.id === 'R9_four_step'), '')
check('规则含 Anima 格式', (rulesRes.json?.rules || []).some((r) => r.id === 'R4_tag_format'), '')
check('规则文本非空', typeof rulesRes.json?.text === 'string' && rulesRes.json.text.length > 500,
  rulesRes.json?.text?.length)
check('字段白名单六类齐全', Object.keys(rulesRes.json?.fields || {}).length === 6,
  Object.keys(rulesRes.json?.fields || {}).join(','))
check('缩略图模板存在', Boolean(rulesRes.json?.thumbs && rulesRes.json.thumbs.pose), rulesRes.json?.thumbs)

const lintRes = await call('/dsh-card-library/lint')
check('体检路由可用', lintRes.status === 200 && typeof lintRes.json?.total === 'number', lintRes.status)
check('体检活库 0 error', lintRes.json?.ok === true && (lintRes.json?.errors || []).length === 0,
  (lintRes.json?.errors || []).map((e) => e.rule + ':' + e.id).slice(0, 5))
check('体检能数到全部卡', (lintRes.json?.total || 0) > 600, lintRes.json?.total)
check('体检给出缩略图撞图字段', Array.isArray(lintRes.json?.md5Dup), typeof lintRes.json?.md5Dup)

const rulesTool = tools.find((t) => t.name === 'card_library_save_rules')
if (rulesTool) {
  const out = await rulesTool.execute({ verbose: true })
  check('规则工具输出含职责边界', String(out).includes('职责边界'), String(out).slice(0, 60))
  check('规则工具 verbose 带字段白名单', String(out).includes('字段白名单'), '')
} else {
  check('规则工具已注册', false, null)
}

const lintTool = tools.find((t) => t.name === 'card_library_lint')
if (lintTool) {
  const out = await lintTool.execute({})
  check('体检工具输出含 PASS/FAIL', /PASS|FAIL/.test(String(out)), String(out).slice(0, 80))
  check('体检工具输出含总数', /共 \d+ 张/.test(String(out)), String(out).slice(0, 80))
} else {
  check('体检工具已注册', false, null)
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)
