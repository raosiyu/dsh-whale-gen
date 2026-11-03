/**
 * 安装指引的测试。
 *
 * 这是给「装插件的人」看的内容，命令敲错一次，人家对整个插件的信任
 * 就没了。所以这里逐字盯：路径拼接、命令能复制去跑、缺什么才出什么。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { buildSetupSteps, envOverrideHint, MODEL_REPO, CONFIG_REPO } from '../lib/setup.js'
import { resolveConfig } from '../lib/config.js'

const require_ = createRequire(import.meta.url)
const nodeFs = require_('node:fs')
const nodePath = require_('node:path')

/** 全缺的配置（权重路径不存在）。 */
function emptyConfig() {
  return resolveConfig({
    pythonPath: null,
    serviceScript: '/custom/server.py',
    workDir: '/tmp/whale-setup-test',
    outputDir: '/tmp/whale-setup-test/out',
    port: 8767,
  }, '/ignored')
}

/** 全齐的配置：临时搭一棵带权重的目录树，测完拆掉。 */
function fullConfig() {
  const fs = nodeFs
  const path = nodePath
  const dir = fs.mkdtempSync('/tmp/whale-gen-setup-')
  fs.mkdirSync(path.join(dir, 'models', 'sdxl', 'sdxl-base-config'), { recursive: true })
  fs.closeSync(fs.openSync(path.join(dir, 'models', 'sdxl', 'animagine-xl-4.0.safetensors'), 'w'))
  return resolveConfig({
    pythonPath: '/venv/bin/python',
    serviceScript: '/custom/server.py',
    workDir: dir,
    outputDir: dir + '/out',
    port: 8767,
  }, '/ignored')
}



test('全缺时按 python → 权重 → config 的顺序给步骤', () => {
  const steps = buildSetupSteps(emptyConfig())
  assert.deepEqual(
    steps.map((step) => step.id),
    ['python', 'weights', 'config'],
  )
})

test('每一步都有标题、理由和可执行的命令', () => {
  for (const step of buildSetupSteps(emptyConfig())) {
    assert.ok(step.title.length > 4, '标题要说清楚装什么：' + step.title)
    assert.ok(step.reason.length > 8, '要解释为什么需要：' + step.reason)
    assert.ok(Array.isArray(step.commands) && step.commands.length > 0)
    for (const line of step.commands) {
      assert.equal(typeof line, 'string')
    }
  }
})

test('python 步骤的 pip 命令带上 torch 和 diffusers', () => {
  const steps = buildSetupSteps(emptyConfig())
  const python = steps.find((step) => step.id === 'python')
  const pip = python.commands.find((line) => line.includes('pip install'))
  assert.ok(pip.includes('torch'), '没有 torch 装了也跑不起来')
  assert.ok(pip.includes('diffusers'), '没有 diffusers 装了也跑不起来')
  assert.ok(pip.includes('transformers'))
})

test('python 步骤把 venv 建在工作目录下', () => {
  const steps = buildSetupSteps(emptyConfig())
  const python = steps.find((step) => step.id === 'python')
  const venv = python.commands.find((line) => line.includes('python3 -m venv'))
  assert.ok(venv.includes('/tmp/whale-setup-test/.venv'), 'venv 路径要贴着工作目录：' + venv)
})

test('权重步骤用对模型仓库名和落盘目录', () => {
  const steps = buildSetupSteps(emptyConfig())
  const weights = steps.find((step) => step.id === 'weights')
  const download = weights.commands.join('\n')
  assert.ok(download.includes(MODEL_REPO))
  assert.ok(download.includes('animagine-xl-4.0.safetensors'))
  assert.ok(download.includes('--local-dir /tmp/whale-setup-test/models/sdxl'))
})

test('config 步骤排除权重文件，只下结构', () => {
  const steps = buildSetupSteps(emptyConfig())
  const config = steps.find((step) => step.id === 'config')
  const download = config.commands.join('\n')
  assert.ok(download.includes(CONFIG_REPO))
  assert.ok(download.includes('--exclude'), '不下排除参数会把 6.5 GB 再拉一遍')
  assert.ok(download.includes('*.safetensors'))
})

test('环境齐时只给一条「可以用了」的确认', () => {
  const steps = buildSetupSteps(fullConfig())
  assert.equal(steps.length, 1)
  assert.equal(steps[0].done, true)
  assert.equal(steps[0].id, 'ready')
  assert.equal(steps[0].commands, undefined, '确认步骤不需要命令')
})

test('环境变量覆盖提示：缺什么提示什么', () => {
  const hint = envOverrideHint(emptyConfig())
  assert.ok(hint !== null)
  assert.ok(hint.includes('WHALE_PYTHON'))
  assert.ok(hint.includes('WHALE_WORKDIR'))

  const none = envOverrideHint(fullConfig())
  assert.equal(none, null, '全齐时不需要指路')
})

test('README 里的模型仓库名与代码一致', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const readme = await readFile(join(here, '..', 'README.md'), 'utf8')
  assert.ok(readme.includes(MODEL_REPO), 'README 的下载命令要和代码里的仓库名一致')
})
