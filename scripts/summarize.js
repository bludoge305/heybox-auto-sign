#!/usr/bin/env node
/**
 * 把 heybox_sign.js / heybox_roll.js 的控制台输出汇总成 GitHub Actions 运行摘要。
 *
 * 背景：Actions 的运行摘要会长期留存在仓库的 Actions 页面，因此这里只挑白名单字段
 *       （账号昵称、ID、任务状态、H 币、活动状态），绝不写入接口原始 body ——
 *       抽奖脚本的报错行里带 body，动辄上万字符，且含 help_code 等信息。
 *
 * 用法：
 *   node scripts/summarize.js --sign sign.log --roll roll.log > summary.md
 *   node scripts/summarize.js --sign sign.log                      # 只有签到结果
 *   cat summary.md >> "$GITHUB_STEP_SUMMARY"
 */

const fs = require("fs");

/* ----------------------------- 参数与清洗 ----------------------------- */

function parseArgs(argv) {
  const args = { sign: "", roll: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--sign") args.sign = argv[++i] || "";
    else if (argv[i] === "--roll") args.roll = argv[++i] || "";
  }
  return args;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const TS_PREFIX = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*/;
// 账号 ID 在日志里已打码成 2528****，这里两种形态都要认
const ACCOUNT_PREFIX = /^账号\[(\d+)\]\[([\d*]+)\](.*)$/;

// 框架噪音或超长 body，一律丢掉
const NOISE = [
  /^##\[/,
  /^node heybox_/,
  /^shell: /,
  /^env:$/,
  /^heybox_ck: /,
  /^-{5,}$/,
  /^读取到的脚本变量:$/,
  /^共读取到\d+个账号$/,
  /^开始运行$/,
  /^通知发送失败: /,
  /^\[小黑盒\./,
];

/**
 * 逐行读取日志，剥掉 ANSI、时间戳与 `账号[n][id]` 前缀。
 * 返回 [{ index, heyboxId, text }]，index 为空表示全局行。
 */
function readEntries(file) {
  if (!file || !fs.existsSync(file)) return null;
  const entries = [];
  const raw = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const rawLine of raw) {
    const line = rawLine.replace(ANSI, "").replace(TS_PREFIX, "").trimEnd();
    if (!line) continue;
    if (NOISE.some((rx) => rx.test(line))) continue;
    // 报错行里带接口 body（上万字符），只要前缀信息，截断后再解析
    const text = line.length > 300 ? line.slice(0, 300) : line;
    const match = text.match(ACCOUNT_PREFIX);
    if (match) entries.push({ index: match[1], heyboxId: match[2], text: match[3].trim() });
    else entries.push({ index: "", heyboxId: "", text });
  }
  return entries;
}

function trimEnd(text) {
  return String(text).replace(/\s+$/, "");
}

/* ----------------------------- 签到日志解析 ----------------------------- */

function maskImei(imei) {
  const text = String(imei || "");
  if (text.includes("*")) return text; // 脚本已经打过码
  if (text.length < 10) return text || "-";
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function stripParens(text) {
  return trimEnd(text)
    .trim()
    .replace(/^[（(]\s*/, "")
    .replace(/\s*[)）]$/, "")
    .trim();
}

function parseSign(entries) {
  if (!entries) return null;
  const result = { accounts: [], total: "", duration: "", error: "", version: "" };
  const byIndex = new Map();

  const accountOf = (index, heyboxId) => {
    if (!byIndex.has(index)) {
      const account = { index, heyboxId: heyboxId || "", name: "", imei: "", coins: "", tasks: [] };
      byIndex.set(index, account);
      result.accounts.push(account);
    }
    const account = byIndex.get(index);
    if (heyboxId) account.heyboxId = heyboxId;
    return account;
  };

  for (const entry of entries) {
    const { index, heyboxId, text } = entry;

    if (/^(Error:|HTTP错误|##\[error\])/.test(text)) {
      if (!result.error) result.error = text.slice(0, 160);
      continue;
    }
    if (index) {
      let m = text.match(/^账号=(\S+)\s+黑盒ID=([\d*]+)\s+IMEI=(\S+)/);
      if (m) {
        const account = accountOf(index, m[2]);
        account.name = m[1];
        account.imei = m[3];
        continue;
      }
      m = text.match(/^当前总H币:\s*(\d+)/);
      if (m) {
        accountOf(index, heyboxId).coins = m[1];
        continue;
      }
      // 任务行：签到: 已完成 (+30经验 +30H币 +1盒电)
      m = text.match(/^([^:：]{2,40})[:：]\s*(已完成|未完成|失败|已跳过|部分完成|跳过)(.*)$/);
      if (m) {
        accountOf(index, heyboxId).tasks.push({ name: m[1].trim(), status: m[2], reward: stripParens(m[3]) });
        continue;
      }
    }

    let m = text.match(/^当前版本:\s*(.*)$/);
    if (m) {
      result.version = trimEnd(m[1]) || result.version;
      continue;
    }
    m = text.match(/^完成:\s*(\d+)\/(\d+)$/);
    if (m) {
      result.total = `${m[1]}/${m[2]}`;
      continue;
    }
    m = text.match(/运行结束，共运行了([\d.]+)秒/);
    if (m) result.duration = `${m[1]}s`;
  }
  return result;
}

/* ----------------------------- 抽奖日志解析 ----------------------------- */

function parseRoll(entries) {
  if (!entries) return null;
  const result = { accounts: [], awards: [], unsupported: [], duration: "", error: "" };
  const accountOf = (index) => {
    let account = result.accounts.find((item) => item.index === index);
    if (!account) {
      account = { index, heyboxId: "", tickets: 0, joined: 0, skipped: 0 };
      result.accounts.push(account);
    }
    return account;
  };

  let current = null;
  for (const entry of entries) {
    const { index, heyboxId, text } = entry;

    if (/^(Error:|HTTP错误|##\[error\])/.test(text)) {
      if (!result.error) result.error = text.slice(0, 160);
      continue;
    }

    let m = text.match(/^抽奖活动 award_id=(\d+)\s*(.*)$/);
    if (m) {
      current = { index, heyboxId, awardId: m[1], name: trimEnd(m[2]), tickets: 0, joined: false, skipped: false };
      result.awards.push(current);
      accountOf(index).heyboxId = heyboxId;
      continue;
    }
    if (!current) continue;

    m = text.match(/^help_code=\S+\s+my_ticket=(\d+)\s+joined=(true|false)/);
    if (m) {
      current.tickets = m[1];
      current.joined = m[2] === "true";
      const account = accountOf(current.index);
      account.tickets += Number(m[1]) || 0;
      if (current.joined) account.joined += 1;
      continue;
    }
    if (/前置参与任务未完成，跳过参与抽奖/.test(text)) {
      current.skipped = true;
      accountOf(current.index).skipped += 1;
      continue;
    }
    m = text.match(/^未自动处理任务:\s*(.+)$/);
    if (m) {
      for (const item of m[1].split(/[,，]\s*/).map((piece) => piece.trim()).filter(Boolean)) {
        if (!result.unsupported.includes(item)) result.unsupported.push(item);
      }
      continue;
    }
    m = text.match(/运行结束，共运行了([\d.]+)秒/);
    if (m) result.duration = `${m[1]}s`;
  }
  return result;
}

/* ----------------------------- 摘要渲染 ----------------------------- */

const STATUS_ICON = {
  已完成: "✅ 已完成",
  部分完成: "🟡 部分完成",
  未完成: "⬜ 未完成",
  已跳过: "⏭️ 已跳过",
  跳过: "⏭️ 已跳过",
  失败: "❌ 失败",
};

function nowInBeijing() {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (UTC+8)`;
}

function esc(text) {
  return String(text === undefined || text === null ? "" : text).replace(/\|/g, "\\|");
}

function render(sign, roll) {
  const out = [];
  const signAccounts = sign ? sign.accounts : [];
  const signError = sign ? sign.error : "";
  const rollError = roll ? roll.error : "";
  const awardCount = roll ? roll.awards.length : 0;
  const joinedCount = roll ? roll.awards.filter((award) => award.joined).length : 0;
  const skippedCount = roll ? roll.awards.filter((award) => award.skipped).length : 0;

  const allDone =
    signAccounts.length > 0 &&
    !signError &&
    signAccounts.every((account) => account.tasks.length > 0 && account.tasks.every((task) => task.status === "已完成"));
  const headline = allDone ? "✅ 签到成功" : signAccounts.length ? "⚠️ 部分任务未完成" : "❌ 未取到签到结果";

  out.push("## 小黑盒每日任务");
  out.push("");
  out.push(`**${headline}**`);
  out.push("");
  out.push("| 项目 | 值 |");
  out.push("| --- | --- |");
  out.push(`| 运行时间 | ${nowInBeijing()} |`);
  if (sign && sign.total) out.push(`| 任务完成 | ${esc(sign.total)} |`);
  if (signAccounts.length) {
    out.push(`| 账号 | ${signAccounts.map((a) => `**${esc(a.name || "-")}**（${a.heyboxId}）`).join("、")} |`);
  }
  const coins = signAccounts.filter((a) => a.coins).map((a) => a.coins);
  if (coins.length) out.push(`| 当前 H 币 | ${coins.join(" / ")} |`);
  if (sign && sign.version) out.push(`| 客户端版本 | ${esc(sign.version)} |`);
  if (awardCount) out.push(`| 抽奖活动 | 进行中 ${awardCount} 个，参与成功 ${joinedCount} 个 |`);
  const durations = [sign && sign.duration ? `签到 ${sign.duration}` : "", roll && roll.duration ? `抽奖 ${roll.duration}` : ""]
    .filter(Boolean)
    .join(" · ");
  if (durations) out.push(`| 耗时 | ${durations} |`);

  if (signAccounts.length) {
    out.push("");
    out.push("### 每日任务");
    for (const account of signAccounts) {
      if (signAccounts.length > 1) {
        out.push("");
        out.push(`**账号${account.index} · ${esc(account.name || "-")}（${account.heyboxId}）**`);
        out.push("");
      }
      out.push("| 任务 | 状态 | 奖励 |");
      out.push("| --- | --- | --- |");
      for (const task of account.tasks) {
        out.push(`| ${esc(task.name)} | ${STATUS_ICON[task.status] || esc(task.status)} | ${esc(task.reward || "-")} |`);
      }
      if (account.imei) {
        out.push("");
        out.push(`<sub>设备 IMEI：${esc(maskImei(account.imei))}（中间位已打码）</sub>`);
      }
    }
  }

  if (awardCount) {
    out.push("");
    out.push("### 0 元抽奖盒券");
    out.push("");
    out.push("| 指标 | 值 |");
    out.push("| --- | --- |");
    out.push(`| 进行中活动 | ${awardCount} |`);
    out.push(`| 参与成功 | ${joinedCount} |`);
    out.push(`| 跳过 | ${skippedCount}（前置任务需手动完成，如 Steam 拥有游戏、好友助力、购买 DLC） |`);
    if (roll.unsupported.length) out.push(`| 脚本不支持的任务 | ${esc(roll.unsupported.join("、"))} |`);
    out.push("");
    out.push("<details><summary>活动明细（点击展开）</summary>");
    out.push("");
    out.push("| 活动 ID | 活动 | 状态 | 我的盒券 |");
    out.push("| --- | --- | --- | --- |");
    for (const award of roll.awards) {
      const status = award.joined ? "✅ 已参与" : award.skipped ? "⏭️ 跳过" : "⬜ 未参与";
      out.push(`| ${award.awardId} | ${esc(award.name)} | ${status} | ${award.tickets} |`);
    }
    out.push("");
    out.push("</details>");
  }

  const notes = [];
  if (signError) notes.push(`签到脚本报错：\`${esc(signError)}\``);
  if (rollError) notes.push(`抽奖脚本报错：\`${esc(rollError)}\``);
  if (!signAccounts.length && !signError) {
    notes.push("未解析到签到结果，请展开上方步骤日志查看原因（最常见是 `heybox_ck` 过期或缺少设备字段）。");
  }
  if (notes.length) {
    out.push("");
    for (const note of notes) out.push(`> ⚠️ ${note}`);
  }
  if (rollError && awardCount) {
    out.push(">");
    out.push("> 抽奖步骤退出码非 0 通常只是「有活动的前置任务无法自动完成」，不影响签到结果。");
  }

  out.push("");
  out.push("<sub>摘要只包含白名单字段（昵称 / ID / 任务状态 / H 币 / 活动状态），不写入接口原始响应。</sub>");
  return `${out.join("\n")}\n`;
}

/* ----------------------------- 入口 ----------------------------- */

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sign = parseSign(readEntries(args.sign));
  const roll = parseRoll(readEntries(args.roll));
  process.stdout.write(render(sign, roll));
}

if (require.main === module) main();

module.exports = { parseSign, parseRoll, render, readEntries };
