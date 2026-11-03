/**
 * dsh-whale-gen 宿主半区。
 *
 * 四块接起来：托管的 MPS 出图服务（daemon）、工具面（模型调）、
 * HTTP 路由（面板调）、系统提示段（告诉模型这个能力存在）。
 *
 * 一条设计原则贯穿全文：**任何一块缺席都不能让插件整体崩掉**。
 * 没有 webServer 就没有面板端点，但工具还能用；没有 systemPrompt
 * 就少一段提示，但出图照跑。半残比全死有用。
 *
 * @module dsh-whale-gen
 */
import { Daemon } from './daemon.js'
import { resolveConfig } from './config.js'
import { createClient } from './client-http.js'
import { buildTools } from './tools.js'
import { makeRoutes, API_PREFIX } from './routes.js'

/**
 * 本行需要宿主先备好这些服务。
 *
 * 少了这个导出，宿主不会等这些服务就绪就 apply——readService 一律拿到
 * undefined，于是工具和路由全都「注册到空气里」，插件看着加载成功、
 * 实际什么都不工作。这是从 dsh-whale-tail 那边对照出来的。
 *
 * 只要 tools / webServer / systemPrompt 三样：本插件不需要网关、不需要
 * LLM、不碰默认模型——出图是本地的。
 */
export const inject = ['tools', 'webServer', 'systemPrompt']

/** 系统提示段的命名空间。 */
export const PROMPT_SECTION = 'plugin:whale-gen'

/**
 * 提示段的正文。
 *
 * 写给模型看，所以只写「什么时候用 / 怎么用 / 别做什么」。
 * 不写「这个插件很强大」这类话——模型不需要被推销。
 */
export const PROMPT_TEXT = [
  '本机装了一个本地出图能力：Animagine XL 4.0 跑在 Apple MPS 上，不联网、不花钱、不需要 API Key。',
  '',
  '## 什么时候用它',
  '',
  '- 用户要你画图、出图、生成图片，且没有指定要用云端模型时。',
  '- 用户要「再来一张」「换个种子」「调一下这个」，沿用上次的语气和构图。',
  '- 需要一版可以反复迭代的草图：本机不要钱，可以多试几张。',
  '',
  '反过来：用户明确说要某个云端模型（Gemini / GPT 图像 / Seedream 等），那就用那个，不要抢。',
  '',
  '## 怎么用',
  '',
  '1. `local_generate` 提交，立刻拿到 jobId。',
  '2. `local_gen_status` 用这个 jobId 查进度；状态 done 时 images 里带文件路径。',
  '3. 把路径告诉用户。图已经落盘，用户可以自己去翻。',
  '',
  '## 提示词的写法',
  '',
  '这是 Animagine XL（二次元底模），认的是 Danbooru 风格英文 Tag，不是自然语言长句。',
  '',
  '- 开头放质量词：`masterpiece, best quality, very aesthetic, absurdres`',
  '- 再放主体：`1girl, solo, <角色/特征>, <服装>, <动作/视角>`',
  '- 再放场景与光：`ocean, sunset, pastel colors, cinematic lighting`',
  '- 默认尺寸 832×1216（竖）或 1024×1024（方）。别的尺寸容易崩构图。',
  '- 默认 28 步 / CFG 6.0 / euler_a，这几个值不要随手改。',
  '',
  '用户说中文没关系，你翻译成英文 Tag 再提交。',
  '',
  '## 要知道的代价',
  '',
  '- 首次出图会加载 6.5 GB 权重，30~60 秒；之后常驻显存。',
  '- 单张 832×1216 / 28 步约 60~80 秒。用户催的时候说真实数字，别含糊。',
  '- 服务崩溃后不会自动重启（MPS 显存可能没归还），下一次调用会重新拉起。',
].join('\n')

/**
 * 按需解析宿主服务。
 *
 * 不能在 apply 时抓一次：官方服务是异步初始化的，抓早了永远是 undefined。
 *
 * 而且**读未声明的服务会抛**（cordis 的 "cannot get property X without inject"），
 * 不是返回 undefined。所以整段必须 try 住：某一行 inject 了但部署里确实
 * 没有这个服务时，我们要的是「降级」，不是让整个插件倒下。
 *
 * @param ctx - cordis 上下文。
 * @param name - 服务名。
 * @returns 服务实例，没有则 undefined。
 */
function readService(ctx, name) {
  try {
    const direct = ctx?.[name]
    if (direct !== undefined) return direct
  } catch {
    // 没注入这个服务
  }
  try {
    if (typeof ctx?.get === 'function') {
      const viaGet = ctx.get(name)
      if (viaGet !== undefined) return viaGet
    }
  } catch {
    // get 也拿不到
  }
  return undefined
}

/**
 * 插件入口。
 * @param ctx - cordis 上下文。
 * @param config - cordis.patch.yml 里的那一份 config。
 */
