#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小黑盒 GitHub Actions 签到巡检器。

职责：
  1. 查仓库最近的 workflow run，判断「今天（CST）」是否已经跑过每日签到；
  2. 没跑过 / 跑失败了 → 用 PAT 调 workflow_dispatch 补触发，并等它跑完；
  3. 拉取该次运行的日志，从「输出运行摘要」步骤里截出 Job Summary 原文输出；
  4. 如果 Actions 这条路最终没签到成功，以退出码 1 提示上层改用本地 heybox-sign 技能。

输出格式（stdout）：
  STATUS: OK | RETRIGGERED | FALLBACK | ERROR
  RUN: <id> <event> <conclusion> <created_at CST>
  ---- SUMMARY ----
  <markdown 摘要>

退出码：
  0  OK / RETRIGGERED（Actions 已签到成功）
  1  FALLBACK（Actions 不可用或签到未成功，需回退本地签到）
  2  ERROR（配置/网络/token 问题，未产生结论）
"""

import io
import json
import os
import re
import sys
import time
import zipfile
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(SKILL_DIR, "config.json")
LOCAL_CONFIG_PATH = os.path.join(SKILL_DIR, "config.local.json")
API = "https://api.github.com"
ANSI = re.compile(r"\x1b\[[0-9;]*m")
TS_PREFIX = re.compile(r"^\ufeff?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?")

EXIT_OK = 0
EXIT_FALLBACK = 1
EXIT_ERROR = 2


def load_config():
    if not os.path.isfile(CONFIG_PATH):
        raise SystemExit(f"缺少配置文件：{CONFIG_PATH}")
    with io.open(CONFIG_PATH, encoding="utf-8") as fh:
        cfg = json.load(fh)
    # config.local.json 用于放本机私密项（如 token），不进版本库
    if os.path.isfile(LOCAL_CONFIG_PATH):
        with io.open(LOCAL_CONFIG_PATH, encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    token = os.environ.get("GITHUB_PAT") or cfg.get("token") or ""
    if not token:
        raise SystemExit("缺少 GitHub token（config.json 的 token 或环境变量 GITHUB_PAT）")
    cfg["token"] = token
    cfg.setdefault("ref", "main")
    cfg.setdefault("timezone_offset_hours", 8)
    cfg.setdefault("dispatch_wait_seconds", 150)
    cfg.setdefault("run_wait_seconds", 360)
    return cfg


def request(cfg, path, method="GET", body=None, raw=False):
    url = path if path.startswith("http") else API + path
    data = None
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {cfg['token']}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "workbuddy-heybox-action-checkin",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = resp.read()
            status = resp.status
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:400]
        return error.code, None, detail
    except Exception as error:  # 网络层异常
        return 0, None, str(error)
    if raw:
        return status, payload, ""
    if not payload:
        return status, None, ""
    try:
        return status, json.loads(payload.decode("utf-8")), ""
    except Exception:
        return status, None, payload.decode("utf-8", "replace")[:400]


def cst_date(cfg, iso_text):
    if not iso_text:
        return ""
    stamp = iso_text.replace("Z", "+00:00")
    moment = datetime.fromisoformat(stamp).astimezone(
        timezone(timedelta(hours=cfg["timezone_offset_hours"]))
    )
    return moment.strftime("%Y-%m-%d")


def cst_text(cfg, iso_text):
    if not iso_text:
        return "-"
    stamp = iso_text.replace("Z", "+00:00")
    moment = datetime.fromisoformat(stamp).astimezone(
        timezone(timedelta(hours=cfg["timezone_offset_hours"]))
    )
    return moment.strftime("%Y-%m-%d %H:%M:%S")


def list_runs(cfg, limit=15):
    path = f"/repos/{cfg['repo']}/actions/workflows/{cfg['workflow_file']}/runs?per_page={limit}"
    status, payload, detail = request(cfg, path)
    if status != 200 or not isinstance(payload, dict):
        raise RuntimeError(f"查询运行记录失败 HTTP {status} {detail}")
    return payload.get("workflow_runs", [])


def dispatch(cfg):
    path = f"/repos/{cfg['repo']}/actions/workflows/{cfg['workflow_file']}/dispatches"
    status, _, detail = request(cfg, path, method="POST", body={"ref": cfg["ref"]})
    if status not in (201, 204):
        raise RuntimeError(f"触发失败 HTTP {status} {detail}")
    return True


def wait_for_new_run(cfg, known_ids, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(8)
        for run in list_runs(cfg):
            if run["id"] not in known_ids:
                return run
    raise RuntimeError("已触发但没等到新的运行记录（GitHub 队列可能拥堵）")


def wait_for_completion(cfg, run, timeout):
    deadline = time.time() + timeout
    current = run
    while time.time() < deadline:
        if current.get("status") == "completed":
            return current
        time.sleep(10)
        status, payload, _ = request(cfg, f"/repos/{cfg['repo']}/actions/runs/{current['id']}")
        if status == 200 and isinstance(payload, dict):
            current = payload
    return current


def fetch_logs(cfg, run_id):
    status, payload, detail = request(
        cfg, f"/repos/{cfg['repo']}/actions/runs/{run_id}/logs", raw=True
    )
    if status not in (200, 302) or not payload:
        return ""
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except Exception:
        return ""
    chunks = []
    for name in archive.namelist():
        if not name.lower().endswith(".txt"):
            continue
        try:
            chunks.append((name, archive.read(name).decode("utf-8", "replace")))
        except Exception:
            continue
    # 摘要步骤优先，其它按档名顺序拼接作为兜底
    chunks.sort(key=lambda item: (0 if "摘要" in item[0] else 1, item[0]))
    return "\n".join(text for _, text in chunks)


def clean_log(text):
    lines = []
    for line in text.splitlines():
        line = ANSI.sub("", line).replace("\ufeff", "")
        line = TS_PREFIX.sub("", line.rstrip())
        lines.append(line)
    return "\n".join(lines)


def extract_summary(text):
    cleaned = clean_log(text)
    # 日志里既会有步骤的命令回显（echo "...摘要..."），也会有真实输出。
    # 用摘要正文的标题做锚点并取最后一次出现，避免截到命令回显。
    anchor = "## 小黑盒每日任务"
    index = cleaned.rfind(anchor)
    if index == -1:
        return ""
    block = cleaned[index:]
    block = block.split("签到退出码=", 1)[0]
    return block.strip("\n")


def sign_verdict(summary, logs):
    """返回 (ok, 说明)。"""
    text = (summary or "") + "\n" + clean_log(logs)
    if "签到: 未完成" in text or "签到未确认" in text:
        return False, "日志出现「签到: 未完成 / 未确认」"
    if "签到: 已完成" in text or "今日已签到" in text or "签到 | ✅ 已完成" in text:
        return True, ""
    if "✅ 签到成功" in text:
        return True, ""
    return False, "日志里找不到签到成功的证据"


def main():
    try:
        cfg = load_config()
    except SystemExit as error:
        print(f"STATUS: ERROR\nREASON: {error}")
        return EXIT_ERROR

    try:
        runs = list_runs(cfg)
    except RuntimeError as error:
        print(f"STATUS: ERROR\nREASON: {error}")
        return EXIT_ERROR

    today = datetime.now(timezone(timedelta(hours=cfg["timezone_offset_hours"]))).strftime("%Y-%m-%d")
    todays = [run for run in runs if cst_date(cfg, run.get("created_at")) == today]
    todays.sort(key=lambda run: run.get("created_at", ""), reverse=True)

    target = None
    retriggered = False

    if todays:
        target = todays[0]
        target = wait_for_completion(cfg, target, cfg["run_wait_seconds"])
        if target.get("conclusion") != "success":
            known = {run["id"] for run in runs}
            dispatch(cfg)
            target = wait_for_new_run(cfg, known, cfg["dispatch_wait_seconds"])
            target = wait_for_completion(cfg, target, cfg["run_wait_seconds"])
            retriggered = True
    else:
        known = {run["id"] for run in runs}
        dispatch(cfg)
        target = wait_for_new_run(cfg, known, cfg["dispatch_wait_seconds"])
        target = wait_for_completion(cfg, target, cfg["run_wait_seconds"])
        retriggered = True

    logs = fetch_logs(cfg, target["id"])
    summary = extract_summary(logs)
    ok, reason = sign_verdict(summary, logs)

    header = (
        f"RUN: {target['id']} {target.get('event')} {target.get('conclusion') or target.get('status')} "
        f"{cst_text(cfg, target.get('created_at'))}"
    )

    if ok:
        print(f"STATUS: {'RETRIGGERED' if retriggered else 'OK'}")
        print(header)
        print("---- SUMMARY ----")
        print(summary or "（未能从日志中提取摘要，但日志显示签到已完成）")
        return EXIT_OK

    print("STATUS: FALLBACK")
    print(header)
    print(f"REASON: {reason}；运行结论={target.get('conclusion') or target.get('status')}")
    print("---- SUMMARY ----")
    print(summary or "（无摘要）")
    return EXIT_FALLBACK


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # 兜底，避免堆栈污染输出
        print(f"STATUS: ERROR\nREASON: {error}")
        sys.exit(EXIT_ERROR)
