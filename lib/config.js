/**
 * 配置解析与路径推导。
 *
 * 这个插件要在**任意机器**上跑得起来，所以路径不能写死。推导顺序是：
 * 显式配置 → 环境变量 → 探测常见位置。
 *
 * 探测这一步是必须的：torch 装在哪个 venv 里，因机器而异，而插件作者
 * 不可能知道。找不到就把话说清楚，别用一个猜出来的路径静默失败。
 *
 * @module dsh-whale-gen/config
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')

/** 默认端口：错开常见的 8765/8188/3000，减少撞车。 */
export const DEFAULT_PORT = 8767

/**
 * 在若干候选里挑第一个存在的。
 * @param candidates - 路径列表。
 * @returns 找到的路径，都没有则 null。
 */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/**
 * 猜 torch 所在的 python。
 *
 * 只看几个高概率位置，不做全盘搜索——全盘搜一次能把插件启动拖到几十秒。
 * 找不到就让 problems 说话，让用户显式配 pythonPath。
 * @param hint - 调用方给的线索（工作目录）。
 * @returns python 路径，找不到则 null。
 */
function guessPython(hint) {
  const env = process.env
  const home = homedir()
  const candidates = [
    env.WHALE_PYTHON,
    env.DSH_WHALE_PYTHON,
    // 项目的虚拟环境
    hint ? join(hint, '.venv', 'bin', 'python') : null,
    hint ? join(dirname(hint), '.venv', 'bin', 'python') : null,
    // 插件自管的环境
    join(home, '.dsh', 'whale-gen', '.venv', 'bin', 'python'),
    // conda / 系统兜底
    join(home, 'miniconda3', 'bin', 'python'),
    join(home, 'anaconda3', 'bin', 'python'),
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ]
  return firstExisting(candidates)
}

/**
 * 猜工作目录：出图服务的 cwd，也是输出落盘的地方。
 *
 * 不能盲信启动 cwd：DSH 可能从任何目录被拉起（CLI 从 /tmp，桌面从
 * profile 目录），那里多半没有权重。所以候选按「含权重 > 存在」排序：
 * 谁的 models/sdxl 里有 Animagine 权重，谁就是工作目录；
 * 都没有再退到第一个存在的目录，并把问题写进 problems。
 * @param hint - 调用方给的线索。
 * @returns 绝对路径。
 */
function guessWorkDir(hint) {
  const env = process.env
  const candidates = [
    env.WHALE_WORKDIR,
    env.DSH_WHALE_WORKDIR,
    hint,
    join(homedir(), 'Developer', '鲸鱼娘'),
    join(homedir(), 'Developer', 'whale'),
    join(homedir(), '.dsh', 'whale-gen'),
  ]

  const weightsRel = join('models', 'sdxl', 'animagine-xl-4.0.safetensors')

  // 先找有权重的：这条线索比「目录存在」强得多
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' &&
        existsSync(join(candidate, weightsRel))) {
      return candidate
    }
  }

  const found = firstExisting(candidates)
  if (found !== null) return found
  return join(homedir(), '.dsh', 'whale-gen')
}

/**
 * 找出服务脚本。
 *
 * 优先用包内自带的（插件自包含，装到哪都能跑）；
 * 其次用工作目录里 console/server.py（开发中的那一份）。
 * @param workDir - 工作目录。
 * @returns 脚本路径，找不到则 null。
 */
function findServiceScript(workDir) {
  return firstExisting([
    process.env.WHALE_SERVICE_SCRIPT,
    join(PACKAGE_ROOT, 'service', 'server.py'),
    join(workDir, 'console', 'server.py'),
  ])
}

/**
 * 找出权重文件与它的 config 目录。
 *
 * 从工作目录里找 models/sdxl/——这是「在项目里跑」的正常布局。
 * 找不到就返回 null，让服务脚本按它自己的默认值走，而不是猜一个路径。
 * @param workDir - 工作目录。
 * @returns { modelPath, configDir }，都能为 null。
 */
function findWeights(workDir) {
  const modelPath = firstExisting([
    process.env.WHALE_MODEL_PATH,
    join(workDir, 'models', 'sdxl', 'animagine-xl-4.0.safetensors'),
  ])
  const configDir = firstExisting([
    process.env.WHALE_CONFIG_DIR,
    join(workDir, 'models', 'sdxl', 'sdxl-base-config'),
  ])
  return { modelPath, configDir }
}

/**
 * 读一个字符串配置项。
 *
 * 三态语义：
 *   非空字符串 → 用它
 *   null       → 明确禁用（跳过探测，保持缺失，让 problems 说话）
 *   undefined  → 没配，去探测
 *
 * 为什么 null 不能当成 undefined：测试和高级用户需要「强制某个探测
 * 关闭」的表达方式；把 null 悄悄当探测，就会出现配了却像没配一样
 * 带回一个探测结果的怪状态。
 */
function stringOption(value, probe) {
  if (typeof value === 'string' && value !== '') return value
  if (value === null) return null
  return probe()
}

/**
 * 把外部配置和推导结果合成一份完整配置。
 *
 * @param raw - cordis 传进来的 config。
 * @param fallbackWorkDir - 从会话或进程继承来的目录线索。
 * @returns 完整配置。
 */
export function resolveConfig(raw, fallbackWorkDir) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}

  const workDir = stringOption(
    config.workDir,
    () => guessWorkDir(fallbackWorkDir),
  )

  const pythonPath = stringOption(
    config.pythonPath,
    () => guessPython(workDir),
  )

  const serviceScript = stringOption(
    config.serviceScript,
    () => findServiceScript(workDir),
  )

  const outputDir = typeof config.outputDir === 'string' && config.outputDir !== ''
    ? resolve(config.outputDir)
    : join(workDir, 'out', 'console')

  const { modelPath, configDir } = findWeights(workDir)

  const port = Number.isInteger(config.port) && config.port > 0 && config.port < 65536
    ? config.port
    : DEFAULT_PORT

  return {
    enabled: config.enabled !== false,
    announceToAgent: config.announceToAgent !== false,
    pythonPath,
    serviceScript,
    workDir,
    outputDir,
    modelPath,
    configDir,
    port,
    /** 没配齐就报出来，而不是等到点出图时才炸。 */
    problems: [
      pythonPath === null ? '找不到能 import torch 的 python（配 pythonPath）' : null,
      serviceScript === null ? '找不到出图服务脚本（配 serviceScript）' : null,
      modelPath === null
        ? '找不到权重 animagine-xl-4.0.safetensors（配 workDir 或 WHALE_MODEL_PATH）'
        : null,
    ].filter((item) => item !== null),
  }
}

export { PACKAGE_ROOT }
