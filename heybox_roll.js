/*
小黑盒 - 0元抽奖盒券任务
账号环境变量:
  heybox_ck=pkey=xxx;x_xhh_tokenid=xxx;imei=xxx;device_info=xxx;os_version=16;dw=411;channel=heybox_xiaomi;
*/
const { $, tools } = require("./src/core");
const {
  DATA_NAME,
  HeyboxAccount,
  HeyboxAppClient,
  HeyboxWebClient,
  OK_STATE,
  sendShareEvents,
  sendWebShareEvent,
} = require("./src/heybox");

exports.name = "小黑盒.抽奖盒券";

const PATH_HOME = "/store/roll_room_v2/get_home_info";
const PATH_TICKET_LIST = "/store/roll_room_v2/ticket_list";
const PATH_JOIN = "/store/roll_room_v2/join";
const PATH_SHARED = "/task/shared/";
const PATH_ROOM_LIST = "/store/roll_room_v2/room_list";
const PATH_DATA_REPORT = "/store/roll_room_v2/data_report";
const PATH_GAME_JSDATA = "/game/jsdata";
const PATH_FOLLOW_USER = "/bbs/app/profile/follow/user/web";

const CONFIG = Object.freeze({
  roomListLimit: 15,
  maxRoomListPages: 10,
  autoPreTasks: true,
  autoFollow: true,
  autoJoin: true,
  autoShare: true,
  printTickets: true,
  injectViewSeconds: 18,
  injectVerifyIntervalMs: 5000,
  injectVerifyMaxTimes: 4,
  shareVerifyIntervalMs: 5000,
  shareVerifyMaxTimes: 4,
  followVerifyIntervalMs: 1000,
  followVerifyMaxTimes: 4,
});

const FOLLOW_TASK_KEYS = new Set([
  "focus_on",
  "focus_on_homeowner",
]);

const WISHLIST_TASK_KEYS = new Set([
  "add_to_wish_list",
  "follow_game",
]);

function getTaskSummary(task) {
  const progress = Array.isArray(task.progress) ? ` ${task.progress[0]}/${task.progress[1]}` : "";
  return `${task.task_key || task.task_id}: ${task.task_name} +${task.award_ticket || 0}盒券 ` +
    `${task.finished ? "已完成" : "未完成"}${progress}`;
}

function normalizeAward(item) {
  const awardId = tools.toText(item?.award_id);
  if (!item || typeof item !== "object" || Array.isArray(item) ||
    !/^[1-9]\d*$/.test(awardId) || !Number.isInteger(item.status) || item.status < 0) {
    throw new Error(`抽奖活动列表包含无效活动 body=${tools.responseBody(item)}`);
  }
  return {
    awardId,
    awardName: tools.toText(item?.award_name),
    status: item?.status,
    statusMsg: tools.toText(item?.status_msg),
    joinedTotal: item?.joined_total,
    awardEndTime: tools.toText(item?.award_end_time),
  };
}

function isActiveAward(award) {
  return award.status === 0;
}

async function discoverAwardIds(webClient) {
  const awards = [];
  const seen = new Set();
  for (let page = 0; page < CONFIG.maxRoomListPages; page += 1) {
    const payload = await webClient.getJson(PATH_ROOM_LIST, {
      query: {
        limit: CONFIG.roomListLimit,
        offset: page * CONFIG.roomListLimit,
      },
      retries: 1,
    });
    if (!isOkPayload(payload) || !Array.isArray(payload.result)) {
      throw new Error(`抽奖活动列表接口异常 ${responseMessage(payload)}`);
    }
    const list = payload.result;
    if (!list.length) break;
    for (const item of list) {
      let award;
      try {
        award = normalizeAward(item);
      } catch (error) {
        throw new Error(`${error.message} response_body=${tools.responseBody(payload)}`);
      }
      if (!award || !isActiveAward(award) || seen.has(award.awardId)) continue;
      seen.add(award.awardId);
      awards.push(award);
    }
    if (list.length < CONFIG.roomListLimit) break;
  }
  return awards;
}

async function fetchHome(webClient, awardId) {
  const payload = await webClient.getJson(PATH_HOME, {
    query: { os_type: "web", award_id: awardId },
    retries: 1,
  });
  validateHome(payload);
  return payload;
}

