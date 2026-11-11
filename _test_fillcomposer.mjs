// 离线验证 fillComposer：模拟 DSH 的 Lexical contenteditable 宿主
// 用法：node _test_fillcomposer.mjs
import fs from 'node:fs'

const src = fs.readFileSync('./client.js', 'utf8')

// 把三个函数抠出来（它们不依赖 React）
function grab(name) {
  const i = src.indexOf('function ' + name + '(')
  if (i < 0) throw new Error('not found: ' + name)
  let depth = 0, started = false
  for (let j = i; j < src.length; j++) {
    const ch = src[j]
    if (ch === '{') { depth++; started = true }
    else if (ch === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1) }
  }
  throw new Error('unbalanced: ' + name)
}

const code = grab('composerEditor') + '\n' + grab('pasteInto') + '\n' + grab('fillComposer')

// ── 假 DOM ────────────────────────────────────────────────
function makeEnv({ withEditor = true, editorTag = 'DIV' } = {}) {
  const listeners = []
  const el = {
    tagName: editorTag,
    textContent: '',
    value: '',
    _focused: false,
    focus() { this._focused = true },
    dispatchEvent(e) { listeners.push(e.type); return true },
    addEventListener() {},
  }

  const document = {
    querySelector(sel) {
      if (sel === '[data-composer-card]') return withEditor ? card : null
      if (sel === '[data-composer-input]') return withEditor && editorTag === 'DIV' ? el : null
      if (sel === '[contenteditable="true"]') return withEditor && editorTag === 'DIV' ? el : null
      if (sel === 'textarea') return withEditor && editorTag === 'TEXTAREA' ? el : null
      return null
    },
    createRange() { return { selectNodeContents() {} } },
    // 模拟 Lexical：insertText 真的把文字写进 textContent 并触发 input
    execCommand(cmd, _ui, text) {
      if (cmd !== 'insertText') return false
      el.textContent = text
      listeners.push('input')
      return true
    },
  }
  const card = {
    querySelector(sel) { return document.querySelector(sel) },
  }
  const window = {
    getSelection() { return { removeAllRanges() {}, addRange() {} } },
    DataTransfer: class { constructor() { this.d = {} } setData(k, v) { this.d[k] = v } getData(k) { return this.d[k] } },
    ClipboardEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o) } },
    Event: class { constructor(t, o) { this.type = t; Object.assign(this, o) } },
    HTMLTextAreaElement: { prototype: {} },
  }
  Object.defineProperty(window.HTMLTextAreaElement.prototype, 'value', {
    set(v) { el.value = v }, get() { return el.value }, configurable: true,
  })

  return { document, window, el, listeners }
}

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ← ' + extra : '')) }
}

function run(env, text) {
  const fn = new Function('document', 'window', code + '\nreturn fillComposer;')
  return fn(env.document, env.window)(text)
}

console.log('\n[1] Lexical contenteditable（DSH 现状）')
{
  const env = makeEnv()
  const ok = run(env, 'masterpiece, best quality')
  check('返回 true', ok === true, String(ok))
  check('文本进了编辑器', env.el.textContent === 'masterpiece, best quality', JSON.stringify(env.el.textContent))
  check('拿过焦点', env.el._focused === true)
}

console.log('\n[2] 老式 textarea（兼容回退）')
{
  const env = makeEnv({ editorTag: 'TEXTAREA' })
  const ok = run(env, 'hello prompt')
  check('返回 true', ok === true, String(ok))
  check('value 被写入', env.el.value === 'hello prompt', JSON.stringify(env.el.value))
  check('派发了 input 事件', env.listeners.includes('input'))
}

console.log('\n[3] 完全没有输入框')
{
  const env = makeEnv({ withEditor: false })
  const ok = run(env, 'x')
  check('返回 false（按钮会显示"没找到输入框"）', ok === false, String(ok))
}

console.log('\n[4] execCommand 被浏览器禁用 → 走 paste 兜底')
{
  const env = makeEnv()
  const realExec = env.document.execCommand
  env.document.execCommand = () => false
  // paste 兜底：Lexical 的 paste 处理器在真浏览器里会写进去，这里模拟它
  const origDispatch = env.el.dispatchEvent.bind(env.el)
  env.el.dispatchEvent = (e) => {
    if (e && e.type === 'paste' && e.clipboardData) env.el.textContent = e.clipboardData.getData('text/plain')
    return origDispatch(e)
  }
  const ok = run(env, 'fallback text')
  check('返回 true', ok === true, String(ok))
  check('paste 路径写入了', env.el.textContent === 'fallback text', JSON.stringify(env.el.textContent))
  env.document.execCommand = realExec
}

console.log('\n[5] 长配方（真实长度 ~2000 字符）')
{
  const env = makeEnv()
  const long = 'masterpiece, best quality, ' + 'tag, '.repeat(400)
  const ok = run(env, long)
  check('返回 true', ok === true)
  check('长度一致', env.el.textContent.length === long.length, env.el.textContent.length + ' vs ' + long.length)
}

console.log('\n结果：' + pass + ' pass / ' + fail + ' fail')
process.exit(fail ? 1 : 0)
