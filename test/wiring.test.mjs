/**
 * 用一个假宿主跑一遍 apply()，验证接线。
 *
 * 为什么需要：插件「加载成功」和「真的把东西注册上了」是两件事。
 * 服务名拼错、注册 API 用错、effect 没生效——这些在浏览器里都表现为
 * 「面板是空的」，很难反查。这里用最小的假 ctx 把每一步都数出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, PROMPT_SECTION } from '../lib/index.js'

/**
 * 造一个假宿主。
 *
 * 关键：用 Proxy 模拟 cordis 的行为——**读未声明的服务会抛**。
 *
 * 这一条是补上一个真 bug 之后加的。原来这里是普通对象，读 `ctx.agent`
 * 只得到 undefined，测试全绿；但真实 cordis 会抛
 * "cannot get property agent without inject"，
 * 于是插件在 apply 第一行就挂掉、整行不激活，而栈只指向行号。
 *
 * 假宿主如果不能复现真宿主的脾气，那它验的就不是同一个东西。
 *
 * @param options - 开关各服务是否提供。
 * @returns { ctx, seen }。
 */
function fakeHost(options = {}) {
  const seen = {
    tools: [],
    routes: [],
    sections: [],
    effects: [],
    warned: [],
  }

  const provided = new Set(['effect', 'get', 'logger'])

  const base = {
    logger: { warn: (message) => seen.warned.push(String(message)) },
    get: (name) => (name in base ? base[name] : undefined),
    effect: (fn, label) => {
      seen.effects.push(label)
      return fn()
    },
  }

  if (options.tools !== false) {
    provided.add('tools')
    base.tools = {
      register: (definition) => {
        seen.tools.push(definition)
      },
    }
  }
  if (options.webServer !== false) {
    provided.add('webServer')
    base.webServer = {
      register: (route) => {
        seen.routes.push(route)
        return () => {}
      },
    }
  }
  if (options.systemPrompt !== false) {
    provided.add('systemPrompt')
    base.systemPrompt = {
      section: (section) => {
        seen.sections.push(section)
        return () => {}
      },
    }
  }

  const ctx = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop.startsWith('_')) {
        return Reflect.get(target, prop, receiver)
      }
      if (!(prop in target)) {
        // 真实 cordis 就是在这里抛的
        throw new Error('cannot get property "' + String(prop) + '" without inject')
      }
      return Reflect.get(target, prop, receiver)
    },
    set(target, prop, value) {
      if (!(prop in target)) {
        throw new Error('cannot set property "' + String(prop) + '" without provide')
      }
      target[prop] = value
      return true
    },
  })

  return { ctx, seen }
}

test('inject 声明了三个必需服务', () => {
  assert.deepEqual(inject, ['tools', 'webServer', 'systemPrompt'])
})

test('apply 注册三个工具', () => {
  const { ctx, seen } = fakeHost()
  apply(ctx, { enabled: true })

  const names = seen.tools.map((item) => item.name).sort()
  assert.deepEqual(names, ['local_gen_env', 'local_gen_status', 'local_generate'])

  for (const definition of seen.tools) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 20, '描述要够模型判断什么时候用')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(definition.parameters.type, 'object')
  }
})

test('apply 注册面板路由', () => {
  const { ctx, seen } = fakeHost()
  apply(ctx, { enabled: true })

  const paths = seen.routes.map((route) => route.path)
  for (const expected of ['/env', '/start', '/stop', '/generate', '/job', '/history', '/cancel', '/unload', '/image']) {
    assert.ok(
      paths.some((path) => path.endsWith(expected)),
      '应该有路由 ' + expected + '，实际：' + paths.join(', '),
    )
  }
  for (const route of seen.routes) {
    assert.equal(typeof route.handler, 'function')
    assert.equal(route.kind, 'prefix')
  }
})

test('apply 注入系统提示段，且能关掉', () => {
  const { ctx, seen } = fakeHost()
  apply(ctx, { enabled: true })

  assert.equal(seen.sections.length, 1)
  assert.equal(seen.sections[0].name, PROMPT_SECTION)
  assert.equal(typeof seen.sections[0].text(), 'string')
  assert.ok(seen.sections[0].text().includes('local_generate'))

  const off = fakeHost()
  apply(off.ctx, { enabled: true, announceToAgent: false })
  assert.equal(off.seen.sections.length, 0)
})

test('enabled:false 时什么都不注册', () => {
  const { ctx, seen } = fakeHost()
  apply(ctx, { enabled: false })

  assert.equal(seen.tools.length, 0)
  assert.equal(seen.routes.length, 0)
  assert.equal(seen.sections.length, 0)
})

test('缺 webServer 时工具照注册，只是没有面板端点', () => {
  const { ctx, seen } = fakeHost({ webServer: false })
  apply(ctx, { enabled: true })

  assert.equal(seen.tools.length, 3, '工具不该跟着一起消失')
  assert.equal(seen.routes.length, 0)
  assert.ok(
    seen.warned.some((message) => message.includes('webServer')),
    '要明确说端点缺席，而不是静默',
  )
})

test('缺 tools 时也警告，但不抛', () => {
  const { ctx, seen } = fakeHost({ tools: false })
  apply(ctx, { enabled: true })

  assert.equal(seen.tools.length, 0)
  assert.ok(seen.warned.some((message) => message.includes('工具注册表')))
  // 路由还在
  assert.ok(seen.routes.length > 0)
})

test('ctx 不可写时 whaleGen 挂不上，但插件不崩', () => {
  const { ctx, seen } = fakeHost()
  // 真 cordis 对未声明的属性赋值会抛；这里不该把整个 apply 带下去
  assert.doesNotThrow(() => apply(ctx, { enabled: true }))

  // 调试句柄是加分项，挂不挂得上都不影响功能。
  // 注意：假宿主读未声明属性也会抛，所以这里不能直接读 ctx.whaleGen，
  // 只能确认「apply 没抛」+「该注册的都注册了」。
  assert.equal(seen.tools.length, 3)
  assert.ok(seen.routes.length > 0)
  assert.equal(seen.sections.length, 1)
})

test('ctx 可写时 whaleGen 正常挂上', () => {
  const target = {}
  const { ctx, seen } = fakeHost()
  // 换一个不做 set 拦截的宿主，验证正常路径
  const permissive = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'effect') return ctx.effect
      if (prop === 'get') return (_name) => undefined
      if (prop === 'logger') return { warn: () => {} }
      if (prop === 'tools') return ctx.tools
      if (prop === 'webServer') return ctx.webServer
      if (prop === 'systemPrompt') return ctx.systemPrompt
      return target[prop]
    },
    set: (_t, prop, value) => { target[prop] = value; return true },
  })

  apply(permissive, { enabled: true })

  assert.ok(permissive.whaleGen !== undefined)
  assert.equal(typeof permissive.whaleGen.warmup, 'function')
  assert.equal(typeof permissive.whaleGen.daemon.ensure, 'function')
  assert.equal(seen.tools.length, 3)
})

test('每个工具的参数兜底真的挡住了 null', async () => {
  const { ctx, seen } = fakeHost()
  apply(ctx, { enabled: true })

  const generate = seen.tools.find((item) => item.name === 'local_generate')
  // 宿主不校验 schema，模型传 null 是可能的
  const result = await generate.execute(null, {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'empty-prompt')
})