async function fetchTicketList(webClient, account, awardId) {
  const payload = await webClient.getJson(PATH_TICKET_LIST, {
    query: {
      offset: 0,
      limit: 20,
      award_id: awardId,
      other_heybox_id: account.heyboxId,
    },
    retries: 1,
  });
  if (!isOkPayload(payload) || !Array.isArray(payload.result?.list)) {
    throw new Error(`抽奖盒券列表接口异常 ${responseMessage(payload)}`);
  }
  return payload;
}

async function joinRollRoom(account, appClient, awardId) {
  return appClient.postJson(PATH_JOIN,
    { osType: account.appProfile.os_type },
    { award_id: awardId },
    { headers: { Cookie: account.appClientCookie }, retries: 0 },
  );
}

async function reportRollTask(webClient, task) {
  return webClient.postJson(PATH_DATA_REPORT, {
    body: {
      report_type: 1,
      task_type: tools.toText(task.task_key),
      task_id: task.task_id,
    },
    retries: 0,
  });
}

function extractShareInfo(task) {
  const parsed = parseProtocol(task?.jump_protocol);
  if (parsed?.protocol_type !== "share" || !tools.toText(parsed.act_id)) {
    throw new Error(`分享任务协议缺少有效的分享活动标识 body=${tools.responseBody(task)}`);
  }
  const shareUrl = tools.toText(parsed.share_url);
  let url;
  try {
    url = new URL(shareUrl);
  } catch {
    throw new Error(`分享任务协议缺少有效的分享链接 body=${tools.responseBody(task)}`);
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".xiaoheihe.cn")) {
    throw new Error(`分享任务协议的分享链接无效 body=${tools.responseBody(task)}`);
  }
  return {
    actId: tools.toText(parsed.act_id),
    shareUrl,
    title: tools.toText(parsed.title),
  };
}

async function shareRollTask(account, webClient, appClient, awardId, task) {
  const shareInfo = extractShareInfo(task);
  const payload = await appClient.getJson(PATH_SHARED, {
    act_id: shareInfo.actId,
    shared_type: "web",
    share_plat: "WechatSession",
    web_url: shareInfo.shareUrl,
  }, { retries: 0 });
  if (!isOkPayload(payload)) {
    account.log(`${task.task_name}: 分享请求失败 ${responseMessage(payload)}`);
    return false;
  }

  let reportsSucceeded = true;
  try {
    await sendShareEvents(appClient, "roll_room_v2", {
      act_id: shareInfo.actId,
      award_id: String(awardId),
      title: shareInfo.title,
    });
    account.log(`${task.task_name || "分享活动"}: 分享行为上报 ok`);
  } catch (error) {
    reportsSucceeded = false;
    account.log(`${task.task_name}: 分享行为上报失败 ${error.message}`);
  }

  try {
    for (const action of ["visit", "click", "success"]) {
      await sendWebShareEvent(webClient, action, "/store/roll_room_v2", {
        act_id: shareInfo.actId,
        award_id: String(awardId),
        share_url: shareInfo.shareUrl,
      });
      await tools.sleep(500);
    }
    account.log(`${task.task_name || "分享活动"}: web_share上报 ok`);
  } catch (error) {
    reportsSucceeded = false;
    account.log(`${task.task_name}: web_share上报失败 ${error.message}`);
  }
  return reportsSucceeded;
}

async function executeShareTask(account, webClient, appClient, awardId, task) {
  await shareRollTask(account, webClient, appClient, awardId, task);
  let latestHome;
  for (let index = 0; index < CONFIG.shareVerifyMaxTimes; index += 1) {
    await tools.sleep(index === 0 ? 1200 : CONFIG.shareVerifyIntervalMs);
    latestHome = await fetchHome(webClient, awardId);
    const latest = getTasks(latestHome).find((item) => getTaskIdentity(item) === getTaskIdentity(task));
    if (latest?.finished === true) {
      account.log(`${task.task_name || "分享活动"}: 已完成`);
      return true;
    }
  }
  account.log(`${task.task_name || "分享活动"}: 活动回查仍未确认完成 body=${tools.responseBody(latestHome)}`);
  return false;
}

