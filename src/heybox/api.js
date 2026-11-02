const { HttpClient, tools } = require("../core");
const {
  API_BASE,
  APP_REFERER,
  APP_UA,
  DATA_BASE,
  HKEY_API,
  WEB_PROFILE,
  WEB_UA,
  WEB_VERSION,
  OK_STATE,
} = require("./constants");
const {
  buildQueryString,
  makeNonce,
  makeWebSignature,
} = require("./signature");

const APP_SIGNED_KEYS = new Set([
  "heybox_id", "imei", "device_info", "nonce", "hkey", "_rnd", "_time",
  "os_type", "x_os_type", "x_client_type", "os_version", "version", "build",
  "dw", "channel", "x_app", "time_zone",
]);

function signatureError(message, payload) {
  return new Error(`hkey接口${message}\nbody=${tools.responseBody(payload)}`);
}

function validateSignaturePayload(payload, timeSec, report = false) {
  if (payload?.status !== OK_STATE) throw signatureError("请求失败", payload);
  const result = payload.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw signatureError("缺少result对象", payload);
  }
  if (!/^[0-9A-F]{1,8}$/.test(result.hkey || "")) throw signatureError("缺少有效hkey", payload);
  if (!/^\d+:([0-9A-F]{1,8})$/.test(result._rnd || "")) throw signatureError("缺少有效_rnd", payload);
  if (!/^\d+\.\d+\.\d+$/.test(result.version || "")) throw signatureError("缺少有效version", payload);
  if (!/^[1-9]\d*$/.test(result.build || "")) throw signatureError("缺少有效build", payload);
  if (result.time !== String(timeSec)) throw signatureError("返回时间与请求时间不一致", payload);
  if (report) {
    if (typeof result.data !== "string" || !result.data || typeof result.key !== "string" || !result.key ||
        !/^[0-9a-f]{64}$/.test(result.sid || "")) {
      throw signatureError("缺少有效data/key/sid", payload);
    }
  }
  return result;
}

class HeyboxAppClient extends HttpClient {
  constructor(account, options = {}) {
    super({ timeoutMs: options.timeoutMs || 15000, retries: options.retries ?? 0 });
    this.account = account;
    this.runtime = options.runtime || { version: "", build: "" };
  }

  signingInput(path, timeSec) {
    const profile = this.account.appProfile;
    for (const key of ["device_info", "os_version", "dw"]) {
      if (!tools.toText(profile?.[key])) throw new Error(`账号配置缺少App请求字段${key}`);
    }
    if (!/^[\x21-\x7e]+$/.test(this.account.imei)) throw new Error("账号配置缺少有效App请求字段imei");
    if (!/^[1-9]\d*$/.test(String(timeSec))) throw new Error("签名时间必须为正整数秒");
    return {
      path,
      time: String(timeSec),
      imei: this.account.imei,
      heybox_id: this.account.heyboxId,
      os_version: profile.os_version,
    };
  }

  appHeaders(extra = {}) {
    return {
      "User-Agent": APP_UA,
      Referer: APP_REFERER,
      Cookie: this.account.appCookie,
      Accept: "application/json",
      ...extra,
    };
  }

  async requestHkey(path, timeSec = Math.floor(Date.now() / 1000)) {
    const query = buildQueryString({
      mode: "request",
      ...this.signingInput(path, timeSec),
    });
    const response = await this.get({
      url: `${HKEY_API}?${query}`,
      headers: { "User-Agent": APP_UA, Accept: "application/json" },
    });
    return validateSignaturePayload(response.result, timeSec);
  }

  buildSignedQuery(path, hkeyResult, extraQuery = {}) {
    for (const key of Object.keys(extraQuery)) {
      if (APP_SIGNED_KEYS.has(key)) throw new Error(`${path}: 业务参数不能覆盖签名字段${key}`);
    }
    this.runtime.version = hkeyResult.version;
    this.runtime.build = hkeyResult.build;
    return {
      ...extraQuery,
      heybox_id: this.account.heyboxId,
      imei: this.account.imei,
      device_info: this.account.deviceInfo,
      nonce: makeNonce(),
      hkey: hkeyResult.hkey,
      _rnd: hkeyResult._rnd,
      ...this.account.appProfile,
      version: this.runtime.version,
      build: this.runtime.build,
      _time: String(hkeyResult.time),
    };
  }

