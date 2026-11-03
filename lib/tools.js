/**
 * 模型可调用的工具面。
 *
 * 三个工具，一个目的：让模型能把「写提示词 → 出图 → 告诉用户图在哪」
 * 串成一次对话。分三类：
 *
 *   local_generate   出图（异步，立刻返回 jobId）
 *   local_gen_status 查进度 / 取结果
 *   local_gen_env    环境自检（python、权重、服务状态）
 *
 * 为什么不做成同步工具：一次出图 30~120 秒，同步会顶穿工具超时，
 * 而且用户在等的时候完全看不到进展。异步 + 轮询在对话里体验更好：
 * 模型可以边等边说。
 *
 * @module dsh-whale-gen/tools
 */

/** 工具描述里给模型看的硬信息，别写成散文。 */
const NEGATIVE_DEFAULT =
  'lowres, bad quality, worst quality, bad anatomy, bad hands, extra digits, ' +
  'watermark, signature, username, text, jpeg artifacts, ugly, nsfw, explicit'

/**
 * 把工具结果包成宿主认的形状。
 *
 * 宿主不按 JSON Schema 校验参数，所以每个工具自己兜底——这是从
 * middleman 那边学到的教训，那边真出过 answer: "undefined" 骗过闸门的事。
 */
const jsonOut = (schema) => ({
  schema,
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
})