function parseProtocol(input) {
  const text = tools.toText(input);
  if (!text.startsWith("heybox://")) return null;
  try {
    const protocol = JSON.parse(decodeURIComponent(text.slice("heybox://".length)));
    return protocol && typeof protocol === "object" && !Array.isArray(protocol) ? protocol : null;
  } catch {
    return null;
  }
}

function extractAppId(task) {
  const parsed = parseProtocol(task?.jump_protocol);
  const stack = [parsed];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (node.appid && /^\d+$/.test(String(node.appid))) return String(node.appid);
    if (node.app_id && /^\d+$/.test(String(node.app_id))) return String(node.app_id);
    if (node.url) {
      const urlMatch = tools.toText(node.url).match(/[?&]appid=(\d+)/i);
      if (urlMatch) return urlMatch[1];
    }
    const values = Array.isArray(node) ? node : Object.values(node);
    for (let index = values.length - 1; index >= 0; index -= 1) stack.push(values[index]);
  }
  return "";
}

function isOkPayload(payload) {
  return tools.toText(payload?.status) === OK_STATE;
}

function responseMessage(payload) {
  const status = tools.toText(payload?.status) || "缺失";
  const message = tools.toText(payload?.msg);
  return `status=${status}${message ? ` msg=${message}` : ""} body=${tools.responseBody(payload)}`;
}

function validateHome(payload) {
  if (!isOkPayload(payload)) throw new Error(`抽奖活动详情接口异常 ${responseMessage(payload)}`);
  const result = payload.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`抽奖活动详情接口缺少 result 对象 body=${tools.responseBody(payload)}`);
  }
  if (result.logined !== true) throw new Error(`抽奖活动请求未通过登录认证，请检查 Cookie body=${tools.responseBody(payload)}`);
  if (typeof result.joined !== "boolean") throw new Error(`抽奖活动详情 joined 字段格式异常 body=${tools.responseBody(payload)}`);
  for (const field of ["front_task", "task_list"]) {
    if (field === "front_task" && result.joined && result[field] === undefined) continue;
    if (!Array.isArray(result[field])) throw new Error(`抽奖活动详情 ${field} 字段格式异常 body=${tools.responseBody(payload)}`);
    if (result[field].some((task) => !task || typeof task !== "object" || Array.isArray(task) ||
      !/^[1-9]\d*$/.test(tools.toText(task.task_id)) || !tools.toText(task.task_key) ||
      (task.finished !== undefined && typeof task.finished !== "boolean"))) {
      throw new Error(`抽奖活动详情 ${field} 包含无效任务 body=${tools.responseBody(payload)}`);
    }
  }
  return result;
}

function getTaskIdentity(task) {
  return tools.toText(task?.task_id);
}

function getTasks(payload) {
  const result = validateHome(payload);
  const tasks = new Map();
  for (const task of [...(result.front_task || []), ...result.task_list]) {
    const identity = getTaskIdentity(task);
    const merged = { ...tasks.get(identity), ...task };
    tools.rememberResponseBody(merged, tools.responseBody(payload));
    tasks.set(identity, merged);
  }
  return Array.from(tasks.values());
}

function isRunnableTask(task) {
  const taskKey = tools.toText(task?.task_key);
  return taskKey === "share_act" || FOLLOW_TASK_KEYS.has(taskKey);
}

function getPendingRunnableTasks(payload) {
  return getTasks(payload).filter((task) => !task.finished && isRunnableTask(task));
}

function getPendingUnsupportedTasks(payload) {
  return getTasks(payload).filter((task) => !task.finished && !isRunnableTask(task));
}

function getPendingPreJoinTasks(payload) {
  const result = validateHome(payload);
  if (result.joined) return [];
  const frontIds = new Set(result.front_task.map(getTaskIdentity));
  return getTasks(payload).filter((task) => frontIds.has(getTaskIdentity(task)) && !task.finished);
}

function isActivityDone(payload) {
  const result = payload?.result || {};
  const tasks = getTasks(payload);
  return Boolean(result.joined) && (tasks.length === 0 || tasks.every((task) => task.finished));
}

