/**
 * 出图服务的进程托管。
 *
 * 插件不该要求你「先另开一个终端跑 server.py」——那是脚本时代的体验。
 * 这里负责：按需拉起、健康检查、崩溃重启、插件卸载时收尸。
 *
 * 几个真会踩的坑，写在这里省得下次再踩：
 *
 * 1. **MPS 进程不能被 SIGKILL 半途打断**。权重在显存里，硬杀可能留下
 *    一块没归还的 MPS 内存，下次加载报 OOM。所以先 SIGTERM，等它自己
 *    走 `finally` 里的 torch.mps.empty_cache()，超时才 SIGKILL。
 *
 * 2. **启动不等于可用**。torch import + 模型加载要几十秒，期间端口
 *    已经在听。健康检查必须问 /api/state 而不是探测端口。
 *
 * 3. **stdout 不读会阻塞**。子进程往管道里写日志，父进程不消费，管道
 *    缓冲区满了子进程就卡死在 write() 上——表现为「出图卡在第一步」。
 *    所以日志必须一直有人读。
 *
 * @module dsh-whale-gen/daemon
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/** 健康检查间隔。 */
const POLL_MS = 700

/** 冷启动上限：torch import 慢的机器上 90 秒不够。 */
const START_TIMEOUT_MS = 180_000

/** SIGTERM 之后等多久才 SIGKILL。VAE 解码中途被打断很不友好。 */
const TERM_GRACE_MS = 8_000

/**
 * 一个最小的、可被插件托管的本地服务句柄。
 */
export class Daemon {
  /**
   * @param options - 路径与端口配置。
   */
  constructor(options) {
    this.pythonPath = options.pythonPath
    this.serviceScript = options.serviceScript
    this.workDir = options.workDir
    this.port = options.port
    this.env = options.env ?? {}
    this.log = options.log ?? (() => {})

    this.child = null
    this.starting = null
    this.stopping = false
    this.lastError = null
    this.startedAt = 0
    this.restarts = 0

    /** 最近若干行日志，面板上能看见「正在加载模型」这类进度。 */
    this.tail = []
  }

  /** 服务根地址。 */
  get baseUrl() {
    return 'http://127.0.0.1:' + this.port
  }

  /** 记一行日志，保留最后 200 行。 */
  _push(line) {
    const text = String(line).trimEnd()
    if (text === '') return
    this.tail.push(text)
    if (this.tail.length > 200) this.tail.splice(0, this.tail.length - 200)
  }

  /**
   * 问一次健康。
   * @returns 状态对象，连不上就是 null。
   */
  async probe(timeoutMs = 1500) {
    try {
      const response = await fetch(this.baseUrl + '/api/state', {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return null
      return await response.json()
    } catch {
      return null
    }
  }

  /**
   * 确保服务在跑。已经在跑就直接返回，正在启动就等那一次启动。
   * @returns 状态对象。
   */
  async ensure() {
    const alive = await this.probe()
    if (alive !== null) return alive

    if (this.starting !== null) return await this.starting

    this.starting = this._launch()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  /**
   * 真正拉起子进程并等到健康。
   * @returns 状态对象。
   */
  async _launch() {
    if (this.stopping) throw new Error('服务正在关闭')

    if (!existsSync(this.pythonPath)) {
      throw new Error('找不到 python：' + this.pythonPath)
    }
    if (!existsSync(this.serviceScript)) {
      throw new Error('找不到出图服务脚本：' + this.serviceScript)
    }

    this.lastError = null
    this.startedAt = Date.now()

    this._push('[daemon] 启动出图服务：' + this.serviceScript)

    const child = spawn(this.pythonPath, [this.serviceScript], {
      cwd: this.workDir,
      env: {
        ...process.env,
        WHALE_PORT: String(this.port),
        // 让子进程的输出立刻到达父进程，否则日志滞后、看起来像卡住
        PYTHONUNBUFFERED: '1',
        ...this.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.child = child

    // 一直读，不能停。管道满了子进程会卡死在 write 上。
    const drain = (stream, prefix) => {
      stream.setEncoding('utf8')
      let buffer = ''
      stream.on('data', (chunk) => {
        buffer += chunk
        const lines = buffer.split('\n')
        // 最后一段可能不完整，留到下一次
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          this._push(prefix + line)
        }
      })
      stream.on('end', () => {
        if (buffer !== '') this._push(prefix + buffer)
      })
    }
    drain(child.stdout, '')
    drain(child.stderr, '[err] ')

    child.on('exit', (code, signal) => {
      const wasStopping = this.stopping
      this.child = null
      if (wasStopping) {
        this._push('[daemon] 服务已停止')
        return
      }
      this.restarts += 1
      this.lastError = '出图服务退出（code=' + code + ' signal=' + signal + '）'
      this._push('[daemon] ' + this.lastError)
      this.log(this.lastError + '\n' + this.tail.slice(-20).join('\n'))
      // 不在这里自动重启：MPS 进程崩了之后立刻重启大概率再次 OOM。
      // 让下一次 ensure()（用户点出图、模型调工具）来触发，那时是干净的状态。
    })

    child.on('error', (error) => {
      this.lastError = '无法启动出图服务：' + String(error)
      this._push('[daemon] ' + this.lastError)
    })

    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.stopping) throw new Error('服务正在关闭')
      if (child.exitCode !== null) {
        throw new Error(
          '出图服务启动即退出：' + (this.lastError ?? '未知原因') +
          '\n最近日志：\n' + this.tail.slice(-15).join('\n'),
        )
      }
      const state = await this.probe()
      if (state !== null) {
        this._push('[daemon] 服务就绪，用时 ' + ((Date.now() - this.startedAt) / 1000).toFixed(1) + 's')
        return state
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }

    throw new Error('出图服务启动超时（' + Math.round(START_TIMEOUT_MS / 1000) + ' 秒）\n最近日志：\n' + this.tail.slice(-15).join('\n'))
  }

  /**
   * 停掉服务：先 SIGTERM，等它自己走完清理，超时才 SIGKILL。
   */
  async stop() {
    const child = this.child
    if (child === null) return

    this.stopping = true
    this._push('[daemon] 正在停止出图服务（SIGTERM）')

    const exited = new Promise((resolve) => {
      child.once('exit', () => resolve(true))
    })

    try {
      child.kill('SIGTERM')
    } catch {
      // 已经没了
    }

    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), TERM_GRACE_MS)),
    ])

    if (timedOut) {
      this._push('[daemon] 优雅退出超时，强制结束')
      try {
        child.kill('SIGKILL')
      } catch {
        // 已经没了
      }
      await exited
    }

    this.child = null
    this.stopping = false
    this._push('[daemon] 出图服务已停止')
  }

  /** 给面板看的一份快照。 */
  snapshot() {
    return {
      running: this.child !== null,
      starting: this.starting !== null,
      lastError: this.lastError,
      restarts: this.restarts,
      uptimeSeconds: this.startedAt === 0 ? 0 : Math.round((Date.now() - this.startedAt) / 1000),
      port: this.port,
      tail: this.tail.slice(-40),
    }
  }
}