/** 只接受真字符串。String(undefined) 是 "undefined"，非空，能骗过下游检查。 */
function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** 取正整数，越界夹到合法区间。 */
function intIn(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * 建工具面。
 * @param faces - 宿主能力：daemon、client、config。
 * @returns 工具定义数组。
 */
export function buildTools(faces) {
  /** 给每个工具套一层参数兜底：宿主可能传 null / 数组 / 少字段。 */
  const guarded = (definitions) =>
    definitions.map((definition) => ({
      ...definition,
      async execute(args, exec) {
        const safe = args === null || typeof args !== 'object' || Array.isArray(args) ? {} : args
        return await definition.execute(safe, exec)
      },
    }))

  return guarded([
    {
      name: 'local_generate',
      description:
        '用本机 MPS 上的 Animagine XL 4.0 出图（不走云端、不花钱、不联网）。' +
        '立刻返回 jobId，图要几十秒才出来，用 local_gen_status 查进度。' +
        '提示词用英文 Tag 串，质量词开头；尺寸走 832x1216（竖）或 1024x1024（方）最稳。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              '英文提示词。建议以 masterpiece, best quality, very aesthetic, absurdres 开头，' +
              '再写主体与场景。例：masterpiece, best quality, 1girl, solo, whale girl, ' +
              'long light blue hair, sailor collar, ocean, pastel colors',
          },
          negative: {
            type: 'string',
            description: '反向提示词。省略则用内置的一套通用负面词，通常不用填。',
          },
          width: { type: 'integer', description: '宽，默认 832。必须是 8 的倍数，范围 256~1536。' },
          height: { type: 'integer', description: '高，默认 1216。必须是 8 的倍数，范围 256~1536。' },
          steps: { type: 'integer', description: '采样步数，默认 28。范围 4~60；低于 20 会糊。' },
          cfg: { type: 'number', description: '引导强度，默认 6.0。范围 1~20；二次元 5.5~7 最稳。' },
          sampler: {
            type: 'string',
            enum: ['euler_a', 'euler', 'dpmpp'],
            description: '采样器，默认 euler_a（Animagine 推荐）。',
          },
          seed: {
            type: 'integer',
            description: '随机种子。省略则随机；要复现某张图就填它的 seed。',
          },
          batch: { type: 'integer', description: '一次出几张，默认 1，最多 8。种子依次 +1。' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        const prompt = text(args.prompt).trim()
        if (prompt === '') {
          return { ok: false, code: 'empty-prompt', error: 'prompt 不能为空' }
        }

        const width = intIn(args.width, 832, 256, 1536)
        const height = intIn(args.height, 1216, 256, 1536)
        const steps = intIn(args.steps, 28, 4, 60)
        const batch = intIn(args.batch, 1, 1, 8)
        const cfgRaw = Number(args.cfg)
        const cfg = Number.isFinite(cfgRaw) ? Math.max(1, Math.min(20, cfgRaw)) : 6

        const sampler = ['euler_a', 'euler', 'dpmpp'].includes(args.sampler)
          ? args.sampler
          : 'euler_a'

        const seedParsed = Number(args.seed)
        const seed = Number.isFinite(seedParsed) && seedParsed > 0
          ? Math.trunc(seedParsed)
          : null

        const body = {
          prompt,
          negative: text(args.negative).trim() || NEGATIVE_DEFAULT,
          width,
          height,
          steps,
          cfg,
          sampler,
          seed,
          batch,
        }

        try {
          const result = await faces.client.generate(body)
          return {
            ok: true,
            jobId: result.jobId,
            request: result.request,
            hint: '出图已排队。首次会先加载 6.5 GB 权重（30~60 秒）。用 local_gen_status 查进度。',
          }
        } catch (error) {
          return {
            ok: false,
            code: 'service-error',
            error: String(error instanceof Error ? error.message : error),
            env: faces.daemon.snapshot(),
          }
        }
      },
    },

    {
      name: 'local_gen_status',
      description:
        '查鲸鱼出图进度。给 jobId 查那一次；不给 jobId 就列出最近的出图记录。' +
        '状态 done 时 images 里是图片的相对路径与全部参数，可以直接把路径给用户。',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'local_generate 返回的 jobId。省略则列出历史。' },
          limit: { type: 'integer', description: '列历史时返回几条，默认 10。' },
        },
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        const jobId = text(args.jobId).trim()

        try {
          if (jobId !== '') {
            const job = await faces.client.job(jobId)
            if (job === null) {
              return { ok: false, code: 'no-such-job', error: '没有这个 jobId：' + jobId }
            }
            const progress = job.progress ?? {}
            return {
              ok: true,
              jobId: job.id,
              status: job.status,
              progress: {
                image: progress.image ?? 0,
                images: progress.images ?? 0,
                step: progress.step ?? 0,
                total: progress.total ?? 0,
              },
              elapsed: Math.round(job.elapsed ?? 0),
              phase: job.phase ?? null,
              images: (job.images ?? []).map((item) => ({
                file: item.file,
                path: faces.config.outputDir + '/' + item.file,
                seed: item.seed,
                size: item.width + 'x' + item.height,
                seconds: item.seconds,
              })),
              error: job.error ?? null,
            }
          }

          const limit = intIn(args.limit, 10, 1, 50)
          const history = await faces.client.history(limit)
          return {
            ok: true,
            count: history.length,
            outputDir: faces.config.outputDir,
            items: history.map((item) => ({
              file: item.file,
              path: faces.config.outputDir + '/' + item.file,
              seed: item.seed,
              size: item.width + 'x' + item.height,
              steps: item.steps,
              cfg: item.cfg,
              seconds: item.seconds,
              prompt: String(item.prompt ?? '').slice(0, 120),
            })),
          }
        } catch (error) {
          return {
            ok: false,
            code: 'service-error',
            error: String(error instanceof Error ? error.message : error),
            env: faces.daemon.snapshot(),
          }
        }
      },
    },

    {
      name: 'local_gen_env',
      description:
        '自检鲸鱼出图环境：python、权重、服务进程状态、显存占用。' +
        '出图失败或首次使用时先调它，比猜快。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: jsonOut({ type: 'object' }),
      async execute() {
        const snapshot = faces.daemon.snapshot()
        let engine = null
        try {
          engine = await faces.daemon.probe()
        } catch {
          engine = null
        }
        return {
          ok: faces.config.problems.length === 0,
          config: {
            pythonPath: faces.config.pythonPath,
            serviceScript: faces.config.serviceScript,
            workDir: faces.config.workDir,
            outputDir: faces.config.outputDir,
            port: faces.config.port,
          },
          problems: faces.config.problems,
          daemon: {
            running: snapshot.running,
            restarts: snapshot.restarts,
            lastError: snapshot.lastError,
            recentLog: snapshot.tail.slice(-8),
          },
          engine,
        }
      },
    },
  ])
}

export { NEGATIVE_DEFAULT }
