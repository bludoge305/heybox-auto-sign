/*
小黑盒 - 定时抢券
账号环境变量:
  heybox_ck=pkey=xxx;x_xhh_tokenid=xxx;
*/
const { $, tools } = require("./src/core");
const {
  DATA_NAME,
  HeyboxAccount,
  HeyboxWebClient,
  WEB_PROFILE,
} = require("./src/heybox");
const { validateCouponResult, couponBusinessMessage, couponResultMessage, isCouponLoginRequired, couponResponseError } = require("./src/heybox/coupon");

exports.name = "小黑盒.定时抢券";

const PATH_DETAIL = "/mall/coupon/center/detail/";
const PATH_SPECIAL = "/mall/coupon/center/detail_special/";
const PATH_RUSH = "/mall/coupon/center/get_time_limit/";
const BUSINESS_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const CONFIG = Object.freeze({
  targets: [],
  rushAt: "",
  appVersion: WEB_PROFILE.x_client_version,
  prewarmMs: 1500,
  windowBeforeMs: 300,
  windowAfterMs: 5000,
  intervalMs: 250,
  maxRounds: 20,
  parallel: 6,
  skipTerminalTargets: true,
  pageLimit: 20,
  maxPages: 500,
});

function validateCouponSession(payload) {
  return validateCouponResult(payload, PATH_DETAIL, { requireSession: true });
}

function validateCouponItem(item, payload, path = PATH_DETAIL) {
  if (!item || typeof item !== "object" || Array.isArray(item) ||
      !Number.isSafeInteger(item.id) || item.id <= 0 ||
      !Number.isSafeInteger(item.state) ||
      typeof item.is_get !== "boolean" || typeof item.is_limit !== "boolean") {
    throw couponResponseError(path, "券列表包含无效券条目", payload);
  }
}

function normalizeRushTarget(item, source, payload) {
  const path = source === "flash_sale" ? PATH_DETAIL : PATH_SPECIAL;
  validateCouponItem(item, payload, path);
  const actId = item.act_id;
  if (!item.is_limit || typeof actId !== "string" || !/^[a-f0-9]{24}$/i.test(actId)) {
    throw couponResponseError(path, "限时券返回无效act_id或is_limit", payload);
  }
  return {
    actId: actId.toLowerCase(),
    poolId: String(item.id),
    name: tools.toText(item.name),
    tag: tools.toText(item.tag),
    value: item.value,
    count: item.count,
    leftPercent: item.left_percent,
    state: item.state,
    isGet: item.is_get,
    description: tools.toText(item.description || item.sub_title),
    source,
  };
}

