/**
 * 宿主 HTTP 面：面板驱动的端点，全部挂在 /whale-gen/api 下。
 *
 * 一条围栏：只放本机浏览器。出图会占满显存、写文件，不该对局域网开放。
 *
 * 这些端点是给**人手点**用的，和工具面（给模型调）分开：
 * 面板不经过模型，模型也点不了面板的按钮。
 *
 * @module dsh-whale-gen/routes
 */
import { createReadStream, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { buildSetupSteps, envOverrideHint } from './setup.js'

/** 路由前缀。 */
export const API_PREFIX = '/whale-gen/api'

/** 请求体上限。出图参数很小，64 KB 绰绰有余。 */
const BODY_LIMIT = 64 * 1024

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

/** 图片文件名白名单：只允许磁盘上可能出现的那些字符。 */
const SAFE_FILE = /^[A-Za-z0-9_.\-]+\.png$/

/**
 * 只放环回地址。
 * @param address - socket 远端地址。
 * @returns 是否本机。
 */
function isLoopback(address) {
  if (typeof address !== 'string') return false
  return address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
}

/** 写一份 JSON。 */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** 拒绝。 */
function refuse(res, status, code, message) {
  writeJson(res, status, { ok: false, code, error: message })
}

/**
 * 读请求体。
 * @param req - 请求。
 * @returns 解析后的对象。
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  return JSON.parse(raw)
}

/**
 * 建路由表。
 * @param faces - { daemon, client, config, warn }。
 * @returns 路由数组，形状对齐 webServer.register。
 */
export function makeRoutes(faces) {
  /** 统一包一层：环回围栏 + 错误收敛。 */
  const route = (kind, path, handler) => ({
    kind,
    path,
    async handler(req, res) {
      if (!isLoopback(req.socket?.remoteAddress)) {
        refuse(res, 403, 'forbidden', '只接受本机连接')
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        // 回环已经确认过，把真实原因说出来比让人翻日志快
        faces.warn?.('[dsh-whale-gen] 路由失败：' + String(error))
        refuse(res, 500, 'internal', error instanceof Error ? error.message : String(error))
      }
    },
  })

  return [
    // ---- 环境自检 ----
    route('prefix', API_PREFIX + '/env', async (req, res) => {
      const snapshot = faces.daemon.snapshot()
      const engine = await faces.daemon.probe()
      writeJson(res, 200, {
        ok: faces.config.problems.length === 0,
        config: {
          pythonPath: faces.config.pythonPath,
          serviceScript: faces.config.serviceScript,
          workDir: faces.config.workDir,
          outputDir: faces.config.outputDir,
          port: faces.config.port,
        },
        problems: faces.config.problems,
        // 安装指引：缺什么就给对应哪段可复制的命令，
        // 让「装插件的人」不用去翻 README
        setup: {
          steps: buildSetupSteps(faces.config),
          envHint: envOverrideHint(faces.config),
        },
        daemon: {
          running: snapshot.running,
          starting: snapshot.starting,
          restarts: snapshot.restarts,
          lastError: snapshot.lastError,
          uptimeSeconds: snapshot.uptimeSeconds,
        },
        engine,
      })
    }),

    // ---- 启动服务（面板上「启动」按钮） ----
    route('prefix', API_PREFIX + '/start', async (req, res) => {
      if (req.method !== 'POST') return refuse(res, 405, 'method', '只接受 POST')
      if (faces.config.problems.length > 0) {
        return refuse(res, 400, 'not-configured', faces.config.problems.join('；'))
      }
      const engine = await faces.daemon.ensure()
      writeJson(res, 200, { ok: true, engine })
    }),

    // ---- 停止服务，释放显存 ----
    route('prefix', API_PREFIX + '/stop', async (req, res) => {
      if (req.method !== 'POST') return refuse(res, 405, 'method', '只接受 POST')
      await faces.daemon.stop()
      writeJson(res, 200, { ok: true })
    }),

    // ---- 出图 ----
    route('prefix', API_PREFIX + '/generate', async (req, res) => {
      if (req.method !== 'POST') return refuse(res, 405, 'method', '只接受 POST')
      const body = await readBody(req).catch(() => null)
      if (body === null) return refuse(res, 400, 'invalid-json', '请求体不是合法 JSON')

      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      if (prompt === '') return refuse(res, 400, 'empty-prompt', 'prompt 不能为空')

      const clamp = (value, fallback, min, max) => {
        const parsed = Number(value)
        if (!Number.isFinite(parsed)) return fallback
        return Math.max(min, Math.min(max, Math.trunc(parsed)))
      }

      const request = {
        prompt,
        negative: typeof body.negative === 'string' && body.negative.trim() !== ''
          ? body.negative.trim()
          : undefined,
        width: clamp(body.width, 832, 256, 1536),
        height: clamp(body.height, 1216, 256, 1536),
        steps: clamp(body.steps, 28, 4, 60),
        cfg: Number.isFinite(Number(body.cfg)) ? Math.max(1, Math.min(20, Number(body.cfg))) : 6,
        sampler: ['euler_a', 'euler', 'dpmpp'].includes(body.sampler) ? body.sampler : 'euler_a',
        batch: clamp(body.batch, 1, 1, 8),
        seed: Number.isFinite(Number(body.seed)) && Number(body.seed) > 0
          ? Math.trunc(Number(body.seed))
          : null,
      }

      try {
        const result = await faces.client.generate(request)
        writeJson(res, 200, { ok: true, jobId: result.jobId, request: result.request })
      } catch (error) {
        refuse(res, 502, 'service-error', error instanceof Error ? error.message : String(error))
      }
    }),

    // ---- 查任务 ----
    route('prefix', API_PREFIX + '/job', async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const id = url.searchParams.get('id') ?? ''
      if (id === '') return refuse(res, 400, 'missing-id', '必须带 id')

      try {
        const job = await faces.client.job(id)
        if (job === null) return refuse(res, 404, 'no-such-job', '没有这个任务')
        writeJson(res, 200, job)
      } catch (error) {
        refuse(res, 502, 'service-error', error instanceof Error ? error.message : String(error))
      }
    }),

    // ---- 历史 ----
    route('prefix', API_PREFIX + '/history', async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const limitRaw = Number(url.searchParams.get('limit'))
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(120, Math.trunc(limitRaw))) : 40

      try {
        const items = await faces.client.history(limit)
        writeJson(res, 200, { ok: true, items, outputDir: faces.config.outputDir })
      } catch (error) {
        refuse(res, 502, 'service-error', error instanceof Error ? error.message : String(error))
      }
    }),

    // ---- 取消 ----
    route('prefix', API_PREFIX + '/cancel', async (req, res) => {
      if (req.method !== 'POST') return refuse(res, 405, 'method', '只接受 POST')
      const body = await readBody(req).catch(() => null)
      const id = typeof body?.id === 'string' ? body.id : ''
      if (id === '') return refuse(res, 400, 'missing-id', '必须带 id')
      try {
        await faces.client.cancel(id)
        writeJson(res, 200, { ok: true })
      } catch (error) {
        refuse(res, 502, 'service-error', error instanceof Error ? error.message : String(error))
      }
    }),

    // ---- 卸载模型 ----
    route('prefix', API_PREFIX + '/unload', async (req, res) => {
      if (req.method !== 'POST') return refuse(res, 405, 'method', '只接受 POST')
      try {
        await faces.client.unload()
        writeJson(res, 200, { ok: true })
      } catch (error) {
        refuse(res, 502, 'service-error', error instanceof Error ? error.message : String(error))
      }
    }),

    // ---- 取图：面板把 png 读出来显示 ----
    route('prefix', API_PREFIX + '/image', async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const file = url.searchParams.get('file') ?? ''

      // 只认白名单文件名，挡掉 ../ 和绝对路径
      if (!SAFE_FILE.test(file) || basename(file) !== file) {
        return refuse(res, 400, 'bad-file', '文件名不合法')
      }

      const full = join(faces.config.outputDir, file)
      if (!existsSync(full)) return refuse(res, 404, 'not-found', '这张图不在了')

      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=31536000, immutable',
        'referrer-policy': 'no-referrer',
      })
      const stream = createReadStream(full)
      // 头已经发出去了，半路失败没法换状态码，只能掐断连接——
      // 浏览器会显示裂图，好过把响应挂着不动
      stream.on('error', () => {
        res.destroy()
      })
      stream.pipe(res)
      // 客户端中途取消（换了张图）时停读文件，别让流空转
      res.on('close', () => {
        stream.destroy()
      })
    }),
  ]
}
