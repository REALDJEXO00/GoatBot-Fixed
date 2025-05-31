"use strict";

const utils = require("./utils");
const log = require("npmlog");
const fs = require("fs");

let checkVerified = null;

const defaultLogRecordSize = 100;
log.maxRecordSize = defaultLogRecordSize;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function delayRandom() {
  const ms = 1000 + Math.floor(Math.random() * 2000); // 1-3 সেকেন্ড random delay
  return delay(ms);
}

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15",
  "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.5005.99 Mobile Safari/537.36"
];

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function setOptions(globalOptions, options) {
  Object.keys(options).map(function (key) {
    switch (key) {
      case 'online':
        globalOptions.online = Boolean(options.online);
        break;
      case 'logLevel':
        log.level = options.logLevel;
        globalOptions.logLevel = options.logLevel;
        break;
      case 'logRecordSize':
        log.maxRecordSize = options.logRecordSize;
        globalOptions.logRecordSize = options.logRecordSize;
        break;
      case 'selfListen':
        globalOptions.selfListen = Boolean(options.selfListen);
        break;
      case 'selfListenEvent':
        globalOptions.selfListenEvent = options.selfListenEvent;
        break;
      case 'listenEvents':
        globalOptions.listenEvents = Boolean(options.listenEvents);
        break;
      case 'pageID':
        globalOptions.pageID = options.pageID.toString();
        break;
      case 'updatePresence':
        globalOptions.updatePresence = Boolean(options.updatePresence);
        break;
      case 'forceLogin':
        globalOptions.forceLogin = Boolean(options.forceLogin);
        break;
      case 'userAgent':
        if (typeof options.userAgent === "string" && options.userAgent.length > 10) {
          globalOptions.userAgent = options.userAgent;
        }
        break;
      case 'autoMarkDelivery':
        globalOptions.autoMarkDelivery = Boolean(options.autoMarkDelivery);
        break;
      case 'autoMarkRead':
        globalOptions.autoMarkRead = Boolean(options.autoMarkRead);
        break;
      case 'listenTyping':
        globalOptions.listenTyping = Boolean(options.listenTyping);
        break;
      case 'proxy':
        if (typeof options.proxy !== "string" || !options.proxy.match(/^https?:\/\/.+:\d+$/)) {
          // Invalid proxy format, remove and unset
          delete globalOptions.proxy;
          utils.setProxy();
          log.warn("setOptions", "Invalid or no proxy provided, proxy disabled");
        } else {
          globalOptions.proxy = options.proxy;
          utils.setProxy(globalOptions.proxy);
          log.info("setOptions", `Proxy enabled: ${globalOptions.proxy}`);
        }
        break;
      case 'autoReconnect':
        globalOptions.autoReconnect = Boolean(options.autoReconnect);
        break;
      case 'emitReady':
        globalOptions.emitReady = Boolean(options.emitReady);
        break;
      default:
        log.warn("setOptions", "Unrecognized option given to setOptions: " + key);
        break;
    }
  });
}

function buildAPI(globalOptions, html, jar) {
  const maybeCookie = jar.getCookies("https://www.facebook.com").filter(val => val.cookieString().split("=")[0] === "c_user");
  const objCookie = jar.getCookies("https://www.facebook.com").reduce((obj, val) => {
    obj[val.cookieString().split("=")[0]] = val.cookieString().split("=")[1];
    return obj;
  }, {});

  if (maybeCookie.length === 0) {
    throw { error: "Error retrieving userID. Possibly blocked by Facebook." };
  }

  const userID = maybeCookie[0].cookieString().split("=")[1].toString();
  const i_userID = objCookie.i_user || null;
  log.info("login", `Logged in as ${userID}`);

  try {
    clearInterval(checkVerified);
  } catch (_) {}

  const clientID = (Math.random() * 2147483648 | 0).toString(16);

  let mqttEndpoint, region, fb_dtsg;
  try {
    const endpointMatch = html.match(/"endpoint":"([^\"]+)"/);
    if (endpointMatch) {
      mqttEndpoint = endpointMatch[1].replace(/\\\//g, '/');
      const url = new URL(mqttEndpoint);
      region = url.searchParams.get('region')?.toUpperCase() || "PRN";
    }
    log.info('login', `Server region: ${region}`);
  } catch (e) {
    log.warn('login', 'No MQTT endpoint found.');
  }

  const tokenMatch = html.match(/DTSGInitialData.*?token":"(.*?)"/);
  if (tokenMatch) {
    fb_dtsg = tokenMatch[1];
  }

  const ctx = {
    userID, i_userID, jar, clientID, globalOptions, loggedIn: true,
    access_token: 'NONE', clientMutationId: 0, mqttClient: undefined,
    mqttEndpoint, region, fb_dtsg, wsReqNumber: 0, wsTaskNumber: 0,
    reqCallbacks: {}, firstListen: true,

    lastPresenceUpdate: 0 // For presence throttle
  };

  const api = {
    setOptions: setOptions.bind(null, globalOptions),
    getAppState: () => utils.getAppState(jar)
  };

  const defaultFuncs = utils.makeDefaults(html, i_userID || userID, ctx);
  fs.readdirSync(__dirname + '/src/').filter(v => v.endsWith('.js')).map(v => {
    api[v.replace('.js', '')] = require('./src/' + v)(defaultFuncs, api, ctx);
  });
  api.listen = api.listenMqtt;

  // Add presence update with throttle (max 1 per minute)
  api.updatePresenceThrottled = (presence) => {
    const now = Date.now();
    if (now - ctx.lastPresenceUpdate > 60000) { // 1 মিনিট থ্রোটল
      if (typeof api.updatePresence === 'function') {
        api.updatePresence(presence);
        ctx.lastPresenceUpdate = now;
        log.info('presence', `Presence updated to: ${presence}`);
      }
    } else {
      log.info('presence', 'Presence update throttled');
    }
  };

  return [ctx, defaultFuncs, api];
}

// Retry wrapper with exponential backoff for safer API calls
async function safeApiCall(apiFunc, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await apiFunc();
    } catch (err) {
      const wait = 1000 * 2 ** i + Math.floor(Math.random() * 500);
      log.warn('safeApiCall', `Attempt ${i + 1} failed, retrying in ${wait}ms...`);
      await delay(wait);
    }
  }
  throw new Error("All retry attempts failed.");
}

