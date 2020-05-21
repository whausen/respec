/**
 * Exports fetchAndWrite() method, allowing programmatic control of the
 * spec generator.
 *
 * For usage, see example a https://github.com/w3c/respec/pull/692
 */
/* jshint node: true, browser: false */
"use strict";
const os = require("os");
const puppeteer = require("puppeteer");
const colors = require("colors");
const { mkdtemp, writeFile } = require("fs").promises;
const path = require("path");
colors.setTheme({
  debug: "cyan",
  error: "red",
  warn: "yellow",
  info: "blue",
});

/**
 * Writes "data" to a particular outPath as UTF-8.
 * @private
 * @param  {String} outPath The relative or absolute path to write to.
 * @param  {String} data    The data to write.
 * @return {Promise}        Resolves when writing is done.
 */
async function writeTo(outPath, data) {
  let newFilePath = "";
  if (path.isAbsolute(outPath)) {
    newFilePath = outPath;
  } else {
    newFilePath = path.resolve(process.cwd(), outPath);
  }
  try {
    await writeFile(newFilePath, data, "utf-8");
  } catch (err) {
    console.error(err, err.stack);
    process.exit(1);
  }
}

/**
 * Fetches a ReSpec "src" URL, processes via NightmareJS and writes it to an
 * "out" path within a given "timeout".
 *
 * @public
 * @param  {String} src         A URL that is the ReSpec source.
 * @param  {String|null|""} out A path to write to. If null, goes to stdout.
 *                              If "", then don't write, just return value.
 * @param  {Number} timeout     Optional. Milliseconds before NightmareJS
 *                              should timeout.
 * @return {Promise}            Resolves with HTML when done writing.
 *                              Rejects on errors.
 */
async function fetchAndWrite(src, out, options = {}) {
  const {
    timeout = 300000,
    disableSandbox = false,
    debug = false,
    onError = () => {},
    onWarning = () => {},
    beforeWrite = () => {},
  } = options;
  const timer = createTimer(timeout);

  const userDataDir = await mkdtemp(`${os.tmpdir()}/respec2html-`);
  const args = disableSandbox ? ["--no-sandbox"] : undefined;
  const browser = await puppeteer.launch({
    userDataDir,
    args,
    devtools: debug,
  });
  try {
    const page = await browser.newPage();
    await page.exposeFunction("onRespecErrorOrWarning", e => {
      if (e.type === "respecerror") return onError(e.detail);
      if (e.type === "respecwarn") return onWarning(e.detail);
    });
    page.evaluateOnNewDocument(() => {
      for (const evName of ["respecwarn", "respecerror"]) {
        document.addEventListener(evName, e => {
          window.onRespecErrorOrWarning({ type: evName, detail: e.detail });
        });
      }
    });
    const url = new URL(src);
    const response = await page.goto(url, { timeout });
    if (
      !response.ok() &&
      response.status() /* workaround: 0 means ok for local files */
    ) {
      const warn = colors.warn(`📡 HTTP Error ${response.status()}:`);
      // don't show params, as they can contain the API key!
      const debugURL = `${url.origin}${url.pathname}`;
      const msg = `${warn} ${colors.debug(debugURL)}`;
      throw new Error(msg);
    }
    await checkIfReSpec(page);
    const html = await generateHTML(page, url, timer);
    await beforeWrite();
    switch (out) {
      case null:
        process.stdout.write(html);
        break;
      case "":
        break;
      default:
        await writeTo(out, html);
    }
    await page.close();
    return html;
  } finally {
    await browser.close();
  }
}

/**
 * @param {import("puppeteer").Page} page
 * @param {string} url
 * @param {ReturnType<typeof createTimer>} timer
 */
async function generateHTML(page, url, timer) {
  await page.waitForFunction(() => window.hasOwnProperty("respecVersion"));
  const version = await page.evaluate(getVersion);
  try {
    return await page.evaluate(evaluateHTML, version, timer);
  } catch (err) {
    const msg = `\n😭  Sorry, there was an error generating the HTML. Please report this issue!\n${colors.debug(
      `${
        `Specification: ${url}\n` +
        `ReSpec version: ${version.join(".")}\n` +
        "File a bug: https://github.com/w3c/respec/\n"
      }${err ? `Error: ${err.stack}\n` : ""}`
    )}`;
    throw new Error(msg);
  }
}

/**
 * @param {import("puppeteer").Page} page
 */
async function checkIfReSpec(page) {
  const isRespecDoc = await page.evaluate(isRespec);
  if (!isRespecDoc) {
    const msg = `${colors.warn(
      "🕵️‍♀️  That doesn't seem to be a ReSpec document. Please check manually:"
    )} ${colors.debug(page.url)}`;
    throw new Error(msg);
  }
  return isRespecDoc;
}

async function isRespec() {
  const query = "script[data-main*='profile-'], script[src*='respec']";
  if (document.head.querySelector(query)) {
    return true;
  }
  await new Promise(resolve => {
    document.onreadystatechange = () => {
      if (document.readyState === "complete") {
        resolve();
      }
    };
    document.onreadystatechange();
  });
  await new Promise(resolve => {
    setTimeout(resolve, 2000);
  });
  return Boolean(document.getElementById("respec-ui"));
}

/**
 * @param {number[]} version
 * @param {ReturnType<typeof createTimer>} timer
 */
async function evaluateHTML(version, timer) {
  await timeout(document.respecIsReady, timer.remaining);

  const [major, minor] = version;
  if (major < 20 || (major === 20 && minor < 10)) {
    console.warn(
      "👴🏽  Ye Olde ReSpec version detected! Please update to 20.10.0 or above. " +
        `Your version: ${window.respecVersion}.`
    );
    // Document references an older version of ReSpec that does not yet
    // have the "core/exporter" module. Try with the old "ui/save-html"
    // module.
    const { exportDocument } = await new Promise((resolve, reject) => {
      require(["ui/save-html"], resolve, err => {
        reject(new Error(err.message));
      });
    });
    return exportDocument("html", "text/html");
  } else {
    const { rsDocToDataURL } = await new Promise((resolve, reject) => {
      require(["core/exporter"], resolve, err => {
        reject(new Error(err.message));
      });
    });
    const dataURL = rsDocToDataURL("text/html");
    const encodedString = dataURL.replace(/^data:\w+\/\w+;charset=utf-8,/, "");
    return decodeURIComponent(encodedString);
  }

  function timeout(promise, ms) {
    return new Promise((resolve, reject) => {
      promise.then(resolve, reject);
      const msg = `Timeout: document.respecIsReady didn't resolve in ${ms}ms.`;
      setTimeout(() => reject(msg), ms);
    });
  }
}

function getVersion() {
  if (window.respecVersion === "Developer Edition") {
    return [123456789, 0, 0];
  }
  return window.respecVersion.split(".").map(str => parseInt(str, 10));
}

function createTimer(duration) {
  const start = Date.now();
  return {
    get remaining() {
      const spent = Date.now() - start;
      return Math.max(0, duration - spent);
    },
  };
}

exports.fetchAndWrite = fetchAndWrite;
