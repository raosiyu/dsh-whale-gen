/**
 * 出图插件的核心逻辑测试。
 *
 * 只测那些「写错了不会报错、但行为是错的」的地方——参数兜底、
 * 路径围栏、工具输出形状。真正的出图要靠端到端跑，不在这里假装。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/config.js'
import { buildTools } from '../lib/tools.js'

/** 一个假的宿主面，够工具跑起来就行。 */
function fakeFaces(overrides = {}) {
  const calls = []
  const daemon = {
    snapshot: () => ({ running: true, restarts: 0, lastError: null, tail: [], port: 8767 }),
    probe: async () => ({ loaded: true }),
    ensure: async () => ({ loaded: true }),
    ...(overrides.daemon ?? {}),
  }
  const client = {
    generate: async (body) => {
      calls.push(['generate', body])
      return { jobId: 'j1', request: body }
    },
    job: async (id) => {
      calls.push(['job', id])
      return overrides.job ?? { id, status: 'done', progress: { image: 1, images: 1, step: 28, total: 28 }, images: [] }
    },
    history: async (limit) => {
      calls.push(['history', limit])
      return []
    },
    cancel: async () => {},
    unload: async () => {},
    ...(overrides.client ?? {}),
  }
  const config = {
    pythonPath: '/x/python',
    serviceScript: '/x/server.py',
    workDir: '/x',
    outputDir: '/x/out',
    port: 8767,
    problems: [],
    ...(overrides.config ?? {}),
  }
  return { faces: { daemon, client, config, warn: () => {} }, calls }
}

/** 按名字取工具。 */
function tool(faces, name) {
  const found = buildTools(faces).find((item) => item.name === name)
  assert.ok(found !== undefined, '应该有工具 ' + name)
  return found
}

test('参数为 null 时不抛 TypeError', async () => {
  const { faces } = fakeFaces()
  const generate = tool(faces, 'local_generate')
  // 宿主不按 schema 校验，模型可能传 null / 数组
  const result = await generate.execute(null)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'empty-prompt')

  const status = tool(faces, 'local_gen_status')
  const listed = await status.execute([])
  assert.equal(listed.ok, true)
})

test('空白 prompt 被拒绝', async () => {
  const { faces, calls } = fakeFaces()
  const result = await tool(faces, 'local_generate').execute({ prompt: '   ' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'empty-prompt')
  assert.equal(calls.length, 0, '不该真的去提交')
})

test('尺寸被夹到合法区间且自动补齐默认值', async () => {
  const { faces, calls } = fakeFaces()
  await tool(faces, 'local_generate').execute({
    prompt: 'a cat',
    width: 99999,
    height: 10,
    steps: 999,
    cfg: 99,
    batch: 99,
  })
  const [, body] = calls[0]
  assert.equal(body.width, 1536, '宽被夹到上限')
  assert.equal(body.height, 256, '高被夹到下限')
  assert.equal(body.steps, 60)
  assert.equal(body.cfg, 20)
  assert.equal(body.batch, 8)
})

test('省略参数时用默认值', async () => {
  const { faces, calls } = fakeFaces()
  await tool(faces, 'local_generate').execute({ prompt: 'a cat' })
  const [, body] = calls[0]
  assert.equal(body.width, 832)
  assert.equal(body.height, 1216)
  assert.equal(body.steps, 28)
  assert.equal(body.cfg, 6)
  assert.equal(body.sampler, 'euler_a')
  assert.equal(body.batch, 1)
  assert.equal(body.seed, null, '没给种子就是随机')
  assert.ok(body.negative.includes('lowres'), '反向提示词有默认值')
})

test('非法采样器回落到 euler_a', async () => {
  const { faces, calls } = fakeFaces()
  await tool(faces, 'local_generate').execute({ prompt: 'x', sampler: 'nope' })
  assert.equal(calls[0][1].sampler, 'euler_a')
})

test('查不到的任务返回 ok:false 而不是抛', async () => {
  const { faces } = fakeFaces({ client: { job: async () => null } })
  const result = await tool(faces, 'local_gen_status').execute({ jobId: 'missing' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no-such-job')
})

test('任务完成时图片带绝对路径', async () => {
  const { faces } = fakeFaces({
    job: {
      id: 'j9',
      status: 'done',
      progress: { image: 1, images: 1, step: 28, total: 28 },
      elapsed: 70,
      images: [{ file: 'a_s1.png', seed: 1, width: 832, height: 1216, seconds: 70 }],
    },
  })
  const result = await tool(faces, 'local_gen_status').execute({ jobId: 'j9' })
  assert.equal(result.ok, true)
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].path, '/x/out/a_s1.png')
  assert.equal(result.images[0].size, '832x1216')
})

test('服务报错时返回 env 快照而不是吞掉', async () => {
  const { faces } = fakeFaces({
    client: { generate: async () => { throw new Error('显存不足') } },
  })
  const result = await tool(faces, 'local_generate').execute({ prompt: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'service-error')
  assert.match(result.error, /显存不足/)
  assert.ok(result.env !== undefined, '要带环境快照，方便判断是哪一步坏的')
})

test('配置不全时把问题列出来，不猜路径', () => {
  const resolved = resolveConfig({ pythonPath: '', serviceScript: '' }, '/nonexistent-dir')
  // 探测可能在本机找到东西，也可能找不到；关键是 problems 与结果一致
  if (resolved.pythonPath === null) {
    assert.ok(resolved.problems.some((item) => item.includes('python')))
  }
  if (resolved.serviceScript === null) {
    assert.ok(resolved.problems.some((item) => item.includes('服务脚本')))
  }
  assert.equal(typeof resolved.port, 'number')
})

test('显式配置覆盖探测结果', () => {
  const resolved = resolveConfig({
    pythonPath: '/custom/python',
    serviceScript: '/custom/server.py',
    workDir: '/tmp',
    outputDir: '/tmp/out',
    port: 9001,
    enabled: true,
    announceToAgent: false,
  }, '/ignored')

  assert.equal(resolved.pythonPath, '/custom/python')
  assert.equal(resolved.serviceScript, '/custom/server.py')
  assert.equal(resolved.outputDir, '/tmp/out')
  assert.equal(resolved.port, 9001)
  assert.equal(resolved.announceToAgent, false)

  // /tmp 里当然没有权重——这一条必须被报出来，而不是静默用错路径
  assert.equal(resolved.modelPath, null)
  assert.ok(
    resolved.problems.some((item) => item.includes('权重')),
    '缺权重要进 problems，实际：' + JSON.stringify(resolved.problems),
  )
})

test('权重存在时 problems 为空', () => {
  // 用真实目录验一次「权重找得到就全绿」的路径；没装权重的机器上跳过
  const workDir = process.env.WHALE_TEST_WORKDIR
  if (workDir === undefined) return

  const resolved = resolveConfig({
    workDir,
    pythonPath: '/custom/python',
    serviceScript: '/custom/server.py',
    outputDir: '/tmp/out',
  }, '/ignored')

  if (resolved.modelPath !== null) {
    assert.equal(resolved.problems.length, 0, '权重找得到就不该有问题：' + JSON.stringify(resolved.problems))
    assert.ok(resolved.modelPath.endsWith('animagine-xl-4.0.safetensors'))
    assert.ok(resolved.configDir !== null, 'config 目录也该找到')
  }
})

test('端口越界回落默认值', () => {
  assert.equal(resolveConfig({ port: 0 }, '/tmp').port, 8767)
  assert.equal(resolveConfig({ port: 99999 }, '/tmp').port, 8767)
  assert.equal(resolveConfig({ port: -1 }, '/tmp').port, 8767)
})
