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
