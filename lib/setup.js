/**
 * 安装指引生成。
 *
 * 「检测到缺什么」和「告诉人怎么装」是两件事。config.problems 只做了
 * 前一半——装插件的人看到「找不到 python」还是不知道下一步敲什么。
 * 这里把每个缺失项翻译成可复制的命令，按顺序编号，做完一步勾一步。
 *
 * 命令只针对 macOS（MPS 只在 Apple Silicon 上有），这不叫平台绑定，
 * 叫诚实：在 Linux 上装了也跑不起来，不如直说。
 *
 * @module dsh-whale-gen/setup
 */

/** Animagine XL 4.0 在 HuggingFace 上的仓库。 */
export const MODEL_REPO = 'cagliostrolab/animagine-xl-4.0'
/** 权重读结构用的 SDXL base config 仓库。 */
export const CONFIG_REPO = 'stabilityai/stable-diffusion-xl-base-1.0'

/**
 * 建安装步骤。
 * @param config - resolveConfig 的结果。
 * @returns 步骤数组，每步 { id, title, done, reason?, commands? }。
 */
export function buildSetupSteps(config) {
  const steps = []

  // ---- 第一步：python 环境 ----
  if (config.pythonPath === null) {
    const venvDir = config.workDir
      ? config.workDir + '/.venv'
      : '~/.dsh/whale-gen/.venv'
    steps.push({
      id: 'python',
      title: '装一个带 torch 的 python 环境',
      done: false,
      reason: '出图跑在 torch + diffusers 上，需要一个装了它们的 python（MPS 版 torch 只在 macOS 12+ 的 Apple Silicon 上可用）',
      commands: [
        '# 1. 建虚拟环境',
        'python3 -m venv ' + venvDir,
        '',
        '# 2. 装 torch（MPS 后端）和 diffusers',
        venvDir + '/bin/pip install torch diffusers transformers accelerate safetensors',
        '',
        '# 3. 装完告诉插件这个 python 在哪',
        '#    面板会自动探测 ' + venvDir + '/bin/python，',
        '#    或者显式配置 pythonPath 指向它',
      ],
    })
  }

  // ---- 第二步：权重 ----
  if (config.modelPath === null) {
    const modelsDir = config.workDir
      ? config.workDir + '/models/sdxl'
      : 'models/sdxl'
    steps.push({
      id: 'weights',
      title: '下载 Animagine XL 4.0 权重（约 6.5 GB）',
      done: false,
      reason: '插件按 <工作目录>/models/sdxl/animagine-xl-4.0.safetensors 找权重',
      commands: [
        '# 需要 huggingface-cli（pip install -U "huggingface_hub[cli]"）',
        'huggingface-cli download ' + MODEL_REPO + ' \\',
        '  animagine-xl-4.0.safetensors \\',
        '  --local-dir ' + modelsDir,
      ],
    })
  }

  // ---- 第三步：config 目录 ----
  if (config.configDir === null) {
    const configDir = config.workDir
      ? config.workDir + '/models/sdxl/sdxl-base-config'
      : 'models/sdxl/sdxl-base-config'
    steps.push({
      id: 'config',
      title: '下载 SDXL 结构描述（config，不含权重，几百 KB）',
      done: false,
      reason: '单文件权重里没有网络结构，diffusers 需要一份 config 才能把它装配起来',
      commands: [
        'huggingface-cli download ' + CONFIG_REPO + ' \\',
        '  --exclude "*.safetensors" "*.bin" "*.ckpt" \\',
        '  --local-dir ' + configDir,
      ],
    })
  }

  // ---- 全齐时的确认步骤 ----
  if (steps.length === 0) {
    steps.push({
      id: 'ready',
      title: '环境齐了',
      done: true,
      reason: 'python、权重、config 都找到了。面板点「启动服务」或直接出图即可，' +
        '首次加载权重需要 30~60 秒',
    })
  }

  return steps
}

/**
 * 环境变量覆盖提示：探测不到且用户更想用现成环境时，指个路。
 * @param config - resolveConfig 的结果。
 * @returns 字符串，全齐时为 null。
 */
export function envOverrideHint(config) {
  const hints = []
  if (config.pythonPath === null) hints.push('WHALE_PYTHON=/path/to/venv/bin/python')
  if (config.workDir === null || config.modelPath === null || config.configDir === null) {
    hints.push('WHALE_WORKDIR=/path/to/有 models/sdxl 的目录')
  }
  if (hints.length === 0) return null
  return '不想按默认位置装也可以指路：' + hints.join('，')
}
