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
check('counts 齐全', counts.kinds === 6 && counts.styles === 7 && counts.characters === 2 && counts.looks === 47 && counts.scenes === 140 && counts.poses === 316 && counts.props === 122, counts)

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

console.log('')
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)
