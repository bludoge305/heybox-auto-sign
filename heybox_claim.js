/*
小黑盒 - 普通领券
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

exports.name = "小黑盒.普通领券";

const PATH_DETAIL = "/mall/coupon/center/detail/";
const PATH_GET = "/mall/coupon/center/get/";

const CONFIG = Object.freeze({
  delayMs: 300,
  appVersion: WEB_PROFILE.x_client_version,
  pageLimit: 20,
  maxPages: 500,
  sessionRetry: 1,
});

function validateCouponDetail(payload, requireSession = true) {
  const result = validateCouponResult(payload, PATH_DETAIL, { requireSession });
  if (result.success !== 1) throw couponResponseError(PATH_DETAIL, "券列表返回结果异常", payload);
  if (!Array.isArray(result.games)) throw couponResponseError(PATH_DETAIL, "券列表缺少games数组", payload);
  if (result.need_is_get !== 0 && result.need_is_get !== 1) {
    throw couponResponseError(PATH_DETAIL, "券列表返回无效need_is_get", payload);
  }
  return result;
}

function isClaimableCoupon(item) {
  return !item.is_get && !item.is_limit && item.state === 0;
}

function validateCouponItem(item, payload) {
  if (!item || typeof item !== "object" || Array.isArray(item) ||
      !Number.isSafeInteger(item.id) || item.id <= 0 ||
      !Number.isSafeInteger(item.state) ||
      typeof item.is_get !== "boolean" || typeof item.is_limit !== "boolean") {
    throw couponResponseError(PATH_DETAIL, "券列表包含无效券条目", payload);
  }
}

function nextCouponCursor(result, payload) {
  if (!Number.isSafeInteger(result.lastval) || result.lastval <= 0) {
    throw couponResponseError(PATH_DETAIL, "券列表返回无效分页游标", payload);
  }
  return String(result.lastval);
}

async function loadTargets(client) {
  const targets = [];
  const seen = new Set();
  const cursors = new Set();
  let lastval = "0";

  for (let page = 1; page <= CONFIG.maxPages; page += 1) {
    if (cursors.has(lastval)) throw new Error(`${PATH_DETAIL}: 券列表分页游标重复`);
    cursors.add(lastval);
    const payload = await client.getJson(PATH_DETAIL, {
      query: {
        primary_id: "",
        sub_id: "",
        cate: "game",
        app_version: CONFIG.appVersion,
        limit: String(CONFIG.pageLimit),
        lastval,
        need_is_get: "0",
      },
      retries: 1,
    });
    const result = validateCouponDetail(payload, page === 1);
    // 初页颁发会话，后续分页不要求重复颁发。
    if (result.session !== undefined) {
      if (!Number.isSafeInteger(result.session) || result.session <= 0) {
        throw couponResponseError(PATH_DETAIL, "券列表返回无效session", payload);
      }
    }
    const games = result.games;
    for (const item of games) {
      validateCouponItem(item, payload);
      if (!isClaimableCoupon(item)) continue;
      const itemId = String(item.id);
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      targets.push({
        itemId,
        name: tools.toText(item.name),
        description: tools.toText(item.description),
      });
    }
    const nextLastval = nextCouponCursor(result, payload);
    // 当前尾页会混入已领取券，处理本页未领取券后结束。
    if (result.need_is_get === 1) return targets;
    if (!games.length) throw couponResponseError(PATH_DETAIL, "空券列表仍返回分页游标", payload);
    if (cursors.has(nextLastval)) throw couponResponseError(PATH_DETAIL, "券列表分页游标重复", payload);
    if (page > 1 && Number(nextLastval) >= Number(lastval)) {
      throw couponResponseError(PATH_DETAIL, "未领取券分页游标未递减", payload);
    }
    if (page === CONFIG.maxPages) throw couponResponseError(PATH_DETAIL, "券列表超过分页上限，请提高maxPages", payload);
    lastval = nextLastval;
  }

  return targets;
}

async function claimCoupon(client, itemId, session) {
  return client.getJson(PATH_GET, {
    query: { item_id: itemId, session },
    retries: 0,
  });
}

async function refreshClaimSession(client) {
  const payload = await client.getJson(PATH_DETAIL, {
    query: {
      primary_id: "",
      sub_id: "",
      cate: "game",
      app_version: CONFIG.appVersion,
      limit: "20",
      lastval: "0",
      need_is_get: "0",
    },
    retries: 1,
  });
  return String(validateCouponDetail(payload).session);
}

function isPageExpired(message) {
  return /页面已过期|刷新当前页面|session/i.test(message);
}

async function claimWithFreshSession(client, target) {
  let lastPayload = null;
  for (let attempt = 0; attempt <= CONFIG.sessionRetry; attempt += 1) {
    const session = await refreshClaimSession(client);
    const payload = await claimCoupon(client, target.itemId, session);
    const message = couponResultMessage(payload);
    lastPayload = payload;
    if (!isPageExpired(couponBusinessMessage(payload)) || attempt >= CONFIG.sessionRetry) {
      return { payload, message, refreshed: attempt > 0 };
    }
    await tools.sleep(200);
  }
  return { payload: lastPayload, message: couponResultMessage(lastPayload), refreshed: true };
}

async function runAccount(account) {
  const client = new HeyboxWebClient(account);
  account.log(`开始领券 heybox_id=${account.heyboxId}`);
  const targets = await loadTargets(client);
  if (!targets.length) {
    account.log("No claimable coupon found");
    account.log("领券汇总: 无可领券", { notify: true });
    return { ok: true, okCount: 0, failCount: 0 };
  }

  account.log(`Claim targets: ${targets.map((target) => target.itemId).join(", ")}`);
  let okCount = 0;
  let failCount = 0;
  for (const target of targets) {
    let result;
    try {
      result = await claimWithFreshSession(client, target);
    } catch (error) {
      failCount += 1;
      account.log(`领券失败: ${error.message}`, { notify: true });
      break;
    }
    const ok = result.payload?.status === "ok" && result.payload?.result?.success === 1;
    if (ok) okCount += 1;
    else failCount += 1;
    const title = target.name ? ` ${target.name}` : "";
    account.log(`item_id=${target.itemId}${title}: ${ok ? "OK" : "FAIL"} ${result.message}`);
    if (!ok && isCouponLoginRequired(result.payload)) {
      account.log("领券请求未通过登录验证，停止当前账号");
      break;
    }
    if (CONFIG.delayMs > 0) await tools.sleep(CONFIG.delayMs);
  }
  account.log(`领券汇总: 成功${okCount}张${failCount ? `，失败${failCount}张` : ""}`, { notify: true });
  return { ok: failCount === 0, okCount, failCount };
}

async function run() {
  if (!await $.read_env(HeyboxAccount, DATA_NAME)) return;
  for (const account of $.userList) {
    try {
      const result = await runAccount(account);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      account.log(`领券失败: ${error.message}`, { notify: true });
      process.exitCode = 1;
    }
  }
}

exports.run = run;

if (require.main === module) $.start(exports);
