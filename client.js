/**
 * dsh-card-library —— 浏览器半端（右侧栏「卡片库」面板）。
 *
 * 六类卡并排浏览：画风 / 角色 / 造型 / 环境 / 动作 / 道具。前五类点一张即选中（再点取消），
 * 道具可以多选（最多 4 件）；另外有一个 3D 视角选择器（左键选机位、右键选视线）。
 * 底部「生成配方」把选中的卡拼成 prompt + negative + 参数，可以复制，也可以
 * 直接塞进输入框。
 *
 * 环境卡只给地点/天气/光线/相机，动作卡只给姿势/动作/表情 —— 这两半原来混在
 * 同一张「环境卡」里（AnimaV5 的 scene_nl 自带人物描述），拼配方时会互相打架。
 *
 * 本文件是手工维护的 __ModuleLoader__.load bundle（与 dsh-raw-html 同一约定），
 * 不含 JSX；改完 `node --check client.js` 验语法，刷新页面即生效。
 */
window.__ModuleLoader__.load({
  id: 'dsh-card-library',
  factory(require) {
    var React = require('react')
    var h = React.createElement

    var PACKAGE_ID = 'card-library'
    var TAB_KIND = 'card-library'
    var PREFIX = '/dsh-card-library'

    var KIND_ORDER = ['style', 'character', 'look', 'scene', 'pose', 'prop']
    var KIND_LABEL = { style: '画风', character: '角色', look: '造型', scene: '环境', pose: '动作', prop: '道具' }
    var LIST_KEY = { style: 'styles', character: 'characters', look: 'looks', scene: 'scenes', pose: 'poses', prop: 'props' }
    var SLOT_HINT = {
      style: '决定画师、渲染档、脸光与后期',
      character: '决定是谁（外貌锁定）',
      look: '决定穿什么（衣服/鞋袜/配饰）',
      scene: '决定在哪、什么光、什么景别（纯环境）',
      pose: '决定在做什么（姿势/动作/表情）',
      prop: '决定手里拿什么、身上挂什么',
    }

    // 主题 token：只用产品自己的别名，不写死颜色，深浅色主题都能跟。
    var C = {
      text: 'var(--dsw-alias-label-primary, CanvasText)',
      dim: 'var(--dsw-alias-label-secondary, GrayText)',
      line: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.28))',
      brand: 'var(--dsw-alias-brand-primary, #4b7bec)',
      ok: 'var(--dsw-alias-state-success-primary, #2f9e44)',
      warn: 'var(--dsw-alias-state-warn-primary, #e8590c)',
      idle: 'var(--dsw-alias-state-idle-primary, rgba(128,128,128,0.5))',
      soft: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.09))',
      soft2: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,0.15))',
    }

    var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    // ─────────────────────────────────────────────────────── 图标
    function Glyph(size) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size || 16, height: size || 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, style: { display: 'block' },
      },
        h('rect', { x: 1.9, y: 2.4, width: 8.2, height: 11.2, rx: 1.2 }),
        h('rect', { x: 6.2, y: 4.6, width: 7.9, height: 9, rx: 1.2, fill: 'none' }),
        h('path', { d: 'M3.4 5.2 h3.4 M3.4 7.6 h3.4 M3.4 10 h2.2' }),
      )
    }

    function SlotGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.3, strokeLinecap: 'round', 'aria-hidden': true, style: { display: 'block', opacity: 0.7 },
      }, h('path', { d: 'M2 4.2 h12 M2 8 h12 M2 11.8 h7' }))
    }

    // ─────────────────────────────────────────────────────── 工具
    function thumbUrl(kind, id) {
      return PREFIX + '/thumb?kind=' + encodeURIComponent(kind) + '&id=' + encodeURIComponent(id)
    }

    function useDebounced(value, ms) {
      var pair = React.useState(value)
      var out = pair[0]
      var set = pair[1]
      React.useEffect(function () {
        var t = window.setTimeout(function () { set(value) }, ms || 160)
        return function () { window.clearTimeout(t) }
      }, [value, ms])
      return out
    }

    /**
     * 找 composer 的输入宿主。
     *
     * DSH 的输入框是 Lexical 的 contenteditable（`[data-composer-input]`），
     * 不是 textarea —— 旧代码只认 textarea，所以「填入输入框」永远返回 false，
     * 按钮看起来就是按不动。这里按 编辑器 → 任意 contenteditable → textarea 的顺序找。
     */
    function composerEditor() {
      var card = document.querySelector('[data-composer-card]')
      var scope = card || document
      var ed = scope.querySelector('[data-composer-input]')
      if (ed) return ed
      var ce = scope.querySelector('[contenteditable="true"]')
      if (ce) return ce
      var ta = scope.querySelector('textarea')
      if (ta) return ta
      return document.querySelector('textarea')
    }

    /** 兜底：模拟一次粘贴，Lexical 的 paste 处理器会把它当正规输入。 */
    function pasteInto(el, text) {
      try {
        var dt = new window.DataTransfer()
        dt.setData('text/plain', text)
        el.dispatchEvent(new window.ClipboardEvent('paste', {
          clipboardData: dt, bubbles: true, cancelable: true,
        }))
        return true
      } catch (e) {
        return false
      }
    }

    /**
     * 把文本塞进 composer。
     *
     * contenteditable 走 execCommand('insertText')：它会真的触发 beforeinput，
     * Lexical 才认；直接改 textContent 会被下次渲染抹掉。写完后回读校验，
     * 只有真进去了才报成功。
     */
    function fillComposer(text) {
      try {
        var el = composerEditor()
        if (!el) return false

        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          var desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
          if (desc && desc.set) desc.set.call(el, text)
          else el.value = text
          el.dispatchEvent(new window.Event('input', { bubbles: true }))
          el.focus()
          return el.value === text
        }

        el.focus()
        try {
          var sel = window.getSelection()
          var range = document.createRange()
          range.selectNodeContents(el)
          sel.removeAllRanges()
          sel.addRange(range)
        } catch (e) { /* 选区失败就让 execCommand 自己插在光标处 */ }

        var ok = false
        try { ok = document.execCommand('insertText', false, text) } catch (e) { ok = false }
        if (!ok || !el.textContent) ok = pasteInto(el, text)

        var got = (el.textContent || '').replace(/\s+/g, ' ').trim()
        var want = String(text).replace(/\s+/g, ' ').trim()
        return got.length > 0 && (got === want || got.indexOf(want.slice(0, 40)) >= 0 || want.indexOf(got.slice(0, 40)) >= 0)
      } catch (e) {
        return false
      }
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text)
          return true
        }
      } catch (e) { /* 走兜底 */ }
      try {
        var ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        return true
      } catch (e) {
        return false
      }
    }

    // ─────────────────────────────────────────────────────── 小组件
    function Pill(props) {
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        disabled: props.disabled,
        title: props.title,
        style: {
          appearance: 'none', border: '1px solid ' + (props.active ? C.brand : C.line),
          background: props.active ? 'color-mix(in srgb, ' + C.brand + ' 14%, transparent)' : 'transparent',
          color: props.active ? C.brand : C.text,
          borderRadius: 999, padding: '3px 10px', fontSize: 11.5, lineHeight: 1.5,
          cursor: props.disabled ? 'default' : 'pointer', opacity: props.disabled ? 0.45 : 1,
          whiteSpace: 'nowrap',
        },
      }, props.children)
    }

    function Row(props) {
      return h('div', {
        style: Object.assign({
          display: 'flex', alignItems: 'center', gap: 6,
        }, props.style || {}),
      }, props.children)
    }

    /** 缩略图：没有 thumb 的卡画一个文字砖，不去请求 404。 */
    function Thumb(props) {
      var failed = React.useState(false)
      var bad = failed[0]
      var setBad = failed[1]
      var box = {
        width: '100%', aspectRatio: props.ratio || '3 / 4',
        borderRadius: 6, overflow: 'hidden', background: C.soft2,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }
      if (props.src && !bad) {
        return h('div', { style: box },
          h('img', {
            src: props.src, alt: props.alt || '', loading: 'lazy', draggable: false,
            onError: function () { setBad(true) },
            style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
          }))
      }
      return h('div', { style: Object.assign({}, box, { padding: 6 }) },
        h('span', {
          style: {
            fontSize: 10.5, lineHeight: 1.35, color: C.dim, textAlign: 'center',
            overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical',
          },
        }, props.label || props.alt || '—'))
    }

    function CardTile(props) {
      var card = props.card
      var on = props.selected
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        title: card.name + (card.desc ? '\n' + card.desc : ''),
        style: {
          appearance: 'none', padding: 4, borderRadius: 8, textAlign: 'left',
          border: '1px solid ' + (on ? C.brand : C.line),
          background: on ? 'color-mix(in srgb, ' + C.brand + ' 10%, transparent)' : 'transparent',
          boxShadow: on ? '0 0 0 1px ' + C.brand + ' inset' : 'none',
          cursor: 'pointer', position: 'relative', minWidth: 0,
        },
      },
        h(Thumb, {
          src: card.thumb ? thumbUrl(props.kind, card.id) : null,
          alt: card.name,
          label: card.name,
          // 缩略图比例跟着卡类走，跟出图时的画幅对齐：环境 16:9、动作 3:4、道具 1:1
          ratio: props.kind === 'scene' ? '16 / 9' : (props.kind === 'prop' ? '1 / 1' : '3 / 4'),
        }),
        h('div', {
          style: {
            fontSize: 11, lineHeight: 1.35, marginTop: 4, color: C.text,
            overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          },
        }, card.name),
        card.nsfw ? h('span', {
          style: {
            position: 'absolute', top: 7, right: 7, fontSize: 9, padding: '1px 4px',
            borderRadius: 4, background: 'rgba(0,0,0,0.6)', color: '#fff', letterSpacing: 0.4,
          },
        }, 'NSFW') : null,
        // 只有机位、没有场所的环境卡 —— 选它等于没给环境，必须当场标出来
        props.kind === 'scene' && card.pose_only ? h('span', {
          style: {
            position: 'absolute', bottom: 7, left: 7, fontSize: 9, padding: '1px 4px',
            borderRadius: 4, background: 'rgba(0,0,0,0.6)', color: '#fff', letterSpacing: 0.4,
          },
        }, '无机位·无环境') : null,
        on ? h('span', {
          style: {
            position: 'absolute', top: 7, left: 7, width: 15, height: 15, borderRadius: 999,
            background: C.brand, color: '#fff', fontSize: 10, lineHeight: '15px', textAlign: 'center',
          },
        }, '✓') : null,
      )
    }

    // ─────────────────────────────────────────────────────── 详情
    function Detail(props) {
      var kind = props.kind
      var card = props.card
      if (!card) return null
      var lines = []
      function push(label, value) {
        var v = String(value == null ? '' : value).trim()
        if (v) lines.push({ label: label, value: v })
      }
      if (kind === 'style') {
        // img2img 专用的画风卡（漫画墨线）：必须把「要底图」这件事摆在最前面，
        // 否则用户会以为它和别的画风卡一样，选了就能直接 text2img 出图（n81/n82）。
        if (card.mode === 'img2img' || card.init_required) {
          push('⚠ 用法', 'img2img 专用 —— 必须给一张底图，text2img 画不出这套画法')
          push('工作流', card.init_hint && card.init_hint.workflow)
          push('底图', card.init_hint && card.init_hint.what)
          push('denoise', card.params && card.params.denoise)
          push('denoise 说明', card.params && card.params.denoise_note)
          push('上色用法', card.colorize && card.colorize.note)
        }
        push('画师段', card.artist_segment)
        push('渲染档', card.render)
        push('脸光段', card.face_light)
        push('后期', card.post ? JSON.stringify(card.post) : '')
        push('说明', card.description)
      } else if (kind === 'character') {
        push('身材', card.body_segment)
        push('基础特色', card.feature_segment)
        push('默认造型', card.default_look)
        push('角色段（老配方兼容）', card.character_segment)
        push('易错点', card.common_mistakes)
        push('说明', card.description)
      } else if (kind === 'look') {
        push('衣服', card.look_tags != null ? card.look_tags : card.tags)
        push('动作', card.pose_tags)
        push('说明', card.description)
        push('备注', card.look_notes && JSON.stringify(card.look_notes))
      } else if (kind === 'pose') {
        var pcam = card.camera || {}
        push('动作 tags', card.pose_tags)
        push('相机', Object.keys(pcam).map(function (k) { return k + '=' + pcam[k] }).join(', '))
        push('原本场景', card.suggest_place)
        push('动作描述', card.pose_nl)
        push('说明', card.description)
        push('分组', card.group_title || card.group)
      } else if (kind === 'prop') {
        push('道具 tags', card.prop_tags)
        push('拿在手里', card.hold ? '是（拼配方会自动补 holding）' : '否（穿戴 / 摆件）')
        push('常配动作', card.suggest_pose)
        push('道具描述', card.prop_nl)
        push('说明', card.description)
        push('分组', card.group_title || card.group)
      } else {
        var tags = card.tags || {}
        var kv = Object.keys(tags).map(function (k) { return k + '=' + tags[k] }).join(', ')
        var cam = card.camera || {}
        var camKv = Object.keys(cam).map(function (k) { return k + '=' + cam[k] }).join(', ')
        push('环境', kv)
        push('相机', camKv)
        push('附加', card.extra)
        push('景别补充', card.extra_camera)
        push('环境描述', card.env_nl)
        push('分组', card.group_title || card.group)
      }
      var p = card.params || {}
      if (p.model) push('参数', p.model + ' · ' + (p.steps || '?') + '步 cfg' + (p.cfg || '?') + ' · ' + (p.resolution || '?'))

      return h('div', {
        style: {
          border: '1px solid ' + C.line, borderRadius: 8, padding: 8, marginTop: 8,
          background: C.soft, display: 'flex', flexDirection: 'column', gap: 5,
          maxHeight: 230, overflowY: 'auto',
        },
      },
        h(Row, { style: { justifyContent: 'space-between' } },
          h('span', { style: { fontSize: 12, fontWeight: 600, color: C.text } }, card.name),
          h('span', { style: { fontSize: 10, color: C.dim, fontFamily: MONO } }, card.id)),
        lines.length === 0 ? h('span', { style: { fontSize: 11, color: C.dim } }, '（这张卡没有附加说明）') : null,
        lines.map(function (it, i) {
          return h('div', { key: i, style: { fontSize: 11, lineHeight: 1.45 } },
            h('span', { style: { color: C.dim } }, it.label + '：'),
            h('span', { style: { color: C.text, wordBreak: 'break-word' } }, it.value))
        }))
    }

    // ─────────────────────────────────────────────────────── 视角（3D 选择器）
    // 十个方位节点围成一个球，中间站人形剪影。
    // 左键点节点 = 选机位（相机在哪），右键点节点 = 选视线（人物往哪看）。
    // 视角是「关系」不是「卡」—— 同时只有一个机位、一个视线，做成卡会出现
    // 「正面 + 背面」这种非法组合，所以单独做成选择器。
    var VIEW_NODES = [
      { id: 'front', label: '正', az: 0, el: 0 },
      { id: 'front_right', label: '前右', az: 45, el: 0 },
      { id: 'right', label: '右', az: 90, el: 0 },
      { id: 'back_right', label: '后右', az: 135, el: 0 },
      { id: 'back', label: '后', az: 180, el: 0 },
      { id: 'back_left', label: '后左', az: 225, el: 0 },
      { id: 'left', label: '左', az: 270, el: 0 },
      { id: 'front_left', label: '前左', az: 315, el: 0 },
      { id: 'above', label: '上', az: 0, el: 90 },
      { id: 'below', label: '下', az: 0, el: -90 },
    ]
    var VIEW_ZH = {
      front: '正面', front_right: '前右', right: '右侧', back_right: '后右',
      back: '背面', back_left: '后左', left: '左侧', front_left: '前左',
      above: '俯拍', below: '仰拍',
    }
    var VIEW_SHOT_LABEL = ['大特写', '特写', '半身', '七分身', '全身', '远景']
    var VIEW_R = 88
    var VIEW_EMPTY = { angle: null, gaze: null, shot: 3, flip: false }

    function ViewPicker(props) {
      var v = props.view || VIEW_EMPTY
      var angle = v.angle || null
      var gaze = v.gaze || null
      var shot = typeof v.shot === 'number' ? v.shot : 3
      var flip = v.flip === true

      var ws = React.useState({ yaw: -22, pitch: 14 })
      var world = ws[0]
      var setWorld = ws[1]
      var drag = React.useRef(null)

      function emit(patch) {
        props.onChange(Object.assign({ angle: angle, gaze: gaze, shot: shot, flip: flip }, patch))
      }
      function onDown(e) {
        drag.current = { x: e.clientX, y: e.clientY, yaw: world.yaw, pitch: world.pitch }
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) { /* 忽略 */ }
      }
      function onMove(e) {
        var d = drag.current
        if (!d) return
        setWorld({
          yaw: d.yaw + (e.clientX - d.x) * 0.6,
          pitch: Math.max(-68, Math.min(68, d.pitch - (e.clientY - d.y) * 0.4)),
        })
      }
      function onUp() { drag.current = null }

      var stage = h('div', {
        onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerLeave: onUp,
        style: {
          position: 'relative', height: 186, margin: '4px 0 6px',
          perspective: 700, cursor: 'grab', touchAction: 'none',
          borderRadius: 8, border: '1px solid ' + C.line,
          background: 'radial-gradient(circle at 50% 46%, ' + C.soft2 + ', transparent 72%)',
          overflow: 'hidden',
        },
      },
        h('div', {
          style: {
            position: 'absolute', left: '50%', top: '50%', width: 0, height: 0,
            transformStyle: 'preserve-3d',
            transform: 'rotateX(' + world.pitch + 'deg) rotateY(' + world.yaw + 'deg)',
          },
        },
          h('div', {
            style: { position: 'absolute', left: -16, top: -46, width: 32, height: 92, pointerEvents: 'none' },
          },
            h('div', { style: { position: 'absolute', left: 8, top: 0, width: 16, height: 16, borderRadius: 999, background: C.dim, opacity: 0.5 } }),
            h('div', { style: { position: 'absolute', left: 4, top: 17, width: 24, height: 38, borderRadius: 6, background: C.dim, opacity: 0.32 } }),
            h('div', { style: { position: 'absolute', left: 9, top: 56, width: 14, height: 34, borderRadius: 5, background: C.dim, opacity: 0.24 } })),
          VIEW_NODES.map(function (n) {
            var isCam = angle === n.id
            var isGaze = gaze === n.id
            return h('button', {
              key: n.id, type: 'button',
              title: '左键＝机位，右键＝视线',
              onClick: function (e) { e.stopPropagation(); emit({ angle: n.id }) },
              onContextMenu: function (e) { e.preventDefault(); e.stopPropagation(); emit({ gaze: n.id }) },
              style: {
                position: 'absolute', left: -17, top: -11, width: 34, height: 22,
                transform: 'rotateY(' + n.az + 'deg) rotateX(' + (-n.el) + 'deg) translateZ(' + VIEW_R + 'px)',
                appearance: 'none', padding: 0, borderRadius: 5, cursor: 'pointer',
                fontSize: 9.5, lineHeight: '20px', textAlign: 'center',
                border: '1px solid ' + (isCam ? C.brand : (isGaze ? C.warn : C.line)),
                background: isCam ? C.brand : (isGaze ? 'color-mix(in srgb, ' + C.warn + ' 22%, transparent)' : C.soft),
                color: isCam ? '#fff' : C.text,
                opacity: isCam || isGaze ? 1 : 0.72,
              },
            }, n.label)
          })))

      var info = h('div', { style: { fontSize: 10.5, lineHeight: 1.6, color: C.dim } },
        h('div', null, '机位：', h('span', { style: { color: angle ? C.brand : C.dim } }, angle ? VIEW_ZH[angle] : '未选（跟随环境卡）')),
        h('div', null, '视线：', h('span', { style: { color: gaze ? C.warn : C.dim } }, gaze ? VIEW_ZH[gaze] : '未选（跟随动作卡）')))

      var shots = h(Row, { style: { gap: 3, flexWrap: 'wrap', marginTop: 5 } },
        VIEW_SHOT_LABEL.map(function (label, i) {
          return h(Pill, { key: label, active: shot === i, onClick: function () { emit({ shot: i }) } }, label)
        }))

      var tools = h(Row, { style: { gap: 4, marginTop: 5 } },
        h(Pill, {
          active: flip, onClick: function () { emit({ flip: !flip }) },
          title: '左右方向没有对应 tag，靠后期 ImageOps.mirror',
        }, flip ? '镜像 ●' : '镜像'),
        h(Pill, { onClick: function () { props.onChange(null) }, title: '回到跟随卡片的机位 / 视线' }, '清空视角'))

      return h('div', {
        style: { border: '1px solid ' + C.line, borderRadius: 8, padding: 7, marginBottom: 8, background: C.soft },
      },
        h(Row, { style: { justifyContent: 'space-between' } },
          h('span', { style: { fontSize: 11.5, fontWeight: 600, color: C.text } }, '视角'),
          h('span', { style: { fontSize: 9.5, color: C.dim } }, '左键机位 · 右键视线 · 拖动旋转')),
        stage, info, shots, tools)
    }

    // ─────────────────────────────────────────────────────── 配方
    function Recipe(props) {
      var r = props.recipe
      if (!r) return null
      var text = r.text || ''
      var copyDone = React.useState(false)
      var done = copyDone[0]
      var setDone = copyDone[1]
      // null=待命 / 'ok'=已填入 / 'fail'=没找到输入框，三种状态都给回话
      var sent = React.useState(null)
      var wasSent = sent[0]
      var setSent = sent[1]
      return h('div', {
        style: {
          border: '1px solid ' + (r.ok ? C.ok : C.warn), borderRadius: 8, padding: 8,
          marginTop: 8, background: C.soft, display: 'flex', flexDirection: 'column', gap: 6,
        },
      },
        h(Row, { style: { justifyContent: 'space-between' } },
          h('span', { style: { fontSize: 12, fontWeight: 600, color: r.ok ? C.ok : C.warn } },
            r.ok ? '配方已生成' : '缺卡：' + (r.missing || []).join(', ')),
          h('span', { style: { fontSize: 10, color: C.dim } },
            (r.params && r.params.resolution) || '')),
        // 自动处理过的冲突用绿色标出来 —— 配方已经和卡里的原样不同了，
        // 用户必须第一眼看见，否则会以为插件没按卡执行。
        r.autofixes && r.autofixes.length ? h('div', {
          style: {
            fontSize: 10.5, lineHeight: 1.5, color: C.ok, padding: '4px 6px',
            borderLeft: '2px solid ' + C.ok, background: C.soft2, borderRadius: 4,
          },
        }, r.autofixes.map(function (f, i) {
          return h('div', { key: i }, '✔ ' + f.message)
        })) : null,
        r.warnings && r.warnings.length ? h('div', {
          style: {
            fontSize: 10.5, lineHeight: 1.5, color: C.warn, padding: '4px 6px',
            borderLeft: '2px solid ' + C.warn, background: C.soft2, borderRadius: 4,
          },
        }, r.warnings.map(function (w, i) {
          return h('div', { key: i }, '· ' + w)
        })) : null,
        h('pre', {
          style: {
            margin: 0, padding: 7, borderRadius: 6, background: C.soft2,
            fontFamily: MONO, fontSize: 10.5, lineHeight: 1.5, color: C.text,
            maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          },
        }, text),
        h(Row, { style: { flexWrap: 'wrap' } },
          h(Pill, {
            onClick: function () {
              if (copyText(text)) { setDone(true); window.setTimeout(function () { setDone(false) }, 1200) }
            },
          }, done ? '已复制' : '复制配方'),
          h(Pill, {
            onClick: function () {
              var ok = fillComposer(text)
              setSent(ok ? 'ok' : 'fail')
              window.setTimeout(function () { setSent(null) }, 1600)
            },
          }, wasSent === 'ok' ? '已填入输入框' : wasSent === 'fail' ? '没找到输入框' : '填入输入框'),
          h(Pill, {
            onClick: function () { props.onClear() },
          }, '清空'))
      )
    }

    /**
     * 存卡规则 + 全库体检。
     *
     * 规则正文只存在 rules.js 里，面板不抄一份 —— 抄一份就会两边漂。
     * 这里只做两件事：把 /rules 的清单画出来，把 /lint 的结果画出来。
     */
    function RulesPane() {
      var rulesState = React.useState({ loading: true, error: null, data: null })
      var rules = rulesState[0]
      var setRules = rulesState[1]

      var lintState = React.useState(null)
      var lint = lintState[0]
      var setLint = lintState[1]

      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      React.useEffect(function () {
        var cancelled = false
        fetch(PREFIX + '/rules')
          .then(function (res) { return res.json() })
          .then(function (payload) {
            if (cancelled) return
            if (!payload || !payload.ok) throw new Error((payload && payload.error) || '读取失败')
            setRules({ loading: false, error: null, data: payload })
          })
          .catch(function (err) {
            if (!cancelled) setRules({ loading: false, error: String((err && err.message) || err), data: null })
          })
        return function () { cancelled = true }
      }, [])

      function runLint() {
        if (busy) return
        setBusy(true)
        fetch(PREFIX + '/lint')
          .then(function (res) { return res.json() })
          .then(function (payload) { setLint(payload) })
          .catch(function (err) { setLint({ ok: false, error: String((err && err.message) || err) }) })
          .then(function () { setBusy(false) })
      }

      if (rules.loading) {
        return h('div', { style: { fontSize: 12, color: C.dim, padding: '10px 0' } }, '正在读取规则…')
      }
      if (rules.error || !rules.data) {
        return h('div', { style: { fontSize: 12, color: C.warn, padding: '10px 0' } },
          rules.error || '没有规则数据')
      }

      var list = rules.data.rules || []
      var hard = list.filter(function (r) { return r.severity === 'error' })
      var soft = list.filter(function (r) { return r.severity !== 'error' && !r.manual })
      var manual = list.filter(function (r) { return r.manual })

      function section(title, arr, color) {
        if (!arr.length) return null
        return h('div', { style: { marginBottom: 10 } },
          h('div', {
            style: { fontSize: 11, fontWeight: 600, color: color, marginBottom: 4, letterSpacing: 0.2 },
          }, title + '（' + arr.length + '）'),
          arr.map(function (r) {
            return h('div', {
              key: r.id,
              style: {
                fontSize: 10.5, lineHeight: 1.55, padding: '4px 6px', marginBottom: 3,
                borderRadius: 4, background: C.soft, borderLeft: '2px solid ' + color,
              },
            },
              h('div', { style: { color: C.text, fontWeight: 600 } }, r.title),
              h('div', { style: { color: C.dim } }, r.why),
              r.kinds && r.kinds.length
                ? h('div', { style: { color: C.dim, fontSize: 10, marginTop: 1 } },
                  '适用：' + r.kinds.map(function (k) { return KIND_LABEL[k] || k }).join(' / '))
                : null)
          }))
      }

      var lintBox = null
      if (lint && !lint.error) {
        var errs = lint.errors || []
        var warns = lint.warnings || []
        var dups = lint.md5Dup || []
        lintBox = h('div', {
          style: {
            border: '1px solid ' + (lint.ok ? C.ok : C.warn), borderRadius: 8, padding: 8,
            marginBottom: 10, background: C.soft, fontSize: 10.5, lineHeight: 1.55,
          },
        },
          h('div', { style: { fontWeight: 600, color: lint.ok ? C.ok : C.warn, marginBottom: 3 } },
            (lint.ok ? '✔ 体检通过' : '✖ 体检未通过') + '　' + (lint.total || 0) + ' 张卡　'
            + errs.length + ' 错 / ' + warns.length + ' 警 / ' + dups.length + ' 组撞图'),
          errs.slice(0, 12).map(function (e, i) {
            return h('div', { key: 'e' + i, style: { color: C.warn } },
              '✖ ' + e.id + '　[' + e.rule + '] ' + e.msg)
          }),
          errs.length > 12 ? h('div', { style: { color: C.dim } }, '…还有 ' + (errs.length - 12) + ' 条错误') : null,
          warns.slice(0, 10).map(function (w, i) {
            return h('div', { key: 'w' + i, style: { color: C.dim } },
              '· ' + w.id + '　[' + w.rule + '] ' + w.msg)
          }),
          warns.length > 10 ? h('div', { style: { color: C.dim } }, '…还有 ' + (warns.length - 10) + ' 条提醒') : null)
      } else if (lint && lint.error) {
        lintBox = h('div', { style: { fontSize: 11, color: C.warn, marginBottom: 10 } }, lint.error)
      }

      return h('div', null,
        h(Row, { style: { justifyContent: 'space-between', marginBottom: 8 } },
          h('span', { style: { fontSize: 11, color: C.dim } }, '规则版本 ' + (rules.data.version || '?')),
          h(Pill, { onClick: runLint, disabled: busy }, busy ? '体检中…' : '跑一次全库体检')),
        lintBox,
        h('div', {
          style: { fontSize: 10.5, color: C.dim, lineHeight: 1.55, marginBottom: 8 },
        }, '硬错会挡住入库；提醒是历史数据或需要人来判断的情况，不挡。'),
        section('硬性规则', hard, C.warn),
        section('提醒', soft, C.dim),
        section('只能人工确认', manual, C.brand))
    }

    // ─────────────────────────────────────────────────────── 主体
    function Panel() {
      var idxState = React.useState({ loading: true, error: null, index: null, root: null })
      var idx = idxState[0]
      var setIdx = idxState[1]

      var kindState = React.useState('style')
      var kind = kindState[0]
      var setKind = kindState[1]

      var qState = React.useState('')
      var query = qState[0]
      var setQuery = qState[1]
      var dq = useDebounced(query, 160)

      var groupState = React.useState('all')
      var group = groupState[0]
      var setGroup = groupState[1]

      var selState = React.useState({ style: null, character: null, look: null, scene: null, pose: null, props: [] })
      var sel = selState[0]
      var setSel = selState[1]

      var viewState = React.useState(VIEW_EMPTY)
      var view = viewState[0]
      var setView = viewState[1]

      var detailState = React.useState(null)
      var detail = detailState[0]
      var setDetail = detailState[1]

      var recipeState = React.useState(null)
      var recipe = recipeState[0]
      var setRecipe = recipeState[1]

      var seedState = React.useState('')
      var seed = seedState[0]
      var setSeed = seedState[1]

      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      // 两个页签：选卡拼配方 / 看存卡规则与全库体检。
      var tabState = React.useState('cards')
      var tab = tabState[0]
      var setTab = tabState[1]

      var load = React.useCallback(function () {
        setIdx(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
        fetch(PREFIX + '/index')
          .then(function (res) { return res.json() })
          .then(function (payload) {
            if (!payload || !payload.ok) throw new Error((payload && payload.error) || '读取失败')
            setIdx({ loading: false, error: null, index: payload.index, root: payload.root })
          })
          .catch(function (err) {
            setIdx({ loading: false, error: String((err && err.message) || err), index: null, root: null })
          })
      }, [])

      React.useEffect(function () { load() }, [load])

      var list = React.useMemo(function () {
        if (!idx.index) return []
        var all = idx.index[LIST_KEY[kind]] || []
        var needle = dq.trim().toLowerCase()
        return all.filter(function (it) {
          if (!it) return false
          if ((kind === 'scene' || kind === 'pose' || kind === 'prop') && group !== 'all' && it.group !== group) return false
          if (!needle) return true
          var hay = (it.id + ' ' + (it.name || '') + ' ' + (it.desc || '') + ' ' + (it.theme || '')
            + ' ' + (it.kw || '') + ' ' + (it.tags || '') + ' ' + (it.group_title || '')).toLowerCase()
          return hay.indexOf(needle) >= 0
        })
      }, [idx.index, kind, dq, group])

      var groups = React.useMemo(function () {
        if (!idx.index) return []
        var seen = {}
        var out = []
        var src = kind === 'pose' ? (idx.index.poses || []) : (kind === 'prop' ? (idx.index.props || []) : (idx.index.scenes || []))
        src.forEach(function (s) {
          if (!s || !s.group) return
          if (seen[s.group]) return
          seen[s.group] = true
          out.push({ id: s.group, title: s.group_title || s.group })
        })
        return out
      }, [idx.index, kind])

      function pick(k, id) {
        if (k === 'prop') {
          // 道具可多选，上限 4 件（和 index.js 的 PROP_MAX 对齐）
          setSel(function (prev) {
            var list = (prev.props || []).slice()
            var at = list.indexOf(id)
            if (at >= 0) list.splice(at, 1)
            else if (list.length >= 4) return prev
            else list.push(id)
            return Object.assign({}, prev, { props: list })
          })
        } else {
          setSel(function (prev) {
            var next = Object.assign({}, prev)
            next[k] = prev[k] === id ? null : id
            return next
          })
        }
        var card = (idx.index[LIST_KEY[k]] || []).find(function (it) { return it.id === id })
        setDetail({ kind: k, id: id, summary: card || null })
      }

      function compose() {
        if (busy) return
        setBusy(true)
        var body = {
          styleId: sel.style, characterId: sel.character, lookId: sel.look,
          sceneId: sel.scene, poseId: sel.pose,
          propIds: (sel.props || []).slice(),
        }
        if (view && view.angle) {
          body.view = {
            angle: view.angle, gaze: view.gaze || 'front',
            shot: typeof view.shot === 'number' ? view.shot : 3, flip: view.flip === true,
          }
        }
        var n = parseInt(seed, 10)
        if (!isNaN(n)) body.seed = n
        fetch(PREFIX + '/compose', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (res) { return res.json() })
          .then(function (payload) { setRecipe(payload) })
          .catch(function (err) {
            setRecipe({ ok: false, missing: [], text: '生成失败：' + String((err && err.message) || err) })
          })
          .then(function () { setBusy(false) })
      }

      // 详情正文：点开哪张就按需拉那张卡的 json。
      var detailCardState = React.useState(null)
      var detailCard = detailCardState[0]
      var setDetailCard = detailCardState[1]
      React.useEffect(function () {
        if (!detail) { setDetailCard(null); return }
        var cancelled = false
        setDetailCard(null)
        fetch(PREFIX + '/card?kind=' + encodeURIComponent(detail.kind) + '&id=' + encodeURIComponent(detail.id))
          .then(function (res) { return res.json() })
          .then(function (payload) { if (!cancelled && payload && payload.ok) setDetailCard(payload.card) })
          .catch(function () { /* 详情拉不到就只显示摘要 */ })
        return function () { cancelled = true }
      }, [detail])

      var selectedCount = KIND_ORDER.filter(function (k) {
        return k === 'prop' ? (sel.props || []).length > 0 : !!sel[k]
      }).length
      var TOTAL_SLOTS = KIND_ORDER.length

      // ── 头部
      var header = h(Row, { style: { justifyContent: 'space-between', marginBottom: 8 } },
        h(Row, { style: { gap: 4 } },
          h(Pill, { active: tab === 'cards', onClick: function () { setTab('cards') } }, '选卡'),
          h(Pill, { active: tab === 'rules', onClick: function () { setTab('rules') } }, '规则 / 体检')),
        h(Row, null,
          h('span', { style: { fontSize: 10.5, color: C.dim } },
            tab === 'cards' && idx.index ? selectedCount + '/' + TOTAL_SLOTS + ' 已选' : ''),
          tab === 'cards' ? h(Pill, { onClick: load, title: '重新读取卡片库' }, '刷新') : null))

      if (tab === 'rules') {
        return h('div', {
          style: {
            display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
            padding: '12px 14px', boxSizing: 'border-box', color: C.text,
            font: 'inherit', overflow: 'hidden',
          },
        },
          header,
          h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 2 } },
            h(RulesPane)))
      }

      if (idx.loading && !idx.index) {
        return h('div', { style: { padding: '12px 14px', fontSize: 12, color: C.dim } }, header, '正在读取卡片库…')
      }
      if (idx.error || !idx.index) {
        return h('div', { style: { padding: '12px 14px', fontSize: 12, color: C.text } },
          header,
          h('div', { style: { color: C.warn, marginBottom: 6 } }, idx.error || '没有卡片库'),
          h('div', { style: { color: C.dim, fontSize: 11, lineHeight: 1.5 } },
            '缺 index.json。库根默认用插件自带的 library/，',
            '也可以用环境变量 CARD_LIBRARY_ROOT 指到别处。'))
      }

      var counts = idx.index.counts || {}

      // ── 四类切换
      var kindBar = h(Row, { style: { gap: 4, flexWrap: 'wrap', marginBottom: 8 } },
        KIND_ORDER.map(function (k) {
          var n = counts[LIST_KEY[k]] || counts[k] || 0
          var picked = k === 'prop'
            ? ((sel.props || []).length ? (sel.props.length + ' 件') : null)
            : sel[k]
          return h(Pill, {
            key: k, active: kind === k, onClick: function () { setKind(k) },
            title: SLOT_HINT[k] + (picked ? '\n已选：' + picked : ''),
          }, KIND_LABEL[k] + ' ' + n + (picked ? ' ●' : ''))
        }))

      // ── 已选槽位
      var slots = h('div', {
        style: {
          display: 'grid', gridTemplateColumns: 'repeat(' + KIND_ORDER.length + ', 1fr)', gap: 4, marginBottom: 8,
        },
      }, KIND_ORDER.map(function (k) {
        var ids = k === 'prop' ? (sel.props || []).slice() : (sel[k] ? [sel[k]] : [])
        var id = ids[0] || null
        var entry = id ? (idx.index[LIST_KEY[k]] || []).find(function (it) { return it.id === id }) : null
        var names = ids.map(function (x) {
          var e = (idx.index[LIST_KEY[k]] || []).find(function (it) { return it.id === x })
          return e ? e.name : x
        })
        return h('button', {
          key: k, type: 'button',
          onClick: function () {
            if (!ids.length) return
            if (k === 'prop') setSel(function (prev) { return Object.assign({}, prev, { props: [] }) })
            else setSel(function (prev) { var n = Object.assign({}, prev); n[k] = null; return n })
          },
          title: ids.length ? KIND_LABEL[k] + '：' + names.join('、') + '（点一下清空）' : SLOT_HINT[k],
          style: {
            position: 'relative',
            appearance: 'none', padding: 0, border: '1px dashed ' + (id ? C.brand : C.line),
            borderRadius: 6, background: id ? 'color-mix(in srgb, ' + C.brand + ' 8%, transparent)' : 'transparent',
            cursor: id ? 'pointer' : 'default', overflow: 'hidden', minWidth: 0,
          },
        },
          ids.length > 1
            ? h('div', {
              style: {
                position: 'absolute', top: 3, right: 3, zIndex: 2, borderRadius: 999,
                background: C.brand, color: '#fff', fontSize: 9, lineHeight: '13px', padding: '0 4px',
              },
            }, '×' + ids.length)
            : null,
          id && entry && entry.thumb
            ? h('div', { style: { width: '100%', aspectRatio: '1 / 1', overflow: 'hidden' } },
              h('img', {
                src: thumbUrl(k, id), alt: '', draggable: false,
                style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
              }))
            : h('div', {
              style: {
                width: '100%', aspectRatio: '1 / 1', display: 'flex', alignItems: 'center',
                justifyContent: 'center', color: C.dim,
              },
            }, h(SlotGlyph)),
          h('div', {
            style: {
              fontSize: 9.5, lineHeight: 1.3, padding: '2px 3px', textAlign: 'center',
              color: id ? C.text : C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, ids.length ? (ids.length > 1 ? names[0] + ' +' + (ids.length - 1) : names[0]) : KIND_LABEL[k]))
      }))

      // ── 搜索 / 分组
      var filters = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 } },
        h('input', {
          value: query, placeholder: '搜 ' + KIND_LABEL[kind] + '（名字 / id / 主题）',
          onChange: function (e) { setQuery(e.target.value) },
          style: {
            width: '100%', boxSizing: 'border-box', padding: '4px 8px', fontSize: 11.5,
            borderRadius: 6, border: '1px solid ' + C.line, background: 'transparent',
            color: C.text, outline: 'none',
          },
        }),
        (kind === 'scene' || kind === 'pose' || kind === 'prop') && groups.length > 0
          ? h(Row, { style: { gap: 4, flexWrap: 'wrap' } },
            h(Pill, { active: group === 'all', onClick: function () { setGroup('all') } }, '全部'),
            groups.map(function (g) {
              return h(Pill, {
                key: g.id, active: group === g.id, onClick: function () { setGroup(g.id) },
              }, g.title)
            }))
          : null)

      // ── 网格
      var grid = h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: (kind === 'scene' || kind === 'prop') ? 'repeat(2, minmax(0, 1fr))' : 'repeat(3, minmax(0, 1fr))',
          gap: 6,
        },
      }, list.slice(0, 240).map(function (it) {
        return h(CardTile, {
          key: it.id, card: it, kind: kind,
          selected: kind === 'prop' ? (sel.props || []).indexOf(it.id) >= 0 : sel[kind] === it.id,
          onClick: function () { pick(kind, it.id) },
        })
      }))

      var emptyHint = list.length === 0
        ? h('div', { style: { fontSize: 11, color: C.dim, padding: '10px 0' } },
          dq ? '没有匹配「' + dq + '」的卡。' : '这一类还没有卡。')
        : null

      var moreHint = list.length > 240
        ? h('div', { style: { fontSize: 10.5, color: C.dim, marginTop: 6 } },
          '共 ' + list.length + ' 张，先显示前 240 张 —— 用搜索或分组缩小范围。')
        : null

      // ── 底部：配方
      var footer = h('div', { style: { marginTop: 10, borderTop: '1px solid ' + C.line, paddingTop: 8 } },
        h(Row, { style: { gap: 5, marginBottom: 6 } },
          h('input', {
            value: seed, placeholder: 'seed（可空）',
            onChange: function (e) { setSeed(e.target.value.replace(/[^0-9]/g, '')) },
            style: {
              flex: '0 0 88px', padding: '4px 7px', fontSize: 11.5, borderRadius: 6,
              border: '1px solid ' + C.line, background: 'transparent', color: C.text, outline: 'none',
            },
          }),
          h('button', {
            type: 'button', onClick: compose, disabled: busy || selectedCount === 0,
            style: {
              flex: 1, appearance: 'none', padding: '5px 10px', fontSize: 11.5, borderRadius: 6,
              border: '1px solid ' + C.brand, background: selectedCount === 0 ? 'transparent' : C.brand,
              color: selectedCount === 0 ? C.dim : '#fff',
              cursor: busy || selectedCount === 0 ? 'default' : 'pointer',
              opacity: busy ? 0.6 : 1,
            },
          }, busy ? '拼装中…' : '生成配方 (' + selectedCount + '/' + TOTAL_SLOTS + ')')),
        h(Recipe, { recipe: recipe, onClear: function () { setRecipe(null) } }))

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
          padding: '12px 14px', boxSizing: 'border-box', color: C.text,
          font: 'inherit', overflow: 'hidden',
        },
      },
        header,
        h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 2 } },
          kindBar, slots,
          h(ViewPicker, {
            view: view,
            onChange: function (v) { setView(v || VIEW_EMPTY) },
          }),
          filters, grid, emptyHint, moreHint,
          h(Detail, {
            kind: detail ? detail.kind : null,
            card: detailCard || (detail ? detail.summary : null),
          })),
        footer)
    }

    // 面板里任何一次抛错都在面板内显示，而不是留一个空白栏。
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      render() {
        var error = this.state.error
        if (!error) return this.props.children
        var stack = String((error && error.stack) || '').split('\n').slice(1, 5).join('\n')
        return h('div', { style: { padding: '14px 16px', fontSize: 12, color: C.text } },
          h('div', { style: { color: C.warn, marginBottom: 6 } }, '卡片库面板出错：' + String((error && error.message) || error)),
          h('pre', {
            style: {
              margin: 0, fontFamily: MONO, fontSize: 10.5, whiteSpace: 'pre-wrap',
              color: C.dim, lineHeight: 1.5,
            },
          }, stack))
      }
    }

    function GuardedBody(props) {
      return h(PanelBoundary, null, h(Panel, props))
    }

    function ChipTitle() {
      return h('span', { style: { fontSize: 12 } }, '卡片库')
    }

    function definition() {
      return {
        id: PACKAGE_ID,
        kind: TAB_KIND,
        keepMounted: true,
        title: function () { return '卡片库' },
        guide: [{
          id: TAB_KIND,
          order: 62,
          title: function () { return '卡片库' },
          description: function () { return '画风 / 角色 / 造型 / 环境四类卡，挑选组合成出图配方' },
          icon: Glyph,
        }],
      }
    }

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(function () { return ctx.sidebarRightTabs.register(definition()) },
          'card-library: tab type')
        ctx.effect(function () {
          return ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PACKAGE_ID }, GuardedBody)
          })
        }, 'card-library: tab body')
        ctx.effect(function () {
          return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
            return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: PACKAGE_ID }, ChipTitle)
          })
        }, 'card-library: chip title')
      },
    }
  },
})