export function apply(ctx, config) {
  const enabled = config?.enabled !== false
  if (!enabled) return

  /**
   * 记一条警告。
   *
   * logger 在 cordis 里也是注入属性，没写进 inject 就读会抛
   * "cannot get property logger without inject"——而这里本身是错误处理
   * 路径，再抛一次就把真正的错误盖掉了。所以整段包住，退到 console。
   */
  const warn = (message) => {
    try {
      const logger = ctx?.logger
      if (typeof logger?.warn === 'function') {
        logger.warn(message)
        return
      }
    } catch {
      // 没注入 logger
    }
    try {
      console.warn('[dsh-whale-gen] ' + message)
    } catch {
      // 连 console 都没了就算了
    }
  }

  /** 装一个副作用并挂到插件 fiber 上。 */
  const effect = (fn, label) => {
    if (typeof ctx.effect === 'function') {
      try {
        return ctx.effect(fn, label)
      } catch (error) {
        warn('[dsh-whale-gen] effect 挂载失败，改为直接执行：' + String(error))
      }
    }
    try {
      return fn()
    } catch (error) {
      warn('[dsh-whale-gen] 直接执行失败：' + String(error))
      return undefined
    }
  }

  // 目录线索：优先会话 cwd，让插件在项目里跑时贴着项目走。
  //
  // 注意：agent 是 cordis 的**注入服务**，没写进 inject 就直接读会抛
  // "cannot get property agent without inject" —— 这个错在 apply 第一行
  // 就炸，整行插件不激活，而栈里只指向 lib/index.js 的行号。
  // 所以这里必须用 try 包住，读不到就退到进程 cwd。
  let sessionCwd = process.cwd()
  try {
    const holder = ctx?.agent
    sessionCwd = holder?.session?.header?.cwd
      ?? holder?.session?.cwd
      ?? holder?.cwd
      ?? process.cwd()
  } catch {
    // 没注入 agent，用进程目录即可
  }

  const resolved = resolveConfig(config, typeof sessionCwd === 'string' ? sessionCwd : process.cwd())

  if (resolved.problems.length > 0) {
    warn('[dsh-whale-gen] 配置不全：' + resolved.problems.join('；'))
  }

  const daemon = new Daemon({
    pythonPath: resolved.pythonPath,
    serviceScript: resolved.serviceScript,
    workDir: resolved.workDir,
    port: resolved.port,
    // 服务脚本可能是包内那一份，但权重和输出在用户的项目目录。
    // 不显式传过去，脚本会按自身位置推导出 plugin/models/ 这种不存在
    // 的路径——表现是「服务起来了，但权重找不到」。
    env: {
      WHALE_ROOT: resolved.workDir,
      WHALE_OUT_DIR: resolved.outputDir,
      ...(resolved.modelPath === null ? {} : { WHALE_MODEL_PATH: resolved.modelPath }),
      ...(resolved.configDir === null ? {} : { WHALE_CONFIG_DIR: resolved.configDir }),
    },
    log: warn,
  })

  const client = createClient({ daemon })

  const faces = {
    daemon,
    client,
    config: resolved,
    warn,
  }

  // ---- 工具面 ----
  const tools = readService(ctx, 'tools')
  if (tools !== undefined && typeof tools.register === 'function') {
    for (const definition of buildTools(faces)) {
      try {
        tools.register({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          output: definition.output,
          // 出图本身是异步的，这个超时只覆盖「提交」那一下
          timeoutMs: 120_000,
          execute: definition.execute,
        })
      } catch (error) {
        warn('[dsh-whale-gen] 工具没注册上：' + definition.name + ' — ' + String(error))
      }
    }
  } else {
    warn('[dsh-whale-gen] 这个部署没有工具注册表，工具面缺席')
  }

  // ---- HTTP 面 ----
  const web = readService(ctx, 'webServer')
  if (web !== undefined && typeof web.register === 'function') {
    for (const route of makeRoutes(faces)) {
      effect(() => web.register(route), 'dsh-whale-gen: ' + route.path)
    }
  } else {
    warn('[dsh-whale-gen] 这个部署没有 webServer，面板端点缺席')
  }

  // ---- 系统提示段 ----
  if (config?.announceToAgent !== false) {
    try {
      const systemPrompt = readService(ctx, 'systemPrompt')
      if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
        effect(
          () => systemPrompt.section({
            name: PROMPT_SECTION,
            order: 45,
            text: () => PROMPT_TEXT,
          }),
          'dsh-whale-gen: 提示段',
        )
      }
    } catch (error) {
      warn('[dsh-whale-gen] 提示段没注册上：' + String(error))
    }
  }

  // ---- 收尸：插件卸载时停掉子进程 ----
  effect(() => {
    return () => {
      void daemon.stop()
    }
  }, 'dsh-whale-gen: 进程收尸')

  // 暴露给测试与调试。
  //
  // 用 try 包住：cordis 的 ctx 代理对未声明的属性赋值会抛
  // "cannot set property ... without provide"。这个句柄只是给调试用的，
  // 挂不上不该让整个插件倒下。
  try {
    ctx.whaleGen = {
      daemon,
      client,
      config: resolved,
      apiPrefix: API_PREFIX,
      /** 供面板/调试手动触发一次启动。 */
      warmup: async () => await daemon.ensure(),
    }
  } catch {
    // 挂不上就算了，工具和路由已经生效
  }
}

export { buildTools } from './tools.js'
export { makeRoutes, API_PREFIX } from './routes.js'
export { Daemon } from './daemon.js'
export { resolveConfig } from './config.js'
