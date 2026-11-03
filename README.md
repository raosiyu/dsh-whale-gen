# dsh-whale-gen

把 **Animagine XL 4.0 跑在 Apple MPS 上**的本地出图能力装进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：侧边栏出图面板 + 模型可调工具 + 出图历史。不联网、不花钱、不需要 API Key。

```
你：「画一张鲸鱼娘」
模型：调 local_generate → 插件自动拉起本地 diffusers 服务 → 出图落盘
     → 把文件路径和参数告诉你
```

## 它是什么

一个 DSH 插件（宿主半区 + 浏览器半区），负责三件事：

1. **托管本地出图服务**。一个 Python 进程（torch + diffusers，MPS 后端），插件按需拉起、健康检查、卸载时收尸。模型常驻显存，首次加载 30~60 秒，之后秒级出图。
2. **给模型三个工具**。`local_generate`（出图）/ `local_gen_status`（查进度）/ `local_gen_env`(环境自检)。模型在对话里就能出图，并知道提示词该怎么写（系统提示段会教它 Danbooru Tag 风格）。
3. **侧边栏面板**。写提示词、调参数、看进度、翻历史、一键复现某张图的参数——和模型出的是同一批图。

## 安装

```bash
# 装进某个 profile（desktop / web）
dsh plugin --profile desktop add /path/to/dsh-whale-gen
# 或者手动：package.json 的 dependencies 加 link: 指向本仓库，bundles 里加上 dsh-whale-gen
```

装好重启 DSH，侧边栏多一个「鲸鱼出图」。

## 前置条件

| 需要 | 说明 |
|---|---|
| Apple Silicon Mac | MPS 后端；24 GB 内存比较稳 |
| python + torch + diffusers | 装在任意 venv 里，插件会自动探测，探测不到时配 `pythonPath` |
| Animagine XL 4.0 权重 | `models/sdxl/animagine-xl-4.0.safetensors`（6.5 GB），放在工作目录下 |

插件按「谁的目录里有权重，谁就是工作目录」自动探测；探测不到时面板会**明确列出缺什么**，而不是猜一个路径静默失败。

### 权重下载

```bash
# Animagine XL 4.0，许可最干净的二次元 SDXL 底模之一
huggingface-cli download cagliostrolab/animagine-xl-4.0 \
  animagine-xl-4.0.safetensors --local-dir models/sdxl
```

config 目录（`sdxl-base-config/`）用 stable-diffusion-xl-base-1.0 的那份即可，服务按 SDXL 结构读。

## 配置

在插件的 config 里覆盖（见 `cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-whale-gen
      config:
        pythonPath: /path/to/venv/bin/python   # 能 import torch 的 python
        workDir: /path/to/your/project          # 有 models/sdxl/ 的目录
        outputDir: /path/to/output              # 出图落盘目录（默认 workDir/out/console）
        port: 8767                              # 本地服务端口，只监听 127.0.0.1
        announceToAgent: true                   # 是否给模型注入提示段
```

环境变量也认：`WHALE_PYTHON` / `WHALE_WORKDIR` / `WHALE_OUT_DIR` / `WHALE_MODEL_PATH`。

## 参数参考

| 参数 | 建议值 | 说明 |
|---|---|---|
| 画幅 832×1216 | 竖图默认 | 二次元竖版写真的舒适区 |
| 步数 28 | 28~30 | 低于 20 会糊，高于 35 收益很小 |
| CFG 6.0 | 5.5~7.0 | 越高越贴提示词，太高会过饱和 |
| 采样器 Euler a | 默认 | Animagine 官方推荐搭配 |

性能参考（M6 Max / 24 GB）：512²/12 步 ≈ 16 s；832×1216/28 步 ≈ 79 s；显存稳定 15~16 GB。

## 设计上的几个决定

- **出图服务是独立 Python 进程，不是 Node 内嵌**。torch/diffusers 只能跑在 Python 里，插件做的是托管（spawn / 健康检查 / SIGTERM 优雅退出 / 卸载收尸），而不是模拟。
- **异步出图，不占工具超时**。`local_generate` 立刻返回 jobId，进度用 `local_gen_status` 轮询——一次出图几十秒，同步工具会顶穿超时，用户也看不到进展。
- **崩溃不自动重启**。MPS 进程崩了之后立刻重启大概率再次 OOM（显存可能没归还）；下一次调用会重新拉起，那时是干净状态。
- **每张图带 sidecar JSON**。完整参数落在图片旁边，服务重启后历史照样读得回来。
- **缺什么就说缺什么**。python / 服务脚本 / 权重，三样探测不到时进 `problems`，面板直接展示，绝不猜路径。

## 测试

```bash
npm test   # 22 项：参数兜底、路径围栏、配置探测、插件接线
```

测试里的假宿主用 Proxy 模拟了 cordis 的真实脾气——**读未声明的服务会抛**。这条是补一个真 bug 之后加上的：普通对象假宿主上测试全绿，真实宿主里插件在 apply 第一行就挂掉。

## 已知边界

- 面板里显示历史缩略图走 `/whale-gen/api/image`，文件名白名单校验，只读 `outputDir` 里的 png。
- 单 worker 串行出图。MPS 不适合并发推理，任务排队执行。
- 服务只监听 `127.0.0.1`，面板路由有环回围栏。

## License

MIT
