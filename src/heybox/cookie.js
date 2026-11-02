const IDENTITY_COOKIE_KEYS = new Set(["pkey", "x_xhh_tokenid", "x_pkey", "x_heybox_id"]);
const APP_DEVICE_KEYS = new Set(["imei", "device_info", "os_version", "dw", "channel"]);

function pickCookie(cookie, key) {
  return parseCookieMap(cookie).get(key) || "";
}

function parseCookieMap(cookie) {
  if (cookie !== undefined && cookie !== null && typeof cookie !== "string") {
    throw new Error("cookie必须为字符串");
  }
  if (/[\x00-\x1f\x7f]/.test(cookie || "")) throw new Error("cookie含有非法控制字符");
  const map = new Map();
  for (const raw of String(cookie || "").split(";")) {
    const item = raw.trim();
    if (!item) continue;
    const pos = item.indexOf("=");
    if (pos <= 0) throw new Error("cookie字段格式错误，应为name=value");
    const key = item.slice(0, pos).trim();
    const value = item.slice(pos + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) throw new Error("cookie字段名格式错误");
    // 同名身份字段会让App和Web请求使用不同账号，不能静默选择其中一个。
    if ((IDENTITY_COOKIE_KEYS.has(key) || APP_DEVICE_KEYS.has(key)) && map.has(key)) {
      throw new Error(`cookie包含重复字段${key}`);
    }
    map.set(key, value);
  }
  return map;
}

function serializeCookie(map) {
  return Array.from(map.entries())
    .filter(([key, value]) => key && value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
}

function decodePkeyToUserId(cookie) {
  const pkey = pickCookie(cookie, "pkey");
  if (!pkey) return "";

  let encoded;
  try {
    encoded = decodeURIComponent(pkey);
  } catch {
    return "";
  }

  const compact = encoded.replace(/_+$/, "") || encoded;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return "";
  if (compact.replace(/=+$/, "").length % 4 === 1) return "";
  const padded = compact + "=".repeat((4 - (compact.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");

  try {
    const plain = Buffer.from(base64, "base64").toString("utf8");
    const match = plain.match(/_(\d{5,})/);
    return match && BigInt(match[1]) > 0n ? match[1] : "";
  } catch {
    return "";
  }
}

function buildAppCookie(cookie) {
  const cookieMap = parseCookieMap(cookie);
  const pkey = cookieMap.get("pkey");
  const tokenId = cookieMap.get("x_xhh_tokenid");
  if (!pkey) throw new Error("cookie缺少pkey");
  if (!tokenId) throw new Error("cookie缺少x_xhh_tokenid");
  return `pkey=${pkey};x_xhh_tokenid=${tokenId}`;
}

function buildWebCookie(cookie, heyboxId) {
  const cookieMap = parseCookieMap(cookie);
  const pkey = cookieMap.get("pkey");
  const tokenId = cookieMap.get("x_xhh_tokenid");
  if (!pkey) throw new Error("cookie缺少pkey");
  if (!tokenId) throw new Error("cookie缺少x_xhh_tokenid");
  const parsedHeyboxId = decodePkeyToUserId(cookie);
  if (!parsedHeyboxId) throw new Error("无法从pkey解析heybox_id");
  if (heyboxId !== undefined && String(heyboxId) !== parsedHeyboxId) {
    throw new Error("cookie账号ID与pkey解析结果不一致");
  }
  // Web身份使用当前App的pkey和账号ID。
  cookieMap.set("x_pkey", pkey);
  cookieMap.set("x_heybox_id", parsedHeyboxId);
  for (const key of APP_DEVICE_KEYS) cookieMap.delete(key);
  return serializeCookie(cookieMap);
}

module.exports = {
  pickCookie,
  parseCookieMap,
  serializeCookie,
  decodePkeyToUserId,
  APP_DEVICE_KEYS,
  buildAppCookie,
  buildWebCookie,
};