  async getJson(path, extraQuery = {}, options = {}) {
    const timeSec = Math.floor(Date.now() / 1000);
    const hk = await this.requestHkey(path, timeSec);
    const query = buildQueryString(this.buildSignedQuery(path, hk, extraQuery));
    const response = await this.get({
      url: `${options.baseUrl || API_BASE}${path}?${query}`,
      headers: this.appHeaders(options.headers),
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    });
    return response.result;
  }

  async postJson(path, extraQuery = {}, bodyData = undefined, options = {}) {
    const timeSec = Math.floor(Date.now() / 1000);
    const hk = await this.requestHkey(path, timeSec);
    const query = buildQueryString(this.buildSignedQuery(path, hk, extraQuery));
    const body = bodyData === undefined ? undefined : buildQueryString(bodyData);
    const response = await this.post({
      url: `${options.baseUrl || API_BASE}${path}?${query}`,
      headers: this.appHeaders({
        ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(options.headers || {}),
      }),
      body,
      timeoutMs: options.timeoutMs,
      retries: options.retries ?? 0,
    });
    return response.result;
  }

  async postEncryptedForm(path, textPayload, extraQuery = {}, options = {}) {
    const timeSec = String(Math.floor(Date.now() / 1000));
    if (typeof textPayload !== "string") throw new Error("report数据必须为JSON字符串");
    if (extraQuery.time_ !== undefined) throw new Error("业务参数不能覆盖report时间time_");
    const hkeyResponse = await this.post({
      url: HKEY_API,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "report",
        text: textPayload,
        ...this.signingInput(path, timeSec),
      }),
    });
    const rp = validateSignaturePayload(hkeyResponse.result, timeSec, true);
    const query = buildQueryString(this.buildSignedQuery(path, rp, { ...extraQuery, time_: timeSec }));
    const body = buildQueryString({ data: rp.data, key: rp.key, sid: rp.sid });
    const response = await this.post({
      url: `${options.baseUrl || DATA_BASE}${path}?${query}`,
      headers: this.appHeaders({ "Content-Type": "application/x-www-form-urlencoded", ...(options.headers || {}) }),
      body,
      timeoutMs: options.timeoutMs,
      retries: options.retries ?? 0,
    });
    return response.result;
  }
}

class HeyboxWebClient extends HttpClient {
  constructor(account, options = {}) {
    super({ timeoutMs: options.timeoutMs || 15000, retries: Number.isInteger(options.retries) ? options.retries : 1 });
    this.account = account;
    this.version = options.version || WEB_VERSION;
    this.clientVersion = options.clientVersion || WEB_PROFILE.x_client_version;
  }

  headers(hasBody = false, extra = {}) {
    const headers = {
      "User-Agent": WEB_UA,
      Accept: "application/json, text/plain, */*",
      Origin: "https://web.xiaoheihe.cn",
      "X-Requested-With": "com.max.xiaoheihe",
      Referer: "https://web.xiaoheihe.cn/",
      Cookie: this.account.webCookie,
      ...extra,
    };
    if (hasBody) headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    return headers;
  }

  buildQuery(path, query = {}) {
    for (const key of ["hkey", "_rnd"]) {
      if (Object.hasOwn(query, key)) throw new Error(`${path}: 业务参数不能覆盖签名字段${key}`);
    }
    const timeSec = query._time === undefined ? Math.floor(Date.now() / 1000) : Number(query._time);
    if (!Number.isSafeInteger(timeSec) || timeSec <= 0) throw new Error(`${path}: 无效的签名时间`);
    const signature = query.nonce === undefined
      ? makeWebSignature(path, this.version, timeSec)
      : makeWebSignature(path, this.version, timeSec, query.nonce);
    return {
      ...WEB_PROFILE,
      x_client_version: this.clientVersion,
      ...query,
      ...signature,
      heybox_id: this.account.heyboxId,
    };
  }

  async getJson(path, options = {}) {
    const query = buildQueryString(this.buildQuery(path, options.query));
    const response = await this.get({
      url: `${options.baseUrl || API_BASE}${path}?${query}`,
      headers: this.headers(false, options.headers),
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    });
    return response.result;
  }

  async postJson(path, options = {}) {
    const query = buildQueryString(this.buildQuery(path, options.query));
    const body = options.body === undefined ? undefined : buildQueryString(options.body);
    const response = await this.post({
      url: `${options.baseUrl || API_BASE}${path}?${query}`,
      headers: this.headers(body !== undefined, options.headers),
      body,
      timeoutMs: options.timeoutMs,
      retries: options.retries ?? 0,
    });
    return response.result;
  }
}

module.exports = {
  HeyboxAppClient,
  HeyboxWebClient,
};
