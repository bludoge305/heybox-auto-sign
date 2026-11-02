const { BasicAccount } = require("../core");
const { APP_PROFILE } = require("./constants");
const {
  buildAppCookie,
  buildWebCookie,
  decodePkeyToUserId,
  parseCookieMap,
} = require("./cookie");

class HeyboxAccount extends BasicAccount {
  constructor(rawData) {
    super(rawData);
    const heyboxId = decodePkeyToUserId(rawData);
    if (!heyboxId) throw new Error("无法从pkey解析heybox_id");
    this.heyboxId = heyboxId;
    this.name = heyboxId;
    const fields = parseCookieMap(rawData);
    this.imei = fields.get("imei") || "";
    this.deviceInfo = fields.get("device_info") || "";
    this.appProfile = {
      ...APP_PROFILE,
      device_info: this.deviceInfo,
      os_version: fields.get("os_version") || "",
      dw: fields.get("dw") || "",
      channel: fields.get("channel") || undefined,
    };
    this.appCookie = buildAppCookie(rawData);
    this.appClientCookie = `${this.appCookie};x_pkey=${fields.get("pkey")};x_heybox_id=${heyboxId}`;
    this.webCookie = buildWebCookie(rawData, heyboxId);
  }
}

module.exports = {
  HeyboxAccount,
};
