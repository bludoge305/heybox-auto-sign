---
name: heybox-action-checkin
description: 巡检小黑盒每日签到在 GitHub Actions 上的执行情况并回传运行摘要。当需要「确认今天的小黑盒签到跑没跑」「看 Actions 的签到 summary」「定时巡检签到」，或 Actions 没执行/失败需要补触发时使用。调用 GitHub REST API 判断当日是否有成功运行，缺失则用 PAT 补触发 workflow_dispatch 并等待完成，最后输出该次运行的 Job Summary；Actions 方案最终签到未成功时给出回退信号，交由 heybox-sign 技能本地补签。
agent_created: true
---

# 小黑盒 Actions 签到巡检

判断小黑盒每日签到在 GitHub Actions 上「今天跑没跑、跑成什么样」，没跑或跑挂了就补触发，最终把 Job Summary 原样带回来；Actions 这条路彻底不行时提示回退本地签到。

## 执行

```bash
python ~/.workbuddy/skills/heybox-action-checkin/scripts/watch.py
```

单次耗时：正常情况 10–30 秒；需要补触发时约 2–3 分钟（脚本自己轮询，不要中途打断）。

脚本内部流程：查最近运行 → 找「今天（UTC+8）」的记录 → 失败则补触发 / 没有则补触发 → 等运行结束 → 下载日志 zip → 从「输出运行摘要」步骤截出 Markdown → 判定签到结果。

## 输出判读

stdout 固定三段：`STATUS:` / `RUN:` / `---- SUMMARY ----` 加上摘要正文。

| STATUS | 退出码 | 含义 | 后续动作 |
| --- | --- | --- | --- |
| `OK` | 0 | 今天已有成功运行，未重复触发 | 直接把摘要报给用户 |
| `RETRIGGERED` | 0 | 原本没有今天的运行或上次失败，已补触发且签到成功 | 汇报时说明「已自动补触发」 |
| `FALLBACK` | 1 | Actions 这条路没签到成功，或根本用不了（token 401/403、缺 token、触发后没起跑、签到未确认） | **立即加载 heybox-sign 技能本地补签**，见下节 |
| `ERROR` | 2 | 网络异常或配置错误（如 `repo`/`workflow_file` 写错导致 404） | 原样转述 `REASON`，不要盲目重试 |

判定依据是日志里出现 `签到: 已完成`、`今日已签到`、`**✅ 签到成功**`；出现 `签到: 未完成` / `签到未确认` 一律算失败。

## FALLBACK 的标准处理

`FALLBACK` 覆盖四类情况，处理方式相同——都去本地补签，不要让当天漏签：

| 触发场景 | 说明 |
| --- | --- |
| 运行完成但签到未确认 | 日志出现 `签到: 未完成` / `签到未确认` |
| GitHub 鉴权失败 | token 401/403，或压根没配 token |
| 触发后没起跑 | 已 dispatch 但等不到运行记录（队列拥堵） |
| 找不到签到证据 | 日志与摘要里都没有签到成功痕迹 |

1. 调用 Skill 工具加载 `heybox-sign`，按其说明执行本地签到（`node ~/.workbuddy/skills/heybox-sign/scripts/sign_runner.js`）。
2. 汇报里把两条链路都说清楚：Actions 的 `RUN` 号与失败原因 + 本地签到的 `status` 与奖励。
3. 本地签到若返回 `AUTH_EXPIRED`，停止并引导用户按 heybox-sign 的「首次使用」重新提取登录态——不要反复重试。

## 汇报格式

先给结论一句话（今天跑了没、是否补触发、签到结果），再把 `---- SUMMARY ----` 之后的 Markdown 原样贴出（它是仓库里 `scripts/summarize.js` 生成的 Job Summary，含账号、H 币、任务表、抽奖明细）。不要自行改写摘要里的数字。

## 配置

`config.json`（与本文件同级，**可以进版本库**）：

| 字段 | 说明 |
| --- | --- |
| `repo` | `owner/repo`，默认 `bludoge305/heybox-auto-sign` |
| `workflow_file` | 工作流文件名，默认 `daily-sign.yml` |
| `ref` | 触发分支，默认 `main` |
| `token` | 默认留空。按 **`config.local.json` → 环境变量 `GITHUB_PAT`** 的顺序取（前者优先，且不进版本库）；需 fine-grained PAT，权限 **Actions: Read and write** |
| `timezone_offset_hours` | 判定「今天」的时区，默认 8（UTC+8） |
| `dispatch_wait_seconds` | 触发后等新记录出现的上限 |
| `run_wait_seconds` | 等待运行结束的上限 |

`config.local.json`（同名同目录，**不进版本库**）：只放本机私密项，目前仅 `{"token": "<你的 fine-grained PAT>"}`。脚本会把它覆盖到 `config.json` 之上。

## 排障

- **401 / 403**：PAT 过期或被撤销。脚本**会自动降级为 `FALLBACK` 让你本地补签**，不会当天漏签；事后仍需去 GitHub 重新生成 token 并同时更新 `config.local.json` 与 cron-job.org 的 header（该 token 到期日约 2026-12-03）。
- **缺 token**：直接 `FALLBACK`，不阻塞当天签到。
- **404**：`repo` / `workflow_file` 写错。
- **已触发但等不到记录**：GitHub 队列拥堵，调大 `dispatch_wait_seconds` 或稍后重跑。
- **摘要为空但状态 OK**：日志下载失败或步骤被改名；脚本会打印提示，不算失败。
- **GitHub 自带 cron 只当兜底**：仓库是 fork，`schedule` 确实会触发，但实测会**迟到 6~7 小时**（01:30 UTC 的 cron 到 07:46 才跑）。准点触发交给 cron-job.org（`30 9 * * *`，Asia/Shanghai）；迟到那次通常只会读到「已签到」，属无害重复。

## 约束

- **不要打印 token 明文**，也不要写进日志、提交到版本库或贴到聊天里。
- 不要一天内反复触发：脚本会先判断当天是否已有成功运行，复用它而不是手工 dispatch。
- 只读 `config.json` 与 GitHub API，不修改工作区里的小黑盒代码。
