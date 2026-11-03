/**
 * dsh-whale-gen 浏览器半区。
 *
 * 这个文件不是普通 ESM：它必须按 DSH 的客户端模块协议注册自己
 * （window.__ModuleLoader__.load({id, factory})），由 web 应用在启动时加载。
 * 写成 export function apply 的形式宿主会当普通模块，浏览器永远看不到它。
 *
 * 页面用 React.createElement 拼，不用 JSX —— 于是不需要构建步骤，
 * 仓库里就是能直接装的那一份。
 *
 * @module dsh-whale-gen/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-gen',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 侧边栏行的 id，与主栏的 key 一致。 */
    const PANEL_ID = 'whale-gen'

    /** 行序：中台是 30，出图放 40，排在它后面。 */
    const PANEL_ORDER = 40

    /** 深色一套，跟随 DSH 的调性。 */
    const C = {
      bg: '#070E1A',
      panel: '#0C1626',
      raised: '#111F33',
      hover: '#16283F',
      border: '#1E3247',
      borderStrong: '#2A4257',
      text: '#E8F1FA',
      text2: '#8FA6BE',
      text3: '#5E7A93',
      accent: '#38D6C4',
      accentSoft: 'rgba(56,214,196,0.16)',
      accentLine: 'rgba(56,214,196,0.42)',
      danger: '#FF6B7A',
      warn: '#FFC24B',
      mono: '"SF Mono", ui-monospace, Menlo, Monaco, monospace',
    }

    const R = { sm: 6, md: 10, lg: 14 }

    /** 出图尺寸预设。 */
    const SIZES = [
      { key: '832x1216', label: '832×1216', w: 832, h: 1216 },
      { key: '1024x1024', label: '1024²', w: 1024, h: 1024 },
      { key: '1216x832', label: '1216×832', w: 1216, h: 832 },
      { key: '768x1024', label: '768×1024', w: 768, h: 1024 },
      { key: '1024x768', label: '1024×768', w: 1024, h: 768 },
      { key: '512x512', label: '512²', w: 512, h: 512 },
    ]

    const STYLE_SUFFIX = 'masterpiece, best quality, very aesthetic, absurdres, '

    const NEG_DEFAULT =
      'lowres, bad quality, worst quality, bad anatomy, bad hands, extra digits, ' +
      'watermark, signature, username, text, jpeg artifacts, ugly, nsfw, explicit'

    const STORE_KEY = 'whale-gen-panel-v1'

    /* ---------------------------------------------------------- API */

    /** 打一次本插件 API。失败也返回对象，不抛。 */
    async function api(path, body) {
      try {
        const response = await fetch('/whale-gen/api' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        return await response.json()
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    }

    /** 图片的 URL。 */
    function imageUrl(file) {
      return '/whale-gen/api/image?file=' + encodeURIComponent(file)
    }

    /* -------------------------------------------------------- 小组件 */

    /** 一个很小的按钮。 */
    function Btn(props) {
      const { children, onClick, disabled, primary, title, style } = props
      const [hover, setHover] = React.useState(false)
      return h('button', {
        onClick,
        disabled,
        title,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          height: 30,
          padding: '0 10px',
          borderRadius: R.sm,
          border: '1px solid ' + (primary ? C.accentLine : C.borderStrong),
          background: primary
            ? (disabled ? C.raised : (hover ? '#3FE0CD' : C.accent))
            : (hover && !disabled ? C.hover : 'transparent'),
          color: primary ? '#04211F' : C.text2,
          fontSize: 12.5,
          fontWeight: primary ? 600 : 400,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          whiteSpace: 'nowrap',
          transition: 'background .15s, color .15s',
          ...style,
        },
      }, children)
    }

    /** 分区标题。 */
    function SectionTitle(props) {
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 1.1,
          textTransform: 'uppercase',
          color: C.text3,
          marginBottom: 8,
        },
      }, [
        h('span', { key: 't' }, props.children),
        h('span', {
          key: 'l',
          style: { flex: 1, height: 1, background: C.border },
        }),
        props.extra === undefined ? null : h('span', {
          key: 'e',
          style: { fontFamily: C.mono, letterSpacing: 0, textTransform: 'none' },
        }, props.extra),
      ])
    }

    /** 带标签的一行。 */
    function Row(props) {
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
        },
      }, [
        h('span', { key: 'k', style: { fontSize: 13, color: C.text2 } }, props.label),
        props.children,
      ])
    }

    /** 数值徽章。 */
    function Value(props) {
      return h('span', {
        style: {
          fontFamily: C.mono,
          fontSize: 12.5,
          color: C.text,
          background: C.raised,
          border: '1px solid ' + C.border,
          borderRadius: R.sm,
          padding: '2px 8px',
          minWidth: 48,
          textAlign: 'center',
        },
      }, props.children)
    }

    /** 一个滑杆。 */
    function Slider(props) {
      const { value, min, max, step, onChange } = props
      const pct = ((value - min) / (max - min)) * 100
      return h('input', {
        type: 'range',
        min,
        max,
        step,
        value,
        onChange: (event) => onChange(Number(event.target.value)),
        style: {
          width: '100%',
          height: 20,
          marginBottom: 10,
          appearance: 'none',
          WebkitAppearance: 'none',
          background: 'transparent',
          cursor: 'pointer',
          // 轨道用渐变画，把手用 webkit 伪元素
        },
        // 内联伪元素做不到，用 background 模拟轨道
        onInput: undefined,
        ref: (node) => {
          if (node === null) return
          node.style.setProperty('--p', pct + '%')
          // 轨道
          node.style.background =
            'linear-gradient(90deg,' + C.accent + ' ' + pct + '%,#1B2E43 ' + pct + '%)'
          node.style.backgroundSize = '100% 4px'
          node.style.backgroundRepeat = 'no-repeat'
          node.style.backgroundPosition = 'center'
          node.style.borderRadius = '99px'
        },
      })
    }

    /** 状态点。 */
    function Dot(props) {
      const tone = props.tone
      const color = tone === 'on' ? C.accent
        : tone === 'busy' ? C.warn
          : tone === 'err' ? C.danger
            : C.text3
      return h('span', {
        style: {
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          boxShadow: '0 0 0 3px ' + color + '22',
          flex: 'none',
          animation: tone === 'busy' ? 'wg-pulse 1.4s ease-in-out infinite' : 'none',
        },
      })
    }

    /* -------------------------------------------------------- 主面板 */

    /**
     * 出图面板。
     *
     * 三块：参数区、预览区、历史区。用 flex 竖排而不是三栏，
     * 因为侧边栏本身就很窄——塞三栏会窄到没法用。
     */
    function WhaleGenPage() {
      const [ready, setReady] = React.useState(false)
      const [env, setEnv] = React.useState(null)
      const [engine, setEngine] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [job, setJob] = React.useState(null)
      const [images, setImages] = React.useState([])
      const [active, setActive] = React.useState(null)
      const [history, setHistory] = React.useState([])
      const [error, setError] = React.useState(null)
      const [toast, setToast] = React.useState(null)

      // 参数
      const [prompt, setPrompt] = React.useState('')
      const [negative, setNegative] = React.useState(NEG_DEFAULT)
      const [showNeg, setShowNeg] = React.useState(false)
      const [sizeKey, setSizeKey] = React.useState('832x1216')
      const [steps, setSteps] = React.useState(28)
      const [cfg, setCfg] = React.useState(6)
      const [sampler, setSampler] = React.useState('euler_a')
      const [seed, setSeed] = React.useState('')
      const [batch, setBatch] = React.useState(1)

      const jobTimer = React.useRef(null)
      const pollTimer = React.useRef(null)

      /* ---- 存取参数 ---- */

      const snapshotParams = React.useCallback(() => ({
        prompt, negative, sizeKey, steps, cfg, sampler, seed, batch,
      }), [prompt, negative, sizeKey, steps, cfg, sampler, seed, batch])

      const persist = React.useCallback(() => {
        try {
          window.localStorage.setItem(STORE_KEY, JSON.stringify(snapshotParams()))
        } catch {
          // 隐私模式下会抛，忽略
        }
      }, [snapshotParams])

      React.useEffect(() => {
        if (!ready) return
        persist()
      }, [ready, persist])

      /* ---- 首次加载 ---- */

      const refreshEnv = React.useCallback(async () => {
        const data = await api('/env')
        setEnv(data)
        setEngine(data.engine ?? null)
        return data
      }, [])

      const refreshHistory = React.useCallback(async () => {
        const data = await api('/history?limit=40')
        if (Array.isArray(data.items)) setHistory(data.items)
      }, [])

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          // 恢复上次的参数
          let saved = null
          try {
            saved = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null')
          } catch {
            saved = null
          }
          if (saved !== null && typeof saved === 'object') {
            if (typeof saved.prompt === 'string') setPrompt(saved.prompt)
            if (typeof saved.negative === 'string' && saved.negative !== '') setNegative(saved.negative)
            if (SIZES.some((item) => item.key === saved.sizeKey)) setSizeKey(saved.sizeKey)
            if (Number.isFinite(saved.steps)) setSteps(saved.steps)
            if (Number.isFinite(saved.cfg)) setCfg(saved.cfg)
            if (typeof saved.sampler === 'string') setSampler(saved.sampler)
            if (typeof saved.seed === 'string') setSeed(saved.seed)
            if (Number.isFinite(saved.batch)) setBatch(Math.max(1, Math.min(8, saved.batch)))
          }

          const data = await refreshEnv()
          if (!alive) return
          setReady(true)
          await refreshHistory()
        })()
        return () => { alive = false }
      }, [refreshEnv, refreshHistory])

      /* ---- 轮询引擎状态 ---- */

      React.useEffect(() => {
        if (!ready) return undefined
        pollTimer.current = setInterval(() => { void refreshEnv() }, 4000)
        return () => {
          if (pollTimer.current !== null) clearInterval(pollTimer.current)
        }
      }, [ready, refreshEnv])

      // 组件卸载时把任务轮询也收掉——不然离开面板后它还在每 700ms
      // 打一次接口，服务日志里全是幽灵请求
      React.useEffect(() => {
        return () => {
          if (jobTimer.current !== null) clearInterval(jobTimer.current)
        }
      }, [])

      /* ---- 轮询任务 ---- */

      const stopJobPolling = React.useCallback(() => {
        if (jobTimer.current !== null) {
          clearInterval(jobTimer.current)
          jobTimer.current = null
        }
      }, [])

      const tickJob = React.useCallback(async (jobId) => {
        const data = await api('/job?id=' + encodeURIComponent(jobId))
        if (data === null || data.ok === false) {
          stopJobPolling()
          setBusy(false)
          return
        }
        setJob(data)

        if (data.status === 'done') {
          stopJobPolling()
          setBusy(false)
          const produced = Array.isArray(data.images) ? data.images : []
          setImages(produced)
          if (produced.length > 0) setActive(produced[0])
          setToast('出图完成 · ' + produced.length + ' 张')
          await refreshHistory()
        } else if (data.status === 'failed') {
          stopJobPolling()
          setBusy(false)
          setError(data.error ?? '出图失败')
        } else if (data.status === 'cancelled') {
          stopJobPolling()
          setBusy(false)
          setToast('已取消')
        }
      }, [stopJobPolling, refreshHistory])

      /* ---- 出图 ---- */

      const generate = React.useCallback(async () => {
        if (prompt.trim() === '') {
          setError('先写提示词')
          return
        }
        setError(null)
        setToast(null)
        setBusy(true)
        setJob(null)
        setImages([])
        setActive(null)

        const size = SIZES.find((item) => item.key === sizeKey) ?? SIZES[0]
        const result = await api('/generate', {
          prompt: prompt.trim(),
          negative: negative.trim(),
          width: size.w,
          height: size.h,
          steps,
          cfg,
          sampler,
          seed: seed.trim() === '' ? null : Number(seed),
          batch,
        })

        if (result.ok !== true) {
          setBusy(false)
          setError(result.error ?? '提交失败')
          return
        }

        const jobId = result.jobId
        stopJobPolling()
        jobTimer.current = setInterval(() => { void tickJob(jobId) }, 700)
        void tickJob(jobId)
      }, [prompt, negative, sizeKey, steps, cfg, sampler, seed, batch, tickJob, stopJobPolling])

      /* ---- 启动 / 停止服务 ---- */

      const startService = React.useCallback(async () => {
        setError(null)
        setToast('正在加载模型，30~60 秒…')
        const data = await api('/start', {})
        if (data.ok === true) {
          setToast('服务已就绪')
          await refreshEnv()
        } else {
          setError(data.error ?? '启动失败')
        }
      }, [refreshEnv])

      const stopService = React.useCallback(async () => {
        setToast('正在停止，释放显存…')
        await api('/stop', {})
        setToast('已停止')
        await refreshEnv()
      }, [refreshEnv])

      const unloadModel = React.useCallback(async () => {
        const data = await api('/unload', {})
        if (data.ok === true) {
          setToast('模型已卸载，显存已释放')
        } else {
          setError(data.error ?? '卸载失败')
        }
        await refreshEnv()
      }, [refreshEnv])

      /* ---- 复用历史参数 ---- */

      const reuse = React.useCallback((item) => {
        if (typeof item.prompt === 'string') setPrompt(item.prompt)
        if (typeof item.negative === 'string' && item.negative !== '') setNegative(item.negative)
        if (Number.isFinite(item.steps)) setSteps(item.steps)
        if (Number.isFinite(item.cfg)) setCfg(item.cfg)
        if (typeof item.sampler === 'string') setSampler(item.sampler)
        if (Number.isFinite(item.seed)) setSeed(String(item.seed))
        const key = item.width + 'x' + item.height
        if (SIZES.some((entry) => entry.key === key)) setSizeKey(key)
        setActive(item)
        setImages([item])
        setToast('已载入这张图的参数')
      }, [])

      /* ---- 渲染 ---- */

      if (!ready) {
        return h('div', {
          style: {
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: C.text3,
            fontSize: 13,
          },
        }, '正在读取出图环境…')
      }

      const problems = env?.problems ?? []
      const configured = problems.length === 0
      const engineState = engine
      const dotTone = !configured ? 'err'
        : job !== null && (job.status === 'running' || job.status === 'queued') ? 'busy'
          : engineState?.loaded === true ? 'on'
            : engineState !== null ? 'busy'
              : 'idle'
      const dotText = !configured ? '未配置'
        : job !== null && job.status === 'running' ? '出图中'
          : job !== null && job.status === 'queued' ? '排队中'
            : engineState?.loaded === true ? '模型就绪'
              : engineState !== null ? '服务在跑' : '服务未启动'

      const progress = job?.progress ?? null
      const pct = progress !== null && progress.total > 0
        ? Math.min(100, (progress.step / progress.total) * 100)
        : 0

      /* 上传区 + 参数区 */
      const controls = h('div', {
        style: {
          padding: 12,
          borderBottom: '1px solid ' + C.border,
          background: C.panel,
          flex: 'none',
        },
      }, [
        // 状态行
        h('div', {
          key: 'status',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 10,
            fontSize: 12,
            color: C.text2,
          },
        }, [
          h(Dot, { key: 'd', tone: dotTone }),
          h('span', { key: 't' }, dotText),
          h('span', { key: 's', style: { flex: 1 } }),
          engineState === null ? null : h('span', {
            key: 'm',
            style: { fontFamily: C.mono, fontSize: 11, color: C.text3 },
          }, (engineState.mpsAllocated ?? 0).toFixed(1) + ' GB'),
        ]),

        // 未配置提示 + 安装指引：缺什么，就给对应的安装命令
        configured ? null : h('div', {
          key: 'prob',
          style: {
            background: 'rgba(255,107,122,0.08)',
            border: '1px solid ' + C.danger + '55',
            borderRadius: R.md,
            padding: 10,
            marginBottom: 10,
            fontSize: 12,
            lineHeight: 1.6,
          },
        }, [
          h('div', {
            key: 'h',
            style: { fontWeight: 600, marginBottom: 6, color: '#FFD9DD' },
          }, '鲸鱼出图还缺几样东西，照下面的顺序装：'),
          ...(env?.setup?.steps ?? []).map((step, index) => h('div', {
            key: 'step' + index,
            style: { marginBottom: 10 },
          }, [
            h('div', {
              key: 't',
              style: {
                display: 'flex',
                alignItems: 'baseline',
                gap: 6,
                marginBottom: 4,
              },
            }, [
              h('span', {
                key: 'n',
                style: {
                  fontFamily: C.mono,
                  fontSize: 10.5,
                  color: C.accent,
                  background: C.accentSoft,
                  borderRadius: 99,
                  padding: '0 6px',
                  flex: 'none',
                },
              }, String(index + 1)),
              h('span', { key: 'l', style: { color: C.text, fontWeight: 600 } }, step.title),
            ]),
            step.reason === undefined ? null : h('div', {
              key: 'r',
              style: { color: C.text3, fontSize: 11, marginBottom: 6, paddingLeft: 22 },
            }, step.reason),
            step.commands === undefined ? null : h('div', {
              key: 'c',
              style: { position: 'relative', paddingLeft: 22 },
            }, [
              h('pre', {
                key: 'pre',
                style: {
                  background: '#050A12',
                  border: '1px solid ' + C.border,
                  borderRadius: R.sm,
                  padding: 8,
                  margin: 0,
                  fontFamily: C.mono,
                  fontSize: 10.5,
                  lineHeight: 1.55,
                  color: '#9EC5DC',
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                },
              }, step.commands.join('\n')),
              h('button', {
                key: 'copy',
                onClick: () => {
                  const text = step.commands.filter((line) => !line.startsWith('#')).join('\n')
                  void navigator.clipboard?.writeText?.(text)
                  setCopied(step.id)
                  setTimeout(() => setCopied(null), 1600)
                },
                style: {
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  height: 22,
                  padding: '0 8px',
                  borderRadius: R.sm,
                  border: '1px solid ' + C.borderStrong,
                  background: C.raised,
                  color: copied === step.id ? C.accent : C.text3,
                  fontSize: 10.5,
                  cursor: 'pointer',
                },
              }, copied === step.id ? '已复制' : '复制'),
            ]),
          ])),
          env?.setup?.envHint === null || env?.setup?.envHint === undefined ? null : h('div', {
            key: 'hint',
            style: { color: C.text3, fontSize: 11, paddingLeft: 22 },
          }, env.setup.envHint),
        ]),

        // 提示词
        h(SectionTitle, { key: 'st1', extra: String(prompt.length) }, '提示词'),
        h('textarea', {
          key: 'prompt',
          value: prompt,
          spellCheck: false,
          placeholder: 'masterpiece, best quality, 1girl, solo, whale girl…',
          onChange: (event) => setPrompt(event.target.value),
          style: {
            width: '100%',
            minHeight: 84,
            resize: 'vertical',
            background: C.raised,
            border: '1px solid ' + C.border,
            borderRadius: R.md,
            padding: 10,
            fontFamily: C.mono,
            fontSize: 12.5,
            lineHeight: 1.6,
            color: C.text,
            outline: 'none',
            marginBottom: 6,
          },
        }),
        h('div', {
          key: 'prompt-tools',
          style: { display: 'flex', gap: 6, marginBottom: 12 },
        }, [
          h(Btn, {
            key: 'style',
            onClick: () => {
              if (prompt.includes('masterpiece')) {
                setToast('已经带了质量词')
                return
              }
              setPrompt(STYLE_SUFFIX + prompt)
            },
          }, '+ 质量词'),
          h(Btn, {
            key: 'clear',
            onClick: () => setPrompt(''),
          }, '清空'),
          h('span', { key: 'sp', style: { flex: 1 } }),
          h(Btn, {
            key: 'neg',
            onClick: () => setShowNeg((value) => !value),
          }, showNeg ? '收起反向' : '反向提示词'),
        ]),

        showNeg ? h('textarea', {
          key: 'neg',
          value: negative,
          spellCheck: false,
          onChange: (event) => setNegative(event.target.value),
          style: {
            width: '100%',
            minHeight: 56,
            resize: 'vertical',
            background: C.raised,
            border: '1px solid ' + C.border,
            borderRadius: R.md,
            padding: 10,
            fontFamily: C.mono,
            fontSize: 11.5,
            lineHeight: 1.6,
            color: C.text2,
            outline: 'none',
            marginBottom: 12,
          },
        }) : null,

        // 画幅
        h(SectionTitle, { key: 'st2' }, '画幅'),
        h('div', {
          key: 'sizes',
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 6,
            marginBottom: 12,
          },
        }, SIZES.map((item) => {
          const on = item.key === sizeKey
          return h('button', {
            key: item.key,
            onClick: () => setSizeKey(item.key),
            style: {
              height: 32,
              borderRadius: R.sm,
              border: '1px solid ' + (on ? C.accentLine : C.border),
              background: on ? C.accentSoft : C.raised,
              color: on ? C.accent : C.text2,
              fontFamily: C.mono,
              fontSize: 11,
              cursor: 'pointer',
              transition: 'all .15s',
            },
          }, item.label)
        })),

        // 采样
        h(Row, { key: 'r-steps', label: '步数' }, h(Value, null, steps)),
        h(Slider, {
          key: 's-steps',
          value: steps,
          min: 8,
          max: 50,
          step: 1,
          onChange: setSteps,
        }),
        h(Row, { key: 'r-cfg', label: 'CFG' }, h(Value, null, cfg.toFixed(1))),
        h(Slider, {
          key: 's-cfg',
          value: cfg,
          min: 1,
          max: 14,
          step: 0.5,
          onChange: setCfg,
        }),

        // 采样器
        h('select', {
          key: 'sampler',
          value: sampler,
          onChange: (event) => setSampler(event.target.value),
          style: {
            width: '100%',
            height: 32,
            marginBottom: 12,
            background: C.raised,
            border: '1px solid ' + C.border,
            borderRadius: R.sm,
            padding: '0 8px',
            fontSize: 12,
            color: C.text,
            outline: 'none',
          },
        }, [
          h('option', { key: 'a', value: 'euler_a' }, 'Euler a — 稳，适合二次元'),
          h('option', { key: 'b', value: 'euler' }, 'Euler — 更锐'),
          h('option', { key: 'c', value: 'dpmpp' }, 'DPM++ 2M — 细节多'),
        ]),

        // 种子与批量
        h('div', {
          key: 'seed-row',
          style: { display: 'grid', gridTemplateColumns: '1fr 96px', gap: 6, marginBottom: 12 },
        }, [
          h('input', {
            key: 'seed',
            value: seed,
            placeholder: '种子（空=随机）',
            onChange: (event) => setSeed(event.target.value.replace(/[^0-9]/g, '')),
            style: {
              height: 32,
              background: C.raised,
              border: '1px solid ' + C.border,
              borderRadius: R.sm,
              padding: '0 8px',
              fontFamily: C.mono,
              fontSize: 12,
              color: C.text,
              outline: 'none',
            },
          }),
          h('div', {
            key: 'batch',
            style: {
              display: 'flex',
              alignItems: 'center',
              background: C.raised,
              border: '1px solid ' + C.border,
              borderRadius: R.sm,
              overflow: 'hidden',
            },
          }, [
            h('button', {
              key: 'm',
              onClick: () => setBatch((value) => Math.max(1, value - 1)),
              style: {
                width: 28,
                height: 30,
                color: C.text2,
                fontSize: 15,
                cursor: 'pointer',
                background: 'transparent',
                border: 'none',
              },
            }, '−'),
            h('span', {
              key: 'v',
              style: {
                flex: 1,
                textAlign: 'center',
                fontFamily: C.mono,
                fontSize: 12,
                color: C.text,
              },
            }, String(batch)),
            h('button', {
              key: 'p',
              onClick: () => setBatch((value) => Math.min(8, value + 1)),
              style: {
                width: 28,
                height: 30,
                color: C.text2,
                fontSize: 15,
                cursor: 'pointer',
                background: 'transparent',
                border: 'none',
              },
            }, '+'),
          ]),
        ]),

        // 出图按钮
        h(Btn, {
          key: 'go',
          primary: true,
          disabled: busy || !configured,
          onClick: () => { void generate() },
          style: { width: '100%', height: 38, fontSize: 13.5 },
        }, busy ? '出图中…' : '开始出图'),

        // 次要操作：按当前状态给合理禁用，避免对着没起的服务点「卸载」
        h('div', {
          key: 'minor',
          style: { display: 'flex', gap: 6, marginTop: 8, justifyContent: 'center' },
        }, [
          h(Btn, {
            key: 'start',
            disabled: engineState !== null || busy,
            onClick: () => { void startService() },
          }, '启动服务'),
          h(Btn, {
            key: 'unload',
            disabled: engineState === null || engineState.loaded !== true,
            onClick: () => { void unloadModel() },
          }, '卸载模型'),
          h(Btn, {
            key: 'stop',
            disabled: engineState === null,
            onClick: () => { void stopService() },
          }, '停止'),
        ]),
      ])

      /* 预览区 */
      const preview = h('div', {
        style: {
          flex: 'none',
          padding: 12,
          borderBottom: '1px solid ' + C.border,
          background: C.bg,
        },
      }, [
        busy || (job !== null && job.status === 'running') ? h('div', {
          key: 'prog',
          style: {
            marginBottom: 10,
          },
        }, [
          h('div', {
            key: 'line',
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11.5,
              color: C.text2,
              marginBottom: 5,
              fontFamily: C.mono,
            },
          }, [
            h('span', { key: 'l' }, progress !== null
              ? '第 ' + progress.image + '/' + progress.images + ' 张 · step ' + progress.step + '/' + progress.total
              : '加载模型…'),
            h('span', { key: 'r' }, '已用 ' + Math.round(job?.elapsed ?? 0) + 's'),
          ]),
          h('div', {
            key: 'bar',
            style: {
              height: 4,
              borderRadius: 99,
              background: '#16283F',
              overflow: 'hidden',
            },
          }, h('div', {
            style: {
              height: '100%',
              width: Math.max(2, pct) + '%',
              background: 'linear-gradient(90deg,#25B7B0,' + C.accent + ')',
              transition: 'width .3s',
            },
          })),
        ]) : null,

        active === null ? h('div', {
          key: 'empty',
          style: {
            height: 160,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            color: C.text3,
            fontSize: 12,
            border: '1px dashed ' + C.border,
            borderRadius: R.md,
          },
        }, [
          h('div', { key: 'a', style: { fontSize: 13, color: C.text2 } }, '还没有图'),
          h('div', { key: 'b' }, '写好提示词，点「开始出图」'),
        ]) : h('div', {
          key: 'img',
          style: { display: 'flex', flexDirection: 'column', gap: 6 },
        }, [
          h('img', {
            key: 'i',
            src: imageUrl(active.file),
            alt: '',
            style: {
              width: '100%',
              height: 'auto',
              maxHeight: 360,
              objectFit: 'contain',
              borderRadius: R.md,
              border: '1px solid ' + C.border,
              background: C.raised,
            },
          }),
          h('div', {
            key: 'meta',
            style: {
              display: 'flex',
              gap: 4,
              flexWrap: 'wrap',
              fontFamily: C.mono,
              fontSize: 10.5,
              color: C.text3,
            },
          }, [
            'seed ' + active.seed,
            active.width + '×' + active.height,
            active.steps + ' 步',
            'CFG ' + Number(active.cfg).toFixed(1),
            active.seconds + 's',
          ].map((text, index) => h('span', {
            key: index,
            style: {
              border: '1px solid ' + C.border,
              borderRadius: 99,
              padding: '1px 7px',
            },
          }, text))),
          images.length > 1 ? h('div', {
            key: 'strip',
            style: { display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 2 },
          }, images.map((item, index) => h('img', {
            key: item.file,
            src: imageUrl(item.file),
            alt: '',
            onClick: () => setActive(item),
            style: {
              width: 48,
              height: 48,
              objectFit: 'cover',
              borderRadius: R.sm,
              cursor: 'pointer',
              border: '1.5px solid ' + (active.file === item.file ? C.accent : C.border),
              flex: 'none',
            },
          }))) : null,
        ]),

        error === null ? null : h('div', {
          key: 'err',
          style: {
            marginTop: 8,
            background: 'rgba(255,107,122,0.1)',
            border: '1px solid ' + C.danger + '55',
            borderRadius: R.sm,
            padding: 8,
            fontSize: 11.5,
            color: '#FFD9DD',
            lineHeight: 1.6,
            wordBreak: 'break-word',
          },
        }, error),

        toast === null ? null : h('div', {
          key: 'toast',
          style: {
            marginTop: 8,
            background: C.accentSoft,
            border: '1px solid ' + C.accentLine,
            borderRadius: R.sm,
            padding: 8,
            fontSize: 11.5,
            color: '#CFFBF4',
          },
        }, toast),
      ])

      /* 历史区 */
      const historyView = h('div', {
        style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 },
      }, [
        h(SectionTitle, {
          key: 'st',
          extra: String(history.length),
        }, '出图历史'),
        history.length === 0 ? h('div', {
          key: 'none',
          style: { color: C.text3, fontSize: 12, padding: '12px 0', textAlign: 'center' },
        }, '暂无记录') : h('div', {
          key: 'list',
          style: { display: 'flex', flexDirection: 'column', gap: 4 },
        }, history.map((item) => h('div', {
          key: item.file,
          onClick: () => setActive(item),
          style: {
            display: 'flex',
            gap: 8,
            padding: 6,
            borderRadius: R.sm,
            cursor: 'pointer',
            border: '1px solid ' + (active !== null && active.file === item.file ? C.accentLine : 'transparent'),
            background: active !== null && active.file === item.file ? C.accentSoft : 'transparent',
          },
        }, [
          h('img', {
            key: 't',
            src: imageUrl(item.file),
            alt: '',
            loading: 'lazy',
            style: {
              width: 44,
              height: 44,
              objectFit: 'cover',
              borderRadius: R.sm,
              border: '1px solid ' + C.border,
              flex: 'none',
              background: C.raised,
            },
          }),
          h('div', {
            key: 'b',
            style: { minWidth: 0, flex: 1 },
          }, [
            h('div', {
              key: 'p',
              style: {
                fontSize: 11.5,
                color: C.text2,
                lineHeight: 1.4,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
              },
            }, String(item.prompt ?? '')),
            h('div', {
              key: 'm',
              style: {
                fontFamily: C.mono,
                fontSize: 10,
                color: C.text3,
                marginTop: 2,
              },
            }, 'seed ' + item.seed + ' · ' + item.width + '×' + item.height + ' · ' + item.seconds + 's'),
          ]),
          h('div', {
            key: 'a',
            style: { display: 'flex', alignItems: 'center' },
          }, h(Btn, {
            onClick: (event) => {
              event.stopPropagation()
              reuse(item)
            },
            style: { height: 24, padding: '0 6px', fontSize: 11 },
          }, '载入')),
        ]))),
      ])

      return h('div', {
        style: {
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: C.bg,
          color: C.text,
          overflow: 'hidden',
        },
      }, [
        // 顶栏
        h('div', {
          key: 'head',
          style: {
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            borderBottom: '1px solid ' + C.border,
            background: C.panel,
          },
        }, [
          h(Dot, { key: 'd', tone: dotTone }),
          h('span', {
            key: 't',
            style: { fontSize: 13, fontWeight: 600, letterSpacing: 0.2 },
          }, '鲸鱼出图'),
          h('span', { key: 's', style: { flex: 1 } }),
          h('span', {
            key: 'v',
            style: { fontFamily: C.mono, fontSize: 10.5, color: C.text3 },
          }, 'Animagine XL · MPS'),
        ]),
        controls,
        preview,
        historyView,
      ])
    }

    /** 侧边栏图标：一条鲸鱼。 */
    function WhaleGenIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 18,
        height: 18,
        fill: 'currentColor',
        'aria-hidden': 'true',
      }, [
        h('ellipse', { key: 'b', cx: 10.6, cy: 14, rx: 7.4, ry: 5.3 }),
        h('path', { key: 't', d: 'M17.4 11.3 22.6 8.1 21.6 13.4 22.6 18.6 17.4 15.4Z' }),
        h('circle', { key: 'e', cx: 6.9, cy: 12.8, r: 0.95, fill: '#7FE9DC' }),
        h('path', {
          key: 's1',
          d: 'M8.6 8.6c0-1.9-.9-3-2.2-3.7',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 's2',
          d: 'M8.6 8.6c.4-1.9 1.5-3 2.8-3.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      ])
    }

    /** 装侧边栏行与主栏页面。 */
    function apply(ctx) {
      const slots = ctx.slots
      if (slots === undefined) return

      // 直接调用 slots.inject，不包 ctx.effect：inject 本身返回 disposer，
      // 而它注册的是浏览器侧占位，与宿主 fiber 无关。
      // 包一层会让主栏那个 key 注册不上，点开是空面板。
      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => '鲸鱼出图',
      }, WhaleGenIcon))

      slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({}),
      }, WhaleGenPage))
    }

    return { name: 'dsh-whale-gen', inject: ['slots'], apply }
  },
})
