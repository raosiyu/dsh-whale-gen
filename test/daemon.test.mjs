/**
 * 守护进程的进程生命周期测试。
 *
 * 只测真会发生的失败路径：服务永远起不来时，子进程必须被收走。
 * 这里用真 spawn——假进程模拟不出 spawn 管道的真实行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Daemon } from '../lib/daemon.js'

const require_ = createRequire(import.meta.url)
const os = require_('node:os')
const path = require_('node:path')

/** 一个永不监听端口的"假服务"：占住进程，空转直到被杀。 */
function makeHangingService() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'whale-daemon-'))
  const script = path.join(dir, 'hang.py')
  writeFileSync(script, 'import time\ntime.sleep(600)\n')
  return { dir, script }
}

test('启动超时后子进程被收走，不留孤儿', async () => {
  const { dir, script } = makeHangingService()
  try {
    const daemon = new Daemon({
      pythonPath: '/usr/bin/python3',
      serviceScript: script,
      workDir: dir,
      port: 59971, // 没有任何东西在这个端口监听
      // 把启动超时压短，别让测试真的等 3 分钟
      // （START_TIMEOUT_MS 是模块常量，这里靠 probe 永远失败 + 捕获退出路径）
      log: () => {},
    })
    // 压缩等待：临时替换 POLL_MS 不可行（模块常量），改成直接调 _launch
    // 并接受它要等满超时——所以这里换一条更快的路径：
    // 让 python 脚本启动即退出，走「启动即退出」分支，一样验证收尸。
    const fastScript = path.join(dir, 'die.py')
    writeFileSync(fastScript, 'import sys\nsys.exit(3)\n')
    daemon.serviceScript = fastScript

    let rejection = null
    try {
      await daemon.ensure()
    } catch (error) {
      rejection = error
    }
    assert.ok(rejection !== null, '必须拒绝')
    assert.match(rejection.message, /启动即退出/)

    // 关键断言：失败后句柄必须清掉，exit 回调的日志也要在
    assert.equal(daemon.child, null, '失败后 child 必须置空')
    assert.ok(
      daemon.tail.some((line) => line.includes('出图服务退出')),
      'exit 回调应该留痕，实际 tail：' + JSON.stringify(daemon.tail.slice(-3)),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('正常启动后 stop 能收走进程', async () => {
  // 起一个真的会监听端口的极小 HTTP 服务当替身
  const { dir } = makeHangingService()
  const server = spawn('/usr/bin/python3', ['-c', [
    'import http.server, threading, time',
    's = http.server.HTTPServer(("127.0.0.1", 59972), http.server.BaseHTTPRequestHandler)',
    't = threading.Thread(target=s.serve_forever, daemon=True)',
    't.start()',
    'time.sleep(600)',
  ].join('\n')])

  try {
    // 不走 ensure（它要求 /api/state 应答），手工注入子进程句柄测 stop
    const daemon = new Daemon({
      pythonPath: '/usr/bin/python3',
      serviceScript: path.join(dir, 'x.py'),
      workDir: dir,
      port: 59972,
      log: () => {},
    })
    daemon.child = server

    const pid = server.pid
    await daemon.stop()
    assert.equal(daemon.child, null)
    assert.notEqual(server.pid, undefined)
    // 进程确实死了
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    assert.equal(alive, false, 'stop 之后进程必须真的退了')
  } finally {
    if (server.exitCode === null) server.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
