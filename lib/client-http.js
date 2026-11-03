/**
 * 出图服务的 HTTP 客户端。
 *
 * 所有请求都先 ensure() 一次守护进程——这样「服务没起来」这件事对
 * 调用方是透明的：点出图、模型调工具，都会自动把服务拉起来。
 *
 * 没有重试。一次出图已经要一分钟，卡在这里反复重试只会让用户多等，
 * 不如把错误原样抛出去，让面板和模型都看见真正的原因。
 *
 * @module dsh-whale-gen/client
 */

/** 出图请求的超时：提交本身很快，但服务冷启动会卡在这。 */
const SUBMIT_TIMEOUT_MS = 30_000

/** 查询类请求的超时。 */
const QUERY_TIMEOUT_MS = 10_000

/**
 * 建一个客户端。
 * @param options - { daemon }。
 * @returns 客户端方法集。
 */
export function createClient(options) {
  const daemon = options.daemon

  /**
   * 发一个请求，先把服务拉起来。
   * @param path - 以 / 开头的路径。
   * @param init - fetch 选项。
   * @param timeoutMs - 超时。
   * @returns 解析后的 JSON。
   */
  async function request(path, init, timeoutMs) {
    await daemon.ensure()

    const response = await fetch(daemon.baseUrl + path, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })

    const body = await response.json().catch(() => null)
    if (!response.ok) {
      const message = body !== null && typeof body.error === 'string'
        ? body.error
        : 'HTTP ' + response.status
      throw new Error(message)
    }
    if (body === null) throw new Error('服务返回了非 JSON 内容')
    return body
  }

  return {
    /**
     * 提交一次出图。
     * @param body - 已校验的出图参数。
     * @returns { jobId, request }。
     */
    async generate(body) {
      return await request(
        '/api/generate',
        { method: 'POST', body: JSON.stringify(body) },
        SUBMIT_TIMEOUT_MS,
      )
    },

    /**
     * 查一个任务。
     * @param jobId - 任务 id。
     * @returns 任务对象，查不到则 null。
     */
    async job(jobId) {
      await daemon.ensure()
      const response = await fetch(daemon.baseUrl + '/api/jobs/' + encodeURIComponent(jobId), {
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      })
      if (response.status === 404) return null
      if (!response.ok) throw new Error('查询任务失败：HTTP ' + response.status)
      return await response.json()
    },

    /**
     * 取出图历史。
     * @param limit - 条数。
     * @returns 图片条目数组。
     */
    async history(limit = 20) {
      const body = await request('/api/history?limit=' + limit, {}, QUERY_TIMEOUT_MS)
      return Array.isArray(body.items) ? body.items : []
    },

    /**
     * 引擎状态（已加载 / 显存 / 均速）。
     * @returns 状态对象，服务不可达则 null。
     */
    async state() {
      return await daemon.probe()
    },

    /**
     * 取消一个任务。
     * @param jobId - 任务 id。
     */
    async cancel(jobId) {
      await request('/api/cancel/' + encodeURIComponent(jobId), { method: 'POST' }, QUERY_TIMEOUT_MS)
    },

    /**
     * 卸载模型，释放显存。
     */
    async unload() {
      await request('/api/unload', { method: 'POST' }, QUERY_TIMEOUT_MS)
    },
  }
}