function printHome(account, payload) {
  const result = payload?.result || {};
  account.log(`奖品: ${tools.toText(result.award_info?.award_name) || "未知"}`);
  account.log(`help_code=${result.help_code || "-"} my_ticket=${result.my_ticket ?? 0} joined=${result.joined}`);
  const tasks = getTasks(payload);
  if (!tasks.length) {
    account.log("未发现盒券任务");
    return;
  }
  account.log("盒券任务:");
  for (const task of tasks) account.log(`- ${getTaskSummary(task)}`, { noPrefix: true });
}

function printTicketList(account, payload) {
  const result = payload?.result || {};
  account.log(`盒券合计: ${result.total_ticket ?? 0}, 空白券: ${result.blank_ticket_count ?? 0}`);
  const list = Array.isArray(result.list) ? result.list : [];
  for (const item of list) {
    account.log(
      `${item.gain_time || "-"} +${item.ticket_count || 0} ${tools.toText(item.ticket_source)} ${item.serial_number || ""}`,
    );
  }
}

function extractFollowUserId(task) {
  const protocol = parseProtocol(task?.jump_protocol);
  if (protocol?.protocol_type !== "openUser") return "";
  const userId = tools.toText(protocol.user_id);
  return /^[1-9]\d*$/.test(userId) ? userId : "";
}

async function executeFollowTask(account, webClient, awardId, task, isFrontTask = false) {
  const followingId = extractFollowUserId(task);
  if (!followingId || followingId === tools.toText(account.heyboxId)) {
    account.log(`${task.task_name}: 无法从 openUser 协议取得有效关注目标 body=${tools.responseBody(task)}`);
    return false;
  }
  // 前置点击会先上报，再进入账号页；普通关注按钮只建立关注关系。
  if (isFrontTask) {
    const reportPayload = await reportRollTask(webClient, task);
    if (!isOkPayload(reportPayload)) {
      account.log(`${task.task_name}: 前置上报失败 ${responseMessage(reportPayload)}`);
      return false;
    }
  }
  const followPayload = await webClient.postJson(PATH_FOLLOW_USER, {
    query: { heybox_id: account.heyboxId, _time: Math.floor(Date.now() / 1000) },
    body: { following_id: followingId },
    retries: 0,
  });
  if (!isOkPayload(followPayload)) {
    account.log(`${task.task_name}: 关注请求失败 ${responseMessage(followPayload)}`);
    return false;
  }
  let latestHome;
  for (let index = 0; index < CONFIG.followVerifyMaxTimes; index += 1) {
    await tools.sleep(CONFIG.followVerifyIntervalMs);
    const home = await fetchHome(webClient, awardId);
    latestHome = home;
    const latest = getTasks(home).find((item) => getTaskIdentity(item) === getTaskIdentity(task));
    if (latest?.finished === true) {
      account.log(`${task.task_name}: 已关注，活动任务已完成`);
      return true;
    }
  }
  account.log(`${task.task_name}: 关注接口成功，但活动回查仍未确认完成 body=${tools.responseBody(latestHome)}`);
  return false;
}

function extractInjectInfo(task) {
  const parsed = parseProtocol(task?.jump_protocol);
  const key = tools.toText(parsed?.key);
  if (parsed?.protocol_type !== "openInjectJSWindow" || !key ||
    (parsed.params !== undefined && (!parsed.params || typeof parsed.params !== "object" || Array.isArray(parsed.params)))) {
    throw new Error(`浏览任务缺少有效的 openInjectJSWindow key/params 协议 body=${tools.responseBody(task)}`);
  }
  return { key, params: parsed.params || {} };
}

async function fetchInjectJsData(appClient, injectInfo) {
  return appClient.postJson(PATH_GAME_JSDATA, { key: injectInfo.key }, injectInfo.params, { retries: 0 });
}