function loginHelper(appState, email, password, globalOptions, callback, prCallback) {
  const jar = utils.getJar();

  if (!appState) {
    throw { error: "No appState provided. Email/password login is unsupported to prevent ban." };
  }

  // Accept appState as string or array
  if (typeof appState === 'string') {
    const arrayAppState = [];
    appState.split(';').forEach(c => {
      const [key, value] = c.split('=');
      if (key && value) {
        arrayAppState.push({
          key: key.trim(),
          value: value.trim(),
          domain: "facebook.com",
          path: "/",
          expires: Date.now() + 1000 * 60 * 60 * 24 * 365 * 2 // 2 বছর মেয়াদ
        });
      }
    });
    appState = arrayAppState;
  }

  appState.forEach(c => {
    const cookieString = `${c.key}=${c.value}; domain=${c.domain}; path=${c.path}; expires=${new Date(c.expires).toUTCString()}`;
    jar.setCookie(cookieString, `https://${c.domain}`);
  });

  let mainPromise = utils.get('https://www.facebook.com/', jar, null, globalOptions, { noRef: true })
    .then(async res => {
      await delayRandom(); // Random delay 1-3 সেকেন্ড
      return utils.saveCookies(jar)(res);
    });

  let ctx, _defaultFuncs, api;

  mainPromise = mainPromise
    .then(res => {
      const html = res.body;
      [ctx, _defaultFuncs, api] = buildAPI(globalOptions, html, jar);
      return res;
    })
    .then(() => {
      if (globalOptions.pageID) {
        return utils.get(`https://www.facebook.com/${ctx.globalOptions.pageID}/messages/`, ctx.jar, null, globalOptions);
      }
    })
    .then(() => callback(null, api))
    .catch(e => {
      log.error("login", e.error || e);
      callback(e);
    });
}

function login(loginData, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  const globalOptions = {
    selfListen: false,
    selfListenEvent: false,
    listenEvents: false,
    listenTyping: false,
    updatePresence: false,
    forceLogin: false,
    autoMarkDelivery: true,
    autoMarkRead: false,
    autoReconnect: true,
    logRecordSize: defaultLogRecordSize,
    online: true,
    emitReady: false,
    userAgent: getRandomUserAgent()
  };

  setOptions(globalOptions, options);

  if (typeof callback !== 'function') {
    return new Promise((resolve, reject) => {
      login(loginData, globalOptions, (err, api) => {
        if (err) return reject(err);
        resolve(api);
      });
    });
  }

  if (typeof loginData === 'string' || Array.isArray(loginData)) {
    // cookie string or array login
    loginHelper(loginData, null, null, globalOptions, callback);
  } else if (typeof loginData === 'object' && loginData !== null) {
    if (!loginData.appState && !loginData.cookies) {
      return callback({ error: "No appState or cookies provided. Email/password login is unsupported to prevent ban." });
    }

    const appState = loginData.appState || loginData.cookies;

    loginHelper(appState, loginData.email, loginData.password, globalOptions, callback);
  } else {
    callback({ error: "Invalid login data provided." });
  }
}

module.exports = login;