function uniqueTargets(targets) {
  const seen = new Set();
  return targets.filter((target) => {
    const key = `${target.actId}:${target.poolId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function flattenSpecialTargets(payload) {
  const special = payload?.result?.special;
  if (!special || typeof special !== "object" || Array.isArray(special)) {
    throw couponResponseError(PATH_SPECIAL, "券列表缺少special对象", payload);
  }
  const groups = ["processing", "closed", "not_start"];
  const targets = [];
  for (const group of groups) {
    if (!Array.isArray(special[group])) {
      throw couponResponseError(PATH_SPECIAL, `券列表缺少${group}数组`, payload);
    }
    for (const item of special[group]) targets.push(normalizeRushTarget(item, group, payload));
  }
  return uniqueTargets(targets);
}

async function loadFlashSalePage(client, lastval = "0") {
  return client.getJson(PATH_DETAIL, {
    query: {
      primary_id: "",
      sub_id: "",
      cate: "flash_sale",
      app_version: CONFIG.appVersion,
      limit: String(CONFIG.pageLimit),
      lastval,
      need_is_get: "0",
    },
    retries: 1,
  });
}

function validateFlashSalePage(payload, requireSession = true) {
  const result = validateCouponResult(payload, PATH_DETAIL, { requireSession });
  if (result.success !== 1) throw couponResponseError(PATH_DETAIL, "券列表返回结果异常", payload);
  if (!Array.isArray(result.items) || !Array.isArray(result.games)) {
    throw couponResponseError(PATH_DETAIL, "券列表缺少items或games数组", payload);
  }
  if (result.session !== undefined && (!Number.isSafeInteger(result.session) || result.session <= 0)) {
    throw couponResponseError(PATH_DETAIL, "券列表返回无效session", payload);
  }
  if (result.need_is_get !== undefined && result.need_is_get !== 0 && result.need_is_get !== 1) {
    throw couponResponseError(PATH_DETAIL, "券列表返回无效need_is_get", payload);
  }
  for (const item of [...result.items, ...result.games]) {
    validateCouponItem(item, payload);
    if (item.is_limit) normalizeRushTarget(item, "flash_sale", payload);
  }
  return result;
}

function nextCouponCursor(result, payload) {
  if (result.lastval === undefined) return "";
  if (!Number.isSafeInteger(result.lastval) || result.lastval <= 0) {
    throw couponResponseError(PATH_DETAIL, "券列表返回无效分页游标", payload);
  }
  return String(result.lastval);
}

async function discoverFlashSaleTargets(client, firstPayload) {
  const targets = [];
  const cursors = new Set(["0"]);
  let lastval = "0";
  for (let page = 1; page <= CONFIG.maxPages; page += 1) {
    const payload = page === 1 && firstPayload ? firstPayload : await loadFlashSalePage(client, lastval);
    const result = validateFlashSalePage(payload, page === 1);
    const items = [...result.items, ...result.games];
    for (const item of items) {
      if (item.is_limit) targets.push(normalizeRushTarget(item, "flash_sale", payload));
    }
    const nextLastval = nextCouponCursor(result, payload);
    if (result.need_is_get === 1 || !nextLastval) return uniqueTargets(targets);
    if (!items.length) throw couponResponseError(PATH_DETAIL, "空券列表仍返回分页游标", payload);
    if (cursors.has(nextLastval)) throw couponResponseError(PATH_DETAIL, "券列表分页游标重复", payload);
    if (page > 1 && Number(nextLastval) >= Number(lastval)) {
      throw couponResponseError(PATH_DETAIL, "未领取券分页游标未递减", payload);
    }
    if (page === CONFIG.maxPages) throw couponResponseError(PATH_DETAIL, "券列表超过分页上限，请提高maxPages", payload);
    cursors.add(nextLastval);
    lastval = nextLastval;
  }
  return uniqueTargets(targets);
}

async function discoverSpecialTargets(client) {
  const payload = await client.getJson(PATH_SPECIAL, { retries: 1 });
  validateCouponResult(payload, PATH_SPECIAL);
  const targets = flattenSpecialTargets(payload);
  const special = payload?.result?.special;
  if (special && typeof special === "object") {
    const groups = Object.keys(special).map((key) => {
      const value = special[key];
      return `${key}=${Array.isArray(value) ? value.length : typeof value}`;
    });
    $.log(`Special coupon groups: ${groups.join(", ") || "empty"}`);
  }
  return targets;
}

async function discoverRushTargets(client, firstPayload) {
  const special = await discoverSpecialTargets(client);
  const flashSale = await discoverFlashSaleTargets(client, firstPayload);
  $.log(`Rush coupon sources: special=${special.length}, flash_sale=${flashSale.length}`);
  return uniqueTargets([...special, ...flashSale]);
}

function normalizeConfiguredTarget(raw) {
  const parts = raw && typeof raw === "object"
    ? [String(raw.actId), String(raw.poolId)]
    : String(raw).split(":").map(item => item.trim());
  if (parts.length !== 2 || !/^[a-f0-9]{24}$/i.test(parts[0]) || !/^[1-9]\d*$/.test(parts[1]) ||
      !Number.isSafeInteger(Number(parts[1]))) {
    throw new Error("抢券目标格式无效，应为24位十六进制act_id:正整数pool_id");
  }
  return { actId: parts[0].toLowerCase(), poolId: parts[1] };
}

function parseStartTime(value, nowMs = Date.now()) {
  const raw = tools.toText(value);
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    const millis = numeric > 1e12 ? numeric : numeric * 1000;
    return millis > 0 && Number.isSafeInteger(millis) ? millis : null;
  }
  const hms = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (hms) {
    if (Number(hms[1]) > 23 || Number(hms[2]) > 59 || Number(hms[3] || 0) > 59) return null;
    const now = new Date(nowMs + BUSINESS_TIME_OFFSET_MS);
    let targetMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      Number(hms[1]), Number(hms[2]), Number(hms[3] || 0), Number((hms[4] || "0").padEnd(3, "0"))) - BUSINESS_TIME_OFFSET_MS;
    if (targetMs <= nowMs) targetMs += DAY_MS;
    return targetMs;
  }
  const dateTime = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!dateTime) return null;
  const [year, month, day, hour, minute, second, millisecond] = [
    Number(dateTime[1]), Number(dateTime[2]), Number(dateTime[3]), Number(dateTime[4]),
    Number(dateTime[5]), Number(dateTime[6] || 0), Number((dateTime[7] || "0").padEnd(3, "0")),
  ];
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const check = new Date(utcMs);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  let offsetMs = BUSINESS_TIME_OFFSET_MS;
  const zone = dateTime[8];
  if (zone === "Z") offsetMs = 0;
  else if (zone) {
    const zoneDigits = zone.slice(1).replace(":", "");
    const zoneHours = Number(zoneDigits.slice(0, 2));
    const zoneMinutes = Number(zoneDigits.slice(2));
    if (zoneHours > 23 || zoneMinutes > 59) return null;
    offsetMs = (zoneHours * 60 + zoneMinutes) * 60 * 1000 * (zone[0] === "+" ? 1 : -1);
  }
  return utcMs - offsetMs;
}

function parseTagStartTime(tag, nowMs = Date.now()) {
  const text = tools.toText(tag);
  const time = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!time) return null;
  if (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] || 0) > 59) return null;
  const now = new Date(nowMs + BUSINESS_TIME_OFFSET_MS);
  let targetMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    Number(time[1]), Number(time[2]), Number(time[3] || 0), 0) - BUSINESS_TIME_OFFSET_MS;
  if (/明日|明天/.test(text)) targetMs += DAY_MS;
  else if (/后天/.test(text)) targetMs += 2 * DAY_MS;
  else if (targetMs <= nowMs) targetMs += DAY_MS;
  return targetMs;
}

function isTerminalMessage(message) {
  return /已抢光|活动已结束|已领取|已抢过|资格|库存不足/.test(message);
}

function isTerminalTarget(target) {
  return target.isGet === true || isTerminalMessage(tools.toText(target.tag));
}

function mergeMetadata(targets, discovered) {
  const metaByKey = new Map(discovered.map((item) => [`${item.actId}:${item.poolId}`, item]));
  return targets.map((target) => ({ ...metaByKey.get(`${target.actId}:${target.poolId}`), ...target }));
}

function buildPlans(targets) {
  const nowMs = Date.now();
  const fixedAt = parseStartTime(CONFIG.rushAt, nowMs);
  if (CONFIG.rushAt && fixedAt === null) throw new Error("抢券时间格式无效，请检查rushAt");
  const plans = new Map();
  for (const target of targets) {
    const tagAt = parseTagStartTime(target.tag, nowMs);
    if (CONFIG.skipTerminalTargets && (isTerminalTarget(target) || (!fixedAt && target.source === "closed" && tagAt === null))) {
      $.log(`Skip pool=${target.poolId}: ${target.tag || "terminal"}`);
      continue;
    }
    if (!fixedAt && /\d{1,2}:\d{2}/.test(target.tag || "") && tagAt === null) throw new Error(`pool=${target.poolId}: 开抢时间格式无效`);
    const atMs = fixedAt || tagAt || nowMs;
    const key = String(atMs);
    if (!plans.has(key)) plans.set(key, []);
    plans.get(key).push(target);
  }
  return Array.from(plans.entries())
    .map(([atMs, groupTargets]) => ({ atMs: Number(atMs), targets: groupTargets }))
    .sort((a, b) => a.atMs - b.atMs);
}

function buildPlanTiming(plan) {
  const anchorMs = plan.atMs;
  const prewarmAtMs = Math.max(Date.now(), anchorMs - CONFIG.prewarmMs);
  const startMs = Math.max(Date.now(), anchorMs - CONFIG.windowBeforeMs);
  const endMs = anchorMs + CONFIG.windowAfterMs;
  const derivedRounds = Math.floor((CONFIG.windowBeforeMs + CONFIG.windowAfterMs) / CONFIG.intervalMs) + 1;
  const maxRounds = Math.max(1, Math.min(CONFIG.maxRounds, derivedRounds));
  const parallel = Math.max(1, Math.min(Math.max(1, plan.targets.length), CONFIG.parallel));
  return { prewarmAtMs, startMs, endMs, maxRounds, parallel };
}

function formatDateTime(inputMs) {
  const date = new Date(inputMs + BUSINESS_TIME_OFFSET_MS);
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
}

function formatTarget(target) {
  const value = target.value !== undefined && target.value !== null && target.value !== "" ? `￥${target.value}` : "券";
  const desc = target.description || target.name || "";
  const stock = target.count !== undefined && target.count !== null ? ` 库存=${target.count}` : "";
  const left = target.leftPercent ? ` 剩余=${target.leftPercent}%` : "";
  return `${value} ${desc} pool=${target.poolId} act=${target.actId}${stock}${left}`;
}

function printPlan(plan) {
  const timing = buildPlanTiming(plan);
  $.log("\n抢券计划:");
  $.log(`  时间: ${formatDateTime(plan.atMs)} (${plan.targets.length}张券)`);
  for (const target of plan.targets) $.log(`  - ${formatTarget(target)}`);
  $.log(`  刷新session: ${formatDateTime(timing.prewarmAtMs)}`);
  $.log(`  请求窗口: ${formatDateTime(timing.startMs)} -> ${formatDateTime(timing.endMs)}`);
  $.log(`  间隔: ${CONFIG.intervalMs}ms, 轮数: ${timing.maxRounds}, 并发: ${timing.parallel}`);
  return timing;
}

async function waitUntil(timeMs) {
  while (Date.now() < timeMs) await tools.sleep(Math.min(60000, timeMs - Date.now()));
}

async function refreshSession(client) {
  const payload = await loadFlashSalePage(client);
  return String(validateCouponSession(payload).session);
}

async function rushCoupon(client, target, session) {
  return client.postJson(PATH_RUSH, {
    body: {
      act_id: target.actId,
      pool_id: target.poolId,
      session,
    },
    retries: 0,
    timeoutMs: 8000,
  });
}

function isSuccess(payload) {
  return payload?.status === "ok" && payload?.result?.success === 1;
}

async function runAttemptWindow(account, client, targets, config) {
  const done = new Set();
  const success = new Set();
  let session = config.session;
  let rounds = 0;
  let failureMessage = "";
  let lastErrorMessage = "";
  while (Date.now() <= config.endMs && rounds < config.maxRounds && done.size < targets.length) {
    await waitUntil(config.startMs + rounds * CONFIG.intervalMs);
    if (Date.now() > config.endMs) break;
    rounds += 1;
    const pending = targets.filter((target) => !done.has(`${target.actId}:${target.poolId}`));
    for (let index = 0; index < pending.length; index += config.parallel) {
      if (Date.now() > config.endMs) break;
      const batch = pending.slice(index, index + config.parallel);
      const results = await Promise.all(batch.map(async (target) => {
        try {
          return { target, payload: await rushCoupon(client, target, session) };
        } catch (error) {
          return { target, error };
        }
      }));
      for (const result of results) {
        const key = `${result.target.actId}:${result.target.poolId}`;
        if (result.error) {
          account.log(`round=${rounds} pool=${result.target.poolId}: ERROR ${result.error.message}`);
          lastErrorMessage = "请求失败";
          continue;
        }
        const message = couponResultMessage(result.payload);
        const businessMessage = couponBusinessMessage(result.payload);
        account.log(`round=${rounds} pool=${result.target.poolId}: ${message}`);
        if (isCouponLoginRequired(result.payload)) {
          failureMessage = `抢券请求未通过登录验证，停止当前账号 body=${tools.responseBody(result.payload)}`;
          continue;
        }
        if (isSuccess(result.payload)) success.add(key);
        if (isSuccess(result.payload) || isTerminalMessage(businessMessage)) done.add(key);
        if (!failureMessage && businessMessage.includes("页面已过期")) {
          try {
            session = await refreshSession(client);
            account.log("抢券会话已刷新");
          } catch (error) {
            failureMessage = error.message;
          }
        }
      }
      if (failureMessage) break;
    }
    if (failureMessage) break;
  }
  const ok = !failureMessage && done.size === targets.length;
  if (!ok) {
    account.log(`抢券失败: ${failureMessage || `${lastErrorMessage || "请求窗口结束"}，剩余${targets.length - done.size}张未完成`}`, { notify: true });
  }
  return { ok, doneCount: done.size, successCount: success.size, rounds };
}

async function executePlan(accounts, clients, plan, shouldPrint = true) {
  const timing = shouldPrint ? printPlan(plan) : buildPlanTiming(plan);
  await waitUntil(timing.prewarmAtMs);
  const sessions = await Promise.all(accounts.map(async (account, index) => {
    const client = clients[index];
    account.log(`预热 session heybox_id=${account.heyboxId}`);
    try {
      const session = await refreshSession(client);
      account.log("抢券会话预热完成");
      return { account, client, session };
    } catch (error) {
      account.log(`抢券失败: ${error.message}`, { notify: true });
      process.exitCode = 1;
      return { account, client, session: "" };
    }
  }));
  if (!sessions.some(item => item.session)) {
    return sessions.map(({ account }) => ({ account, result: { ok: false, doneCount: 0, successCount: 0, rounds: 0 } }));
  }
  await waitUntil(timing.startMs);
  const results = await Promise.all(sessions.map(async ({ account, client, session }) => {
    if (!session) return { account, result: { ok: false, doneCount: 0, successCount: 0, rounds: 0 } };
    try {
      return {
        account,
        result: await runAttemptWindow(account, client, plan.targets, {
          session,
          startMs: timing.startMs,
          endMs: timing.endMs,
          maxRounds: timing.maxRounds,
          parallel: timing.parallel,
        }),
      };
    } catch (error) {
      account.log(`抢券失败: ${error.message}`, { notify: true });
      process.exitCode = 1;
      return { account, result: { ok: false, doneCount: 0, successCount: 0, rounds: 0 } };
    }
  }));
  return results.map(({ account, result }) => {
    if (!result.ok) process.exitCode = 1;
    account.log(`done: rounds=${result.rounds}, closed=${result.doneCount}/${plan.targets.length}`);
    return { account, result };
  });
}

async function run() {
  if (!await $.read_env(HeyboxAccount, DATA_NAME)) return;
  const checkedAccounts = await Promise.all($.userList.map(async (account) => {
    const client = new HeyboxWebClient(account);
    try {
      const firstPayload = await loadFlashSalePage(client);
      validateFlashSalePage(firstPayload);
      return { account, client, firstPayload };
    } catch (error) {
      account.log(`抢券认证失败: ${error.message}`, { notify: true });
      process.exitCode = 1;
      return null;
    }
  }));
  const ready = checkedAccounts.filter(Boolean);
  if (!ready.length) return;
  const accounts = ready.map(({ account }) => account);
  const clients = ready.map(({ client }) => client);
  let targets = uniqueTargets(CONFIG.targets.map(normalizeConfiguredTarget));
  let discovered = [];
  let discoverySucceeded = false;
  for (let index = 0; index < clients.length; index += 1) {
    try {
      discovered = await discoverRushTargets(clients[index], ready[index].firstPayload);
      discoverySucceeded = true;
      break;
    } catch (error) {
      accounts[index].log(`抢券发现失败: ${error.message}`, { notify: true });
      process.exitCode = 1;
    }
  }
  if (!discoverySucceeded && !targets.length) return;
  if (!targets.length) targets = discovered;
  else if (discovered.length) targets = mergeMetadata(targets, discovered);
  if (!targets.length) {
    $.log("No rush targets found from current coupon list");
    $.notifyStr.push("未发现可抢券目标");
    return;
  }
  const plans = buildPlans(targets);
  if (!plans.length) {
    $.log("当前抢券目标均已结束或已领取");
    $.notifyStr.push("当前抢券目标均已结束或已领取");
    return;
  }
  $.log(`Loaded ${targets.length} rush target(s), ${plans.length} plan(s).`);
  for (const plan of plans) printPlan(plan);
  const summaryByAccount = new Map();
  for (const plan of plans) {
    const results = await executePlan(accounts, clients, plan, false);
    for (const { account, result } of results) {
      const summary = summaryByAccount.get(account) || { closed: 0, success: 0, total: 0, rounds: 0 };
      summary.closed += result.doneCount;
      summary.success += result.successCount;
      summary.total += plan.targets.length;
      summary.rounds += result.rounds;
      summaryByAccount.set(account, summary);
    }
  }
  for (const [account, summary] of summaryByAccount) {
    account.log(
      `抢券汇总: 处理${summary.total}张，成功${summary.success}张`,
      { notify: true },
    );
  }
  $.notifyStr.push(`抢券结束: 目标${targets.length}张，计划${plans.length}个`);
}

exports.run = run;

if (require.main === module) $.start(exports);
