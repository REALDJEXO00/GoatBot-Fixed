"use strict";

const fs = require("fs");
const path = require("path");
const utils = require("./utils");
const log = require("npmlog");

let checkVerified = null;
const defaultLogRecordSize = 100;
log.maxRecordSize = defaultLogRecordSize;

function setOptions(globalOptions, options = {}) {
  Object.keys(options).forEach(function (key) {
    switch (key) {
      case 'logLevel': log.level = options.logLevel; globalOptions.logLevel = options.logLevel; break;
      case 'userAgent': globalOptions.userAgent = options.userAgent; break;
      case 'selfListen': globalOptions.selfListen = Boolean(options.selfListen); break;
      case 'listenEvents': globalOptions.listenEvents = Boolean(options.listenEvents); break;
      case 'listenTyping': globalOptions.listenTyping = Boolean(options.listenTyping); break;
      default: log.warn("setOptions", `Unknown option '${key}' ignored.`); break;
    }
  });
}

function buildAPI(globalOptions, html, jar) {
  const cookies = jar.getCookies("https://www.facebook.com");
  const c_user = cookies.find(c => c.cookieString().startsWith("c_user="));
  const userID = c_user ? c_user.cookieString().split("=")[1] : null;

  if (!userID) throw { error: "Login failed: No user ID found." };
  log.info("login", `Logged in as ${userID}`);

  try { clearInterval(checkVerified); } catch (e) { }

  const ctx = {
    userID,
    jar,
    globalOptions,
    clientID: (Math.random() * 2147483648 | 0).toString(16),
    loggedIn: true,
    access_token: 'NONE',
    clientMutationId: 0,
    mqttClient: undefined,
    lastSeqId: null,
    syncToken: undefined,
    mqttEndpoint: null,
    region: null,
    firstListen: true,
  };

  const api = {
    setOptions: setOptions.bind(null, globalOptions),
    getAppState: () => utils.getAppState(jar)
  };

  const apiFuncNames = [
    "sendMessage", "listenMqtt", "markAsRead", "getUserInfo", "getThreadList", "getThreadInfo",
    "setMessageReaction", "unsendMessage", "removeUserFromGroup", "logout", "uploadAttachment",
  ];

  const defaultFuncs = utils.makeDefaults(html, userID, ctx);

  apiFuncNames.forEach(name => {
    api[name] = require("./src/" + name)(defaultFuncs, api, ctx);
  });

  api.listen = api.listenMqtt;
  return [ctx, defaultFuncs, api];
}

function loginHelper(appState, globalOptions, callback) {
  const jar = utils.getJar();

  appState.forEach(c => {
    const str = `${c.key}=${c.value}; domain=${c.domain}; path=${c.path}; expires=${c.expires};`;
    jar.setCookie(str, "https://" + c.domain);
  });

  utils.get("https://www.facebook.com/", jar, null, globalOptions, { noRef: true })
    .then(utils.saveCookies(jar))
    .then(res => {
      const html = res.body;
      const [ctx, defaultFuncs, api] = buildAPI(globalOptions, html, jar);
      log.info("login", "Login completed.");
      callback(null, api);
    })
    .catch(err => {
      log.error("login", err);
      callback(err);
    });
}

function login(options = {}, callback) {
  const globalOptions = {
    selfListen: false,
    listenEvents: false,
    listenTyping: false,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36",
    logRecordSize: defaultLogRecordSize
  };

  setOptions(globalOptions, options);

  if (typeof callback !== "function") {
    return new Promise((resolve, reject) => {
      const cb = (err, api) => err ? reject(err) : resolve(api);
      loginCore(globalOptions, cb);
    });
  } else {
    loginCore(globalOptions, callback);
  }
}

function loginCore(globalOptions, callback) {
  const filePath = path.join(__dirname, "account.txt");

  if (!fs.existsSync(filePath)) {
    return callback({ error: "account.txt not found." });
  }

  let appState;
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    appState = JSON.parse(data);
  } catch (err) {
    return callback({ error: "Failed to parse account.txt. Must be valid JSON format." });
  }

  if (!Array.isArray(appState)) {
    return callback({ error: "account.txt must be a JSON array of cookies." });
  }

  loginHelper(appState, globalOptions, callback);
}

module.exports = login;
