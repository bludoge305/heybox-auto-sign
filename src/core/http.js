const got = require("got");
const tools = require("./tools");

class HttpClient {
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || 15000;
    this.defaultHeaders = options.headers || {};
    this.defaultRetries = Number.isInteger(options.retries) ? options.retries : 0;
  }

  isRetryable(error) {
    const code = error && error.code;
    const message = tools.toText(error && error.message);
    return (
      error && error.name === "TimeoutError" ||
      ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ECONNABORTED"].includes(code) ||
      message.includes("socket hang up")
    );
  }

  parseBody(text, url) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      const error = new Error(`JSON解析失败 ${url}\nbody=${text}`);
      error.rawbody = text;
      throw error;
    }
    if (payload === null || typeof payload !== "object") {
      const error = new Error(`JSON响应必须为对象或数组 ${url}\nbody=${text}`);
      error.rawbody = text;
      throw error;
    }
    return tools.rememberResponseBody(payload, text);
  }

  async request(options) {
    const method = (options.method || "GET").toUpperCase();
    const retries = Number.isInteger(options.retries)
      ? options.retries
      : (["GET", "HEAD", "OPTIONS"].includes(method) ? this.defaultRetries : 0);
    const headers = { ...this.defaultHeaders, ...(options.headers || {}) };
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const body = options.body !== undefined && typeof options.body !== "string"
      ? JSON.stringify(options.body)
      : options.body;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await got(options.url, {
          method,
          headers,
          body,
          timeout: { request: timeoutMs },
          throwHttpErrors: false,
          retry: 0,
          decompress: true,
        });
        const rawbody = response.body || "";
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`HTTP错误 ${response.statusCode} ${options.url}\nbody=${rawbody}`);
          error.statusCode = response.statusCode;
          error.rawbody = rawbody;
          throw error;
        }
        return {
          statusCode: response.statusCode,
          headers: response.headers,
          rawbody,
          result: options.parseJson === false ? rawbody : this.parseBody(rawbody, options.url),
        };
      } catch (error) {
        if (error.response?.body !== undefined && error.rawbody === undefined) {
          error.rawbody = String(error.response.body);
          error.message += `\nbody=${error.rawbody}`;
        }
        if (attempt >= retries || !this.isRetryable(error)) throw error;
        await tools.sleep(500 * (attempt + 1));
      }
    }
    throw new Error("request failed");
  }

  get(options) {
    return this.request({ ...(typeof options === "string" ? { url: options } : options), method: "GET" });
  }

  post(options) {
    return this.request({ ...(typeof options === "string" ? { url: options } : options), method: "POST" });
  }
}

module.exports = HttpClient;
