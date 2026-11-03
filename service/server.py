#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鲸鱼娘 · 出图控制台 —— 本地 MPS 出图服务

把 sdxl_gen.py / sdxl_batch.py 那一套管道包成 HTTP 服务：
  - 懒加载 pipeline，常驻内存（6.5G 权重反复加载太慢）
  - 单 worker 线程跑任务队列（MPS 不适合并发推理）
  - 逐步回调上报进度，前端轮询
  - 每张图带 meta 落盘到 out/console/

只监听 127.0.0.1，不对外暴露。
"""

import json
import os
import queue
import random
import re
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# ---------------------------------------------------------------- 路径
#
# 这个脚本有两种跑法：
#   1. 在项目里直接跑（console/server.py）——路径跟着脚本走
#   2. 被插件托管（plugin/service/server.py）——脚本在插件包里，
#      但权重和输出都在**用户的项目目录**，跟脚本位置无关
#
# 所以一律允许环境变量覆盖。插件那边会把这些变量传进来；
# 少了这段，modelPath 会指向 plugin/models/ 这种不存在的路径，
# 表现为「服务起来了但权重找不到」——很绕的一类错。
_BUNDLED_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _env_dir(name, fallback):
    """环境变量优先，否则用推导出来的默认值。"""
    value = os.environ.get(name)
    return os.path.abspath(value) if value else fallback


ROOT = _env_dir("WHALE_ROOT", _BUNDLED_ROOT)

STATIC_DIR = os.path.join(ROOT, "console", "static")
OUT_DIR = _env_dir("WHALE_OUT_DIR", os.path.join(ROOT, "out", "console"))
MODEL_PATH = _env_dir(
    "WHALE_MODEL_PATH",
    os.path.join(ROOT, "models", "sdxl", "animagine-xl-4.0.safetensors"),
)
CONFIG_DIR = _env_dir(
    "WHALE_CONFIG_DIR",
    os.path.join(ROOT, "models", "sdxl", "sdxl-base-config"),
)
HF_HOME = _env_dir("WHALE_HF_HOME", os.path.join(ROOT, "out", "hfhome"))

os.makedirs(OUT_DIR, exist_ok=True)

# 必须在 import torch/diffusers 之前设好
os.environ["HF_HOME"] = HF_HOME
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

import torch  # noqa: E402
from diffusers import (  # noqa: E402
    StableDiffusionXLPipeline,
    EulerAncestralDiscreteScheduler,
    EulerDiscreteScheduler,
    DPMSolverMultistepScheduler,
)

# ---------------------------------------------------------------- 常量

PORT = int(os.environ.get("WHALE_PORT", "8765"))

DEFAULT_NEG = (
    "lowres, bad quality, worst quality, bad anatomy, bad hands, extra digits, "
    "watermark, signature, username, text, jpeg artifacts, ugly, nsfw, explicit"
)

SAMPLERS = {
    "euler_a": "Euler a",
    "euler": "Euler",
    "dpmpp": "DPM++ 2M",
}

SIZES = {
    "1024x1024": (1024, 1024),
    "832x1216": (832, 1216),
    "1216x832": (1216, 832),
    "1024x768": (1024, 768),
    "768x1024": (768, 1024),
    "512x512": (512, 512),
}

MAX_BATCH = 8
MAX_DIM = 1536


class Cancelled(Exception):
    pass


# ---------------------------------------------------------------- 引擎

class Engine:
    """单例：持有 pipeline，跑任务队列。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.pipe = None
        self.loading = False
        self.load_started = 0.0
        self.load_seconds = 0.0
        self.load_error = None
        self.jobs = {}
        self.queue = queue.Queue()
        self.current_job = None
        self.model_name = os.path.basename(MODEL_PATH)
        self.total_images = 0
        self.total_seconds = 0.0
        self.started_at = time.time()
        self.worker = threading.Thread(target=self._loop, daemon=True)
        self.worker.start()

    # -- 模型 ---------------------------------------------------------

    def _ensure_pipe(self, job=None):
        with self.lock:
            if self.pipe is not None:
                return self.pipe
            if self.loading:
                # 另一个任务正在加载，等它
                while self.loading:
                    time.sleep(0.3)
                if self.pipe is not None:
                    return self.pipe
                raise RuntimeError(self.load_error or "模型加载失败")
            self.loading = True
            self.load_error = None
            self.load_started = time.time()

        try:
            t0 = time.time()
            if not os.path.exists(MODEL_PATH):
                raise RuntimeError("找不到权重文件：%s" % MODEL_PATH)

            pipe = StableDiffusionXLPipeline.from_single_file(
                MODEL_PATH,
                config=CONFIG_DIR,
                torch_dtype=torch.float16,
                use_safetensors=True,
                add_watermarker=False,
                local_files_only=True,
            )
            pipe.set_progress_bar_config(disable=True)
            pipe.enable_attention_slicing()
            if hasattr(pipe, "vae") and hasattr(pipe.vae, "enable_slicing"):
                pipe.vae.enable_slicing()
            pipe = pipe.to("mps")

            with self.lock:
                self.pipe = pipe
                self.load_seconds = time.time() - self.load_started
            print("[engine] 模型加载完成 %.1fs" % (time.time() - t0), flush=True)
            return pipe
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                self.load_error = str(exc)
            print("[engine] 加载失败: %s" % exc, flush=True)
            traceback.print_exc()
            raise
        finally:
            with self.lock:
                self.loading = False

    def unload(self):
        with self.lock:
            if self.pipe is None:
                return False
            self.pipe = None
        try:
            import gc

            gc.collect()
            torch.mps.empty_cache()
        except Exception:  # noqa: BLE001
            pass
        return True

    def _apply_sampler(self, pipe, name):
        cfg = pipe.scheduler.config
        if name == "euler":
            pipe.scheduler = EulerDiscreteScheduler.from_config(
                cfg, timestep_spacing="trailing"
            )
        elif name == "dpmpp":
            pipe.scheduler = DPMSolverMultistepScheduler.from_config(
                cfg, timestep_spacing="trailing"
            )
        else:
            pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(
                cfg, timestep_spacing="trailing"
            )

    # -- 队列 ---------------------------------------------------------

    def submit(self, req):
        job_id = uuid.uuid4().hex[:12]
        job = {
            "id": job_id,
            "status": "queued",
            "createdAt": time.time(),
            "startedAt": None,
            "finishedAt": None,
            "request": req,
            "progress": {"step": 0, "total": req["steps"], "image": 0,
                         "images": req["batch"]},
            "images": [],
            "error": None,
            "elapsed": 0.0,
            "loadSeconds": 0.0,
            "cancel": False,
        }
        with self.lock:
            self.jobs[job_id] = job
            if len(self.jobs) > 200:
                for old in sorted(self.jobs.values(), key=lambda j: j["createdAt"])[:50]:
                    self.jobs.pop(old["id"], None)
        self.queue.put(job_id)
        return job_id

    def get(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            return None
        out = {k: v for k, v in job.items() if k != "cancel"}
        if job["status"] == "running" and job["startedAt"]:
            out["elapsed"] = time.time() - job["startedAt"]
        return out

    def cancel(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            return False
        if job["status"] == "queued":
            job["status"] = "cancelled"
            job["finishedAt"] = time.time()
            return True
        job["cancel"] = True
        return True

    def snapshot(self):
        with self.lock:
            return {
                "model": self.model_name,
                "modelPath": MODEL_PATH,
                "loaded": self.pipe is not None,
                "loading": self.loading,
                "loadSeconds": round(self.load_seconds, 1),
                "loadError": self.load_error,
                "device": "mps" if torch.backends.mps.is_available() else "cpu",
                "queued": self.queue.qsize(),
                "current": self.current_job,
                "totalImages": self.total_images,
                "avgSeconds": round(
                    self.total_seconds / self.total_images, 1
                ) if self.total_images else 0,
                "samplers": SAMPLERS,
                "sizes": list(SIZES.keys()),
                "defaults": {
                    "negative": DEFAULT_NEG,
                    "width": 832,
                    "height": 1216,
                    "steps": 28,
                    "cfg": 6.0,
                    "sampler": "euler_a",
                    "batch": 1,
                },
                "mpsAllocated": round(torch.mps.driver_allocated_memory() / 1024 ** 3, 2)
                if torch.backends.mps.is_available() else 0,
            }

    def _loop(self):
        while True:
            job_id = self.queue.get()
            job = self.jobs.get(job_id)
            if job is None or job["status"] == "cancelled":
                continue
            self.current_job = job_id
            with self.lock:
                job["status"] = "running"
                job["startedAt"] = time.time()
            try:
                self._run(job)
                with self.lock:
                    job["status"] = "done"
            except Cancelled:
                with self.lock:
                    job["status"] = "cancelled"
            except Exception as exc:  # noqa: BLE001
                with self.lock:
                    job["status"] = "failed"
                    job["error"] = str(exc)
                traceback.print_exc()
            finally:
                with self.lock:
                    job["finishedAt"] = time.time()
                    job["elapsed"] = job["finishedAt"] - (job["startedAt"] or job["finishedAt"])
                self.current_job = None
                self._write_sidecar(job)

    def _run(self, job):
        req = job["request"]
        t_load = time.time()
        pipe = self._ensure_pipe(job)
        with self.lock:
            job["loadSeconds"] = round(time.time() - t_load, 1)

        self._apply_sampler(pipe, req["sampler"])

        width = req["width"]
        height = req["height"]
        steps = req["steps"]
        batch = req["batch"]
        base_seed = req["seed"]

        for i in range(batch):
            if job["cancel"]:
                raise Cancelled()
            seed = (base_seed + i) if base_seed is not None else random.randint(0, 2**31 - 1)
            gen = torch.Generator(device="cpu").manual_seed(int(seed))

            with self.lock:
                job["progress"] = {"step": 0, "total": steps, "image": i + 1,
                                   "images": batch}

            def on_step(_pipe, step_index, _ts, kw, _job=job, _steps=steps, _i=i):
                if _job["cancel"]:
                    raise Cancelled()
                with self.lock:
                    _job["progress"] = {
                        "step": step_index + 1,
                        "total": _steps,
                        "image": _i + 1,
                        "images": batch,
                    }
                return kw

            t0 = time.time()
            with self.lock:
                job["phase"] = "sampling"
            result = pipe(
                prompt=req["prompt"],
                negative_prompt=req["negative"],
                num_inference_steps=steps,
                guidance_scale=req["cfg"],
                width=width,
                height=height,
                generator=gen,
                callback_on_step_end=on_step,
            ).images[0]
            took = time.time() - t0
            with self.lock:
                job["phase"] = "saving"

            fname = "%s_%s_s%d.png" % (
                time.strftime("%Y%m%d-%H%M%S", time.localtime()),
                job["id"],
                seed,
            )
            fpath = os.path.join(OUT_DIR, fname)
            result.save(fpath)

            meta = {
                "file": fname,
                "seed": seed,
                "width": width,
                "height": height,
                "steps": steps,
                "cfg": req["cfg"],
                "sampler": req["sampler"],
                "batchIndex": i,
                "prompt": req["prompt"],
                "negative": req["negative"],
                "seconds": round(took, 2),
                "jobId": job["id"],
                "createdAt": time.time(),
            }
            with self.lock:
                job["images"].append(meta)
                self.total_images += 1
                self.total_seconds += took
            print("[engine] %s seed=%s %.1fs" % (fname, seed, took), flush=True)

    def _write_sidecar(self, job):
        try:
            meta = {
                "jobId": job["id"],
                "request": job["request"],
                "status": job["status"],
                "images": job["images"],
                "createdAt": job["createdAt"],
                "elapsed": round(job.get("elapsed") or 0, 1),
            }
            path = os.path.join(OUT_DIR, "%s_%s.json" % (
                time.strftime("%Y%m%d-%H%M%S", time.localtime(job["createdAt"])),
                job["id"],
            ))
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(meta, fh, ensure_ascii=False, indent=1)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # -- 历史 ---------------------------------------------------------

    def history(self, limit=80):
        items = []
        try:
            names = [n for n in os.listdir(OUT_DIR) if n.endswith(".json")]
        except OSError:
            return items
        names.sort(reverse=True)
        for name in names[:limit]:
            try:
                with open(os.path.join(OUT_DIR, name), encoding="utf-8") as fh:
                    data = json.load(fh)
                for img in data.get("images", []):
                    img["jobId"] = data.get("jobId", img.get("jobId"))
                    items.append(img)
            except Exception:  # noqa: BLE001
                continue
        items.sort(key=lambda x: x.get("createdAt", 0), reverse=True)
        return items[:limit]


ENGINE = Engine()


# ---------------------------------------------------------------- HTTP

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}

SAFE_NAME = re.compile(r"^[A-Za-z0-9_.\-]+\.(png|json)$")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 安静一点
        if "/api/" in (args[0] if args else ""):
            return

    # -- 工具 ---------------------------------------------------------

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    # -- GET ----------------------------------------------------------

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/state":
            return self._send(200, ENGINE.snapshot())
        if path == "/api/history":
            limit = int((parse_qs(parsed.query).get("limit") or ["80"])[0])
            return self._send(200, {"items": ENGINE.history(limit)})
        if path.startswith("/api/jobs/"):
            job = ENGINE.get(path.rsplit("/", 1)[-1])
            if not job:
                return self._send(404, {"error": "no such job"})
            return self._send(200, job)
        if path.startswith("/img/"):
            name = path.rsplit("/", 1)[-1]
            if not SAFE_NAME.match(name):
                return self._send(400, {"error": "bad name"})
            fpath = os.path.join(OUT_DIR, name)
            if not os.path.exists(fpath):
                return self._send(404, {"error": "not found"})
            ext = os.path.splitext(name)[1].lower()
            with open(fpath, "rb") as fh:
                data = fh.read()
            return self._send(200, data, STATIC_TYPES.get(ext, "application/octet-stream"),
                              {"Cache-Control": "public, max-age=31536000"})

        return self._static(path)

    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        name = path.lstrip("/")
        if "/" in name or name.startswith("."):
            return self._send(404, {"error": "not found"})
        fpath = os.path.join(STATIC_DIR, name)
        if not os.path.exists(fpath):
            # SPA 兜底
            fpath = os.path.join(STATIC_DIR, "index.html")
            if not os.path.exists(fpath):
                return self._send(404, {"error": "not found"})
            name = "index.html"
        ext = os.path.splitext(name)[1].lower()
        with open(fpath, "rb") as fh:
            data = fh.read()
        return self._send(200, data, STATIC_TYPES.get(ext, "application/octet-stream"))

    # -- POST ---------------------------------------------------------

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/generate":
                return self._handle_generate()
            if path == "/api/unload":
                removed = ENGINE.unload()
                return self._send(200, {"unloaded": removed})
            if path.startswith("/api/cancel/"):
                ok = ENGINE.cancel(path.rsplit("/", 1)[-1])
                return self._send(200, {"cancelled": ok})
            return self._send(404, {"error": "not found"})
        except json.JSONDecodeError:
            return self._send(400, {"error": "invalid json"})
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self._send(500, {"error": str(exc)})

    def _handle_generate(self):
        body = self._json_body()

        prompt = (body.get("prompt") or "").strip()
        if not prompt:
            return self._send(400, {"error": "提示词不能为空"})

        negative = (body.get("negative") or DEFAULT_NEG).strip()

        try:
            width = int(body.get("width") or 832)
            height = int(body.get("height") or 1216)
            steps = int(body.get("steps") or 28)
            cfg = float(body.get("cfg") or 6.0)
            batch = int(body.get("batch") or 1)
        except (TypeError, ValueError):
            return self._send(400, {"error": "参数类型不对"})

        # 尺寸对齐到 8 的倍数（VAE 要求）
        width = max(256, min(MAX_DIM, width - width % 8))
        height = max(256, min(MAX_DIM, height - height % 8))
        steps = max(4, min(60, steps))
        cfg = max(1.0, min(20.0, cfg))
        batch = max(1, min(MAX_BATCH, batch))

        sampler = body.get("sampler") or "euler_a"
        if sampler not in SAMPLERS:
            sampler = "euler_a"

        seed_raw = body.get("seed")
        if seed_raw in (None, "", 0, "0"):
            seed = None
        else:
            try:
                seed = int(seed_raw)
            except (TypeError, ValueError):
                seed = None
            else:
                seed = max(0, min(2**31 - 1, seed))

        req = {
            "prompt": prompt,
            "negative": negative,
            "width": width,
            "height": height,
            "steps": steps,
            "cfg": cfg,
            "batch": batch,
            "sampler": sampler,
            "seed": seed,
        }
        job_id = ENGINE.submit(req)
        return self._send(200, {"jobId": job_id, "request": req})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print("=" * 54, flush=True)
    print(" 鲸鱼娘 · 出图控制台", flush=True)
    print(" http://127.0.0.1:%d" % PORT, flush=True)
    print(" 模型: %s" % os.path.basename(MODEL_PATH), flush=True)
    print(" 设备: %s" % ("mps" if torch.backends.mps.is_available() else "cpu"), flush=True)
    print(" 输出: %s" % OUT_DIR, flush=True)
    print("=" * 54, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] 退出", flush=True)


if __name__ == "__main__":
    main()
