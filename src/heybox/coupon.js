const { toText, responseBody } = require("../core/tools");

function couponResponseError(path, message, payload) {
  return new Error(`${path}: ${message} body=${responseBody(payload)}`);
}

function validateCouponResult(payload, path, options = {}) {
  const status = toText(payload?.status);
  if (status === "login") throw couponResponseError(path, "登录未通过，请检查heybox_ck", payload);
  if (status !== "ok") throw couponResponseError(path, `业务失败 status=${status || "缺失"}`, payload);
  const result = payload?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw couponResponseError(path, "券列表返回结构异常", payload);
  }
  if (options.requireSession) {
    if (result.success !== 1) throw couponResponseError(path, "券列表返回结果异常", payload);
    if (!Number.isSafeInteger(result.session) || result.session <= 0) {
      throw couponResponseError(path, "未取得已认证会话，当前响应仅提供券列表；请检查heybox_ck是否有效及实际发送", payload);
    }
  }
  return result;
}

function couponBusinessMessage(payload) {
  const status = toText(payload?.status);
  if (status === "login") return "登录未通过，请检查heybox_ck";
  const msg = toText(payload?.msg);
  const result = payload?.result;
  if (typeof result === "string") return result;
  if (status !== "ok") return msg || `业务失败 status=${status || "缺失"}`;
  if (result?.success === 1) return "success";
  if (result?.success === 2) return "pending";
  return toText(result?.error_msg) || msg || "领券接口未返回有效领取结果";
}

function couponResultMessage(payload) {
  const message = couponBusinessMessage(payload);
  if (payload?.status === "ok" && (payload?.result?.success === 1 || payload?.result?.success === 2)) return message;
  return `${message} body=${responseBody(payload)}`;
}

function isCouponLoginRequired(payload) {
  return payload?.status === "login" || /请登录|登录未通过|登录后|未登录|登录态/.test(couponBusinessMessage(payload));
}

module.exports = { validateCouponResult, couponBusinessMessage, couponResultMessage, isCouponLoginRequired, couponResponseError };