async function executeInjectJsTask(account, webClient, appClient, awardId, task) {
  const injectInfo = extractInjectInfo(task);
  const reportPayload = await reportRollTask(webClient, task);
  if (!isOkPayload(reportPayload)) {
    account.log(`${task.task_name}: 前置上报失败 ${responseMessage(reportPayload)}`);
    return false;
  }

  const jsPayload = await fetchInjectJsData(appClient, injectInfo);
  const targetUrl = tools.toText(jsPayload?.result?.url);
  account.log(`${task.task_name}: 注入配置 ${isOkPayload(jsPayload) ? "ok" : "失败"}${targetUrl ? ` ${targetUrl}` : ""}`);
  if (!isOkPayload(jsPayload)) {
    account.log(`${task.task_name}: 注入配置接口失败 ${responseMessage(jsPayload)}`);
    return false;
  }

  account.log(`${task.task_name}: 模拟停留${CONFIG.injectViewSeconds}秒后回查`);
  await tools.sleep(CONFIG.injectViewSeconds * 1000);
  let latestHome;
  for (let index = 0; index < CONFIG.injectVerifyMaxTimes; index += 1) {
    const home = await fetchHome(webClient, awardId);
    latestHome = home;
    const latest = getTasks(home).find((item) => String(item.task_id) === String(task.task_id));
    if (latest?.finished) return true;
    if (index < CONFIG.injectVerifyMaxTimes - 1) await tools.sleep(CONFIG.injectVerifyIntervalMs);
  }
  account.log(`${task.task_name}: 回查仍未完成 body=${tools.responseBody(latestHome)}`);
  return false;
}

async function skipWishlistTask(account, task) {
  const appid = extractAppId(task);
  account.log(`${task.task_name}: Steam心愿单/关注任务需Steam登录，跳过${appid ? ` appid=${appid}` : ""} body=${tools.responseBody(task)}`);
  return false;
}

async function executePreJoinTask(account, webClient, appClient, awardId, task) {
  const taskKey = tools.toText(task.task_key);
  try {
    if (WISHLIST_TASK_KEYS.has(taskKey)) return await skipWishlistTask(account, task);
    if (FOLLOW_TASK_KEYS.has(taskKey)) {
      return await executeFollowTask(account, webClient, awardId, task, true);
    }
    if (taskKey === "inject_js_for_count") {
      return await executeInjectJsTask(account, webClient, appClient, awardId, task);
    }
    if (taskKey === "share_act") {
      const reportPayload = await reportRollTask(webClient, task);
      if (!isOkPayload(reportPayload)) {
        account.log(`${task.task_name}: 前置上报失败 ${responseMessage(reportPayload)}`);
        return false;
      }
      return await executeShareTask(account, webClient, appClient, awardId, task);
    }
    account.log(`${task.task_name}: 暂不支持自动完成 task_key=${taskKey} body=${tools.responseBody(task)}`);
    return false;
  } catch (error) {
    account.log(`${task.task_name}: 执行失败 ${error.message}`);
    return false;
  }
}

async function runPreJoinTasks(account, webClient, appClient, awardId, home) {
  if (!CONFIG.autoPreTasks || home?.result?.joined) return home;
  let current = home;
  for (const task of getPendingPreJoinTasks(current)) {
    if (!getPendingPreJoinTasks(current).some((item) => getTaskIdentity(item) === getTaskIdentity(task))) continue;
    await executePreJoinTask(account, webClient, appClient, awardId, task);
    await tools.sleep(1000);
    current = await fetchHome(webClient, awardId);
    const latest = getTasks(current).find((item) => String(item.task_id) === String(task.task_id));
    if (latest?.finished && !FOLLOW_TASK_KEYS.has(task.task_key)) account.log(`${latest.task_name}: 已完成`);
  }
  return current;
}

