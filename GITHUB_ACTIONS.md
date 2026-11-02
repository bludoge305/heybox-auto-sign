# 部署到 GitHub Actions（云端每日自动签到）

本说明教你把小黑盒自动签到放到 GitHub 上，每天在云端自动运行，**电脑不用开机**。

> 核心思路：代码（含脚本）推到 GitHub，账号 cookie 以**加密 Secret** 形式存储，工作流运行时读取后执行 `heybox_sign.js`。cookie 永不进入代码仓库。

---

## 一、前置条件

- 本地已有可运行的 `heybox-auto-sign/` 项目（本目录）。
- 已有一个 GitHub 账号。
- 本地 `cookie.txt` 里是正确的 App 请求字段（从手机抓的，至少包含 `pkey`、`x_xhh_tokenid`、`imei`、`device_info`、`os_version`、`dw`）。

---

## 二、在 GitHub 上准备仓库（二选一）

### 方案 A：Fork 原项目（推荐，最干净）

1. 打开 https://github.com/yowiv08/heybox ，点右上角 **Fork** → 创建 `你的用户名/heybox`。
2. Fork 已经包含原项目全部代码，我们只需把本目录新增的几个文件推上去。

### 方案 B：新建空白仓库

1. GitHub 右上角 **+ → New repository**，建议 **Private（私有）**，仓库名随意（如 `heybox-auto-sign`）。
2. **不要**勾选 Initialize with README（保持空仓库）。
3. 由于本地是浅克隆，推送前建议补全历史：
   ```bash
   git fetch --unshallow
   ```

---

## 三、添加 Cookie 密钥（关键，必须做）

1. 进入你的仓库 → **Settings → Secrets and variables → Actions → New repository secret**。
2. Name 填：`HEYBOX_CK`
3. Secret 内容填：**`cookie.txt` 里的那一行**（形如 `pkey=xxxx;x_xhh_tokenid=yyyy;imei=xxx;device_info=xxx;os_version=16;dw=411;`）。
   - 不要带换行，就是单行。
   - `imei`、`device_info`、`os_version`、`dw` 必须来自**你自己手机的同一次真实请求**，缺任意一个脚本会直接报「账号配置缺少App请求字段」。
   - 可选 `channel=heybox_xiaomi`（iOS 无此字段则省略）。
   - 本地可在项目目录执行 `type cookie.txt`（Windows）/`cat cookie.txt`（mac/Linux）复制。
4. 保存。

> ⚠️ cookie 会过期。过期后脚本会报 `relogin` 并让工作流失败（红色 ✗），此时重新抓手机 cookie 并更新这个 Secret 即可。

---

## 四、推送代码

在项目目录执行（把 `你的用户名` 换成实际用户名，方案 B 用你新建的仓库地址）：

```bash
# 方案 A（fork）添加远程
git remote add mine https://github.com/你的用户名/heybox.git

# 方案 B（空白仓库）添加远程
git remote add mine https://github.com/你的用户名/heybox-auto-sign.git

# 暂存并推送我们自己新增的文件（cookie.txt / sign_log.txt 已被 .gitignore 排除，不会上传）
git add .github/workflows/daily-sign.yml GITHUB_ACTIONS.md .gitignore dump_token.py run_sign.bat scan_token.py scripts/
git commit -m "feat: add GitHub Actions auto-sign + token tools"
git push mine main
```

---

## 五、开启并验证

1. 仓库 → **Settings → Actions → General → Workflow permissions** 确认允许运行（默认即可）。
2. 仓库 → **Actions** 标签页，应能看到 `小黑盒每日签到` 工作流。
3. 点 **Run workflow** 手动跑一次验证：
   - 绿色 ✓ = 成功，日志里能看到 `签到: 已完成` 和 `完成: 1/1`，页面底部会生成「小黑盒每日任务」运行摘要。
   - 红色 ✗ = 检查 Secret 是否正确、cookie 是否过期。
4. 之后每天 UTC 01:30（北京 09:30）自动跑。

---

## 六、运行摘要（Actions 页面自动生成）

每次运行结束后，Actions 运行页面的 **Summary** 区会自动生成一张表格，不用翻日志就能看到结果：

```
## 小黑盒每日任务

**✅ 签到成功**

| 项目 | 值 |
| --- | --- |
| 运行时间 | 2026-11-02 22:18 (UTC+8) |
| 任务完成 | 1/1 |
| 账号 | **bludoge**（25287644） |
| 当前 H 币 | 5573 |
| 客户端版本 | 1.3.399 build=1148 |
| 抽奖活动 | 进行中 7 个，参与成功 1 个 |

### 每日任务
| 任务 | 状态 | 奖励 |
| --- | --- | --- |
| 签到 | ✅ 已完成 | +30经验 +30H币 +1盒电 |
| 分享任意帖子到社交平台 | ✅ 已完成 | +10经验 +100H币 +1盒电 |
```

抽奖部分会折叠成 `<details>`，展开可看每个活动的参与状态。

实现方式：

- 工作流把两个脚本的输出分别 `tee` 到 `sign.log` / `roll.log`（同时用 `PIPESTATUS` 保住退出码，避免管道吞错）；
- `scripts/summarize.js` 解析日志，输出 Markdown 到 `$GITHUB_STEP_SUMMARY`；
- 摘要步骤用 `if: always()`，签到失败时同样出摘要，并直接标红报错原因（如 cookie 过期、缺少设备字段）。

**摘要只写入白名单字段**（昵称 / 黑盒 ID / 任务状态 / H 币 / 活动状态，IMEI 中间位打码），不写入接口原始响应 —— 摘要会长期留存在 Actions 页面，原始 body 里含有 `help_code` 等信息，不适合公开展示。

本地也可单独预览摘要：

```bash
node scripts/summarize.js --sign sign.log --roll roll.log
```

---

## 七、注意事项

- **定时精度**：GitHub cron 可能延迟几分钟；若仓库 **60 天无任何提交/活动**，定时任务会被自动停用——届时手动 push 一次或重新 enable 即可。
- **私有仓库**：强烈建议 Private，避免 cookie 逻辑和账号暴露（即使 cookie 在 Secret 里，仓库公开也会增加风险）。
- **免费额度**：公开仓库 Actions 免费；私有仓库有每月额度，单脚本每日跑一次完全够用。
- **扩展**：想顺便自动领奖，可在工作流里再加一步 `node heybox_claim.js`（同样依赖 `HEYBOX_CK`）。
- **依赖外部签名服务** `hkey.qcciii.com`，若其不可用，签到会失败。
- **同步上游**：本仓库已合并 `yowiv08/heybox` 最新代码（含 `_rnd` 签名校验、真实设备字段要求）。日后再次同步执行 `git fetch upstream main && git merge upstream/main` 即可（两仓库历史互不相关，首次合并用了 `--allow-unrelated-histories`）。