async function runAward(account, webClient, appClient, award) {
  const awardId = award.awardId;
  account.log(`抽奖活动 award_id=${awardId} ${award.awardName || ""}`.trim());
  let home = await fetchHome(webClient, awardId);
  if (isActivityDone(home)) {
    account.log("活动已完成，跳过");
    if (CONFIG.printTickets) {
      const tickets = await fetchTicketList(webClient, account, awardId);
      printTicketList(account, tickets);
    }
    return { skipped: true, done: true, failedCount: 0 };
  }

  home = await runPreJoinTasks(account, webClient, appClient, awardId, home);

  if (CONFIG.autoJoin && !home?.result?.joined) {
    const blockers = getPendingPreJoinTasks(home);
    if (blockers.length) {
      account.log(`前置参与任务未完成，跳过参与抽奖: ${blockers.map((task) => task.task_key || task.task_id).join(", ")} body=${tools.responseBody(home)}`);
    } else {
      const joinPayload = await joinRollRoom(account, appClient, awardId);
      if (!isOkPayload(joinPayload)) {
        throw new Error(`参与抽奖失败 ${responseMessage(joinPayload)}`);
      }
      await tools.sleep(800);
      home = await fetchHome(webClient, awardId);
      if (!home.result.joined) throw new Error(`参与抽奖接口成功，但活动回查仍未确认参与 body=${tools.responseBody(home)}`);
      account.log("参与抽奖: 已参与");
    }
  }

  if (CONFIG.autoFollow && home.result.joined) {
    for (const task of getPendingRunnableTasks(home).filter((item) => FOLLOW_TASK_KEYS.has(item.task_key))) {
      if (!getPendingRunnableTasks(home).some((item) => getTaskIdentity(item) === getTaskIdentity(task))) continue;
      try {
        await executeFollowTask(account, webClient, awardId, task);
      } catch (error) {
        account.log(`${task.task_name}: 执行关注失败 ${error.message}`);
      }
      home = await fetchHome(webClient, awardId);
    }
  }

  if (CONFIG.autoShare && home.result.joined) {
    for (const task of getPendingRunnableTasks(home).filter((item) => item.task_key === "share_act")) {
      if (!getPendingRunnableTasks(home).some((item) => getTaskIdentity(item) === getTaskIdentity(task))) continue;
      try {
        await executeShareTask(account, webClient, appClient, awardId, task);
      } catch (error) {
        account.log(`${task.task_name || "分享活动"}: 执行分享失败 ${error.message}`);
      }
      home = await fetchHome(webClient, awardId);
    }
  }

  printHome(account, home);
  const unsupported = getPendingUnsupportedTasks(home);
  if (unsupported.length) {
    account.log(`未自动处理任务: ${unsupported.map((task) => task.task_key || task.task_id).join(", ")}`);
  }
  if (CONFIG.printTickets) {
    const tickets = await fetchTicketList(webClient, account, awardId);
    printTicketList(account, tickets);
  }
  const pendingTasks = home.result.joined ? getPendingRunnableTasks(home) : getPendingPreJoinTasks(home);
  const failedCount = pendingTasks.length;
  return { skipped: false, done: isActivityDone(home), unsupportedCount: unsupported.length, failedCount };
}

async function runAccount(account, awards) {
  const webClient = new HeyboxWebClient(account);
  const appClient = new HeyboxAppClient(account);
  let runCount = 0;
  let skipCount = 0;
  let doneCount = 0;

  for (const award of awards) {
    try {
      const result = await runAward(account, webClient, appClient, award);
      if (result.skipped) skipCount += 1;
      else runCount += 1;
      if (result.done) doneCount += 1;
      if (result.failedCount) process.exitCode = 1;
      await tools.sleep(500);
    } catch (error) {
      account.log(`award_id=${award.awardId} 处理失败: ${error.message}`);
      process.exitCode = 1;
    }
  }

  account.log(
    `抽奖活动处理完成: 跑=${runCount}, 跳过=${skipCount}, 当前完成=${doneCount}/${awards.length}`,
    { notify: true },
  );
}

async function run() {
  if (!await $.read_env(HeyboxAccount, DATA_NAME)) return;
  const discoveryClient = new HeyboxWebClient($.userList[0]);
  const awards = await discoverAwardIds(discoveryClient);
  if (!awards.length) {
    $.log("未发现当前进行中的抽奖活动");
    $.notifyStr.push("未发现当前进行中的抽奖活动");
    return;
  }
  $.notifyStr.push(`发现进行中抽奖活动${awards.length}个`);
  $.log(`发现进行中抽奖活动: ${awards.length} 个`);
  for (const award of awards) {
    $.log(`- award_id=${award.awardId} ${award.awardName || ""} ${award.statusMsg || ""}`.trim());
  }
  for (const account of $.userList) {
    try {
      await runAccount(account, awards);
    } catch (error) {
      account.log(`抽奖盒券任务失败: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

exports.run = run;

if (require.main === module) $.start(exports);
