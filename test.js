/* בדיקות לאפליקציה. הרצה: npm test
   דורש דפדפן: npm install && npx playwright install chromium

   הבדיקות כאן הן לא כיסוי שלם — הן המקומות שכבר נשברו פעם אחת.
   כל קבוצה מסבירה למה היא קיימת. */

import http from "node:http";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".gz": "application/gzip"
};

// שרת סטטי קטן, קרוב ככל האפשר למה ש-GitHub Pages עושה. served סופר כמה
// פעמים כל קובץ הוגש, כדי לבדוק מה באמת יורד מהרשת.
const served = new Map();
function staticServer(){
  return http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    served.set(rel, (served.get(rel) || 0) + 1);
    const file = path.join(DIR, rel);
    if(!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){
      res.writeHead(404, {"Content-Type": "text/plain"});
      return res.end("not found");
    }
    res.writeHead(200, {"Content-Type": TYPES[path.extname(file)] || "application/octet-stream"});
    fs.createReadStream(file).pipe(res);
  });
}

// מילון המודל, מתוך model.tar.gz עצמו. tar הוא רצף של כותרות בנות 512
// בתים, ובכל אחת שם הקובץ וגודלו באוקטלי; התוכן מרופד לכפולה של 512.
function modelWords(){
  const tar = zlib.gunzipSync(fs.readFileSync(path.join(DIR, "model.tar.gz")));
  for(let off = 0; off + 512 <= tar.length; ){
    const name = tar.toString("latin1", off, off + 100).replace(/\0.*$/s, "");
    if(!name) break;
    const size = parseInt(tar.toString("latin1", off + 124, off + 136).replace(/\0/g, "").trim(), 8) || 0;
    if(name.endsWith("graph/words.txt"))
      return new Set(tar.toString("utf8", off + 512, off + 512 + size).split("\n").map(l => l.split("\t")[0]));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return new Set();
}

let passed = 0, failed = [];
function check(name, ok, detail){
  if(ok){ passed++; console.log("  ✓ " + name); }
  else { failed.push(name); console.log("  ✗ " + name + (detail !== undefined ? "\n      " + JSON.stringify(detail) : "")); }
}
function group(title){ console.log("\n" + title); }

async function main(){
  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch { console.error("playwright חסר. הריצו: npm install && npx playwright install chromium"); process.exit(1); }

  const server = staticServer();
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // מיקרופון מזויף, כדי שאפשר יהיה לבדוק את מסלול השמע בלי חומרה
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
  });
  // מכשיר שלא נשמר בו כלום נפתח בהכנת המכשיר ולא במסך הפתיחה. כל הקבוצות כאן
  // מתחילות ממכשיר שכבר הוכן, חוץ מ"הכנת המכשיר", שמבקשת { setup: true }.
  const openContext = browser.newContext.bind(browser);
  browser.newContext = async ({ setup = false, ...options } = {}) => {
    const context = await openContext(options);
    if(!setup) await context.addInitScript(() => {
      try{ if(localStorage.getItem("say-the-word-setup") === null) localStorage.setItem("say-the-word-setup", "1"); }catch(e){}
    });
    return context;
  };
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if(m.type() === "error") errors.push("console: " + m.text()); });
  // שגיאה שהבדיקה גורמת לה בכוונה לא נספרת ב"אין שגיאות בקונסולה". מאזינים
  // לפני הפעולה, ואחריה מוציאים מ-errors את השורה שהגיעה.
  const expectConsoleError = match => {
    const line = page.waitForEvent("console", {
      predicate: m => m.type() === "error" && match(m), timeout: 2000
    }).catch(() => null);
    return async () => {
      const m = await line;
      const n = m ? errors.lastIndexOf("console: " + m.text()) : -1;
      if(n >= 0) errors.splice(n, 1);
    };
  };
  // השמע דלוק כברירת מחדל, ורוב הקבוצות מניחות שהוא כבוי: מה שנאמר נספר
  // בהן רק כשהן מדליקות אותו. קבוצה ששומרת אותו אחרת, שומרת.
  await page.addInitScript(() => {
    if(localStorage.getItem("sound_enabled") === null) localStorage.setItem("sound_enabled", "0");
  });
  // סבב שנגמר מציג מסך סיום ומסתיר את 🎤. רוב הקבוצות קוראות ל-next() שוב
  // ושוב בלי קשר לסבבים, ולכן בהן הילד לוחץ ▶ מיד, בכל טעינה של הדף.
  // קבוצת הסבב מחזירה את מסך הסיום האמיתי, realShowRoundEnd, בזמן שהיא רצה.
  // באותו אופן שלב "להבין" והבדיקה מהתמונה של מילה חדשה כבויים מחוץ לקבוצה
  // שלהם: בלעדיהם כל מילה חדשה בבדיקות הייתה מוצגת בלי כתב, כי ילד בלי
  // ניסיונות הוא ילד חדש במסלול המהיר. וכך גם "שומעים ובוחרים בלבד" כל עוד
  // המנוע לא נטען. קבוצת "הבנה" מחזירה אותם.
  // והדף נפתח במסך הפתיחה. כאן הוא נכנס מיד למשחק, כמו אחרי ▶, בלי לבקש את
  // המיקרופון: הוא נפתח בניסיון הראשון, כמו לפני ▶. קבוצת "מסך הפתיחה" בודקת
  // את ▶ עצמו.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      if(typeof showRoundEnd !== "function") return;
      window.realShowRoundEnd = showRoundEnd;
      showRoundEnd = () => newRound();
      window.realStep = { laneFast, canSpeak, listenOnly, mixedSpellDue, loanwords: [...LOANWORD_SET] };
      // ובמצב המעורב, שהוא ברירת המחדל, המשחק לא משלב סבב כתיבה מעצמו. קבוצת
      // "מעורב" מחזירה את זה.
      mixedSpellDue = () => false;
      laneFast = () => false;
      canSpeak = () => false;
      listenOnly = () => false;
      LOANWORD_SET.clear();
      enterGame();
    });
  });
  // טעינה מחדש של הדף הראשי, עם זמן לסקריפט שלו לעלות.
  const reload = () => page.reload({ waitUntil: "domcontentloaded" }).then(() => page.waitForTimeout(800));
  // אזור המבוגר נפתח באפליקציה רק דרך 🔒 ושאלת המספר, שנבדקים בקבוצה "כניסת
  // מבוגר". כאן הוא נפתח ישר. הסגירה שלו חוזרת למסך הפתיחה, ולכן קבוצה שממשיכה
  // לשחק אחריה חוזרת למשחק (backToGame), כמו ב-▶.
  const openSettings = () => page.evaluate(() => openPanel()).then(() => page.waitForTimeout(150));
  const backToGame = () => page.evaluate(() => { if(!$("overlay").hidden) closePanel(); if(screen !== "game") enterGame(); });

  // --------------------------------------------------------------
  group("בקלוג");
  // כל פריט ב-BACKLOG.md מעוגן בקטע קוד, לא במספר שורה. מספר שורה מתיישן
  // בשקט; קטע קוד שנעלם מפיל את הבדיקה ומזכיר שהפריט כנראה כבר לא נכון.
  const backlog = fs.readFileSync(path.join(DIR, "BACKLOG.md"), "utf8");
  const anchors = [...backlog.matchAll(/^עוגן: `([^`]+)` — `([^`]+)`(?:\s*×(\d+))?\s*$/gm)]
    .map(m => ({ file: m[1], snippet: m[2], times: m[3] ? Number(m[3]) : null }));

  check("יש עוגנים בבקלוג", anchors.length > 0, anchors.length);
  const broken = [];
  for(const a of anchors){
    const target = path.join(DIR, a.file);
    if(!fs.existsSync(target)){ broken.push(`${a.file} לא קיים`); continue; }
    const found = fs.readFileSync(target, "utf8").split(a.snippet).length - 1;
    if(found === 0) broken.push(`${a.file}: "${a.snippet.slice(0, 40)}" לא נמצא`);
    else if(a.times !== null && found !== a.times) broken.push(`${a.file}: "${a.snippet.slice(0, 40)}" ×${found}, הבקלוג אומר ×${a.times}`);
  }
  check("כל עוגן בבקלוג עדיין מצביע על קוד קיים", broken.length === 0, broken);

  // --------------------------------------------------------------
  group("מניפסט");
  // נתיב מוחלט עובד רק כשהאפליקציה יושבת בשורש. ב-GitHub Pages היא יושבת
  // תחת /REPO/, שם כל אייקון מחזיר 404 — ואז כרום לא מציע להתקין בכלל.
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
  const absolute = [
    ...["start_url", "scope"].filter(k => String(manifest[k]).startsWith("/")).map(k => `${k}=${manifest[k]}`),
    ...manifest.icons.filter(ic => ic.src.startsWith("/")).map(ic => ic.src)
  ];
  check("כל הנתיבים במניפסט יחסיים", absolute.length === 0, absolute);
  // אין id בכוונה: id נפתר מול ה-origin, ו-./ היה נותן את שורש האתר ולא את
  // /REPO/. בלעדיו הזהות של האפליקציה היא start_url.
  check("אין id במניפסט", !("id" in manifest), manifest.id);
  const missingIcons = manifest.icons.map(ic => ic.src).filter(src => !fs.existsSync(path.join(DIR, src)));
  check("כל האייקונים במניפסט קיימים", missingIcons.length === 0, missingIcons);
  // מסך הפתיחה של אפליקציה מותקנת וסרגל המצב בצבע של רקע הדף, ולא בצבעים
  // של העיצוב הקודם.
  const themeMeta = (fs.readFileSync(path.join(DIR, "index.html"), "utf8").match(/<meta name="theme-color" content="([^"]+)">/) || [])[1];
  check("צבעי המניפסט כמו רקע הדף", manifest.theme_color === themeMeta && manifest.background_color === themeMeta,
    { theme: manifest.theme_color, background: manifest.background_color, themeMeta });

  await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  // --------------------------------------------------------------
  group("טעינה");
  // words.js נטען מכתובת עם ?v=. אם הוא חוזר כ-HTML, PAIRS ריק. הדף צריך
  // לקבל בדיוק את הצמדים שבקובץ, שנספרים כאן בלי דפדפן.
  const wordsFile = {};
  new Function("window", fs.readFileSync(path.join(DIR, "words.js"), "utf8"))(wordsFile);
  const pairsInFile = wordsFile.PAIRS.length;
  const pairsInPage = await page.evaluate(() => PAIRS.length);
  check("מאגר המילים נטען", pairsInFile > 0 && pairsInPage === pairsInFile, { pairsInPage, pairsInFile });
  check("יש מילים לתרגול", await page.evaluate(() => words.length) > 0);
  check("מוצגת מילה על המסך", (await page.textContent("#word")).length > 0);

  // רשימה שמורה שאף פריט בה לא תקין מסתננת לרשימה ריקה. בלי חזרה לברירת
  // המחדל show() קורס כבר בעלייה, והמודל לא נטען לעולם: 🎤 נשאר ⏳. בדפדפן
  // נפרד, כדי שלא יהיה מה לשחזר בדף הראשי ושהקריסה לא תיספר שוב ב"אין
  // שגיאות בקונסולה".
  const junkWords = await browser.newContext({ serviceWorkers: "block" });
  const junkPage = await junkWords.newPage();
  const crashes = [];
  junkPage.on("pageerror", e => crashes.push(e.message));
  await junkPage.goto(base + "/manifest.json");
  await junkPage.evaluate(() => localStorage.setItem("words", JSON.stringify(["dog", "cat"])));
  await junkPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  const fallback = await junkPage.evaluate(() => (enterGame(), {
    defaults: words.length > 0 && JSON.stringify(words) === JSON.stringify(DEFAULT_WORDS),
    shown: $("word").textContent,
    listed: words.some(w => w.word === $("word").textContent)
  }));
  const kept = await junkPage.evaluate(() => {
    const emoji = Object.keys(WORD_BY_EMOJI)[0];
    localStorage.setItem("words", JSON.stringify(["dog", { emoji }]));
    return WORD_BY_EMOJI[emoji];
  });
  await junkPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  const mixed = await junkPage.evaluate(() => words.map(w => w.word));
  await junkWords.close();
  check("רשימה שמורה בלי אף מילה תקינה — עולה רשימת ברירת המחדל",
    fallback.defaults && fallback.listed && crashes.length === 0, { ...fallback, crashes });
  check("רשימה שמורה עם מילה תקינה אחת נטענת, והפגומות נופלות",
    mixed.length === 1 && mixed[0] === kept, { mixed, kept });

  // --------------------------------------------------------------
  group("מנוע שלא נטען");
  // כשה-worker של Vosk לא מצליח לטעון את המודל הוא שולח error ולא load.
  // מי שמחכה רק ל-load נשאר על "עוד רגע…" לנצח. כאן model.tar.gz אינו
  // ארכיון, גם לדף וגם ל-worker; על שגיאת HTTP הדף נכשל עוד ב-fetchModel ולא
  // מגיע ל-worker. בדפדפן נפרד ובלי service worker: הדף לא מחכה לו, וה-route
  // רואה גם את הבקשה של ה-worker. בלי קולות באנגלית, כמו בכרומיום של הבדיקות.
  const badModel = await browser.newContext({ permissions: ["microphone"] });
  await badModel.addInitScript(() => { delete Navigator.prototype.serviceWorker; });
  await badModel.route("**/model.tar.gz", route =>
    route.fulfill({ status: 200, contentType: "application/gzip", body: Buffer.alloc(4096, 7) }));
  const badPage = await badModel.newPage();
  await badPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await badPage.waitForFunction(() => modelError !== "", null, { timeout: 15000 }).catch(() => {});
  const stuck = await badPage.evaluate(() => ({ error: modelError, loading: !$("loading").hidden, model: model !== null }));
  // ▶ אף פעם לא מוביל למסך קפוא: "קראו למבוגר", עם ▶ שממשיך לשחק.
  await badPage.click("#play", { force: true });
  await badPage.waitForFunction(() => screen !== "door", null, { timeout: 5000 }).catch(() => {});
  const called = await badPage.evaluate(() => ({ screen, resume: $("resume").checkVisibility(),
    lock: $("lock").checkVisibility(), text: $("grownup").innerText }));
  // בלי מנוע ובלי קול אי אפשר לא לומר ולא לשמוע, ולכן הסבב הזה הוא כתיבה, שלא נשמרת.
  await badPage.click("#resume", { force: true });
  const resumed = await badPage.evaluate(() => ({ screen, mode, saved: localStorage.getItem("practice_mode"),
    spell: $("spell").checkVisibility(), say: $("say").checkVisibility(), switchShows: document.querySelector('#modeSwitch [aria-checked="true"]').dataset.mode }));
  const status = await badPage.evaluate(() => { openPanel();
    return { shown: $("deviceStatus").checkVisibility(), text: $("modelStatus").checkVisibility() ? $("modelStatusText").textContent : "" }; });
  await badModel.close();
  check("מודל שלא נטען — הסיבה נשמרת במקום המתנה בלי סוף",
    stuck.error !== "" && !stuck.loading && !stuck.model, stuck);
  check("מודל שלא נטען — ▶ מוביל ל\"קראו למבוגר\" עם ▶ ו-🔒, בלי הודעה טכנית",
    called.screen === "grownup" && called.resume && called.lock && !called.text.includes("model"), called);
  check("בלי מנוע ובלי קול באנגלית — ממשיכים בסבב כתיבה זמני, שלא נשמר",
    resumed.screen === "game" && resumed.mode === "spell" && resumed.spell && !resumed.say && resumed.saved === null
      && resumed.switchShows === "mixed", resumed);
  check("באזור המבוגר כתובה הסיבה המדויקת", status.shown && status.text === stuck.error, { status, stuck });
  // הורדה שנקטעה באמצע, כשהמכשיר עוד מדווח שהוא מחובר: הסיבה היא החיבור, לא הקובץ.
  const cutModel = await browser.newContext();
  await cutModel.addInitScript(() => { delete Navigator.prototype.serviceWorker; });
  await cutModel.route("**/model.tar.gz", route => route.abort("connectionreset"));
  const cutPage = await cutModel.newPage();
  await cutPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await cutPage.waitForFunction(() => modelError !== "", null, { timeout: 15000 }).catch(() => {});
  const cut = await cutPage.evaluate(() => ({ error: modelError, online: navigator.onLine }));
  // אחרי הורדה שנכשלה Vosk מוריד בעצמו, בלי פס: לא "100% עוד רגע…" לכל ההורדה.
  const afterCut = await cutPage.evaluate(async () => {
    fetchModel = async () => { throw new TypeError("Failed to fetch"); };
    Vosk.Model = class { on(){} };
    modelError = "";
    loadModel();
    await new Promise(r => setTimeout(r, 300));
    return { text: $("loadtext").textContent, width: $("fill").style.width };
  });
  // והמקום במכשיר נגמר: Vosk לא יסתדר בלעדיו, וזה מה שכתוב.
  const quota = await cutPage.evaluate(async () => {
    fetchModel = async () => { throw new DOMException("full", "QuotaExceededError"); };
    modelError = "";
    // בלי התיקון loadModel מחכה ל-Vosk לנצח, וזה בדיוק הבאג.
    await Promise.race([loadModel(), new Promise(r => setTimeout(r, 3000))]);
    return modelError;
  });
  await cutModel.close();
  check("אחרי הורדה שנכשלה הפס לא מראה 100%", afterCut.text !== "עוד רגע…" && afterCut.width === "0%", afterCut);
  check("כשהמקום נגמר בהורדה, כתוב שאין מקום, בלי לחכות ל-Vosk", quota.includes("מקום"), quota);
  check("הורדה שנקטעה — כתוב לבדוק את החיבור, לא את model.tar.gz",
    cut.online && cut.error.includes("החיבור") && !cut.error.includes("model.tar.gz"), cut);

  // --------------------------------------------------------------
  group("התקנה");
  // ספארי באייפד מציג כברירת מחדל user agent של מק, בלי ipad בתוכו, ו-iOS לא
  // מציע להתקין מעצמו: בלי הכפתור אין מי שיגיד למורה על "הוספה למסך הבית".
  // מק מדווח אותו user agent ואפס נקודות מגע. כרומיום מדווח את הפלטפורמה
  // האמיתית ונקודת מגע אחת גם עם hasTouch, ואייפד מדווח חמש.
  const safariMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
  const installOffer = async touchPoints => {
    const c = await browser.newContext({ serviceWorkers: "block", userAgent: safariMac, hasTouch: touchPoints > 0 });
    await c.addInitScript(n => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
      Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => n });
    }, touchPoints);
    const p = await c.newPage();
    await p.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
    await p.evaluate(() => openPanel());
    const shown = await p.isVisible("#installBtn");
    if(shown) await p.click("#installBtn");
    const hint = await p.textContent("#settingsNotice");
    await c.close();
    return { shown, hint };
  };
  const ipad = await installOffer(5);
  check("באייפד מוצעת הוספה למסך הבית", ipad.shown && ipad.hint.includes("הוספה למסך הבית"), ipad);
  const mac = await installOffer(0);
  check("במק בלי מסך מגע אין כפתור התקנה", !mac.shown && mac.hint === "", mac);
  // בקשת ההתקנה של כרום נפתחת פעם אחת. אחרי "לא עכשיו" הכפתור לא נשאר בלי תגובה.
  const dismissed = await page.evaluate(async () => {
    let prompts = 0;
    const e = new Event("beforeinstallprompt", { cancelable: true });
    e.prompt = () => { prompts++; };
    e.userChoice = Promise.resolve({ outcome: "dismissed" });
    window.dispatchEvent(e);
    const before = !installBtn.hidden;
    installBtn.click();
    await new Promise(r => setTimeout(r, 50));
    return { before, prompts, after: !installBtn.hidden, setup: !$("setupInstall").hidden };
  });
  check("אחרי שבקשת ההתקנה נדחתה, כפתור ההתקנה יורד",
    dismissed.before && dismissed.prompts === 1 && !dismissed.after && !dismissed.setup, dismissed);

  // --------------------------------------------------------------
  group("מילון המודל");
  // KaldiRecognizer מקבל בשקט גם מילה שהמודל לא מכיר, ואז היא לא תזוהה
  // לעולם, גם כשהילד אומר אותה מושלם. מילה חדשה במאגר צריכה להופיע במילון.
  const vocab = modelWords();
  const unknown = (await page.evaluate(() => PAIRS.map(p => p[1]))).filter(w => !vocab.has(w));
  check("המודל מכיר כל מילה במאגר", unknown.length === 0, unknown);

  // --------------------------------------------------------------
  group("בחירת קול");
  // סדר הקולות משתנה ממכשיר למכשיר. קול מרוחק או בסיסי שמופיע ראשון לא אמור
  // להסתיר קול מקומי טוב יותר, ובלי קול בשפה המבוקשת לא נבחר קול של שפה אחרת.
  const voiceSelection = await page.evaluate(() => {
    const original = voices;
    try {
      const remote = {name: "Remote Natural", lang: "en-US", localService: false};
      const compact = {name: "Compact", lang: "en-US", localService: true};
      const enhanced = {name: "Enhanced", lang: "en-US", localService: true};
      const british = {name: "Premium", lang: "en-GB", localService: true};
      voices = [remote, compact, british, enhanced];
      const localQuality = voiceFor(EN) === enhanced;
      voices = [{name: "Hebrew", lang: "he-IL", localService: true}];
      const noEnglish = voiceFor(EN) === null;
      voices = [{name: "English", lang: "en_US", localService: true}];
      const underscore = voiceFor(EN) === voices[0];
      // באייפון הרשימה נפתחת בקולות הצעצוע של אפל, מקומיים ובאותו מבטא כמו
      // Samantha. השם של Grandpa כאן מתורגם, ורק ה-voiceURI מסגיר אותו.
      const albert = {name: "Albert", lang: "en-US", localService: true,
        voiceURI: "com.apple.speech.synthesis.voice.Albert"};
      const grandpa = {name: "סבא (אנגלית)", lang: "en-US", localService: true,
        voiceURI: "com.apple.eloquence.en-US.Grandpa"};
      const samantha = {name: "Samantha", lang: "en-US", localService: true,
        voiceURI: "com.apple.voice.compact.en-US.Samantha"};
      voices = [albert, grandpa, samantha];
      const notToy = voiceFor(EN) === samantha;
      voices = [albert];
      const onlyToy = voiceFor(EN) === albert;
      return {localQuality, noEnglish, underscore, notToy, onlyToy};
    } finally { voices = original; }
  });
  check("קול מקומי איכותי במבטא המבוקש מועדף", voiceSelection.localQuality, voiceSelection);
  check("אין קול באנגלית — לא נבחר קול משפה אחרת", voiceSelection.noEnglish, voiceSelection);
  check("תג שפה עם קו תחתון נתמך", voiceSelection.underscore, voiceSelection);
  check("קול צעצוע של אפל לא נבחר כשיש קול רגיל", voiceSelection.notToy, voiceSelection);
  check("כשיש רק קול צעצוע — הוא נבחר ולא שותקים", voiceSelection.onlyToy, voiceSelection);

  // --------------------------------------------------------------
  group("מנוע ההתאמה");
  // הניקוד הוא מספר אחד, וההחלטה היא השוואה אחת מולו. אלה התכונות
  // שחייבות להישמר גם אם הנוסחה תשתנה.

  // מילים רחוקות מהיעד. שכנה קרובה מהרשימה, כמו ship מול sheep, מתקבלת ברמה
  // הסלחנית בכוונה, ונבדקת בנפרד.
  const wrongAccepted = await page.evaluate(() => {
    const bad = [];
    for(const [target, spoken] of [["dog","cat"],["lion","house"],["sun","moon"],["apple","car"]])
      for(const { threshold: th } of PRESETS)
        for(const conf of [null, 0.5, 0.9, 1])
          if(scoreToken(spoken, conf, target) >= th) bad.push(`${spoken}/${target} th=${th}`);
    return bad;
  });
  check("מילה שגויה ורחוקה מהיעד לא מתקבלת באף רמה", wrongAccepted.length === 0, wrongAccepted.slice(0, 5));

  // ההחלטה עצמה, דרך processRecognition: רשימה, יעד, מה שנשמע ורמה, ומה
  // ש-finish קיבל (undefined כשלא הוחלט כלום). מצב הדף חוזר אחרי כל קריאה.
  await page.evaluate(() => {
    window.decide = (list, target, said, p, conf = 1) => {
      const saved = { words, i, active, preset, finish };
      let now;
      try {
        words = list.map(w => ({emoji: "", word: w}));
        i = list.indexOf(target);
        finish = ok => { now = ok; };
        preset = p;
        active = true;
        processRecognition({ result: { result: [].concat(said).map(word => ({ word, conf })) } });
      } finally {
        words = saved.words; i = saved.i; active = saved.active;
        preset = saved.preset; finish = saved.finish;
      }
      return now;
    };
  });

  // בכל רמה בנפרד: ניקוד שמחושב פעם אחת מחוץ ללולאה לא רואה נוסחה שתלויה ברמה.
  const nonMonotonic = await page.evaluate(() => {
    const bad = [];
    for(const [target, spoken] of [["dog","dog"],["cat","kat"],["butterfly","butterf"],["banana","banan"]])
      for(const conf of [null, 0.4, 0.7, 1]){
        let prev = true;
        for(const p of PRESETS){
          const now = decide([target], target, spoken, p, conf), th = p.threshold;
          if(now === undefined) bad.push(`${spoken}/${target} conf=${conf} th=${th}: אין החלטה`);
          else if(now && !prev) bad.push(`${spoken}/${target} conf=${conf} th=${th}`);
          prev = now;
        }
      }
    return bad;
  });
  check("העלאת האחוז רק מקשה", nonMonotonic.length === 0, nonMonotonic);

  // בדקדוק סגור המנוע מחזיר רק מילים מהרשימה. ship כשהיעד sheep היא מילה
  // אחרת, גם כשהניקוד הפונטי שלה גבוה. ושכנה באותה תוצאה מדלגים עליה: לפני
  // היעד היא לא עוצרת, ואחריו היא לא מבטלת אותו.
  const listNeighbour = await page.evaluate(() => {
    const farm = ["sheep", "ship", "dog"], [lenient, normal, strict] = PRESETS;
    return {
      rejected: {
        shipNormal: decide(farm, "sheep", "ship", normal),
        shipStrict: decide(farm, "sheep", "ship", strict),
        ball:       decide(["ball", "balloon"], "balloon", "ball", normal),
        grandma:    decide(["grandpa", "grandma"], "grandpa", "grandma", normal),
        grandpa:    decide(["grandpa", "grandma"], "grandma", "grandpa", normal)
      },
      target: PRESETS.map(p => decide(farm, "sheep", "sheep", p)),
      withNeighbour: [["ship", "sheep"], ["sheep", "ship"]].map(said => decide(farm, "sheep", said, normal)),
      lenient: decide(farm, "sheep", "ship", lenient),
      // מילים שנשמעות אותו דבר לילד דובר עברית (SOUNDALIKE) הן שכנות קרובות.
      soundalike: decide(["tooth", "two", "dog"], "two", "tooth", lenient),
      // אותן אותיות, מילה אחרת: moon מול book, car ו-cake מול cat.
      far: [["book", "moon"], ["cat", "cake"], ["dog", "door"]].map(([target, said]) =>
        decide(["book", "moon", "cat", "cake", "dog", "door"], target, said, lenient)),
      // שכנה לא עוברת כשהיעד עצמו לא היה עובר באותו ביטחון.
      weak: { target: decide(["house", "mouse"], "house", "house", lenient, 0.35),
              neighbour: decide(["house", "mouse"], "house", "mouse", lenient, 0.35) }
    };
  });
  check("מילה אחרת מהרשימה לא מתקבלת מעל הרמה הסלחנית",
        Object.values(listNeighbour.rejected).every(ok => ok === false), listNeighbour);
  check("מילת היעד מתקבלת בכל רמה כששכנותיה ברשימה",
        listNeighbour.target.every(ok => ok === true), listNeighbour);
  check("מילת היעד מתקבלת גם לפני או אחרי שכנה מהרשימה באותה תוצאה",
        listNeighbour.withNeighbour.every(ok => ok === true), listNeighbour);
  check("ברמה הסלחנית שכנה קרובה מהרשימה מתקבלת, גם כזו שנשמעת אותו דבר לדובר עברית",
    listNeighbour.lenient === true && listNeighbour.soundalike === true, listNeighbour);
  check("ברמה הסלחנית מילה אחרת שרק חולקת אותיות עם היעד לא מתקבלת",
    listNeighbour.far.every(ok => ok === false), listNeighbour.far);
  const hebrewOnly = await page.evaluate(() => {
    const saved = { voices, sound: soundEnabled, refresh: refreshVoices };
    voices = [{ lang: "he-IL", name: "Carmit", localService: true, voiceURI: "he" }];
    refreshVoices = () => {};
    soundEnabled = true;
    try{ return speak("dog", EN) === null; }
    finally { voices = saved.voices; soundEnabled = saved.sound; refreshVoices = saved.refresh; }
  });
  check("במכשיר עם קולות ובלי קול באנגלית המילה לא נאמרת בקול אחר", hebrewOnly);
  check("שכנה לא עוברת כשהיעד עצמו לא עובר באותו ביטחון",
    listNeighbour.weak.target === false && listNeighbour.weak.neighbour === false, listNeighbour.weak);

  const scores = await page.evaluate(() => ({
    exact:    scoreToken("dog", 0.9, "dog"),
    phonetic: scoreToken("kat", 0.9, "cat"),
    prefix:   scoreToken("butterf", 0.9, "butterfly"),
    junk:     scoreToken("[unk]", 0.9, "dog")
  }));
  check("זיהוי מדויק נמדד בביטחון המנוע", scores.exact === 90, scores);
  check("התאמה פונטית לא עוברת רף גבוה", scores.phonetic === 88 && scores.phonetic < 90, scores);
  check("התאמת קידומת מתחת להתאמה פונטית", scores.prefix === 80, scores);
  check("רעש לא מקבל ניקוד", scores.junk === 0, scores);

  // --------------------------------------------------------------
  group("רמת ההתאמה");
  // נשמרת הרמה עצמה; האחוז וחלון ההקשבה באים ממנה.
  await openSettings();
  for(const [id, want] of [["btnLevelLenient",45], ["btnLevelNormal",70], ["btnLevelStrict",90]]){
    await page.click("#" + id);
    check(`הכפתור ${id} קובע ${want}%`, await page.evaluate(() => preset.threshold) === want);
  }
  const windows = await page.evaluate(() => {
    const before = preset;
    const out = PRESETS.map(p => { preset = p; return listenWindowMs(); });
    preset = before;
    return out;
  });
  check("חלון ההקשבה מתקצר ככל שהאחוז עולה",
        windows.every((v, n) => n === 0 || v < windows[n - 1]), windows);

  // הטעינה מחדש גם סוגרת את ההגדרות לפני הקבוצה הבאה.
  await reload();
  check("הרמה שנבחרה נטענת בפתיחה הבאה ומסומנת", await page.evaluate(() =>
    preset.id === "strict" && $("btnLevelStrict").classList.contains("active") &&
    $("matchLevelBadge").textContent === "🎯 מדויקת (90%)"));

  // --------------------------------------------------------------
  group("מאגר המילים");
  // הקטלוג נבנה פעם אחת והסינון רק מסתיר. הבדיקה מודדת מה באמת מוצג
  // ולא את התכונה hidden — כי display של הכפתור יכול לגבור עליה.
  await openSettings();
  await page.click("#openWordsViewBtn");
  await page.click("#openCatalogBtn");
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    window.visibleCatalogItems = () =>
      [...document.querySelectorAll("#catalog .catalog-item")].filter(b => getComputedStyle(b).display !== "none");
  });
  const built = await page.evaluate(() => document.querySelectorAll("#catalog .catalog-item").length);
  check("כל המאגר נבנה", built === pairsInFile, { built, pairsInFile });
  // מילה ברשימת המילים מעברית שאינה במאגר לא תופיע לעולם, וטעות כתיב בה עוברת בשקט.
  const loanwords = await page.evaluate(() => {
    const pool = new Set(PAIRS.map(p => p[1]));
    const set = new Set(realStep.loanwords);
    return { size: set.size, listed: (window.LOANWORDS || []).length, outside: [...set].filter(w => !pool.has(w)) };
  });
  check("כל מילה ברשימת המילים מעברית נמצאת במאגר, פעם אחת",
    loanwords.size > 0 && loanwords.size === loanwords.listed && loanwords.outside.length === 0, loanwords);
  // גם בזוגות של תמונות דומות ושל מילים שנשמעות דומה: מילה שאינה במאגר לא
  // משפיעה על כלום, וטעות כתיב בה עוברת בשקט.
  const pairsOutside = await page.evaluate(() => {
    const pool = new Set(PAIRS.map(p => p[1]));
    return [...(window.LOOKALIKE || []), ...(window.SOUNDALIKE || [])].flat().filter(w => !pool.has(w));
  });
  check("כל מילה בזוגות הדומים נמצאת במאגר",
    (wordsFile.LOOKALIKE || []).length > 0 && (wordsFile.SOUNDALIKE || []).length > 0 && pairsOutside.length === 0, pairsOutside);
  // הניקוד של וו בתעתיק יושב על ה-ו השנייה (ווִי, ווֶ), כמו ברוב המאגר. על
  // הראשונה ילד שקורא בניקוד הוגה וִ-ו-י.
  const vavFirst = wordsFile.PAIRS.filter(p => /ו[\u05B0-\u05BD\u05C1\u05C2\u05C7]+ו(?![\u05B0-\u05BD\u05C1\u05C2\u05C7])/.test(p[2]))
    .map(p => p[1] + " " + p[2]);
  check("בתעתיק, הניקוד של וו על ה-ו השנייה", vavFirst.length === 0, vavFirst);
  // ילד דובר עברית שומע את mouth ו-mouse כמעט אותו דבר, ואת 🐻 ו-🧸 הוא רואה
  // כמעט אותו דבר: הם לא באים יחד.
  const alike = await page.evaluate(() => {
    const saved = words;
    try{
      words = ["bear", "teddy", "mouth", "mouse", "dog", "cat", "sun", "car", "book", "apple"]
        .map(w => ({ emoji: emojiFor(w), word: w }));
      let together = 0;
      for(let k = 0; k < 300; k++){
        const c = choicesFor("bear");
        if(c.includes("teddy")) together++;
        if(choicesFor("mouth").includes("mouse")) together++;
      }
      return { together, confusable: confusable("mouth", "mouse") && confusable("socks", "fox") && confusable("two", "tooth") };
    } finally { words = saved; }
  });
  check("תמונות שנראות אותו דבר ומילים שנשמעות אותו דבר לא באות יחד",
    alike.together === 0 && alike.confusable, alike);
  // אימוג'י שהמכשיר לא יודע לצייר מופיע כריבוע ריק. כאן כל אימוג'י מצויר, ולכן
  // הבדיקה של הציור נבדקת מול נקודת קוד שאין לה תמונה, והסינון מול 🦩 שמסומן
  // כלא מצויר.
  const undrawn = await page.evaluate(() => {
    const out = { unknown: drawable("\u{1FAFF}"), flamingo: drawable("🦩"), dog: drawable("🐶") };
    const saved = words;
    drawn.set("🦩", false);
    try{
      words = ["flamingo", "dog", "cat", "sun", "car", "book", "apple", "moon"].map(w => ({ emoji: emojiFor(w), word: w }));
      let seen = 0;
      for(let k = 0; k < 200; k++) if(choicesFor("dog").includes("flamingo")) seen++;
      out.inChoices = seen;
      out.inRound = roundWords().includes("flamingo") || sayRound({}, dayNumber(), 3).queue.includes("flamingo");
      words = [{ emoji: "🦩", word: "flamingo" }];
      out.onlyOne = roundWords().join();
      words = saved;
      renderCatalog();
      out.inCatalog = !catalogItems.find(b => b.dataset.word === "flamingo").hidden;
      // 🛹 הוא Emoji 11, מתחת ל-U+1F900, וגם הוא נבדק.
      drawable("🛹");
      out.skate = drawn.has("🛹");
      return out;
    } finally {
      drawn.delete("🦩");
      words = saved;
      renderCatalog();
    }
  }).catch(e => ({ error: e.message }));
  check("אימוג'י שלא מצויר במכשיר לא מגיע לסבב ולבחירת התמונות, אלא אם אין אחר",
    undrawn.unknown === false && undrawn.flamingo && undrawn.dog && undrawn.inChoices === 0 && !undrawn.inRound
      && undrawn.onlyOne === "flamingo" && !undrawn.inCatalog && undrawn.skate, undrawn);

  // בנייה מחדש מלאה נותנת את אותו מספר פריטים, אז נבדק שהצומת עצמו נשאר.
  const firstItem = await page.$("#catalog .catalog-item");
  await page.fill("#search", "lion");
  await page.waitForTimeout(150);
  check("סינון מסתיר בפועל", await page.evaluate(() => visibleCatalogItems().length) === 1);
  check("הצמתים לא נבנים מחדש",
        await page.evaluate(() => document.querySelectorAll("#catalog .catalog-item").length) === built &&
        await firstItem.evaluate(b => b.isConnected));

  await page.fill("#search", "zzzz");
  await page.waitForTimeout(150);
  check("אין תוצאות — מוצגת הודעה",
        await page.evaluate(() => visibleCatalogItems().length === 0 && !$("catalogEmpty").hidden));

  await page.fill("#search", "lion");
  await page.waitForTimeout(150);
  const wordsBefore = await page.evaluate(() => words.length);
  await page.click("#catalog .catalog-item:not([hidden])");
  await page.waitForTimeout(250);
  check("הוספת מילה מהמאגר", await page.evaluate(() => words.length) === wordsBefore + 1);
  check("המילה מסומנת כבתרגול", await page.evaluate(() => !!document.querySelector('.catalog-item[data-word="lion"].in-list')));
  await page.click("#catalog .catalog-item:not([hidden])");
  await page.waitForTimeout(200);
  check("לחיצה חוזרת לא מוסיפה פעמיים", await page.evaluate(() => words.length) === wordsBefore + 1);

  // רשימה שנשמרה לפני ש-sax יצאה מהמאגר עדיין מחזיקה אותה. היא לא מורידה
  // ממה שזמין להוספה, ואחרת המונה מראה פחות מילים ממה שהמאגר מציג.
  const withRemoved = await page.evaluate(() => {
    const list = words.slice(), at = i;
    applyWords([{ emoji: "🎷", word: "sax" }, { emoji: "🐶", word: "dog" }], 0);
    const badge = $("catalogAvailableCount").textContent;
    applyWords(list, at);
    return { badge, available: +(badge.match(/\((\d+) /) || [])[1], pairs: PAIRS.length,
             saxInPairs: PAIRS.some(p => p[1] === "sax"), dogInPairs: PAIRS.some(p => p[1] === "dog") };
  });
  check("מילה שיצאה מהמאגר לא נספרת מול מה שזמין להוספה",
        !withRemoved.saxInPairs && withRemoved.dogInPairs && withRemoved.available === withRemoved.pairs - 1, withRemoved);

  // --------------------------------------------------------------
  group("ערכות");
  // מורה בוחרת נושא ורמה, ומחליפה או מוסיפה בלחיצה אחת את כל מה שמוצג.
  // הכפתורים פועלים על מה שהמאגר מציג, אז גם כאן נמדד מה באמת על המסך.
  const unsorted = await page.evaluate(() =>
    PAIRS.filter(p => ![1, 2, 3].includes(p[3]) || !THEME_BY_WORD[p[1]]).map(p => p[1]));
  check("לכל מילה במאגר יש נושא ורמה", unsorted.length === 0, unsorted);

  const listBeforeSets = await page.evaluate(() => words.slice());
  const shownSet = () => page.evaluate(() => visibleCatalogItems().map(b => b.dataset.word).sort().join());
  const fruit = level => page.evaluate(l => THEMES.find(t => t.id === "fruit").pairs
    .filter(p => !l || p[3] === l).map(p => p[1]).sort().join(), level);
  const actionsShown = () => page.evaluate(() => getComputedStyle($("setActions")).display !== "none");
  const practiced = () => page.evaluate(() => words.map(w => w.word).sort().join());

  await page.fill("#search", "");
  await page.waitForTimeout(150);
  check("בלי סינון אין כפתורי ערכה", !(await actionsShown()));
  await page.click('#themeChips [data-theme="fruit"]');
  check("נושא מסנן בפועל", await shownSet() === await fruit(), await shownSet());
  await page.click('#levelChips [data-level="1"]');
  const easyFruit = await fruit(1);
  check("רמה מצמצמת בתוך הנושא", !!easyFruit && await shownSet() === easyFruit, await shownSet());
  check("עם סינון יש כפתורי ערכה", await actionsShown());

  page.once("dialog", d => d.dismiss());
  await page.click("#practiceSetBtn");
  check("ביטול משאיר את הרשימה",
        JSON.stringify(await page.evaluate(() => words)) === JSON.stringify(listBeforeSets));

  page.once("dialog", d => d.accept());
  await page.click("#practiceSetBtn");
  await page.waitForTimeout(150);
  const replaced = await page.evaluate(() => ({
    saved: JSON.parse(localStorage.getItem("words")).map(w => w.word).sort().join(),
    current: word()
  }));
  check("▶ תרגלו רק את האלה מחליף את הרשימה ושומר",
        await practiced() === easyFruit && replaced.saved === easyFruit &&
        easyFruit.split(",").includes(replaced.current), replaced);

  await page.click('#levelChips [data-level=""]');
  await page.click("#addSetBtn");
  await page.waitForTimeout(150);
  check("הוספה מצרפת רק את החסרות", await practiced() === await fruit(), await practiced());
  check("כשהכל בתרגול אין מה להוסיף", await page.evaluate(() => $("addSetBtn").disabled));

  // מכרטיס הערכות באים לבחור נושא: בלי מקלדת שמכסה אותו, ובלי הסינון הקודם.
  await page.click("#closePanelFromCatalog");
  const closedTo = await page.evaluate(() => ({ screen, overlay: $("overlay").hidden, focus: document.activeElement.id }));
  check("סגירת אזור המבוגר חוזרת למסך הפתיחה, והפוקוס על 🔒",
    closedTo.screen === "door" && closedTo.overlay && closedTo.focus === "lock", closedTo);
  await openSettings();
  await page.click("#openThemesBtn");
  await page.waitForTimeout(150);
  const entry = await page.evaluate(() => ({
    catalog: !$("viewCatalog").hidden,
    focused: document.activeElement === $("search"),
    all: visibleCatalogItems().length === PAIRS.length
  }));
  check("כרטיס הערכות פותח את כל המאגר בלי מקלדת",
        entry.catalog && !entry.focused && entry.all, entry);

  // הקבוצה הבאה מוחקת שורה מהרשימה שהשאירה הקבוצה הקודמת.
  await page.evaluate(list => applyWords(list, 0), listBeforeSets);

  // --------------------------------------------------------------
  group("רשימת התרגול");
  await page.click("#backToWordsBtn");
  await page.waitForTimeout(200);
  check("אין סגנון בתוך JS על השורות",
        await page.evaluate(() => document.querySelectorAll("#wordList [style]").length) === 0);
  await page.click("#wordList li .speak-word-btn");
  await page.waitForTimeout(150);
  check("השמעה לא סוגרת את החלונית", await page.evaluate(() => $("overlay").hidden) === false);

  // נמחקת שורה שלפני המילה שעל המסך, ומה שהילד מתרגל לא מתחלף.
  const listState = () => page.evaluate(() => ({
    rows: [...document.querySelectorAll("#wordList li .w")].map(s => s.textContent),
    shown: $("word").textContent
  }));
  await page.evaluate(() => { i = 2; show(); renderPanel(); });
  const beforeDelete = await listState();
  await page.click("#wordList li .del-word-btn");
  await page.waitForTimeout(250);
  const afterDelete = await listState();
  check("מחיקת מילה",
        afterDelete.rows.length === beforeDelete.rows.length - 1 && !afterDelete.rows.includes(beforeDelete.rows[0]),
        { beforeDelete, afterDelete });
  check("מחיקה של שורה קודמת לא מחליפה את המילה שעל המסך",
        afterDelete.shown === beforeDelete.shown, { beforeDelete, afterDelete });

  // אין קפיצה למילה: המשחק בוחר את המילים של הסבב, ומבוגר לא מחליף אותן באמצעו.
  check("אין ברשימה קפיצה למילה", await page.evaluate(() => !document.querySelector("#wordList button.jump")));

  // האפליקציה המותקנת ולשונית בדפדפן, או שתי לשוניות, חולקות את localStorage.
  // כל אחת קוראת את הרשימה רק בעלייה ושומרת את כולה, ובלי האזנה לשינוי הבאה
  // ששומרת מוחקת את מה שהשנייה הוסיפה. הדף השני הוא manifest.json, בלי
  // האפליקציה עצמה. השדות שם בסדר הפוך מזה של save(), כדי ששמירה בחזרה תיראה.
  await backToGame();
  const beforeSync = await page.evaluate(() => {
    openPanel();
    showSettingsView("words");
    const taken = takenSet();
    return { list: words.slice(), at: i, current: words[i],
             outside: PAIRS.filter(p => !taken.has(p[1])).slice(0, 3).map(([emoji, word]) => ({ emoji, word })) };
  });
  // הדף השני כותב, והדף הראשי אמור להגיע לרשימה שהמילים שלה הן want.
  const writeFromTab = async (tab, raw, want) => {
    await tab.evaluate(raw => localStorage.setItem("words", raw), raw);
    await page.waitForFunction(want => words.map(w => w.word).join() === want, want, { timeout: 5000 }).catch(() => {});
  };
  const otherTab = await ctx.newPage();
  await otherTab.goto(base + "/manifest.json");
  const syncTo = async list => {
    const raw = JSON.stringify(list.map(w => ({ word: w.word, emoji: w.emoji })));
    const want = list.map(w => w.word).join();
    await writeFromTab(otherTab, raw, want);
    return page.evaluate(([raw, want]) => ({
      want, words: words.map(w => w.word).join(), shown: $("word").textContent,
      rows: [...document.querySelectorAll("#wordList li .w")].map(s => s.textContent).join(),
      notWrittenBack: localStorage.getItem("words") === raw
    }), [raw, want]);
  };
  const keptWord = await syncTo([...beforeSync.outside, beforeSync.current]);
  const lostWord = await syncTo(beforeSync.outside);
  await otherTab.close();
  await page.evaluate(({ list, at }) => applyWords(list, at), beforeSync);
  await backToGame();
  check("רשימה שנשמרה בחלון אחר מוצגת, והמילה שעל המסך נשארת",
    keptWord.words === keptWord.want && keptWord.rows === keptWord.want && keptWord.shown === beforeSync.current.word,
    keptWord);
  check("מילה שנמחקה בחלון אחר מתחלפת במילה מהרשימה החדשה",
    lostWord.words === lostWord.want && lostWord.rows === lostWord.want && lostWord.want.split(",").includes(lostWord.shown),
    lostWord);
  check("רשימה מחלון אחר לא נשמרת בחזרה", keptWord.notWrittenBack && lostWord.notWrittenBack, { keptWord, lostWord });

  // כשהמקום נגמר — כל הפרויקטים באותו github.io חולקים אותו — מה שמבוגר מוסיף
  // לא נשמר, וזה כתוב, ולא "נוספה בהצלחה". בהקשר נפרד, שהמקום שלו מלא.
  const fullCtx = await browser.newContext({ serviceWorkers: "block" });
  const fullPage = await fullCtx.newPage();
  await fullPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  const full = await fullPage.evaluate(() => {
    for(let size = 1 << 20, k = 0; size >= 1; ){
      try{ localStorage.setItem("fill" + k++, "x".repeat(size)); }catch(e){ size >>= 1; }
    }
    openPanel();
    showSettingsView("catalog", false);
    const item = [...document.querySelectorAll("#catalog .catalog-item")].find(b => !takenSet().has(b.dataset.word));
    item.click();
    const out = { notice: $("catalogNotice").textContent, error: $("catalogNotice").classList.contains("error"),
                  saved: localStorage.getItem("words") };
    showSettingsView("main", false);
    $("btnLevelStrict").click();
    out.preset = { notice: $("settingsNotice").textContent, error: $("settingsNotice").classList.contains("error"),
                   saved: localStorage.getItem("speech_match_config") };
    out.meta = $("panelMeta").textContent;
    // מתפנה מקום והגדרה אחרת נשמרת: הרשימה עדיין לא נשמרה.
    localStorage.removeItem("fill0");
    $("btnLevelLenient").click();
    out.metaLater = $("panelMeta").textContent;
    return out;
  });
  await fullCtx.close();
  check("כשהמקום במכשיר נגמר, הוספה ושינוי הגדרה אומרים שלא נשמרו, גם אחרי שהגדרה אחרת נשמרה",
    full.error && full.notice.includes("לא הצלחנו לשמור") && full.saved === null
      && full.preset.error && full.preset.saved === null && full.meta.includes("לא נשמר") && full.metaLater.includes("לא נשמר"), full);

  // --------------------------------------------------------------
  group("מה נרשם לבד");
  // הילד רואה כל הצלחה אותו דבר: הכרטיס מוריק, קונפטי, והתמונה נשארת. מה
  // שנאמר או נכתב בניסיון הראשון בלי עזרה נרשם בסבב (round.row), ורק המבוגר
  // רואה אותו. ההחלטה עוברת דרך finish(), כמו מהמזהה, כבר לפני שהמודל נטען.
  // כל מקרה מתחיל סבב חדש ומחכה למעבר ש-good() מזמן.
  const rowAfter = how => page.evaluate(async how => {
    const synth = speechSynthesis, realSound = soundEnabled;
    synth.speak = () => {};
    const accept = () => { active = true; finish(true, { score: 100 }); };
    try{
      newRound();
      const out = { target: word(), emoji: words[i].emoji };
      if(how === "clean" || how === "fresh") accept();
      if(how === "heard"){ playCurrentWord(); accept(); }
      if(how === "second"){ active = true; finish(false, { score: 0 }); accept(); }
      if(how === "twice"){ accept(); turn.word = null; show(); accept(); }
      out.card = $("card").className;
      out.picture = $("picture").textContent;
      out.cue = $("cue").dataset.cue;
      out.dock = ["say", "playWord", "next"].filter(id => isShown($(id)));
      out.row = round.row.map(emojiFor).join("");
      if(how === "fresh"){ newRound(); out.fresh = round.row.join(""); }
      await new Promise(r => setTimeout(r, Math.max(GOOD_MS, AGAIN_MS) + 300));
      return out;
    } finally {
      if(soundEnabled !== realSound) setSound(realSound);
      delete synth.speak;
    }
  }, how);
  const cleanRow = await rowAfter("clean");
  check("הצלחה — הכרטיס מוריק, התמונה נשארת, \"אמרתם!\", ואין מה ללחוץ",
    cleanRow.card === "good" && cleanRow.picture === cleanRow.emoji && cleanRow.cue === "good" && cleanRow.dock.length === 0, cleanRow);
  check("מילה שנאמרה בניסיון הראשון בלי עזרה נרשמת כלבד", cleanRow.row === cleanRow.emoji, cleanRow);
  const heardRow = await rowAfter("heard");
  check("הצלחה אחרי ששמעו את המילה נראית אותו דבר, ולא נרשמת כלבד",
    heardRow.card === "good" && heardRow.picture === heardRow.emoji && heardRow.row === "", heardRow);
  const secondRow = await rowAfter("second");
  check("הצלחה בניסיון השני נראית אותו דבר, ולא נרשמת כלבד", secondRow.card === "good" && secondRow.row === "", secondRow);
  const twiceRow = await rowAfter("twice");
  check("מילה שחוזרת בסבב נרשמת פעם אחת", twiceRow.row === twiceRow.emoji, twiceRow);
  const freshRow = await rowAfter("fresh");
  check("סבב חדש מתחיל בלי מה שנרשם בקודם", freshRow.row === freshRow.emoji && freshRow.fresh === "", freshRow);
  // ובאזור המבוגר: מה לבד ומה לא, מהסבב האחרון.
  // נראה או לא לפי ה-CSS, ולא רק לפי התכונה hidden: הכרטיס מגדיר display משלו.
  const adultRow = await page.evaluate(() => {
    const saved = { tried: round.tried, row: round.row };
    round.tried = []; round.row = [];
    renderLastRound();
    const empty = getComputedStyle($("lastRoundSection")).display;
    round.tried = ["dog", "cat"]; round.row = ["dog"];
    renderLastRound();
    const out = { text: $("lastRound").textContent, empty, shown: getComputedStyle($("lastRoundSection")).display };
    Object.assign(round, saved);
    return out;
  });
  check("באזור המבוגר: מה נאמר לבד ומה בעזרה בסבב האחרון, ובלי סבב אין כלום",
    adultRow.shown !== "none" && adultRow.empty === "none" && /לבד[^.]*🐶/.test(adultRow.text) && /עזרה[^.]*🐱/.test(adultRow.text), adultRow);

  // בטלפון קטן שורת הכפתורים על המסך, גם בכתיבה עם מילה ארוכה, ולא מתחת לכרטיס.
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 640 });
  const beforeSpell = await page.evaluate(() => {
    const before = { mode, at: i };
    setMode("spell");
    i = Math.max(0, words.findIndex(w => w.word === "banana"));
    show();
    return before;
  });
  const spellButtons = await page.evaluate(() => ["playWord", "hint", "next"]
    .filter(id => $(id) && $(id).offsetParent !== null)
    .map(id => ({ id, bottom: $(id).getBoundingClientRect().bottom, max: innerHeight })));
  await page.evaluate(b => { setMode(b.mode); i = b.at; show(); }, beforeSpell);
  check("במצב כתיבה בטלפון בגובה 640 הכפתורים בתחתית על המסך",
    spellButtons.length > 0 && spellButtons.every(b => b.bottom <= b.max), spellButtons);
  await page.setViewportSize(viewport);

  // אחרי ההצלחה עוברים למילה הבאה, אבל ילד שלחץ ⏭️ בזמן ההצלחה כבר בחר מילה,
  // והמעבר המאוחר לא מחליף אותה. ההמתנה היא טיימר בדף שמתחיל אחרי good(),
  // ולכן נגמרת אחרי המעבר שהוא מזמן גם כשהמכונה עמוסה.
  const afterGood = async skip => await page.evaluate(async skip => {
    const before = i;
    good();
    if(skip === "next") next();
    const chosen = i;
    await new Promise(r => setTimeout(r, 1500));
    return { before, chosen, now: i, words: words.length };
  }, skip);
  const advanced = await afterGood(false);
  check("אחרי הצלחה עוברים למילה הבאה", advanced.words > 1 && advanced.now !== advanced.before, advanced);
  const skippedCheer = await afterGood("next");
  check("מילה שנבחרה בזמן ההצלחה לא מוחלפת אחריה",
    skippedCheer.words > 1 && skippedCheer.chosen !== skippedCheer.before && skippedCheer.now === skippedCheer.chosen, skippedCheer);
  // ההצלחות כאן נרשמו בהתקדמות, ומילה שהילד כבר אמר מוצגת בלי כתב. הקבוצות
  // הבאות בודקות את הכתב, אז הן מתחילות בלי היסטוריה.
  await page.evaluate(() => {
    for(const k of ["say-the-word-progress", "say-the-word-log"]) localStorage.removeItem(k);
    newRound();
  });

  // --------------------------------------------------------------
  group("תעתיק לעברית");
  // ילד שעוד לא קורא אנגלית רואה מתחת למילה איך אומרים אותה. מורה יכולה
  // לכבות, והבחירה נשמרת.
  const noHe = await page.evaluate(() => PAIRS.filter(p => !/^[\u0590-\u05FF'־ ]+$/.test(p[2] || "")).map(p => p[1]));
  check("לכל מילה במאגר יש תעתיק בעברית", noHe.length === 0, noHe);
  // ניקוד שבא אחרי הגרש מצויר מתחת לגרש או לאות הבאה, לא מתחת לאות שלפניו.
  const markAfterGeresh = await page.evaluate(() => PAIRS.filter(p => /'[֑-ׇ]/.test(p[2] || "")).map(p => p[1]));
  check("הניקוד לפני הגרש, לא אחריו", markAfterGeresh.length === 0, markAfterGeresh);
  const heLine = () => page.evaluate(() => ({ text: $("wordHe").innerText, word: word(), he: HE_BY_WORD[word()] }));
  let he = await heLine();
  check("התעתיק מופיע על המסך מתחת למילה", !!he.he && he.text === he.he, he);
  await page.evaluate(() => $("hebrewToggle").click());
  he = await heLine();
  check("כיבוי מעלים את התעתיק ונשמר",
        he.text === "" && await page.evaluate(() => localStorage.getItem("hebrew_spelling")) === "0", he);
  await page.evaluate(() => { next(); });
  check("נשאר כבוי במילה הבאה", (await heLine()).text === "");
  // השמירה קיימת בשביל הפתיחה הבאה, אז נבדק מה מוצג אחרי טעינה.
  await reload();
  const reloadedHe = await page.evaluate(() => ({ text: $("wordHe").innerText, toggle: $("hebrewToggle").checked }));
  check("נשאר כבוי אחרי טעינה מחדש", reloadedHe.text === "" && !reloadedHe.toggle, reloadedHe);
  await page.evaluate(() => $("hebrewToggle").click());
  he = await heLine();
  check("הדלקה מחזירה אותו", he.text === he.he && !!he.he, he);

  // --------------------------------------------------------------
  group("כתיבה");
  // הילד בונה את המילה מבנק של האותיות שלה. מילה שלמה מקבלת 🎉, ותמונה
  // בשורה רק בלי 💡 ובלי מילה שגויה לפניה. ההחלפה בין 🎤 ל-💡 נמדדת במה
  // שמוצג בפועל, כי display של כפתורי השורה גובר על התכונה hidden.
  const shown = id => page.evaluate(id => getComputedStyle($(id)).display !== "none", id);
  await page.evaluate(() => setMode("spell"));
  check("במצב כתיבה 🎤 מוסתר ו-💡 מוצג", !(await shown("say")) && await shown("hint"));
  check("במצב כתיבה המילה באנגלית לא מוצגת", !(await shown("word")) && await shown("spell"));

  const board = await page.evaluate(() => ({
    word: word(), slots: $("slots").children.length,
    bank: [...$("bank").children].map(t => t.dataset.letter)
  }));
  check("משבצת לכל אות, ובבנק בדיוק אותיות המילה",
    board.slots === board.word.length && [...board.bank].sort().join("") === [...board.word].sort().join(""), board);
  const unshuffled = await page.evaluate(() => {
    let same = 0;
    for(let n = 0; n < 200; n++)
      for(const w of ["ox", "cat", "bee"]) if(shuffled([...w]).join("") === w) same++;
    return same;
  });
  check("הבנק אף פעם לא מגיע בסדר של המילה", unshuffled === 0, unshuffled);

  // כל אות נכנסת, גם לא נכונה, ונבדקת רק כשהמילה מלאה. אילו רק הנכונה
  // נכנסה, היה מספיק ללחוץ על כל הבנק עד שמשהו נתפס.
  const newBoard = () => page.waitForFunction(() => !busy && slotList().every(s => !s.tile));
  const wrongTap = await page.evaluate(() => {
    const before = round.row.length;
    const tile = [...$("bank").children].find(t => t.dataset.letter !== word()[0]);
    tile.click();
    const slot = $("slots").children[0];
    return { letter: tile.dataset.letter, slot: slot.textContent, row: round.row.length - before, inBank: !tile.disabled };
  });
  check("אות לא נכונה נכנסת למשבצת, ולא נרשם לבד",
    wrongTap.slot === wrongTap.letter && wrongTap.row === 0 && !wrongTap.inBank, wrongTap);
  const takeBack = await page.evaluate(() => {
    const slot = $("slots").children[0], tile = slot.tile;
    slot.click();
    return { slot: slot.textContent, inBank: !tile.disabled && !tile.classList.contains("used") };
  });
  check("לחיצה על אות במשבצת מחזירה אותה לבנק", takeBack.slot === "" && takeBack.inBank, takeBack);

  // מילה מלאה ושגויה: האות הראשונה במקומה, והשאר מסובבות באחת — כך יש גם
  // נכונות וגם שגויות. מילה שכל אותיותיה אחרי הראשונה זהות לא מתאימה.
  const filled = await page.evaluate(() => {
    i = words.findIndex(w => new Set(w.word.slice(1)).size > 1);
    show();
    const target = word(), rest = target.slice(1);
    const order = target[0] + rest.slice(1) + rest[0];
    const before = round.row.length;
    for(const ch of order)
      [...$("bank").children].find(t => !t.disabled && t.dataset.letter === ch).click();
    const slots = slotList();
    return {
      target, order, row: round.row.length - before, again: $("card").className,
      right: slots.map((s, k) => s.classList.contains("right") === (order[k] === target[k])),
      red: slots.map((s, k) => s.classList.contains("wrong") === (order[k] !== target[k]))
    };
  });
  check("מילה מלאה ושגויה — הכרטיס רועד, ולא נרשם לבד",
    filled.row === 0 && filled.again === "again", filled);
  check("הנכונות בירוק והשגויות באדום",
    filled.right.every(Boolean) && filled.red.every(Boolean), filled);
  await page.waitForTimeout(1200);
  const after = await page.evaluate(({ target, order }) => {
    const slots = slotList();
    const board = slots.map(s => s.textContent || "_").join("");
    slots[0].click();
    return {
      board, expected: [...order].map((ch, k) => ch === target[k] ? ch : "_").join(""),
      firstStays: slots[0].textContent === target[0],
      inBank: [...$("bank").children].filter(t => !t.disabled).length
    };
  }, filled);
  check("השגויות חוזרות לבנק והנכונות נשארות",
    after.board === after.expected && after.inBank === after.board.split("_").length - 1, after);
  check("אות שנבדקה ונמצאה נכונה לא יוצאת בלחיצה", after.firstStays, after);

  // משלים את המשבצות הריקות באותיות הנכונות, משמאל לימין.
  await page.evaluate(() => {
    window.completeWord = () => {
      const target = word();
      for(let n; (n = slotList().findIndex(s => !s.tile)) >= 0; )
        [...$("bank").children].find(t => !t.disabled && t.dataset.letter === target[n]).click();
    };
  });
  const fixed = await page.evaluate(() => {
    const before = round.row.length;
    completeWord();
    return { row: round.row.length - before, card: $("card").className, cue: $("cue").dataset.cue };
  });
  check("כתיבה נכונה אחרי מילה שגויה — הצלחה, \"כתבתם!\", ולא נרשם לבד", fixed.row === 0 && fixed.card === "good" && fixed.cue === "wrote", fixed);
  await newBoard();

  // good() עובר למילה הבאה אחרי המשוב, ושם הלוח מתחיל מחדש.
  const spellAll = async withHint => {
    await newBoard();
    return page.evaluate(withHint => {
      const before = round.row.length, emoji = words[i].emoji;
      if(withHint) $("hint").click();
      completeWord();
      return { added: round.row.length - before, card: $("card").className, emoji,
               last: emojiFor(round.row[round.row.length - 1]),
               hinted: $("slots").querySelectorAll(".hinted").length, hintOff: $("hint").disabled };
    }, withHint);
  };
  const clean = await spellAll(false);
  check("מילה שנכתבה בלי עזרה — הצלחה, ונרשמת כלבד, כמו באמירה",
    clean.added === 1 && clean.card === "good" && clean.last === clean.emoji, clean);
  const helped = await spellAll(true);
  check("רמז ממלא אות אחת, והמילה מקבלת הצלחה בלי להירשם כלבד",
    helped.added === 0 && helped.hinted === 1 && helped.card === "good", helped);
  check("אחרי שהמילה הושלמה אין רמז", helped.hintOff, helped);
  await newBoard();

  // רמז על משבצת שיש בה אות שגויה: היא חוזרת לבנק, והאות הנכונה באה
  // ממשבצת שאינה שלה כשאין אחת כזו בבנק.
  const swapped = await page.evaluate(() => {
    i = words.findIndex(w => w.word.length >= 3 && w.word[0] !== w.word[1]
      && [...w.word].filter(ch => ch === w.word[0]).length === 1);
    show();
    const target = word(), bank = () => [...$("bank").children];
    bank().find(t => t.dataset.letter === target[1]).click();
    bank().find(t => t.dataset.letter === target[0]).click();
    $("hint").click();
    const slots = slotList();
    return {
      target, first: slots[0].textContent, hinted: slots[0].classList.contains("hinted"),
      emptied: slots.slice(1).every(s => s.textContent === ""),
      inBank: bank().filter(t => !t.disabled).length
    };
  });
  check("רמז מחליף אות שגויה ומביא את הנכונה ממקום אחר",
    swapped.first === swapped.target[0] && swapped.hinted && swapped.emptied
      && swapped.inBank === swapped.target.length - 1, swapped);
  await page.evaluate(() => show());

  // לכל תרגול סבב משלו: מעבר בין אומרים לכותבים מתחיל סבב, והשורה ריקה.
  // רגע לפני הטעינה מחדש, שמבטלת את המעברים ש-good() מזמן.
  const apart = await page.evaluate(() => {
    round.row = ["dog"];
    const word = $("word").textContent;
    setMode("say");
    return { row: round.row.length, kept: $("word").textContent === word, mode };
  });
  check("מעבר בין אומרים לכותבים מתחיל סבב חדש, והמילה שעל המסך נשארת",
    apart.row === 0 && apart.kept && apart.mode === "say", apart);
  await page.evaluate(() => setMode("spell"));

  await reload();
  check("מצב הכתיבה נשמר בין טעינות",
    await page.evaluate(() => mode) === "spell" && !(await shown("say")) && await shown("spell"));
  await page.evaluate(() => setMode("say"));
  check("חזרה לאמירה מחזירה את 🎤 ואת המילה",
    await shown("say") && !(await shown("hint")) && await shown("word") && !(await shown("spell")));

  // --------------------------------------------------------------
  group("נגישות");
  // $() מוצא רק את הראשון, אבל כלל CSS לפי id תופס את כולם: הסגנון של
  // כפתור הרמז צבע פעם את שורת ההסבר במאגר, כי גם לה קראו hint.
  const dupIds = await page.evaluate(() => {
    const seen = new Set(), dup = [];
    for(const el of document.querySelectorAll("[id]")){ if(seen.has(el.id)) dup.push(el.id); seen.add(el.id); }
    return dup;
  });
  check("אין שני אלמנטים עם אותו id", dupIds.length === 0, dupIds);

  // כל מה שהילד נוגע בו הוא לפחות 64px, גם כשהוא נראה קטן. התמונה והציפור הן
  // ציורים ולא פקדים: נגיעה מקרית בהן לא עושה כלום.
  const targets = await page.evaluate(() => {
    turn.word = null;
    i = 0;
    show();
    const small = [...document.querySelectorAll("#game button, #door button")]
      .filter(b => b.checkVisibility() && !b.classList.contains("away"))
      .map(b => ({ id: b.id || b.className, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }))
      .filter(r => r.w < 64 || r.h < 64);
    return { small, picture: $("picture").tabIndex, bird: !!$("bird").closest("button") };
  });
  check("כל כפתור על המסך של הילד הוא לפחות 64px", targets.small.length === 0, targets);
  check("התמונה והציפור אינן פקדים", targets.picture < 0 && !targets.bird, targets);

  // אזור המבוגר במקלדת: Enter על 🔒 פותח את שאלת המספר, והתשובה פותחת את
  // ההגדרות. ההגדרות מכסות את המסך, ובמקלדת גם הפוקוס צריך להישאר בהן. אחרת
  // Tab עובר על הכפתורים שמאחוריהן, ו-Enter או רווח מפעילים אותם בלי שרואים.
  // BODY הוא היציאה מהדף אל הדפדפן, בדרך חזרה לתחילת החלונית, ולא נחשב יציאה ממנה.
  await page.evaluate(() => goDoor());
  await page.focus("#lock");
  await page.keyboard.press("Enter");
  const gateDigits = await page.evaluate(() => ({ open: !$("gate").hidden, digits: String(gateNumber),
    focus: $("gate").contains(document.activeElement) }));
  for(const d of gateDigits.digits){
    await page.focus(`#gateKeys [data-digit="${d}"]`);
    await page.keyboard.press("Enter");
  }
  const opened = await page.evaluate(() => {
    window.behindClicks = [];
    window.recordBehind = e => { if(!e.target.closest("#overlay")) behindClicks.push(e.target.id || e.target.tagName); };
    document.addEventListener("click", recordBehind, true);
    return { open: !$("overlay").hidden, inPanel: $("panel").contains(document.activeElement),
             focus: document.activeElement.id || document.activeElement.tagName, gate: $("gate").hidden };
  });
  const focusAt = () => page.evaluate(() => {
    const a = document.activeElement;
    return (a.id || a.tagName) + (a === document.body || a.closest("#overlay") ? "" : " ✗");
  });
  const visited = [];
  for(const key of ["Shift+Tab", "Space", ...Array(12).fill("Tab"), ...Array(3).fill("Shift+Tab")]){
    await page.keyboard.press(key);
    visited.push(await focusAt());
  }
  await page.keyboard.press("Escape");
  const closed = await page.evaluate(() => {
    document.removeEventListener("click", recordBehind, true);
    const out = { hidden: $("overlay").hidden, focus: document.activeElement.id, behind: behindClicks, screen };
    // שהקבוצות הבאות לא יתחילו מתחת לחלונית פתוחה גם כשהבדיקה נופלת.
    if(!$("overlay").hidden) closePanel();
    return out;
  });
  check("🔒 במקלדת פותח את שאלת המספר, והתשובה פותחת את ההגדרות עם הפוקוס בתוכן",
    gateDigits.open && gateDigits.focus && opened.open && opened.inPanel && opened.gate, { gateDigits, opened });
  check("Tab ו-Shift+Tab לא מגיעים למה שמאחורי ההגדרות",
    visited.length > 0 && !visited.some(v => v.endsWith(" ✗")), visited);
  check("Esc סוגר את ההגדרות, חוזר למסך הפתיחה עם הפוקוס על 🔒, ושום דבר מאחוריהן לא הופעל",
    closed.hidden && closed.focus === "lock" && closed.behind.length === 0 && closed.screen === "door", { opened, closed });
  // וכשהן סגורות Esc לא עושה כלום. אחרת הוא מקפיץ את הפוקוס ל-🔒 מכל מקום בדף.
  await page.focus("#play");
  await page.keyboard.press("Escape");
  const escIdle = await page.evaluate(() => ({ hidden: $("overlay").hidden, focus: document.activeElement.id }));
  check("Esc כשההגדרות סגורות לא מזיז את הפוקוס", escIdle.hidden && escIdle.focus === "play", escIdle);
  // גם שאלת המספר: Tab לא יוצא ממנה, ו-Enter על ▶ שמאחוריה לא מתחיל משחק.
  const gateModal = await page.evaluate(() => {
    openGate();
    const out = { door: $("door").inert, lock: $("lock").inert, gate: $("gate").inert };
    closeGate();
    out.after = $("door").inert || $("lock").inert;
    return out;
  });
  check("כששאלת המספר פתוחה, מה שמאחוריה לא מגיב למקלדת",
    gateModal.door && gateModal.lock && !gateModal.gate && !gateModal.after, gateModal);
  await backToGame();
  // מילה באנגלית בתוך דף בעברית מסומנת באנגלית, כדי שקורא מסך יקרא אותה כך.
  const english = await page.evaluate(() => {
    const lang = el => el && (el.closest("[lang]") || {}).lang;
    openPanel();
    showSettingsView("catalog", false);
    const out = { word: lang($("word")), gate: lang($("gateWord")), catalog: lang(document.querySelector(".catalog-item-name")),
                  picture: lang(picture("dog")) };
    showSettingsView("words", false);
    out.list = lang(document.querySelector("#wordList .w"));
    closePanel();
    return out;
  });
  await backToGame();
  check("מילים באנגלית מסומנות lang=\"en\"", Object.values(english).every(l => l === "en"), english);

  // --------------------------------------------------------------
  group("קישורי המשוב");
  // הכתובת היא קבוע אחד. אם היא תיכתב שוב ב-HTML, החלפת טופס תשאיר עותק
  // על הטופס הישן בלי שאף אחד ישים לב.
  const feedbackHrefs = await page.evaluate(
    () => [...document.querySelectorAll("a[data-feedback]")].map(a => a.href));
  check("קישור משוב אחד, באזור המבוגר",
    feedbackHrefs.length === 1 && await page.evaluate(() => $("panel").contains(document.querySelector("a[data-feedback]"))), feedbackHrefs);
  check("הכתובת היא טופס Google",
    feedbackHrefs.every(h => /^https:\/\/docs\.google\.com\/forms\//.test(h)), feedbackHrefs);
  const html = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
  const formPath = feedbackHrefs[0] ? new URL(feedbackHrefs[0]).pathname : "";
  check("הכתובת כתובה במקור פעם אחת",
    !!formPath && html.split(formPath).length - 1 === 1, formPath);

  // --------------------------------------------------------------
  group("מיקרופון");
  // נשאר פתוח בין ניסיונות בכוונה, אבל לא כשהדף יורד מהמסך — אחרת חיווי
  // ההקלטה של הדפדפן נשאר דולק על אפליקציה שאף אחד לא משתמש בה.
  await page.evaluate(() => ensureAudio());
  await page.waitForTimeout(300);
  check("המיקרופון נפתח", await page.evaluate(() => !!micStream));
  // המסלול שנבדק בכל מכשיר נשאר כל עוד הדפדפן מציע אותו.
  check("כשיש createScriptProcessor המיקרופון עובר דרכו",
    await page.evaluate(() => procNode.constructor.name) === "ScriptProcessorNode");
  // micStream === null לבדו לא אומר כלום: מסלול שלא נעצר ממשיך להקליט גם
  // בלי משתנה שמחזיק אותו.
  const released = await page.evaluate(() => {
    const tracks = micStream.getTracks();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    return { gone: micStream === null, tracks: tracks.map(t => t.readyState) };
  });
  check("המיקרופון משוחרר כשהדף יורד מהמסך",
    released.gone && released.tracks.length > 0 && released.tracks.every(s => s === "ended"), released);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    return ensureAudio();
  });
  await page.waitForTimeout(300);
  check("המיקרופון חוזר לעבוד", await page.evaluate(() => !!micStream));

  // פתיחת המיקרופון לוקחת זמן, ובינתיים ילד נוגע שוב, יוצא מהאפליקציה או
  // עובר לכתיבה. כאן listen() נקרא כשהמיקרופון סגור, during קורה בזמן
  // שהדפדפן פותח אותו, ובסוף הדף יורד מהמסך.
  await page.waitForFunction(() => model !== null, null, { timeout: 60000 });
  const loaded = await page.evaluate(() => ({ screen, say: isShown($("say")), error: modelError, status: $("deviceStatus").hidden }));
  check("המנוע נטען — 🎤 על המסך, ושום דבר באזור המבוגר",
    loaded.screen === "game" && loaded.say && !loaded.error && loaded.status, loaded);
  const whileOpening = ({ taps = 1, during = null }) => page.evaluate(async ({ taps, during }) => {
    const real = navigator.mediaDevices.getUserMedia, tracks = [];
    let opens = 0;
    const live = () => tracks.filter(t => t.readyState === "live").length;
    const hide = h => {
      Object.defineProperty(document, "hidden", { value: h, configurable: true });
      if(h) document.dispatchEvent(new Event("visibilitychange"));
    };
    navigator.mediaDevices.getUserMedia = async function(c){
      opens++;
      if(during === "deny") throw new DOMException("denied", "NotAllowedError");
      const s = await real.call(this, c);
      tracks.push(...s.getTracks());
      if(during === "hide") hide(true);
      if(during === "spell") setMode("spell");
      return s;
    };
    try{
      releaseMic();
      await Promise.all(Array.from({ length: taps }, () => listen()));
      const out = { opens, active, opening, listening: $("say").classList.contains("listening"), live: live(),
                    screen, blocked: micBlocked };
      stopListening();
      hide(true);
      out.liveAfterHide = live();
      return out;
    } finally {
      navigator.mediaDevices.getUserMedia = real;
      hide(false);
      setMode("say");
      micBlocked = false;
      renderStatus();
      if(screen !== "game") enterGame();
    }
  }, { taps, during });
  // סירוב: "קראו למבוגר", ומשם ▶ ממשיך בשומעים ובוחרים. סירוב שהשאיר את
  // הדגל דולק היה נועל את 🎤 גם אחרי שמבוגר אישר.
  const denied = await whileOpening({ during: "deny" });
  check("סירוב למיקרופון — \"קראו למבוגר\", בלי להשאיר את הפתיחה נעולה",
    denied.opens === 1 && !denied.active && !denied.opening && denied.screen === "grownup" && denied.blocked, denied);
  const doubleTap = await whileOpening({ taps: 2 });
  check("נגיעה כפולה פותחת את המיקרופון פעם אחת",
    doubleTap.opens === 1 && doubleTap.active && doubleTap.liveAfterHide === 0, doubleTap);
  const hiddenWhileOpening = await whileOpening({ during: "hide" });
  check("דף שירד מהמסך בזמן שהמיקרופון נפתח לא מקשיב ולא מחזיק אותו",
    hiddenWhileOpening.opens === 1 && !hiddenWhileOpening.active && hiddenWhileOpening.live === 0, hiddenWhileOpening);
  const spellWhileOpening = await whileOpening({ during: "spell" });
  check("מעבר לכתיבה בזמן שהמיקרופון נפתח לא מתחיל להקשיב",
    spellWhileOpening.opens === 1 && !spellWhileOpening.active && !spellWhileOpening.listening, spellWhileOpening);

  // הרשאה שבוטלה או מיקרופון שנותק עוצרים את המסלול, והזרם נשאר. אילו הוא
  // נחשב פתוח, כל ניסיון היה מקשיב לשקט עד שהדף יורד מהמסך.
  const ended = await page.evaluate(async () => {
    await ensureAudio();
    const readyBefore = audioReady();
    const oldSrc = srcNode, disconnect = oldSrc.disconnect.bind(oldSrc);
    let detached = false;
    oldSrc.disconnect = (...a) => { detached = true; return disconnect(...a); };
    micStream.getTracks().forEach(t => t.stop());
    const ready = audioReady();
    await ensureAudio();
    return { readyBefore, ready, detached, replaced: srcNode !== oldSrc,
             after: micStream.getTracks().map(t => t.readyState) };
  });
  check("מיקרופון שהמסלול שלו נגמר לא נחשב פתוח", ended.readyBefore && !ended.ready, ended);
  check("מיקרופון שהמסלול שלו נגמר נפתח מחדש",
    ended.after.length > 0 && ended.after.every(s => s === "live"), ended);
  check("הזרם המת מנותק מגרף השמע", ended.detached && ended.replaced, ended);

  // רשימה שנשמרה בחלון אחר צריכה להגיע גם ל-recognizer, שמכיר רק את מה שהיה
  // ברשימה כשנבנה: מילה שלא נכנסה לדקדוק לא תזוהה לעולם. grammar() נבנה
  // מ-words ומראה את המילה גם בלי בנייה מחדש, ולכן נרשם גם מה שנשלח ל-worker.
  const recBefore = await page.evaluate(() => {
    window.recBeforeSync = rec;
    window.recCreated = [];
    model.postMessage = function(m, ...rest){
      if(m && m.action === "create") recCreated.push(m);
      return Object.getPrototypeOf(this).postMessage.call(this, m, ...rest);
    };
    const taken = takenSet(), [emoji, word] = PAIRS.find(p => !taken.has(p[1]));
    return { had: !!rec, raw: localStorage.getItem("words") ?? JSON.stringify(words), list: words.slice(),
             added: { emoji, word } };
  });
  const recTab = await ctx.newPage();
  let recSync;
  try{
    await recTab.goto(base + "/manifest.json");
    const longer = recBefore.list.concat([recBefore.added]);
    await writeFromTab(recTab, JSON.stringify(longer), longer.map(w => w.word).join());
    recSync = await page.evaluate(added => ({
      fresh: !!rec && rec !== recBeforeSync, inGrammar: JSON.parse(grammar()).includes(added),
      sent: recCreated.filter(m => rec && m.recognizerId === rec.id).map(m => JSON.parse(m.grammar).includes(added))
    }), recBefore.added.word);
    await writeFromTab(recTab, recBefore.raw, recBefore.list.map(w => w.word).join());
  } finally {
    await recTab.close();
    await page.evaluate(() => { delete model.postMessage; delete window.recBeforeSync; delete window.recCreated; });
  }
  check("רשימה שנשמרה בחלון אחר נכנסת גם לדקדוק של המנוע",
    recBefore.had && recSync.fresh && recSync.inGrammar && recSync.sent.length === 1 && recSync.sent[0],
    { had: recBefore.had, added: recBefore.added.word, ...recSync });

  // אותו דבר במעבר לילד אחר: המילים שלו צריכות להגיע ל-recognizer, אחרת אף
  // אחת מהן לא תזוהה. הילד נכתב ישר ל-localStorage, והמצב משוחזר בסוף.
  const childGrammar = await page.evaluate(() => {
    const saved = { i };
    const taken = takenSet(), [emoji, word] = PAIRS.find(p => !taken.has(p[1]));
    localStorage.setItem("words@grammartest", JSON.stringify([{ emoji, word }]));
    localStorage.setItem("say-the-word-children", JSON.stringify([{ id: "grammartest", name: "בדיקה" }]));
    const before = rec, sent = [];
    model.postMessage = function(m, ...rest){
      if(m && m.action === "create") sent.push(m);
      return Object.getPrototypeOf(this).postMessage.call(this, m, ...rest);
    };
    try{
      switchChild("grammartest");
      return { word, fresh: !!rec && rec !== before,
               sent: sent.filter(m => rec && m.recognizerId === rec.id).map(m => JSON.parse(m.grammar)) };
    } finally {
      delete model.postMessage;
      for(const k of ["words@grammartest", "say-the-word-children", "say-the-word-child"]) localStorage.removeItem(k);
      switchChild("", false);
      i = saved.i;
      show();
    }
  });
  check("מעבר לילד אחר בונה את הדקדוק של המנוע מהמילים שלו",
    childGrammar.fresh && childGrammar.sent.length === 1 && childGrammar.sent[0].includes(childGrammar.word)
      && childGrammar.sent[0].length === 2, childGrammar);

  // --------------------------------------------------------------
  group("החלטה");
  // רק תוצאה סופית מחליטה. תוצאה חלקית היא ניחוש באמצע הדיבור, ומול המודל
  // האמיתי "elephant" עובר דרך apple ונגמר כ-[unk], ורעש ורוד נשמע כ-house.
  // האירועים נשלחים ל-recognizer עצמו, כך שגם החיווט ב-buildRecognizer
  // נבדק ולא רק הפונקציה.
  await page.waitForFunction(() => model !== null, null, { timeout: 60000 });
  await page.evaluate(() => { setPreset(DEFAULT_PRESET); return ensureAudio(); });
  // won: good() נקרא, כלומר הילד קיבל 🎉.
  const attempt = async events => await page.evaluate(async evs => {
    await listen();
    const target = word(), realGood = good;
    let won = false;
    good = () => { won = true; return realGood(); };
    try{
      for(const [type, detail] of evs)
        rec.dispatchEvent(new CustomEvent(type, { detail: JSON.parse(JSON.stringify(detail).replaceAll("TARGET", target)) }));
      return { active, won };
    } finally {
      good = realGood;
      stopListening();
    }
  }, events);
  const said = (w, conf = 1) => ["result", { result: { result: [{ word: w, conf }], text: w } }];

  const partialOnly = await attempt([["partialresult", { result: { partial: "TARGET" } }]]);
  check("תוצאה חלקית לבדה לא מזכה", !partialOnly.won && partialOnly.active, partialOnly);
  const unkOnly = await attempt([said("[unk]")]);
  check("[unk] בתוצאה סופית ממשיך להקשיב", unkOnly.active && !unkOnly.won, unkOnly);
  const right = await attempt([["partialresult", { result: { partial: "TARGET" } }], said("TARGET")]);
  check("המילה הנכונה בתוצאה סופית מזכה", right.won && !right.active, right);
  const wrong = await attempt([said("zzz")]);
  check("מילה שגויה בתוצאה סופית מסיימת בכישלון", !wrong.won && !wrong.active, wrong);

  // ילד שאומר את המילה ממש בסוף החלון: המנוע עוד לא שמע שקט אחריה ולא שלח
  // תוצאה סופית מעצמו. מול המודל האמיתי, הקלטה שנחתכה מיד אחרי המילה החזירה
  // אותה רק דרך retrieveFinalResult. כאן ה-recognizer מדומה בדיוק כך: עונה
  // רק כשמבקשים, ובאיחור קטן, כמו ה-worker.
  const atWindowEnd = async answer => await page.evaluate(async answer => {
    const realWindow = listenWindowMs, realRetrieve = rec.retrieveFinalResult, realAgain = again, realGood = good;
    const say = $("say"), sayClasses = [];
    let agains = 0, won = false;
    listenWindowMs = () => 100;
    again = why => { agains++; return realAgain(why); };
    good = () => { won = true; return realGood(); };
    rec.retrieveFinalResult = function(){
      if(answer) setTimeout(() => this.dispatchEvent(new CustomEvent("result",
        { detail: { result: { result: [{ word: answer === "TARGET" ? word() : answer, conf: 1 }] } } })), 50);
    };
    const obs = new MutationObserver(() => sayClasses.push(say.className));
    obs.observe(say, { attributes: true, attributeFilter: ["class"] });
    try{
      const misses = sayMisses;
      await listen();
      await new Promise(r => setTimeout(r, 100 + FINAL_GRACE_MS + FINAL_ANSWER_MS + GOOD_MS + 300));
      return { active, won, agains, missed: sayMisses - misses,
               nudged: sayClasses.some(c => c.split(" ").includes("nudge")) };
    } finally {
      obs.disconnect();
      listenWindowMs = realWindow;
      rec.retrieveFinalResult = realRetrieve;
      again = realAgain;
      good = realGood;
      stopListening();
    }
  }, answer);
  const lateRight = await atWindowEnd("TARGET");
  check("מילה נכונה בסוף החלון מזכה", lateRight.won && !lateRight.active, lateRight);
  // ילד שעוד מחפש את המילה, או שדיבר חלש מדי, לא טעה. החלון נסגר בלי
  // "נסו שוב", ו-🎤 פועם פעם אחת כדי שיידע שאפשר לנסות שוב.
  const lateNothing = await atWindowEnd(null);
  check("בלי תשובה מהמנוע החלון נסגר בלי \"נסו שוב\" ולא נחשב ניסיון",
    !lateNothing.won && !lateNothing.active && lateNothing.agains === 0 && lateNothing.missed === 0, lateNothing);
  check("חלון שנגמר בלי מילה — 🎤 פועם פעם אחת", lateNothing.nudged && !lateRight.nudged, { lateNothing, lateRight });
  // ילד שמתחיל את המילה ממש בסוף החלון. עד שהיא נגמרת, בקשה לתוצאה סופית
  // מחזירה "" וחותכת אותה. כאן המילה נגמרת 300ms אחרי סוף החלון: מי שמבקש
  // כבר בסוף החלון מפסיד אותה, ומי שמבקש בסוף ההמתנה מקבל אותה כשהניסיון
  // עוד פעיל. נמדד מול המודל האמיתי, עם מילה מוקלטת שהתחילה 300ms לפני הסוף.
  const lateStart = await page.evaluate(async () => {
    const realWindow = listenWindowMs, realRetrieve = rec.retrieveFinalResult, realGood = good;
    let won = false, t0 = 0, cut = false;
    const asked = [];
    listenWindowMs = () => 100;
    good = () => { won = true; return realGood(); };
    // בקשה באמצע המילה מאפסת את המפענח, והמילה כבר לא תחזור.
    rec.retrieveFinalResult = function(){
      const at = performance.now() - t0, done = at >= 100 + 300 && !cut;
      if(at < 100 + 300) cut = true;
      asked.push(Math.round(at));
      setTimeout(() => this.dispatchEvent(new CustomEvent("result", { detail: { result:
        done ? { result: [{ word: word(), conf: 1 }], text: word() } : { text: "" } } })), 50);
    };
    try{
      await listen();
      t0 = performance.now();
      await new Promise(r => setTimeout(r, 100 + FINAL_GRACE_MS + FINAL_ANSWER_MS + GOOD_MS + 300));
      return { won, asked, active };
    } finally {
      listenWindowMs = realWindow;
      rec.retrieveFinalResult = realRetrieve;
      good = realGood;
      stopListening();
    }
  });
  check("מילה שהתחילה ממש בסוף החלון ונגמרה אחריו — מתקבלת", lateStart.won && !lateStart.active, lateStart);

  // מעבר לכתיבה באמצע הקשבה עוצר אותה בשקט: זה לא ניסיון שנכשל, ו"נסו שוב"
  // היה נשמע כאילו הילד טעה.
  const switched = await page.evaluate(async () => {
    const realAgain = again;
    let failures = 0;
    again = () => { failures++; };
    try{
      await listen();
      const wasActive = active;
      setMode("spell");
      return { wasActive, active, failures, listening: $("say").classList.contains("listening") };
    } finally {
      again = realAgain;
      setMode("say");
    }
  });
  check("מעבר לכתיבה באמצע הקשבה לא נחשב כישלון",
    switched.wasActive && !switched.active && switched.failures === 0 && !switched.listening, switched);

  // וכך גם מילה אחרת על המסך. בלי זה שאר החלון, או תוצאה סופית שמגיעה
  // באיחור, נשפטים מול המילה החדשה, והילד שומע "נסו שוב" על מילה שלא ניסה.
  // ההמתנה בדף היא החלון, FINAL_GRACE_MS ו-FINAL_ANSWER_MS, ועוד מרווח. כל מה
  // שהתמונה הייתה נאסף, כי "נסו שוב" נשאר עליה רק לרגע. גם הקריאות ל-again()
  // ול-good() נספרות: עצירה שאומרת "נסו שוב" לפני ש-show() מנקה את התמונה לא
  // משאירה עליה סימן.
  const skipWhileListening = how => page.evaluate(async how => {
    const real = { listenWindowMs, again, good, words }, pic = $("card"), seen = [], calls = [];
    listenWindowMs = () => 200;
    again = why => { calls.push("again"); return real.again(why); };
    good = () => { calls.push("good"); return real.good(); };
    try{
      await listen();
      const was = active, from = word();
      if(how === "list"){
        // רשימה חדשה, כמו מ-#practiceSetBtn במאגר, ועל המסך המילה שאחרי זו שהייתה.
        applyWords(words.slice().reverse(), words.length - 1 - (i + 1) % words.length);
      } else next();
      const out = { was, from, to: word(), active, listening: $("say").classList.contains("listening") };
      const obs = new MutationObserver(ms => { for(const m of ms) seen.push(m.oldValue); });
      obs.observe(pic, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
      if(how === "late") rec.dispatchEvent(new CustomEvent("result",
        { detail: { result: { result: [{ word: from, conf: 1 }], text: from } } }));
      await new Promise(r => setTimeout(r, listenWindowMs()));
      await new Promise(r => setTimeout(r, FINAL_GRACE_MS + FINAL_ANSWER_MS + 200));
      for(const m of obs.takeRecords()) seen.push(m.oldValue);
      obs.disconnect();
      return { ...out, calls, seen: seen.concat(pic.className) };
    } finally {
      listenWindowMs = real.listenWindowMs;
      again = real.again;
      good = real.good;
      stopListening();
      // הסדר המקורי חוזר, כדי שהקבוצות הבאות יראו את אותה רשימה.
      if(words !== real.words) applyWords(real.words, real.words.indexOf(words[i]));
    }
  }, how);
  const skips = {
    next: "⏭️ באמצע הקשבה עוצר אותה בלי \"נסו שוב\"",
    late: "תוצאה סופית מאוחרת למילה הקודמת לא נשפטת מול החדשה",
    list: "החלפת הרשימה באמצע הקשבה עוצרת אותה בלי \"נסו שוב\""
  };
  for(const [how, name] of Object.entries(skips)){
    const s = await skipWhileListening(how);
    check(name, s.was && s.to !== s.from && !s.active && !s.listening && s.calls.length === 0
      && !s.seen.some(c => c === "again" || c === "good"), s);
  }
  // good() ו-again() מזמנים מעברים והודעות; שלא ידרסו את הקבוצה הבאה.
  await page.waitForTimeout(1500);

  // אמירה שלא התקבלה: בפעם הראשונה הכרטיס רועד, בלי צליל, ואחרי רגע, עם שמע,
  // המילה נאמרת פעם אחת באנגלית. בפעם השנייה הכרטיס נופל לכיס ובאה מילה אחרת.
  // הדיבור נספר ב-speechSynthesis עצמו: speak() נקראת גם כשהשמע כבוי, ופשוט
  // חוזרת. כל מקרה מתחיל ממילה חדשה ומחכה עד שהטיימרים שלו נגמרים.
  const notYetRun = scenario => page.evaluate(async scenario => {
    const real = { again, chime, soundEnabled }, synth = speechSynthesis, pic = $("card");
    const log = { again: 0, chime: 0, spoken: [], cancels: 0, classes: [] };
    again = why => { log.again++; return real.again(why); };
    chime = sound => { log.chime++; return real.chime(sound); };
    synth.speak = u => { log.spoken.push([u.text, u.lang]); };
    synth.cancel = () => { log.cancels++; };
    const obs = new MutationObserver(() => log.classes.push(pic.className));
    obs.observe(pic, { attributes: true, attributeFilter: ["class"] });
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const miss = async () => {
      await listen();
      rec.dispatchEvent(new CustomEvent("result", { detail: { result: { result: [{ word: "zzz", conf: 1 }], text: "zzz" } } }));
    };
    const mark = () => ({ again: log.again, chime: log.chime, spoken: log.spoken.length, classes: log.classes.length });
    try{
      soundEnabled = scenario !== "muted";
      turn.word = null;
      show();
      const out = { start: shownCount, target: word() };
      if(scenario === "first" || scenario === "muted"){
        await miss();
        out.misses = sayMisses;
        await wait(AGAIN_MS + 300);
        out.shown = shownCount;
      } else if(scenario === "second"){
        await miss();
        await wait(AGAIN_MS + 100);
        out.before = mark();
        await miss();
        await wait(AGAIN_MS + 300);
        out.after = mark();
        out.shown = shownCount;
      } else if(scenario === "redisplay"){
        // אותה מילה מוצגת שוב באותו תור: הדלקת התעתיק, רשימה שנשמרה בחלון אחר.
        await miss();
        await wait(AGAIN_MS + 100);
        show();
        out.redisplayed = shownCount;
        out.before = mark();
        await miss();
        await wait(AGAIN_MS + 300);
        out.after = mark();
        out.shown = shownCount;
      } else if(scenario === "retry"){
        await miss();
        await listen();
        await wait(CHIME_SECONDS * 1000 + 200);
        out.listening = active;
      } else if(scenario === "reset"){
        await miss();
        next();
        out.next = shownCount;
        await miss();
        await wait(AGAIN_MS + 300);
        out.shown = shownCount;
        out.misses = sayMisses;
      } else if(scenario === "skip"){
        await miss();
        await wait(AGAIN_MS + 100);
        await miss();
        next();
        out.next = shownCount;
        await wait(AGAIN_MS + 300);
        out.shown = shownCount;
      } else if(scenario === "cancel"){
        const before = log.cancels;
        await listen();
        out.cancelled = log.cancels - before;
      }
      return { ...out, log };
    } finally {
      obs.disconnect();
      stopListening();
      again = real.again;
      chime = real.chime;
      soundEnabled = real.soundEnabled;
      delete synth.speak;
      delete synth.cancel;
    }
  }, scenario);
  const firstMiss = await notYetRun("first");
  check("אמירה ראשונה שלא התקבלה — הכרטיס רועד, בלי צליל טעות, ונשארים על המילה",
    firstMiss.misses === 1 && firstMiss.shown === firstMiss.start && firstMiss.log.again === 1
      && firstMiss.log.classes.includes("again") && firstMiss.log.chime === 0, firstMiss);
  check("עם שמע, אחרי אמירה ראשונה שלא התקבלה המילה נאמרת פעם אחת באנגלית",
    JSON.stringify(firstMiss.log.spoken) === JSON.stringify([[firstMiss.target, "en-US"]]), firstMiss.log);
  const mutedMiss = await notYetRun("muted");
  check("בלי שמע אין הקראה אחרי אמירה שלא התקבלה",
    mutedMiss.misses === 1 && mutedMiss.log.spoken.length === 0, mutedMiss.log);
  const secondMiss = await notYetRun("second");
  check("אמירה שנייה שלא התקבלה — הכרטיס נופל לכיס ובאה מילה אחרת, בלי רעידה, בלי צליל ובלי הקראה",
    secondMiss.shown === secondMiss.start + 1 && secondMiss.after.again === secondMiss.before.again
      && secondMiss.after.chime === secondMiss.before.chime && secondMiss.after.spoken === secondMiss.before.spoken
      && !secondMiss.log.classes.slice(secondMiss.before.classes).includes("again")
      && secondMiss.log.classes.slice(secondMiss.before.classes).includes("fall"), secondMiss);
  // הספירה שייכת לתור ולא להצגה. אחרת האמירה השנייה נרשמת בסולם כ-failed,
  // ועל המסך מקבלת "עוד פעם" במקום הכיס.
  const redisplayed = await notYetRun("redisplay");
  check("הצגה מחדש של אותה מילה לא מאפסת את ספירת האמירות שלא התקבלו",
    redisplayed.shown === redisplayed.redisplayed + 1
      && redisplayed.log.classes.slice(redisplayed.before.classes).includes("fall")
      && redisplayed.after.again === redisplayed.before.again, redisplayed);
  const retried = await notYetRun("retry");
  check("מי שכבר לוחץ שוב על 🎤 לא שומע את ההקראה באמצע",
    retried.listening && retried.log.spoken.length === 0, retried);
  const perWord = await notYetRun("reset");
  check("ספירת האמירות שלא התקבלו מתחילה מחדש בכל מילה",
    perWord.shown === perWord.next && perWord.misses === 1, perWord);
  const skippedAfter = await notYetRun("skip");
  check("מילה שנבחרה ב-⏭️ אחרי אמירה שנייה שלא התקבלה לא מוחלפת",
    skippedAfter.shown === skippedAfter.next, skippedAfter);
  const cancelledSpeech = await notYetRun("cancel");
  check("נגיעה ב-🎤 עוצרת הקראה שעוד נשמעת", cancelledSpeech.cancelled === 1, cancelledSpeech);
  // ירידה מהמסך משחררת את המיקרופון, ולכן היא אחרונה ומחזירה אותו בסוף.
  const hiddenMid = await page.evaluate(async () => {
    const realAgain = again;
    let agains = 0;
    again = why => { agains++; return realAgain(why); };
    try{
      turn.word = null;
      show();
      const misses = sayMisses;
      await listen();
      const was = active;
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      return { was, active, agains, missed: sayMisses - misses };
    } finally {
      again = realAgain;
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      await ensureAudio();
    }
  });
  check("ירידה מהמסך באמצע הקשבה לא נחשבת ניסיון",
    hiddenMid.was && !hiddenMid.active && hiddenMid.agains === 0 && hiddenMid.missed === 0, hiddenMid);
  await page.waitForTimeout(500);

  // --------------------------------------------------------------
  group("התקדמות");
  // כל ניסיון נרשם לילד שעל המסך: ההתקדמות בכל מילה, ויומן בלי הקלטות.
  // היום מוחלף ב-dayNumber, כמו listenWindowMs, כדי לבדוק ימים שונים בלי שעון.
  const P = "say-the-word-progress", L = "say-the-word-log";
  await page.evaluate(([P, L]) => { localStorage.removeItem(P); localStorage.removeItem(L); }, [P, L]);

  const ladder = await page.evaluate(() => {
    const a = ladderStep(undefined, "clean", 100);
    const b = ladderStep(a, "clean", 100);
    const c = ladderStep(b, "clean", 101);
    const d = ladderStep(c, "failed", 105);
    const back = ladderStep(a, "clean", 99);
    const helped = ladderStep(c, "helped", 103);
    const wrote = ladderStep(c, "write", 104);
    const text = ladderStep(undefined, "cleanText", 100);
    const textThenPicture = ladderStep(text, "clean", 100);
    const nextDay = ladderStep(textThenPicture, "clean", 101);
    // מילה שכבר הצליחה, ירדה לתיבה 0, ואז באותו יום הצלחה אחרי הצצה בכתיבה ועוד אחת מהתמונה.
    const dropped = ladderStep(ladderStep(undefined, "cleanText", 98), "failed", 99);
    const peekedAgain = ladderStep(dropped, "cleanText", 100);
    const thenClean = ladderStep(peekedAgain, "clean", 100);
    return { a, b, c, d, back, helped, wrote, text, textThenPicture, nextDay, peekedAgain, thenClean };
  });
  const L1 = ladder;
  check("הצלחה נקייה ראשונה מעלה לתיבה 1 ומסמנת שהילד הצליח",
    L1.a.met === 100 && L1.a.box === 1 && L1.a.got === 100 && L1.a.due === 101 && L1.a.n === 1 && L1.a.k === 1
      && JSON.stringify(L1.a.ok) === "[100]", L1.a);
  check("הצלחה חוזרת באותו יום נספרת ולא מעלה תיבה",
    L1.b.box === 1 && L1.b.n === 2 && L1.b.k === 2 && JSON.stringify(L1.b.ok) === "[100]", L1.b);
  check("הצלחה נקייה ביום אחר — שני ימים של \"אמר\"",
    L1.c.box === 2 && L1.c.due === 103 && JSON.stringify(L1.c.ok) === "[100,101]", L1.c);
  check("שתי אמירות שלא התקבלו מורידות תיבה, ומה שהילד כבר הצליח נשאר",
    L1.d.box === 1 && L1.d.due === 106 && L1.d.got === 100 && L1.d.ok.length === 2, L1.d);
  check("שעון שחזר אחורה נחשב לאותו יום ולא מקדם",
    L1.back.seen === 100 && L1.back.box === 1 && JSON.stringify(L1.back.ok) === "[100]", L1.back);
  check("הצלחה אחרי עזרה נספרת ולא מקדמת",
    L1.helped.box === L1.c.box && L1.helped.k === L1.c.k && L1.helped.n === L1.c.n + 1, L1.helped);
  check("הצלחה כשהמילה כתובה על המסך מסמנת שהצליח ומחזירה את המילה מחר, בלי יום של \"אמר\"",
    L1.text.got === 100 && L1.text.box === 1 && L1.text.due === 101 && L1.text.ok.length === 0 && L1.text.k === 1, L1.text);
  check("ובאותו יום מהתמונה — יום של \"אמר\", בלי לעלות שוב תיבה",
    JSON.stringify(L1.textThenPicture.ok) === "[100]" && L1.textThenPicture.box === 1 && L1.textThenPicture.due === 101,
    L1.textThenPicture);
  check("ולמחרת מהתמונה — היום השני, ותיבה למעלה",
    JSON.stringify(L1.nextDay.ok) === "[100,101]" && L1.nextDay.box === 2 && L1.nextDay.due === 103, L1.nextDay);
  check("הצלחה עם כתב במילה שכבר הצליחה לא מעלה תיבה, וגם אחריה התיבה עולה פעם אחת ביום",
    L1.peekedAgain.box === 0 && L1.thenClean.box === 1 && JSON.stringify(L1.thenClean.ok) === "[100]", L1);
  check("כתיבה נקייה מסמנת שהילד כותב את המילה, ולא נוגעת בסולם של האמירה",
    L1.wrote.wrote === 104 && L1.wrote.box === L1.c.box && L1.wrote.n === L1.c.n
      && JSON.stringify(L1.wrote.ok) === JSON.stringify(L1.c.ok), L1.wrote);

  // ניסיונות אמיתיים, דרך ה-recognizer, כמו בקבוצת ההחלטה.
  const probe = how => page.evaluate(async ([how, P, L]) => {
    const realDay = dayNumber, realWindow = listenWindowMs, realRetrieve = rec.retrieveFinalResult;
    const realSound = soundEnabled, synth = speechSynthesis;
    synth.speak = () => {};
    dayNumber = () => 200;
    const store = k => JSON.parse(localStorage.getItem(k) || "null");
    const say = async w => {
      await listen();
      rec.dispatchEvent(new CustomEvent("result", { detail: { result: { result: [{ word: w, conf: 1 }], text: w } } }));
    };
    try{
      localStorage.removeItem(P); localStorage.removeItem(L);
      next();
      const target = word();
      const settle = () => new Promise(r => setTimeout(r, Math.max(GOOD_MS, AGAIN_MS) + 200));
      if(how === "accept"){ await say(target); await settle(); }
      else if(how === "heard"){ playCurrentWord(); await say(target); await settle(); }
      else if(how === "toggle"){ setSound(false); toggleSound(); await say(target); await settle(); }
      else if(how === "rerender"){
        playCurrentWord(); setMode("spell"); setMode("say");
        await say(target); await settle();
      } else if(how === "missThenHit"){
        setSound(false);
        await say("zzz");
        await new Promise(r => setTimeout(r, AGAIN_MS + 100));
        await say(target); await settle();
      } else if(how === "skip") skipWord();
      else if(how === "skipDuringCheer"){ await say(target); skipWord(); await settle(); }
      else if(how === "sayDuringCheer"){ await say(target); await say(target); await settle(); }
      else if(how === "listSpeak"){
        setSound(true);
        renderList();
        $("wordList").querySelector(`li[data-index="${i}"] .speak-word-btn`).click();
        await say(target); await settle();
      }
      else if(how === "twoMisses"){
        localStorage.setItem(P, JSON.stringify({ v: 1, w: { [target]: { met: 90, seen: 190, box: 2, due: 199, ok: [180, 190], got: 90, n: 5, k: 3 } } }));
        await say("zzz");
        await new Promise(r => setTimeout(r, AGAIN_MS + 100));
        await say("zzz");
        await new Promise(r => setTimeout(r, AGAIN_MS + 300));
      } else if(how === "quiet"){
        listenWindowMs = () => 100;
        rec.retrieveFinalResult = () => {};
        await listen();
        await new Promise(r => setTimeout(r, 100 + FINAL_GRACE_MS + FINAL_ANSWER_MS + 300));
      }
      const log = store(L), prog = store(P);
      return { target, threshold: preset.threshold, presetId: preset.id, size: words.length,
               log: log && log.a, rec: prog && prog.w[target] };
    } finally {
      stopListening();
      dayNumber = realDay; listenWindowMs = realWindow; rec.retrieveFinalResult = realRetrieve;
      if(soundEnabled !== realSound) setSound(realSound);
      delete synth.speak;
    }
  }, [how, P, L]);
  const accepted = await probe("accept");
  const lastOf = r => (r.log || []).slice(-1)[0] || [];
  const acc = lastOf(accepted);
  check("אמירה שהתקבלה נרשמת ביומן: המילה, ניסיון ראשון, הניקוד ומה שהמנוע שמע",
    acc[0] === 200 && acc[2] === accepted.target && acc[3] === "say" && acc[4] === "ok" && acc[5] === 1
      && String(acc[6]).includes("t") && !String(acc[6]).includes("h") && acc[7] >= accepted.threshold && acc[8] === accepted.target
      && acc[9] === accepted.presetId && acc[10] === accepted.size, accepted);
  check("ובהתקדמות של המילה: הצלחה נקייה ראשונה",
    !!accepted.rec && accepted.rec.got === 200 && accepted.rec.box === 1 && accepted.rec.k === 1, accepted.rec);
  const heardFirst = await probe("heard");
  check("מי ששמע את המילה לפני שאמר אותה — נרשם, ולא נחשב להצלחה נקייה",
    String(lastOf(heardFirst)[6]).includes("h") && !!heardFirst.rec && heardFirst.rec.k === 0
      && heardFirst.rec.got === undefined && heardFirst.rec.box === 0, heardFirst);
  const twoMisses = await probe("twoMisses");
  const missLog = (twoMisses.log || []).slice(-2);
  check("שתי אמירות שלא התקבלו — שני ניסיונות ביומן, תיבה אחת למטה, והצלחה ישנה נשארת",
    missLog.length === 2 && missLog.every(e => e[4] === "no") && missLog[0][5] === 1 && missLog[1][5] === 2
      && !!twoMisses.rec && twoMisses.rec.box === 1 && twoMisses.rec.got === 90 && twoMisses.rec.n === 7, twoMisses);
  check("והמילה תחזור מחר", !!twoMisses.rec && twoMisses.rec.due === 201, twoMisses.rec);
  const toggled = await probe("toggle");
  check("הדלקת השמע, שאומרת את המילה, נחשבת לשמיעה לפני הניסיון",
    !!toggled.rec && toggled.rec.k === 0 && String(lastOf(toggled)[6]).includes("h"), toggled);
  const rerendered = await probe("rerender");
  check("מעבר לכתיבה וחזרה לא מוחק את מה שכבר קרה עם המילה",
    !!rerendered.rec && rerendered.rec.k === 0 && rerendered.rec.box === 0 && String(lastOf(rerendered)[6]).includes("h"), rerendered);
  const missThenHit = await probe("missThenHit");
  check("הצלחה בניסיון השני נרשמת כניסיון 2, ולא כהצלחה נקייה",
    lastOf(missThenHit)[4] === "ok" && lastOf(missThenHit)[5] === 2 && !!missThenHit.rec
      && missThenHit.rec.k === 0 && missThenHit.rec.box === 0, missThenHit);
  const skipRun = await probe("skip");
  check("⏭️ נרשם ביומן כוויתור על המילה שהייתה על המסך, בלי התקדמות",
    lastOf(skipRun)[4] === "skip" && lastOf(skipRun)[2] === skipRun.target && lastOf(skipRun)[5] === 1
      && skipRun.rec == null, skipRun);
  const cheerSkip = await probe("skipDuringCheer");
  check("⏭️ בזמן ה-🎉 אינו ויתור",
    (cheerSkip.log || []).filter(e => e[2] === cheerSkip.target).map(e => e[4]).join() === "ok", cheerSkip);
  const twiceInCheer = await probe("sayDuringCheer");
  check("אמירה נוספת בזמן ה-🎉 נרשמת ביומן ולא מזיזה שוב את הסולם",
    !!twiceInCheer.rec && twiceInCheer.rec.n === 1 && twiceInCheer.rec.k === 1
      && (twiceInCheer.log || []).filter(e => e[2] === twiceInCheer.target && e[4] === "ok").length === 2, twiceInCheer);
  const fromList = await probe("listSpeak");
  check("🔊 של המילה שעל המסך מתוך הרשימה נחשב לשמיעה לפני הניסיון",
    !!fromList.rec && fromList.rec.k === 0 && String(lastOf(fromList)[6]).includes("h"), fromList);
  const quietRun = await probe("quiet");
  check("חלון שנגמר בלי מילה נרשם ביומן כשקט, ולא נוגע בהתקדמות",
    lastOf(quietRun)[4] === "quiet" && lastOf(quietRun)[5] === 1 && quietRun.rec == null, quietRun);

  // כתיבה: בלי 💡 מסמנת, עם 💡 לא.
  const spelled = await page.evaluate(async ([P, L]) => {
    const realDay = dayNumber;
    dayNumber = () => 201;
    // next() נמנע רק מהמילה הקודמת, ולכן מדלגים גם על מה שכבר נכתב כאן.
    const used = [];
    const spellNow = (hint) => {
      do next(); while(used.includes(word()));
      used.push(word());
      if(hint) giveHint();
      for(const ch of word().slice(hint ? 1 : 0)){
        const tile = [...$("bank").children].find(t => !t.disabled && t.dataset.letter === ch);
        tapTile(tile);
      }
      return word();
    };
    try{
      localStorage.removeItem(P); localStorage.removeItem(L);
      setMode("spell");
      const plain = spellNow(false);
      await new Promise(r => setTimeout(r, GOOD_MS + 200));
      const helped = spellNow(true);
      await new Promise(r => setTimeout(r, GOOD_MS + 200));
      // מילה שגויה מלאה ואחריה הנכונה: המילה הפוכה, ולכן מילה עם לפחות שתי
      // אותיות שונות שאינה פלינדרום, ושלא נכתבה כבר בבדיקה הזו.
      let wrongFirst = null;
      for(let k = 0; k < 20 && !wrongFirst; k++){
        next();
        const w = word();
        if(w === plain || w === helped || new Set(w).size < 2 || [...w].reverse().join("") === w) continue;
        for(const ch of [...w].reverse()) tapTile([...$("bank").children].find(t => !t.disabled && t.dataset.letter === ch));
        await new Promise(r => setTimeout(r, WRONG_MS + 200));
        // האותיות שנבדקו ונמצאו במקומן ננעלות, לא דווקא בתחילת המילה.
        for(const [k, slot] of slotList().entries())
          if(!slot.tile) tapTile([...$("bank").children].find(t => !t.disabled && t.dataset.letter === w[k]));
        wrongFirst = w;
      }
      await new Promise(r => setTimeout(r, GOOD_MS + 200));
      const prog = JSON.parse(localStorage.getItem(P) || "null"), log = JSON.parse(localStorage.getItem(L) || "null");
      return { plain, helped, wrongFirst, plainRec: prog && prog.w[plain], helpedRec: prog && prog.w[helped],
               wrongRec: prog && prog.w[wrongFirst], log: log && log.a.slice(-4, -2),
               wrongLog: log && log.a.filter(e => e[2] === wrongFirst) };
    } finally {
      dayNumber = realDay;
      setMode("say");
    }
  }, [P, L]);
  check("כתיבה בלי 💡 מסמנת שהילד כותב את המילה, בלי לקדם את האמירה",
    !!spelled.plainRec && spelled.plainRec.wrote === 201 && spelled.plainRec.box === 0 && spelled.plainRec.n === 0, spelled);
  check("כתיבה עם 💡 נרשמת ביומן ולא מסמנת",
    spelled.plain !== spelled.helped && spelled.helpedRec === undefined
      && !!spelled.log && spelled.log[1][2] === spelled.helped && spelled.log[1][4] === "ok" && String(spelled.log[1][6]).includes("x"), spelled);
  check("כתיבה נכונה אחרי מילה שגויה נרשמת ביומן ולא מסמנת",
    !!spelled.wrongFirst && spelled.wrongRec == null && !!spelled.wrongLog
      && spelled.wrongLog.map(e => e[4]).join() === "no,ok" && String(spelled.wrongLog[1][6]).includes("w"), spelled);

  // שמירה: יומן חסום באורכו, ערך שאי אפשר לקרוא לא נדרס, מילה שחלון אחר כתב
  // נשארת, ומקום שנגמר לא שובר את הניסיון.
  const storage = await page.evaluate(([P, L]) => {
    const w = word(), out = {};
    localStorage.removeItem(P); localStorage.removeItem(L);
    for(let k = 0; k < LOG_MAX + 50; k++) recordAttempt(w, "no", null, { tryNo: k + 1 });
    const kept = (JSON.parse(localStorage.getItem(L) || "null") || { a: [] }).a;
    out.logLength = kept.length;
    out.oldestKept = kept.length && kept[0][5];
    out.newestKept = kept.length && kept[kept.length - 1][5];
    localStorage.setItem(P, "{bad");
    localStorage.setItem(L, JSON.stringify({ v: 99, a: [] }));
    recordAttempt(w, "ok", "clean", { tryNo: 1 });
    out.keptBad = localStorage.getItem(P) === "{bad";
    out.keptNewer = localStorage.getItem(L) === JSON.stringify({ v: 99, a: [] });
    localStorage.setItem(P, JSON.stringify({ v: 1, w: { fromOtherTab: { met: 1, seen: 1, box: 0, due: 1, ok: [], n: 1, k: 0 } } }));
    localStorage.removeItem(L);
    recordAttempt(w, "ok", "clean", { tryNo: 1 });
    const merged = JSON.parse(localStorage.getItem(P)).w;
    out.otherTabKept = !!merged.fromOtherTab && !!merged[w];
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(k, v){ if(k === L) throw new DOMException("full", "QuotaExceededError"); return realSet.call(this, k, v); };
    try{
      localStorage.removeItem(P);
      try{ recordAttempt(w, "ok", "clean", { tryNo: 1 }); }catch(e){ out.threw = true; }
      out.progressWhenLogFull = !!JSON.parse(localStorage.getItem(P) || "{\"w\":{}}").w[w];
      Storage.prototype.setItem = function(){ throw new DOMException("full", "QuotaExceededError"); };
      try{ recordAttempt(w, "ok", "clean", { tryNo: 1 }); }catch(e){ out.threw = true; }
    } finally { Storage.prototype.setItem = realSet; }
    const seedLog = () => localStorage.setItem(L, JSON.stringify({ v: 1, a: Array.from({ length: 10 }, (_, k) => [1, 0, "old", "say", "no", k + 1, "", null, "", "normal", 1]) }));
    const tooLong = v => { try{ return JSON.parse(v).a.length > 6; }catch(e){ return false; } };
    localStorage.removeItem(P);
    seedLog();
    Storage.prototype.setItem = function(k, v){ if(k === L && tooLong(v)) throw new DOMException("full", "QuotaExceededError"); return realSet.call(this, k, v); };
    try{ recordAttempt(w, "no", null, { tryNo: 1 }); } finally { Storage.prototype.setItem = realSet; }
    const halved = JSON.parse(localStorage.getItem(L)).a;
    out.halvedLength = halved.length;
    out.halvedNewest = halved[halved.length - 1][2];
    localStorage.removeItem(P);
    seedLog();
    Storage.prototype.setItem = function(k, v){
      if(k === P && tooLong(localStorage.getItem(L))) throw new DOMException("full", "QuotaExceededError");
      return realSet.call(this, k, v);
    };
    try{ recordAttempt(w, "ok", "clean", { tryNo: 1 }); } finally { Storage.prototype.setItem = realSet; }
    out.progressAfterHalving = !!(JSON.parse(localStorage.getItem(P) || "null") || { w: {} }).w[w];
    out.logAfterHalving = JSON.parse(localStorage.getItem(L)).a.length;
    localStorage.removeItem(P); localStorage.removeItem(L);
    const realChild = childId;
    childId = "ghostchild";
    try{ recordAttempt(w, "ok", "clean", { tryNo: 1 }); } finally { childId = realChild; }
    out.ghostKeys = Object.keys(localStorage).filter(k => k.endsWith("@ghostchild"));
    localStorage.removeItem(P); localStorage.removeItem(L);
    return out;
  }, [P, L]);
  const logMax = await page.evaluate(() => LOG_MAX);
  check("היומן שומר רק את הניסיונות האחרונים",
    storage.logLength === logMax && storage.oldestKept === 51 && storage.newestKept === logMax + 50, storage);
  check("ערך שאי אפשר לקרוא, או מגרסה חדשה יותר, לא נדרס", storage.keptBad && storage.keptNewer, storage);
  check("מילה שחלון אחר כתב נשארת אחרי ניסיון כאן", storage.otherTabKept, storage);
  check("כשאין מקום ליומן ההתקדמות עדיין נשמרת, וכשאין מקום בכלל שום דבר לא נזרק",
    storage.progressWhenLogFull && !storage.threw, storage);
  check("יומן שאין לו מקום מתקצר לחצי, והניסיון החדש נשמר בו",
    storage.halvedLength === 5 && storage.halvedNewest !== "old", storage);
  check("כשאין מקום להתקדמות, היומן מתקצר והיא נשמרת",
    storage.progressAfterHalving && storage.logAfterHalving === 6, storage);
  check("ילד שנמחק בחלון אחר לא מקבל שום מפתח", storage.ghostKeys.length === 0, storage);
  await page.waitForTimeout(500);

  // --------------------------------------------------------------
  group("סבב");
  // במקום הגרלה בלי סוף: סבבים קצרים מהרשימה, לפי מה שהילד כבר יודע, ומסך
  // סיום. הסדר נבדק על sayRound עצמה, עם התקדמות שנבנית כאן ויום קבוע. כאן
  // מסך הסיום אמיתי, ובסוף הקבוצה ▶ שוב נלחץ מיד, כמו בשאר הקבוצות.
  await page.evaluate(() => {
    showRoundEnd = realShowRoundEnd;
    // סבב שהבדיקה קובעת, אמירה דרך ה-recognizer, וסבב שנגמר מיד ב-⏭️.
    window.roundTest = {
      wait: ms => new Promise(r => setTimeout(r, ms)),
      say: async w => {
        await listen();
        rec.dispatchEvent(new CustomEvent("result", { detail: { result: { result: [{ word: w, conf: 1 }], text: w } } }));
      },
      plan: (queue, tried = []) => {
        round = { queue: queue.slice(), at: -1, row: [], tried: tried.slice(), fresh: [], requeued: [], seen: [] };
        shownWord = null;
        next();
      },
      // said: בסבב הייתה אמירה, ולכן בסופו הקצב מתעדכן.
      end: (last = "fish", said = true) => { roundTest.plan([last]); round.said = said; skipWord(); }
    };
  });
  const roundList = await page.evaluate(() => {
    const before = words.slice();
    const names = ["dog", "cat", "hat", "fish", "apple", "banana", "sun", "moon", "car", "book", "lion",
                   "ship", "sheep", "tea", "tie", "ball", "bowl", "ten", "tent", "bird", "water", "flower"];
    applyWords(PAIRS.filter(p => names.includes(p[1])).map(([emoji, word]) => ({ emoji, word })), 0, false);
    return before;
  });

  const confused = await page.evaluate(() => ({
    yes: [["ship", "sheep"], ["tea", "tie"], ["ball", "bowl"], ["ten", "tent"], ["cat", "hat"]].filter(([a, b]) => !confusable(a, b)),
    no: [["dog", "cat"], ["sun", "moon"], ["apple", "lion"]].filter(([a, b]) => confusable(a, b))
  }));
  check("מילים שקל לבלבל ביניהן מזוהות, ומילים שונות לא",
    confused.yes.length === 0 && confused.no.length === 0, confused);

  // dog ו-fish הילד אמר לבד בימים קודמים, ו-fish הגיע יומה לחזור. את cat אמר
  // לבד רק היום. ב-apple ניסה ועוד לא הצליח. כל השאר חדשות.
  const planned = await page.evaluate(() => {
    const day = 300;
    const w = {
      dog: { met: 290, seen: 299, box: 3, due: 305, ok: [295, 299], n: 4, k: 3, got: 290 },
      fish: { met: 295, seen: 298, box: 2, due: 299, ok: [298], n: 3, k: 2, got: 296 },
      cat: { met: 300, seen: 300, box: 1, due: 301, ok: [], n: 1, k: 1, got: 300 },
      apple: { met: 299, seen: 299, box: 0, due: 300, ok: [], n: 2, k: 0 }
    };
    const { queue, fresh } = sayRound(w, day, 2);
    const at = x => queue.map((q, k) => q === x ? k : -1).filter(k => k >= 0);
    return { queue, fresh, size: ROUND_SIZE, gap: RECHECK_GAP,
             levels: fresh.map(levelOf), themes: fresh.map(x => THEME_BY_WORD[x]), places: fresh.map(at) };
  });
  check("הסבב באורך הקבוע לכל היותר, ומתחיל במילה שהילד כבר אמר לבד ביום קודם",
    planned.queue.length > 0 && planned.queue.length <= planned.size && planned.queue[0] === "dog", planned);
  check("מילה שהגיע יומה לחזור, ומילה שניסו ועוד לא הצליחו בה, בסבב",
    planned.queue.includes("fish") && planned.queue.includes("apple"), planned);
  check("עד שתי מילים חדשות, הקלות קודם, מנושאים שונים",
    planned.fresh.length === 2 && planned.levels.every(l => l === 1) && new Set(planned.themes).size === 2
      && planned.fresh.every(x => !["dog", "fish", "cat", "apple"].includes(x)), planned);
  check("כל מילה חדשה חוזרת עוד פעם בסבב, כמה מילים אחריה",
    planned.places.every(p => p.length === 2 && p[1] - p[0] >= planned.gap), planned);

  // מאתיים סבבים ממצבים אקראיים של התקדמות וקצב.
  // הזוגות כתובים כאן, ולא דרך confusable(), כדי שהבדיקה לא תסמוך על מה שהיא בודקת.
  const random = await page.evaluate(() => {
    const day = 500, list = words.map(x => x.word), bad = [];
    const keepApart = [["ship", "sheep"], ["tea", "tie"], ["ball", "bowl"], ["ten", "tent"], ["cat", "hat"]];
    for(let t = 0; t < 200; t++){
      const w = {};
      for(const x of list){
        const r = Math.random();
        if(r < 0.3) continue;
        const got = r < 0.7 ? day - Math.floor(Math.random() * 10) : undefined;
        w[x] = { met: day - 20, seen: day - 1, box: Math.floor(Math.random() * 5), due: day - 3 + Math.floor(Math.random() * 6),
                 ok: [], n: 1 + Math.floor(Math.random() * 4), k: 0, ...(got === undefined ? {} : { got }) };
      }
      const pace = 1 + Math.floor(Math.random() * 3);
      const { queue, fresh } = sayRound(w, day, pace);
      const distinct = [...new Set(queue)];
      const problems = [];
      if(!queue.length || queue.length > ROUND_SIZE) problems.push("length");
      if(queue.some((x, k) => k && queue[k - 1] === x)) problems.push("twice in a row");
      for(const [a, b] of keepApart) if(distinct.includes(a) && distinct.includes(b)) problems.push(a + "/" + b);
      if(fresh.length > pace || fresh.some(x => w[x])) problems.push("fresh");
      if(distinct.some(x => queue.filter(q => q === x).length > (fresh.includes(x) ? 2 : 1))) problems.push("repeats");
      if(problems.length) bad.push({ queue, fresh, pace, problems });
    }
    return bad.slice(0, 3);
  });
  check("במאתיים סבבים אקראיים: לא ארוך מדי, אף מילה לא פעמיים ברצף, ואין שתי מילים שקל לבלבל",
    random.length === 0, random);

  // ברשימה של שתי מילים, apple והמילה החדשה dog: כשמילת הפתיחה היא apple,
  // dog באה אחריה ואין מקום לחזרה; כש-apple רק בלמידה, dog באה לפניה וחוזרת.
  const edges = await page.evaluate(() => {
    const day = 300, list = words.map(x => x.word), saved = words;
    const first = sayRound({}, day, PACE_START);
    const allKnown = Object.fromEntries(list.map(x => [x, { met: 1, seen: 299, box: 4, due: 400, ok: [1, 2], n: 5, k: 5, got: 1 }]));
    const full = sayRound(allKnown, day, 3);
    try{
      words = [saved[0]];
      const single = sayRound({}, day, 3).queue;
      words = saved.filter(x => x.word === "apple" || x.word === "dog");
      const learning = { apple: { met: 299, seen: 299, box: 0, due: 300, ok: [], n: 2, k: 0 } };
      const opening = { apple: { met: 290, seen: 299, box: 2, due: 305, ok: [298], n: 3, k: 2, got: 295 } };
      return { first, firstThemes: first.fresh.map(x => THEME_BY_WORD[x]), full, single, pace: PACE_START,
               learningPair: sayRound(learning, day, 1).queue.join(), openerPair: sayRound(opening, day, 1).queue.join() };
    } finally { words = saved; }
  });
  check("בפעם הראשונה: מילים חדשות לפי הקצב ההתחלתי, מנושאים שונים, וכל אחת חוזרת",
    edges.first.fresh.length === edges.pace && edges.first.queue.length === 2 * edges.pace
      && new Set(edges.firstThemes).size === edges.pace, edges);
  check("מילה חדשה שהייתה יוצאת אחרונה באה לפני המילה שלפניה, כדי לחזור — אבל לא לפני מילת הפתיחה",
    edges.learningPair === "dog,apple,dog" && edges.openerPair === "apple,dog", edges);
  check("כשאין מה לחזור עליו ואין מילים חדשות, הסבב מתמלא במילים שהילד כבר אומר",
    edges.full.fresh.length === 0 && edges.full.queue.length === planned.size, edges.full);
  check("ברשימה של מילה אחת יש סבב, והוא נגמר", edges.single.length === 1, edges.single);

  // הקצב: יותר מילים חדשות כשהילד מצליח ברוב הניסיונות הראשונים, פחות כשהוא
  // מתקשה. ניסיון שני וכתיבה לא נספרים, ורמת ההתאמה לא זזה.
  const paced = await page.evaluate(([P, L]) => {
    const entry = (outcome, mode = "say", tryNo = 1, flags = "") => [1, 0, "dog", mode, outcome, tryNo, flags, null, "", "normal", 1];
    const run = (pace, oks, total, extra = []) => {
      localStorage.setItem(P, JSON.stringify({ v: 1, w: {}, ...(pace ? { pace } : {}) }));
      localStorage.setItem(L, JSON.stringify({ v: 1, a: extra.concat(Array.from({ length: total }, (_, k) => entry(k < oks ? "ok" : "no"))) }));
      adaptPace();
      return JSON.parse(localStorage.getItem(P)).pace;
    };
    const presetBefore = preset.id;
    const out = {
      up: run(2, 29, 30), down: run(2, 20, 30), keep: run(2, 24, 30), few: run(2, 9, 9),
      top: run(3, 30, 30), bottom: run(1, 0, 30), start: run(undefined, 30, 30),
      // עשרים ניסיונות שניים וכתיבות שלא הצליחו, ואחריהם עשרים ראשונים שהצליחו.
      onlyFirst: run(2, 20, 20, Array.from({ length: 20 }, (_, k) => k % 2 ? entry("no", "say", 2) : entry("no", "spell"))),
      // שמונה שקטים ו-⏭️ בניסיון הראשון, ושתים עשרה הצלחות.
      quiet: run(2, 12, 12, Array.from({ length: 8 }, (_, k) => entry(k % 2 ? "quiet" : "skip"))),
      // עשרים הצלחות אחרי ששמעו את המילה, ובלעדיהן שמונה מעשר.
      heard: run(2, 8, 10, Array.from({ length: 20 }, () => entry("ok", "say", 1, "hte")))
    };
    out.presetKept = preset.id === presetBefore;
    // והסבב הבא בונה לפי הקצב החדש.
    localStorage.setItem(P, JSON.stringify({ v: 1, w: {}, pace: 1 }));
    startRound();
    out.nextRound = round.fresh.length;
    localStorage.removeItem(P); localStorage.removeItem(L);
    return out;
  }, [P, L]);
  check("רוב הניסיונות הראשונים הצליחו — יותר מילים חדשות בסבב",
    paced.up === 3 && paced.start === 3 && paced.top === 3, paced);
  check("מתקשה — פחות מילים חדשות, ולא פחות מאחת", paced.down === 1 && paced.bottom === 1, paced);
  check("באמצע, או כשיש מעט ניסיונות, הקצב לא זז", paced.keep === 2 && paced.few === 2, paced);
  check("רק ניסיונות ראשונים באמירה נספרים, ורמת ההתאמה לא זזה", paced.onlyFirst === 3 && paced.presetKept, paced);
  check("שקט ו-⏭️ אינם ניסיון שנכשל, והצלחה אחרי ששמעו את המילה אינה הצלחה לקצב",
    paced.quiet === 3 && paced.heard === 2, paced);
  check("הסבב הבא בונה לפי הקצב", paced.nextRound === 1, paced);

  // והקצב זז מעצמו בסוף סבב באמירה, ולא בסוף סבב בכתיבה.
  const paceAtEnd = await page.evaluate(([P, L]) => {
    const oks = Array.from({ length: 12 }, () => [1, 0, "dog", "say", "ok", 1, "", null, "", "normal", 1]);
    const seed = () => {
      localStorage.setItem(P, JSON.stringify({ v: 1, w: {}, pace: 1 }));
      localStorage.setItem(L, JSON.stringify({ v: 1, a: oks }));
    };
    const pace = () => JSON.parse(localStorage.getItem(P)).pace;
    try{
      seed();
      roundTest.end();
      const say = { ended, pace: pace() };
      // סבב של שומעים ובוחרים בלבד: אין בו ניסיון חדש, והקצב לא מחושב שוב מאותם ניסיונות ישנים.
      seed();
      roundTest.end("fish", false);
      const listened = { ended, pace: pace() };
      seed();
      setMode("spell");
      roundTest.end();
      return { say, listened, spell: { ended, pace: pace() } };
    } finally {
      setMode("say");
      localStorage.removeItem(P); localStorage.removeItem(L);
    }
  }, [P, L]);
  check("בסוף סבב באמירה הקצב זז לפי היומן", paceAtEnd.say.ended && paceAtEnd.say.pace === 2, paceAtEnd);
  check("בסוף סבב בלי אף אמירה הקצב לא זז", paceAtEnd.listened.ended && paceAtEnd.listened.pace === 1, paceAtEnd);
  check("בסוף סבב בכתיבה הקצב לא זז", paceAtEnd.spell.ended && paceAtEnd.spell.pace === 1, paceAtEnd);

  // אמירה שלא התקבלה פעמיים: המילה חוזרת פעם אחת, שלוש מילים אחרי, ולא מיד.
  const requeueRun = await page.evaluate(async ([P, L]) => {
    localStorage.removeItem(P); localStorage.removeItem(L);
    const synth = speechSynthesis;
    synth.speak = () => {};
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const missTwice = async () => {
      for(let k = 0; k < 2; k++){
        await listen();
        rec.dispatchEvent(new CustomEvent("result", { detail: { result: { result: [{ word: "zzz", conf: 1 }], text: "zzz" } } }));
        await wait(AGAIN_MS + 150);
      }
    };
    const plan = queue => {
      round = { queue: queue.slice(), at: -1, row: [], tried: [], fresh: [], requeued: [], seen: [] };
      shownWord = null;
      next();
    };
    try{
      plan(["dog", "sun", "lion", "book", "car"]);
      await missTwice();
      const out = { after: word(), queue: round.queue.slice() };
      next(); next();
      out.back = word();
      await missTwice();
      out.again = round.queue.slice();
      plan(["dog", "sun"]);
      await missTwice();
      out.short = round.queue.slice();
      plan(["dog", "sun", "lion", "book"]);
      await listen();
      rec.dispatchEvent(new CustomEvent("result", { detail: { result: { result: [{ word: "zzz", conf: 1 }], text: "zzz" } } }));
      await wait(AGAIN_MS + 150);
      await listen();
      rec.dispatchEvent(new CustomEvent("result", { detail: { result: { result: [{ word: "dog", conf: 1 }], text: "dog" } } }));
      out.oneMiss = round.queue.slice();
      await wait(GOOD_MS + 200);
      return out;
    } finally {
      delete synth.speak;
      localStorage.removeItem(P); localStorage.removeItem(L);
    }
  }, [P, L]);
  check("שתי אמירות שלא התקבלו — המילה חוזרת שלוש מילים אחרי, ולא מיד",
    requeueRun.after === "sun" && requeueRun.queue.join() === "dog,sun,lion,dog,book,car", requeueRun);
  check("ומילה שכבר חזרה לא חוזרת שוב באותו סבב",
    requeueRun.back === "dog" && requeueRun.again.join() === requeueRun.queue.join(), requeueRun);
  check("קרוב לסוף הסבב היא לא חוזרת בו", requeueRun.short.join() === "dog,sun", requeueRun);
  check("מילה שהתקבלה בניסיון השני לא חוזרת", requeueRun.oneMiss.join() === "dog,sun,lion,book", requeueRun);

  // מילה שהילד כבר אמר לבד מוצגת בלי כתב, כדי שישלוף אותה מהתמונה. רק הצלחה
  // כזו נספרת ליום של "אמר". אמירה שלא התקבלה מחזירה את הכתב, כדוגמה גם בלי שמע.
  const veil = await page.evaluate(async ([P, L]) => {
    const realDay = dayNumber, synth = speechSynthesis;
    synth.speak = () => {};
    dayNumber = () => 400;
    const seen = id => getComputedStyle($(id)).visibility === "visible";
    const say = async w => {
      await listen();
      rec.dispatchEvent(new CustomEvent("result", { detail: { result: { result: [{ word: w, conf: 1 }], text: w } } }));
    };
    const showWord = w => { turn.word = null; i = words.findIndex(x => x.word === w); show(); };
    const store = () => JSON.parse(localStorage.getItem(P)).w;
    try{
      localStorage.setItem(P, JSON.stringify({ v: 1, w: {
        dog: { met: 390, seen: 399, box: 2, due: 400, ok: [399], n: 3, k: 2, got: 395 },
        sun: { met: 390, seen: 399, box: 2, due: 400, ok: [399], n: 3, k: 2, got: 395 },
        moon: { met: 390, seen: 399, box: 2, due: 400, ok: [399], n: 3, k: 2, got: 395 },
        book: { met: 390, seen: 399, box: 2, due: 400, ok: [399], n: 3, k: 2, got: 395 } } }));
      localStorage.removeItem(L);
      const out = {};
      showWord("lion");
      out.fresh = { en: seen("word"), he: seen("wordHe") };
      showWord("dog");
      out.known = { en: seen("word"), he: seen("wordHe") };
      await say("dog");
      out.cheer = { en: seen("word"), he: seen("wordHe") };
      out.dog = store().dog;
      out.dogFlags = JSON.parse(localStorage.getItem(L)).a.slice(-1)[0][6];
      showWord("lion");
      await say("lion");
      out.lion = store().lion;
      showWord("sun");
      await say("zzz");
      out.missed = { en: seen("word"), he: seen("wordHe") };
      await new Promise(r => setTimeout(r, AGAIN_MS + 100));
      setMode("spell");
      showWord("sun");
      out.spell = { he: seen("wordHe") };
      setMode("say");
      // בכתיבה רואים את המילה באותיות שלה. מי שחוזר לאמירה באותו תור לא שלף אותה.
      showWord("moon");
      setMode("spell");
      setMode("say");
      out.peekVeiled = !seen("word");
      await say("moon");
      out.moon = store().moon;
      out.moonFlags = JSON.parse(localStorage.getItem(L)).a.slice(-1)[0][6];
      // וגם תור שהתחיל בכתיבה ועבר לאמירה.
      setMode("spell");
      showWord("book");
      setMode("say");
      await say("book");
      out.book = store().book;
      return out;
    } finally {
      dayNumber = realDay;
      delete synth.speak;
      localStorage.removeItem(P); localStorage.removeItem(L);
    }
  }, [P, L]);
  check("מילה חדשה מוצגת עם הכתב", veil.fresh.en && veil.fresh.he, veil);
  check("מילה שהילד כבר אמר לבד מוצגת בלי המילה באנגלית ובלי התעתיק", !veil.known.en && !veil.known.he, veil);
  check("שלף אותה מהתמונה — יום של \"אמר\", והכתב מופיע עם ה-🎉",
    !!veil.dog && JSON.stringify(veil.dog.ok) === "[399,400]" && veil.dog.box === 3 && !/[te]/.test(veil.dogFlags)
      && veil.cheer.en && veil.cheer.he, veil);
  check("הצלחה כשהמילה כתובה על המסך לא נספרת ליום של \"אמר\"",
    !!veil.lion && veil.lion.got === 400 && veil.lion.ok.length === 0 && veil.lion.box === 1, veil);
  check("אמירה שלא התקבלה מחזירה את הכתב", veil.missed.en && veil.missed.he, veil);
  check("בכתיבה התעתיק נשאר גם במילה שהילד כבר אומר", veil.spell.he, veil);
  check("מילה שראו בכתיבה באותו תור לא נספרת ליום של \"אמר\"",
    veil.peekVeiled && !!veil.moon && JSON.stringify(veil.moon.ok) === "[399]" && String(veil.moonFlags).includes("p")
      && !!veil.book && JSON.stringify(veil.book.ok) === "[399]", veil);

  // מסך הסיום: מה שניסו בסבב, כמדבקות שוות, בלי מספרים ובלי כוכבים, ו-▶ שמתחיל
  // סבב חדש. מילה שנכנסה לסל בסבב הזה קופצת אליו, כתמונה בלבד. ⏭️ על המילה
  // האחרונה מסיים את הסבב כמו הצלחה.
  await page.setViewportSize({ width: 360, height: 640 });
  const ending = await page.evaluate(async ([P, L]) => {
    const realChime = chime, chimes = [], synth = speechSynthesis, spoken = [], realSound = soundEnabled;
    chime = sound => { chimes.push(sound); return realChime(sound); };
    synth.speak = u => spoken.push(u.text);
    const visible = id => $(id).checkVisibility();
    const ok2 = { met: 1, seen: 9, box: 3, due: 20, ok: [5, 9], n: 4, k: 3, got: 1 };
    try{
      setSound(true);
      // dog כבר בסל כשהסבב התחיל; lion נכנס אליו בסבב הזה; sax, שיצאה מהמאגר, בלי תמונה.
      localStorage.setItem(P, JSON.stringify({ v: 1, w: { dog: ok2 } }));
      localStorage.removeItem(L);
      const tried = ["dog", "cat", "sun", "lion", "book", "ship", "tea", "ball"];
      round = { queue: ["fish"], at: -1, row: tried.slice(0, 5), tried, fresh: ["sun"], requeued: [], seen: [],
                basket: ["dog"], pocketed: [] };
      shownWord = null;
      next();
      localStorage.setItem(P, JSON.stringify({ v: 1, w: { dog: ok2, lion: { ...ok2, wrote: 7 }, sax: ok2 } }));
      // ההצלחה מזמנת מעבר, ו-⏭️ בזמנה מסיים את הסבב לפניו. ▶ גלוי מסוף הסבב הקודם.
      $("againBtn").hidden = false;
      good();
      skipWord();
      // ▶ מופיע רק כשההגנה מנגיעה כפולה נגמרת, והאנימציה כבר נגמרה עד אז.
      const early = { play: visible("againBtn"), focus: document.activeElement.id };
      const anim = [...document.querySelectorAll("#roundEnd .pic")]
        .map(p => parseFloat(getComputedStyle(p).animationDelay) * 1000 + parseFloat(getComputedStyle(p).animationDuration) * 1000);
      await new Promise(r => setTimeout(r, END_GUARD_MS + 50));
      $("roundPics").children[0].click();
      const end = $("roundEnd").getBoundingClientRect();
      const out = {
        early, ended, end: visible("roundEnd"), say: visible("say"), picture: visible("picture"), next: visible("next"),
        pics: [...$("roundPics").children].map(b => b.dataset.word),
        sizes: [...new Set([...$("roundPics").children].map(b => getComputedStyle(b).width))],
        intoBasket: [...$("endBasketNew").children].map(b => b.textContent),
        lock: visible("lock"), play: visible("againBtn"), animEnds: Math.max(...anim), guard: END_GUARD_MS,
        focus: document.activeElement.id,
        text: $("roundEnd").innerText,
        inView: [end, $("againBtn").getBoundingClientRect(), ...[...$("roundPics").children].map(b => b.getBoundingClientRect())]
          .every(r => r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth),
        buttons: [...$("roundEnd").querySelectorAll("button")].filter(b => b.checkVisibility()).map(b => b.id)
      };
      // והמעבר שההצלחה זימנה לא מחזיר מילה ולא מסיים את הסבב פעם שנייה.
      await new Promise(r => setTimeout(r, GOOD_MS + 200));
      out.stillEnded = ended;
      out.chimes = chimes.filter(c => c === ROUND_CHEER).length;
      out.spoken = spoken.slice();
      return out;
    } finally {
      chime = realChime;
      setSound(realSound);
      delete synth.speak;
      localStorage.removeItem(P);
    }
  }, [P, L]);
  check("בסוף הסבב — מסך סיום במקום התמונה והכפתורים",
    ending.ended && ending.end && !ending.say && !ending.picture && !ending.next && ending.stillEnded, ending);
  check("במסך הסיום כל מה שניסו, כמדבקות באותו גודל, בלי כוכבים ובלי ✨",
    ending.pics.join() === "dog,cat,sun,lion,book,ship,tea,ball" && ending.sizes.length === 1 && !/[✨⭐]/.test(ending.text), ending);
  check("מילה שנכנסה לסל בסבב הזה קופצת אליו, כתמונה בלבד",
    ending.intoBasket.join() === "🦁" && !/lion/.test(ending.text), ending);
  check("▶ מופיע רק כשההגנה מנגיעה כפולה נגמרת, אחרי האנימציה, ו-🔒 בפינה",
    !ending.early.play && ending.play && ending.lock && ending.animEnds <= ending.guard, ending);
  check("צליל אחד בסוף הסבב, שום מילה לא נאמרת, והפוקוס על ▶",
    ending.chimes === 1 && ending.spoken.length === 0 && ending.focus === "againBtn", ending);
  check("אין מספרים במסך הסיום, ואין בו כפתור מלבד ▶", !/[0-9]/.test(ending.text) && ending.buttons.join() === "againBtn", ending);
  check("בטלפון בגובה 640 מסך הסיום ו-▶ על המסך", ending.inView, ending);

  // ההגדרות מעל מסך הסיום: Tab לא מגיע אליו.
  const endInert = await page.evaluate(async () => {
    openPanel();
    const inert = $("game").inert;
    closePanel();
    const out = { inert, after: $("game").inert, screen };
    enterGame();
    roundTest.end();
    await roundTest.wait(END_GUARD_MS + 50);
    return out;
  });
  check("מסך הסיום לא נגיש במקלדת כשההגדרות פתוחות, והסגירה חוזרת למסך הפתיחה",
    endInert.inert && !endInert.after && endInert.screen === "door", endInert);

  // הסל: מילים שהילד אמר לבד מהתמונה בשני ימים שונים, גם אחרי שחזרו לתרגול או
  // יצאו מהמאגר. לילד, במסך הפתיחה, רק תמונות, בלי כתב ובלי קול; למבוגר עם
  // המילה באנגלית, ו-✏️ ליד מה שגם נכתב.
  const basket = await page.evaluate(async P => {
    const synth = speechSynthesis, spoken = [], realSound = soundEnabled, set = w => localStorage.setItem(P, JSON.stringify({ v: 1, w }));
    synth.speak = u => spoken.push(u.text);
    try{
      setSound(true);
      localStorage.removeItem(P);
      goDoor();
      const empty = { door: $("doorBasket").classList.contains("empty"), pics: $("doorBasketPics").children.length };
      openPanel();
      empty.adult = !$("basketEmpty").hidden && $("basketPics").children.length === 0;
      closePanel();
      set({ dog: { met: 1, seen: 9, box: 3, due: 20, ok: [5, 9], n: 4, k: 3, got: 1 },
            sax: { met: 1, seen: 4, box: 2, due: 6, ok: [3, 4], n: 2, k: 2, got: 3 },
            sun: { met: 1, seen: 9, box: 1, due: 10, ok: [9], n: 2, k: 1, got: 9 } });
      renderDoor();
      set({ dog: { met: 1, seen: 9, box: 3, due: 20, ok: [5, 9], n: 4, k: 3, got: 1 },
            lion: { met: 1, seen: 12, box: 0, due: 13, ok: [6, 8], n: 6, k: 2, got: 2, wrote: 7 },
            sun: { met: 1, seen: 9, box: 1, due: 10, ok: [9], n: 2, k: 1, got: 9 },
            cat: { met: 1, seen: 9, box: 1, due: 10, ok: [], n: 1, k: 1, got: 9 },
            sax: { met: 1, seen: 4, box: 2, due: 6, ok: [3, 4], n: 2, k: 2, got: 3 } });
      renderDoor();
      const door = { pics: [...$("doorBasketPics").children].map(b => b.textContent + (b.classList.contains("new") ? "*" : "")),
                     text: $("doorBasket").innerText.trim(), empty: $("doorBasket").classList.contains("empty"),
                     tappable: getComputedStyle($("doorBasket")).pointerEvents };
      $("doorBasketPics").children[0].click();
      door.spoken = spoken.length;
      openPanel();
      const adult = [...$("basketPics").children].map(b => b.innerText.replace(/\s+/g, " ").trim());
      closePanel();
      return { empty, door, adult };
    } finally {
      setSound(realSound);
      delete synth.speak;
      localStorage.removeItem(P);
      enterGame();
      roundTest.end();
      await roundTest.wait(END_GUARD_MS + 50);
    }
  }, P);
  check("סל ריק: במסך הפתיחה רק קווי מתאר, ולמבוגר מה ייכנס אליו",
    basket.empty.door && basket.empty.pics === 0 && basket.empty.adult, basket);
  check("במסך הפתיחה הסל הוא תמונות בלבד, בלי כתב, ובלי מה שאין לו תמונה; תמונה חדשה מנצנצת",
    basket.door.pics.join() === "🐶,🦁*" && !/[a-z]/i.test(basket.door.text) && !basket.door.empty, basket);
  check("אי אפשר ללחוץ על הסל, והוא לא משמיע כלום", basket.door.tappable === "none" && basket.door.spoken === 0, basket);
  check("באזור המבוגר: הסל עם המילים באנגלית, ו-✏️ למה שגם נכתב",
    basket.adult.join("|") === "🐶 dog|🦁 lion ✏️|sax", basket);

  const again = await page.evaluate(() => {
    $("againBtn").click();
    const visible = id => $(id).checkVisibility();
    return { ended, end: visible("roundEnd"), say: visible("say"), picture: visible("picture"),
             row: round.row.length, at: round.at, word: word() };
  });
  check("▶ מתחיל סבב חדש: המילה הראשונה בו על המסך, ומה שנרשם ריק",
    !again.ended && !again.end && again.say && again.picture && again.row === 0 && again.at === 0, again);

  // נגיעה כפולה: הראשונה מסיימת את הסבב, והשנייה נוחתת על ▶ שהופיע תחתיה.
  const guard = await page.evaluate(async () => {
    roundTest.end();
    $("againBtn").click();
    const early = ended;
    await roundTest.wait(END_GUARD_MS + 50);
    $("againBtn").click();
    return { early, late: ended };
  });
  check("▶ שנלחץ מיד כשמסך הסיום מופיע לא מדלג עליו", guard.early && !guard.late, guard);

  // ובכיוון השני: נגיעה כפולה ב-▶ נוחתת על ⏭️ של הסבב החדש, ו-🧺 שנלחץ מיד.
  const tapAfterPlay = await page.evaluate(async () => {
    roundTest.end();
    await roundTest.wait(END_GUARD_MS + 50);
    $("againBtn").click();
    const first = word();
    $("next").click();
    const kept = word() === first;
    await roundTest.wait(END_GUARD_MS + 50);
    $("next").click();
    const moved = word() !== first || ended;
    return { kept, moved };
  });
  check("נגיעה שנייה מיד אחרי ▶ לא מדלגת על המילה הראשונה בסבב, ואחר כך ⏭️ עובד",
    tapAfterPlay.kept && tapAfterPlay.moved, tapAfterPlay);
  // ⏭️ פעמיים מהר מדלג על מילה אחת, ולא גם על הבאה, שהילד לא ראה.
  const doubleSkip = await page.evaluate(async () => {
    await roundTest.wait(END_GUARD_MS + 50);
    // כל כרטיס שמוצג עובר ב-show.
    const real = show;
    let shown = 0;
    show = () => { shown++; return real(); };
    try{
      $("next").click();
      await roundTest.wait(150);
      $("next").click();
      const quick = shown;
      await roundTest.wait(END_GUARD_MS + 50);
      $("next").click();
      return { quick, later: shown };
    } finally { show = real; }
  });
  check("נגיעה כפולה ב-⏭️ מדלגת על מילה אחת, ואחר כך ⏭️ עובד שוב",
    doubleSkip.quick === 1 && doubleSkip.later === 2, doubleSkip);
  // וגם ▶ של מסך הפתיחה: נגיעה כפולה בו לא מדלגת על המילה הראשונה. הדף נפתח
  // בהקשר נפרד, בלי מה שהבדיקות כאן מכבות.
  const earlyCtx = await browser.newContext({ serviceWorkers: "block" });
  const earlyPage = await earlyCtx.newPage();
  await earlyPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  const earlySkip = await earlyPage.evaluate(async () => {
    const door = { screen, word: $("word").textContent };
    enterGame();
    const before = word();
    $("next").click();
    const kept = word() === before;
    await new Promise(r => setTimeout(r, END_GUARD_MS + 50));
    $("next").click();
    return { door, kept, moved: word() !== before || ended };
  });
  await earlyCtx.close();
  check("לפני ▶ שום מילה לא מוצגת", earlySkip.door.screen === "door" && earlySkip.door.word === "", earlySkip);
  check("נגיעה שנייה מיד אחרי ▶ של מסך הפתיחה לא מדלגת על המילה הראשונה, ואחר כך ⏭️ עובד",
    earlySkip.kept && earlySkip.moved, earlySkip);

  // במקלדת, ▶ ממשיך ל-🎤 של הסבב החדש.
  await page.evaluate(async () => { roundTest.end(); await roundTest.wait(END_GUARD_MS + 50); $("againBtn").focus(); });
  await page.keyboard.press("Enter");
  const keyed = await page.evaluate(() => ({ ended, focus: document.activeElement.id }));
  check("▶ במקלדת מעביר את הפוקוס ל-🎤", !keyed.ended && keyed.focus === "say", keyed);

  // בסוף הסבב: מחיקת מילה ושינוי התעתיק משאירים את מסך הסיום; מעבר לכתיבה
  // וקפיצה מהרשימה מתחילים סבב חדש מיד, בלי המילה האחרונה של הסבב שנגמר.
  const whileEnded = await page.evaluate(async () => {
    const picture = () => $("picture").checkVisibility();
    const out = {};
    roundTest.end("fish");
    round.row = ["dog"];
    const gone = words.findIndex(x => x.word === "moon");
    removeAt(gone);
    out.removed = { ended, picture: picture(), row: round.row.join() };
    $("hebrewToggle").click();
    $("hebrewToggle").click();
    out.hebrew = { ended, picture: picture() };
    const spoken = [], synth = speechSynthesis, realSound = soundEnabled;
    synth.speak = u => spoken.push(u.text);
    try{
      setSound(false);
      toggleSound();
      out.sound = { ended, spoken: spoken.slice() };
    } finally { setSound(realSound); delete synth.speak; }
    setMode("spell");
    out.spell = { ended, word: word(), at: round.at, moon: round.queue.includes("moon") };
    setMode("say");
    return out;
  });
  check("מחיקת מילה בסוף הסבב משאירה את מסך הסיום ואת מה שנרשם בו, והסבב הבא בלעדיה",
    whileEnded.removed.ended && !whileEnded.removed.picture && whileEnded.removed.row === "dog" && !whileEnded.spell.moon, whileEnded);
  check("שינוי התעתיק בסוף הסבב משאיר את מסך הסיום", whileEnded.hebrew.ended && !whileEnded.hebrew.picture, whileEnded);
  check("הדלקת השמע בסוף הסבב לא אומרת את המילה האחרונה",
    whileEnded.sound.ended && whileEnded.sound.spoken.length === 0, whileEnded);
  check("מעבר לכתיבה בסוף הסבב מתחיל סבב חדש, לא במילה האחרונה",
    !whileEnded.spell.ended && whileEnded.spell.word !== "fish" && whileEnded.spell.at === 0, whileEnded);

  // מילה שמורה קפצה אליה, כשהיא האחרונה בסבב והילד כבר ניסה אותה, לא חוזרת
  // מיד; סבב חדש שיש בו רק אותה מילה מציג אותה.
  const repeat = await page.evaluate(() => {
    roundTest.plan(["dog", "fish"]);
    i = words.findIndex(x => x.word === "fish");
    show();
    noteTried("fish");
    next();
    const jumped = { ended, word: word() };
    round = { queue: ["fish"], at: -1, row: [], tried: [], fresh: [], requeued: [], seen: [] };
    next();
    return { jumped, alone: { ended, word: word() } };
  });
  check("מילה שבדיוק הוצגה לא מוצגת שוב מיד, גם כשהיא האחרונה בסבב",
    repeat.jumped.ended && repeat.alone.word === "fish" && !repeat.alone.ended, repeat);

  // קפיצה למילה שמופיעה בסבב פעמיים, ואז ⏭️ עד הסוף: אף תמונה לא פעמיים ברצף.
  const jumpedSkips = await page.evaluate(() => {
    roundTest.plan(["dog", "fish", "dog", "fish"]);
    i = words.findIndex(x => x.word === "fish");
    show();
    const seen = ["dog", "fish"];
    for(let k = 0; k < 6 && !ended; k++){ skipWord(); if(!ended) seen.push(word()); }
    return { seen, ended };
  });
  check("אחרי קפיצה מהרשימה ⏭️ לא מציג את אותה תמונה פעמיים ברצף",
    jumpedSkips.ended && jumpedSkips.seen.every((x, k) => !k || jumpedSkips.seen[k - 1] !== x), jumpedSkips);

  // "תרגלו רק את האלה" כשהסבב החדש נפתח במילה שעל המסך: זה אותו תור, וילד ששמע
  // אותה רגע לפני לא נרשם כמי שאמר לבד.
  const sameTurn = await page.evaluate(() => {
    const before = words, keep = words[i];
    try{
      roundTest.plan([keep.word]);
      turn.heard = true;
      const was = turn;
      applyWords([keep], null, false);
      return { same: turn === was, heard: turn.heard, word: word() === keep.word };
    } finally { applyWords(before, before.indexOf(keep), false); }
  });
  check("רשימה חדשה שהסבב שלה נפתח במילה שעל המסך ממשיכה את אותו תור",
    sameTurn.same && sameTurn.heard && sameTurn.word, sameTurn);

  // ומסוף הסבב, רשימה חדשה או ילד אחר מתחילים מיד את הסבב שלהם, בלי לסיים
  // את הקודם פעם שנייה.
  const freshList = await page.evaluate(([P, L]) => {
    const realChime = chime, before = words;
    let cheers = 0;
    chime = sound => { if(sound === ROUND_CHEER) cheers++; return realChime(sound); };
    localStorage.setItem(P, JSON.stringify({ v: 1, w: {}, pace: 1 }));
    localStorage.setItem(L, JSON.stringify({ v: 1, a: Array.from({ length: 12 }, () => [1, 0, "dog", "say", "ok", 1, "", null, "", "normal", 1]) }));
    try{
      roundTest.end();
      const set = words.filter(x => ["sun", "moon", "lion"].includes(x.word));
      applyWords(set, null, false);
      return { ended, inSet: set.some(x => x.word === word()), cheers, pace: JSON.parse(localStorage.getItem(P)).pace };
    } finally {
      chime = realChime;
      applyWords(before, 0, false);
      localStorage.removeItem(P); localStorage.removeItem(L);
    }
  }, [P, L]);
  check("רשימה חדשה מסוף הסבב מתחילה את הסבב שלה, והקודם לא נגמר פעמיים",
    !freshList.ended && freshList.inSet && freshList.cheers === 1 && freshList.pace === 2, freshList);

  // מה שהילד עשה בפועל מגיע למסך הסיום, ומה שהיה לבד נרשם לאזור המבוגר:
  // אמירה נקייה, ולא אמירה בניסיון השני; כתיבה נקייה.
  const played = await page.evaluate(async ([P, L]) => {
    const { plan, say, wait } = roundTest, synth = speechSynthesis;
    const pics = () => [...$("roundPics").children].map(b => b.dataset.word + (round.row.includes(b.dataset.word) ? "+" : ""));
    synth.speak = () => {};
    localStorage.removeItem(P); localStorage.removeItem(L);
    try{
      plan(["dog", "sun"]);
      await say("dog");
      await wait(GOOD_MS + 200);
      await say("zzz");
      await wait(AGAIN_MS + 100);
      await say("sun");
      await wait(GOOD_MS + 200);
      const sayPics = { ended, pics: pics() };
      setMode("spell");
      plan(["cat"]);
      for(const ch of word()) [...$("bank").children].find(t => !t.disabled && t.dataset.letter === ch).click();
      await wait(GOOD_MS + 200);
      return { say: sayPics, spell: { ended, pics: pics() } };
    } finally {
      setMode("say");
      delete synth.speak;
      localStorage.removeItem(P); localStorage.removeItem(L);
    }
  }, [P, L]);
  check("מסך הסיום אחרי סבב אמיתי: מה שנאמר בניסיון הראשון נרשם כלבד, בניסיון השני לא",
    played.say.ended && played.say.pics.join() === "dog+,sun", played);
  check("ובכתיבה: מילה שנכתבה בלי עזרה נרשמת כלבד", played.spell.ended && played.spell.pics.join() === "cat+", played);

  // בכתיבה הסבב מתחיל במה שהילד כבר אמר ועוד לא כתב.
  const spellOrder = await page.evaluate(() => {
    const w = { dog: { got: 1, n: 1 }, cat: { got: 1, n: 1 }, sun: { got: 1, n: 1, wrote: 2 } };
    return Array.from({ length: 20 }, () => spellRound(w)).filter(r => [r[0], r[1]].sort().join() !== "cat,dog").length;
  });
  check("סבב כתיבה מתחיל במילים שהילד אמר ועוד לא כתב", spellOrder === 0, spellOrder);

  // ⏭️ בזמן שהמיקרופון עוד נפתח: ההקשבה לא מתחילה על המילה הבאה, וגם לא על
  // מסך הסיום כשזו הייתה האחרונה.
  const raced = await page.evaluate(async () => {
    const real = { audioReady, ensureAudio };
    audioReady = () => false;
    ensureAudio = () => new Promise(r => setTimeout(r, 200));
    const run = async queue => {
      roundTest.plan(queue);
      const opening = listen();
      skipWord();
      await opening;
      return { ended, word: word(), active, listening: $("say").classList.contains("listening") };
    };
    try{
      return { next: await run(["dog", "cat"]), last: await run(["dog"]) };
    } finally {
      audioReady = real.audioReady;
      ensureAudio = real.ensureAudio;
      stopListening();
    }
  });
  check("⏭️ בזמן שהמיקרופון נפתח — לא מקשיבים למילה הבאה",
    raced.next.word === "cat" && !raced.next.active && !raced.next.listening, raced);
  check("סבב שנגמר בזמן שהמיקרופון נפתח לא מקשיב על מסך הסיום",
    raced.last.ended && !raced.last.active && !raced.last.listening, raced);

  // פתיחת ההגדרות באמצע הקשבה עוצרת אותה: מאחוריהן הילד לא רואה ולא מנסה.
  const panelStops = await page.evaluate(async () => {
    roundTest.plan(["dog", "sun"]);
    await listen();
    const was = active;
    openPanel();
    const out = { was, active, listening: $("say").classList.contains("listening") };
    closePanel();
    enterGame();
    return out;
  });
  check("פתיחת ההגדרות באמצע הקשבה עוצרת אותה", panelStops.was && !panelStops.active && !panelStops.listening, panelStops);

  // 🎉 שבא מהר אחרי "נסו שוב" נשאר ירוק עד סופו.
  const cheerStays = await page.evaluate(async () => {
    roundTest.plan(["dog", "sun"]);
    const realNext = next;
    next = () => {};
    try{
      again();
      await roundTest.wait(300);
      good();
      await roundTest.wait(AGAIN_MS);
      return { cls: $("card").className, card: $("picture").textContent, emoji: words[i].emoji };
    } finally { next = realNext; }
  });
  check("הצלחה מהר אחרי רעידה נשארת ירוקה עד סופה, עם התמונה", cheerStays.cls === "good" && cheerStays.card === cheerStays.emoji, cheerStays);

  // מעבר בין התרגולים באמצע מילה: המילה שעל המסך לא חוזרת מיד בסבב החדש, וגם
  // אחרי שתי אמירות שלא התקבלו היא חוזרת רק שלוש מילים אחר כך.
  const held = await page.evaluate(async ([P, L]) => {
    const day = dayNumber(), synth = speechSynthesis;
    synth.speak = () => {};
    localStorage.setItem(P, JSON.stringify({ v: 1, w: {
      dog: { met: day - 9, seen: day - 2, box: 3, due: day + 5, ok: [day - 3], n: 3, k: 2, got: day - 5 } } }));
    localStorage.removeItem(L);
    try{
      roundTest.plan(["dog"]);
      setMode("spell");
      const spellHas = round.queue.includes("dog");
      setMode("say");
      const sayHas = round.queue.includes("dog");
      for(let k = 0; k < 2; k++){
        await roundTest.say("zzz");
        await roundTest.wait(AGAIN_MS + 150);
      }
      const seen = [word()];
      for(let k = 0; k < 2 && !ended; k++){ skipWord(); seen.push(word()); }
      return { spellHas, sayHas, seen };
    } finally {
      delete synth.speak;
      localStorage.removeItem(P); localStorage.removeItem(L);
    }
  }, [P, L]);
  check("מעבר בין התרגולים באמצע מילה — היא לא חוזרת מיד בסבב החדש, ואחרי שתי החמצות שלוש מילים אחר כך",
    !held.spellHas && !held.sayHas && held.seen.indexOf("dog") === 2, held);
  await page.setViewportSize(viewport);

  // פתיחה של האפליקציה מתחילה בסבב חדש, ובמילה שהילד כבר אמר ביום קודם:
  // המילה האחרונה ברשימה השמורה, שהטעינה תמצא.
  const opener = await page.evaluate(P => {
    const day = dayNumber(), saved = JSON.parse(localStorage.getItem("words")), w = saved[saved.length - 1].word;
    localStorage.setItem(P, JSON.stringify({ v: 1, w: {
      [w]: { met: day - 9, seen: day - 2, box: 2, due: day + 1, ok: [day - 3], n: 3, k: 2, got: day - 3 } } }));
    return w;
  }, P);
  await reload();
  const startedOn = await page.evaluate(() => ({ word: word(), at: round.at,
    veiled: getComputedStyle($("word")).visibility === "hidden" }));
  check("פתיחה מתחילה במילה שהילד כבר אמר, בלי כתב",
    startedOn.word === opener && startedOn.at === 0 && startedOn.veiled, { opener, startedOn });

  // מחיקת המילה בסוף הסבב שמרה את רשימת הקבוצה, אז הרשימה מלפניה נשמרת בחזרה.
  await page.evaluate(([P, list]) => {
    localStorage.removeItem(P);
    applyWords(list, 0);
    newRound();
  }, [P, roundList]);
  // הטעינה מחדש פותחת את המנוע מחדש, והקבוצה הבאה צריכה אותו מוכן.
  await page.waitForFunction(() => model !== null, null, { timeout: 60000 });

  // --------------------------------------------------------------
  group("הבנה");
  // מילה שהילד עוד לא אמר מתחילה בשמיעה: הדף אומר אותה, והילד בוחר את התמונה
  // שלה מבין שלוש. ילד שאולי כבר יודע מילה חדשה נבדק קודם מהתמונה בלבד. כאן
  // שניהם דולקים, וההקראה מדומה: לדפדפן של הבדיקות אין קולות, ולכן speak
  // מוחלפת בהקראה שמתחילה, נכשלת או שותקת, ו-voices מקבל קול אחד באנגלית.
  await page.evaluate(([P, L]) => {
    laneFast = realStep.laneFast;
    canSpeak = realStep.canSpeak;
    listenOnly = realStep.listenOnly;
    for(const w of realStep.loanwords) LOANWORD_SET.add(w);
    localStorage.removeItem(P); localStorage.removeItem(L);
    const before = words, names = ["dog", "cat", "sun", "moon", "banana", "ship", "ball", "tea", "fish", "apple", "car",
                                   "book", "lion", "tree", "bird", "house", "flower", "cake"];
    applyWords(PAIRS.filter(p => names.includes(p[1])).map(([emoji, word]) => ({ emoji, word })), 0, false);
    window.uTest = {
      before, spoken: [], speech: "start", chimes: [], realSpeak: speak, realChime: chime, realSound: soundEnabled,
      realRefresh: refreshVoices, pending: null,
      voice: { name: "Test", lang: "en-US", localService: true, default: true, voiceURI: "test" },
      wait: ms => new Promise(r => setTimeout(r, ms)),
      // מילה על המסך כתור חדש, כאילו זו הפעם הראשונה שלה בסבב.
      show: (w, keepSeen = false) => {
        if(!keepSeen) round.seen = [];
        turn.word = null;
        i = words.findIndex(x => x.word === w);
        show();
      },
      // said: כמה מילים, מחוץ לרשימה, הילד כבר אמר. בדיקה מהתמונה באה רק אחרי
      // FIRST_MODEL_TURNS כאלה, ולכן בדיקות של הבדיקה מתחילות מהן.
      lane: (v, said = 0) => localStorage.setItem(P, JSON.stringify({ v: 1, ...(v ? { lane: v } : {}),
        w: Object.fromEntries(Array.from({ length: said }, (_, k) => ["said" + k, { met: 1, seen: 1, box: 0, due: 1, ok: [], n: 1, k: 0 }])) })),
      probing: () => uTest.lane("fast", FIRST_MODEL_TURNS),
      store: () => JSON.parse(localStorage.getItem(P) || "null"),
      log: () => (JSON.parse(localStorage.getItem(L) || "null") || { a: [] }).a,
      seen: id => $(id).checkVisibility() && getComputedStyle($(id)).visibility === "visible",
      choice: right => [...$("choices").children].find(b => (b.dataset.word === word()) === right && !b.disabled),
      say: async w => {
        await listen();
        rec.dispatchEvent(new CustomEvent("result", { detail: { result: { result: [{ word: w, conf: 1 }], text: w } } }));
      }
    };
    voices = [uTest.voice];
    refreshVoices = () => {};
    // "slow": מתחילה רק אחרי 300ms, והקראה חדשה מבטלת את זו שעוד לא התחילה, כמו ב-cancel().
    speak = text => {
      if(!soundEnabled) return null;
      uTest.spoken.push(text);
      const u = new EventTarget(), old = uTest.pending;
      if(old && !old.started) old.dispatchEvent(Object.assign(new Event("error"), { error: "canceled" }));
      uTest.pending = u;
      // ואחרי שהתחילה היא נגמרת (end), כמו מילה אחת.
      const start = () => { if(uTest.pending === u){ u.started = true; u.dispatchEvent(new Event("start"));
        setTimeout(() => u.dispatchEvent(new Event("end")), 30); } };
      if(uTest.speech === "start") setTimeout(start, 5);
      if(uTest.speech === "slow") setTimeout(start, 300);
      // "hang": מתחילה ולא נגמרת, כמו הקראה שהדפדפן עצר כשהדף ירד מהמסך.
      if(uTest.speech === "hang") setTimeout(() => { if(uTest.pending === u){ u.started = true; u.dispatchEvent(new Event("start")); } }, 5);
      if(uTest.speech === "error") setTimeout(() => u.dispatchEvent(Object.assign(new Event("error"), { error: "synthesis-failed" })), 5);
      return u;
    };
    chime = sound => { uTest.chimes.push(sound); return uTest.realChime(sound); };
    setSound(true);
  }, [P, L]);

  // שלב "להבין" רק כשהמכשיר מדבר: שמע דלוק וקול באנגלית.
  const speechGate = await page.evaluate(() => {
    const out = {};
    uTest.lane("off");
    uTest.show("dog");
    out.on = { step: turn.step, choices: uTest.seen("choices"), picture: uTest.seen("picture"), text: uTest.seen("word") };
    setSound(false);
    uTest.show("dog");
    out.muted = { step: turn.step, choices: uTest.seen("choices"), text: uTest.seen("word") };
    setSound(true);
    const realVoices = voices;
    voices = [];
    uTest.show("dog");
    out.voiceless = { step: turn.step, text: uTest.seen("word") };
    voices = realVoices;
    return out;
  });
  check("עם שמע וקול באנגלית, מילה חדשה מתחילה בשלוש תמונות, בלי הכתב",
    speechGate.on.step === "understand" && speechGate.on.choices && !speechGate.on.picture && !speechGate.on.text, speechGate);
  check("בלי שמע, או בלי קול באנגלית, אין \"להבין\": המילה מוצגת עם הכתב, כמו קודם",
    speechGate.muted.step === "say" && !speechGate.muted.choices && speechGate.muted.text && speechGate.voiceless.step === "say" && speechGate.voiceless.text, speechGate);

  // שלוש תמונות שונות, ביניהן של המילה, מנושאים שונים, ששום שתיים מהן לא דומות,
  // בלי אימוג'י מורכב, ושמות שלא מגלים את התשובה.
  const choiceSet = await page.evaluate(() => {
    const bad = [];
    for(let k = 0; k < 40; k++){
      const target = ["dog", "ship", "ball", "tea", "cat"][k % 5], c = choicesFor(target);
      const themes = new Set(c.map(x => THEME_BY_WORD[x])), emojis = new Set(c.map(emojiFor));
      const problems = [];
      if(c.length !== 3 || !c.includes(target) || new Set(c).size !== 3 || emojis.size !== 3) problems.push("shape");
      if(themes.size !== 3) problems.push("themes");
      for(const a of c) for(const b of c) if(a < b && confusable(a, b)) problems.push(a + "/" + b);
      if(c.filter(x => x !== target).some(x => emojiFor(x).includes("‍"))) problems.push("zwj");
      if(problems.length) bad.push({ target, c, problems });
    }
    uTest.show("dog");
    const labels = [...$("choices").children].map(b => (b.getAttribute("aria-label") || "") + (b.title || ""));
    return { bad: bad.slice(0, 3), leak: labels.filter(l => turn.choices.some(w => l.includes(w))),
             digits: /[0-9]/.test($("choices").innerText) };
  });
  check("שלוש תמונות שונות, ביניהן של המילה, מנושאים שונים ולא דומות זו לזו", choiceSet.bad.length === 0, choiceSet);
  check("שמות התמונות לא אומרים את המילה, ואין בהן מספרים", choiceSet.leak.length === 0 && !choiceSet.digits, choiceSet);

  // המילה נאמרת מעצמה כשהשלב מתחיל, רק אם כבר נגעו בדף. 🔊 ו-🎤 הישן משמיעים שוב,
  // ואינם תשובה.
  const replays = await page.evaluate(async () => {
    const out = {};
    uTest.spoken = [];
    uTest.show("dog");
    out.auto = uTest.spoken.slice();
    const realUA = Object.getOwnPropertyDescriptor(Navigator.prototype, "userActivation");
    Object.defineProperty(navigator, "userActivation", { value: { hasBeenActive: false }, configurable: true });
    try{
      uTest.spoken = [];
      uTest.show("dog");
      out.untouched = { spoken: uTest.spoken.length, nudge: $("playWord").classList.contains("nudge") };
    } finally { delete navigator.userActivation; }
    uTest.spoken = [];
    const picksBefore = uTest.log().filter(e => e[4] === "pick").length;
    $("playWord").click();
    out.replay = { spoken: uTest.spoken.slice(), step: turn.step };
    out.duringWord = { pictures: [...$("choices").children].every(b => b.classList.contains("asleep")),
                       help: isShown($("playWord")), next: isShown($("next")), cue: $("cue").dataset.cue };
    await uTest.wait(80);
    out.afterWord = { pictures: [...$("choices").children].some(b => b.classList.contains("asleep")),
                      help: isShown($("playWord")), cue: $("cue").dataset.cue, mic: $("say").checkVisibility() };
    uTest.spoken = [];
    $("say").click();
    await uTest.wait(50);
    out.mic = { spoken: uTest.spoken.slice(), active, step: turn.step };
    out.noPick = uTest.log().filter(e => e[4] === "pick").length === picksBefore;
    return out;
  });
  check("המילה נאמרת מעצמה כשהשלב מתחיל", JSON.stringify(replays.auto) === '["dog"]', replays);
  check("לפני נגיעה ראשונה בדף היא לא נאמרת, ו-🔊 פועם", replays.untouched.spoken === 0 && replays.untouched.nudge, replays);
  check("🔊 משמיע שוב, ובשלב הזה אין 🎤 על המסך; גם הקשבה מהמקלדת רק משמיעה — ואף אחד מהם אינו תשובה",
    JSON.stringify(replays.replay.spoken) === '["dog"]' && replays.replay.step === "understand" && !replays.afterWord.mic
      && JSON.stringify(replays.mic.spoken) === '["dog"]' && !replays.mic.active && replays.mic.step === "understand"
      && replays.noPick, replays);
  check("בזמן שהמילה נשמעת התמונות ישנות, \"הקשיבו\", ואין 🔊 ו-⏭️; כשהיא נגמרת הן מתעוררות, \"איזו תמונה?\"",
    replays.duringWord.pictures && !replays.duringWord.help && !replays.duringWord.next && replays.duringWord.cue === "listen"
      && !replays.afterWord.pictures && replays.afterWord.help && replays.afterWord.cue === "pick", replays);

  // תמונה שגויה דוהה, והמילה נשמעת שוב, בלי אדום ובלי צליל. הנכונה בניסיון הראשון
  // מסמנת הבנה, בלי לגעת בסולם של האמירה, ועוברת לאמירה של אותה מילה.
  const picked = await page.evaluate(async ([P]) => {
    const out = {};
    uTest.lane("off");
    uTest.show("dog");
    await uTest.wait(HEAR_MS + 50);
    uTest.spoken = []; uTest.chimes = [];
    const wrong = uTest.choice(false);
    wrong.click();
    out.wrong = { faded: wrong.classList.contains("faded"), disabled: wrong.disabled, card: $("card").className,
                  oops: uTest.chimes.length > 0, spoken: uTest.spoken.slice(), log: uTest.log().slice(-1)[0],
                  n: ((uTest.store() || { w: {} }).w.dog || { n: 0 }).n };
    await uTest.wait(HEAR_MS + 50);
    uTest.chimes = [];
    uTest.speech = "slow";
    uTest.choice(true).click();
    out.right = { green: !!$("choices").querySelector(".right"), cheer: uTest.chimes.includes(CHEER) };
    await uTest.wait(UNDERSTOOD_MS + 100);
    // "אני אומר, אתם אומרים": המילה נאמרת שוב, ו-🎤 מופיע רק כשהיא נגמרת.
    out.after = { step: turn.step, choices: uTest.seen("choices"), picture: uTest.seen("picture"), text: uTest.seen("word"),
                  spoken: uTest.spoken.slice(-1)[0], micDuring: isShown($("say")) };
    await uTest.wait(400);
    out.after.micAfter = isShown($("say"));
    uTest.speech = "start";
    out.secondTry = (uTest.store() || { w: {} }).w.dog;
    uTest.lane("off");
    uTest.show("dog");
    await uTest.wait(HEAR_MS + 50);
    uTest.choice(true).click();
    out.firstRec = uTest.store().w.dog;
    await uTest.wait(UNDERSTOOD_MS + 200);
    await uTest.say("dog");
    out.saidRec = uTest.store().w.dog;
    await uTest.wait(GOOD_MS + 200);
    return out;
  }, [P]);
  check("תמונה שגויה דוהה, והמילה נשמעת שוב — בלי אדום ובלי צליל",
    picked.wrong.faded && picked.wrong.disabled && picked.wrong.card !== "again" && !picked.wrong.oops
      && JSON.stringify(picked.wrong.spoken) === '["dog"]' && picked.wrong.log[4] === "pick" && picked.wrong.log[8] !== "dog"
      && picked.wrong.n === 0, picked);
  check("תמונה נכונה — ירוק וצליל, ואז אמירה של אותה מילה, עם הכתב",
    picked.right.green && picked.right.cheer && picked.after.step === "say" && !picked.after.choices
      && picked.after.picture && picked.after.text, picked);
  check("אחרי הבחירה המילה נאמרת שוב, ו-🎤 מופיע רק כשהיא נגמרת",
    picked.after.spoken === "dog" && !picked.after.micDuring && picked.after.micAfter, picked);
  check("בחירה נכונה רק אחרי שגויה לא מסמנת הבנה, ולא נוגעת באמירה",
    !picked.secondTry || (picked.secondTry.u === undefined && picked.secondTry.n === 0), picked);
  check("בחירה נכונה ראשונה מסמנת הבנה בלי לגעת בסולם, והאמירה אחריה נעזרה",
    !!picked.firstRec && picked.firstRec.u !== undefined && picked.firstRec.n === 0 && picked.firstRec.box === 0
      && !!picked.saidRec && picked.saidRec.n === 1 && picked.saidRec.k === 0 && picked.saidRec.got === undefined, picked);

  // כשהדיבור לא עובד השלב לא יכול לעבוד, וילד שלא שומע היה רק מנחש.
  const brokenSpeech = await page.evaluate(async () => {
    const out = {};
    uTest.lane("off");
    uTest.speech = "silent";
    uTest.show("dog");
    await uTest.wait(SPEECH_START_MS + 200);
    out.silentAuto = { step: turn.step, nudge: $("playWord").classList.contains("nudge") };
    uTest.speech = "error";
    const misses = uTest.log().filter(e => e[4] === "no").length;
    $("playWord").click();
    await uTest.wait(100);
    out.errorTap = { step: turn.step, text: uTest.seen("word"), misses: uTest.log().filter(e => e[4] === "no").length - misses };
    uTest.speech = "start";
    uTest.show("cat");
    out.after = turn.step;
    speechBroken = false;
    return out;
  });
  check("הקראה שלא התחילה מעצמה — 🔊 פועם, והשלב נשאר", brokenSpeech.silentAuto.step === "understand" && brokenSpeech.silentAuto.nudge, brokenSpeech);
  check("הקראה שנכשלה אחרי נגיעה — המילה עוברת לאמירה עם הכתב, בלי שנרשם ניסיון, ו\"להבין\" יורד לפתיחה הזו",
    brokenSpeech.errorTap.step === "say" && brokenSpeech.errorTap.text && brokenSpeech.errorTap.misses === 0 && brokenSpeech.after === "say", brokenSpeech);

  // 🔇 באמצע, מעבר לכתיבה וחזרה, והחזרה של המילה בהמשך הסבב: אמירה.
  const leaving = await page.evaluate(() => {
    const out = {};
    uTest.lane("off");
    uTest.show("dog");
    toggleSound();
    out.muted = { step: turn.step, text: uTest.seen("word"), choices: uTest.seen("choices") };
    toggleSound();
    uTest.show("dog");
    setMode("spell");
    out.spell = uTest.seen("choices");
    setMode("say");
    out.back = { step: turn.step, choices: uTest.seen("choices") };
    uTest.show("dog");
    uTest.show("dog", true);
    out.again = turn.step;
    // מילה שנפגשה בלי שמע, ועוד לא נאמרה לבד ולא זוהתה בשמיעה, מקבלת את השלב כשיש שמע.
    localStorage.setItem("say-the-word-progress", JSON.stringify({ v: 1, lane: "off", w: { sun: { met: 1, seen: 1, box: 0, due: 1, ok: [], n: 2, k: 0 } } }));
    uTest.show("sun");
    out.later = turn.step;
    return out;
  });
  check("🔇 באמצע \"להבין\" — המילה עוברת לאמירה, עם הכתב",
    leaving.muted.step === "say" && leaving.muted.text && !leaving.muted.choices, leaving);
  check("מעבר לכתיבה וחזרה באמצע \"להבין\" — ממשיכים באמירה", !leaving.spell && leaving.back.step === "say" && !leaving.back.choices, leaving);
  check("החזרה של מילה בהמשך הסבב היא אמירה, בלי \"להבין\" שוב", leaving.again === "say", leaving);
  check("מילה שנפגשה בלי שמע מקבלת את \"להבין\" כשיש שמע", leaving.later === "understand", leaving);

  // הבדיקה מהתמונה: ילד במסלול המהיר, ומילים מעברית לכל ילד — אחרי שהילד
  // כבר אמר FIRST_MODEL_TURNS מילים. עד אז "אני אומר, אתם אומרים".
  const firsts = await page.evaluate(async () => {
    const out = [];
    uTest.lane(null);
    for(const w of ["dog", "cat", "sun", "banana"]){
      uTest.show(w);
      out.push(turn.step);
      if(turn.step === "understand"){
        await uTest.wait(HEAR_MS + 50);
        uTest.choice(true).click();
        await uTest.wait(UNDERSTOOD_MS + 150);
      }
      await uTest.say(w);
      await uTest.wait(GOOD_MS + 200);
    }
    uTest.show("moon");
    out.push(turn.step);
    return { steps: out, lane: uTest.store().lane };
  });
  check("ילד חדש: שלוש המילים הראשונות, גם מילה מעברית, הן \"אני אומר, אתם אומרים\", ורק אחריהן בדיקה מהתמונה",
    firsts.steps.join() === "understand,understand,understand,probe,probe" && firsts.lane === "fast", firsts);
  const probes = await page.evaluate(async () => {
    const out = {};
    uTest.probing();
    uTest.show("dog");
    out.fresh = { step: turn.step, text: uTest.seen("word"), choices: uTest.seen("choices"), picture: uTest.seen("picture"),
                  badge: $("badge").className, cue: $("cue").dataset.cue };
    await uTest.say("dog");
    await uTest.wait(GOOD_MS + 200);
    const s = uTest.store();
    out.accepted = { lane: s.lane, dog: s.w.dog, flags: uTest.log().slice(-1)[0][6] };
    uTest.show("sun");
    out.stillFast = turn.step;
    uTest.spoken = []; uTest.chimes = [];
    await uTest.say("zzz");
    out.missed = { card: $("card").className, oops: uTest.chimes.length > 0, text: uTest.seen("word"),
                   lane: uTest.store().lane, step: turn.step };
    await uTest.wait(100);
    out.missed.spoken = uTest.spoken.slice();
    await uTest.wait(AGAIN_MS);
    uTest.show("moon");
    out.afterLane = turn.step;
    // מילה מעברית נבדקת מהתמונה גם אצל מי שכבר לא במסלול.
    uTest.show("banana");
    out.loanword = turn.step;
    // 🔊 בבדיקה הוא "אני לא יודע": הכתב מופיע, והמסלול נגמר.
    uTest.probing();
    uTest.show("dog");
    out.help = $("playWord").innerText.trim();
    $("playWord").click();
    out.heard = { step: turn.step, text: uTest.seen("word"), lane: uTest.store().lane };
    uTest.probing();
    uTest.show("dog");
    skipWord();
    out.skipped = uTest.store().lane;
    return out;
  });
  check("במסלול המהיר מילה חדשה נבדקת קודם מהתמונה בלבד, בלי הכתב ובלי \"להבין\", עם ❓",
    probes.fresh.step === "probe" && !probes.fresh.text && !probes.fresh.choices && probes.fresh.picture && probes.fresh.badge === "probe", probes);
  check("בדיקה מהתמונה שהצליחה — יום של \"אמר\", והילד נשאר במסלול המהיר",
    probes.accepted.lane === "fast" && !!probes.accepted.dog && JSON.stringify(probes.accepted.dog.ok).length > 2
      && String(probes.accepted.flags).includes("q") && probes.stillFast === "probe", probes);
  check("בדיקה שלא הצליחה — בלי רעידה ובלי צליל, גוון של \"מלמדים\", המילה כתובה ונשמעת, והמסלול המהיר נגמר",
    probes.missed.card === "teach" && !probes.missed.oops && probes.missed.text && probes.missed.lane === "off"
      && JSON.stringify(probes.missed.spoken) === '["sun"]' && probes.afterLane === "understand", probes);
  check("מילה מעברית נבדקת מהתמונה גם אחרי המסלול המהיר", probes.loanword === "probe", probes);
  check("🔊 או ⏭️ בבדיקה מהתמונה מסיימים את המסלול המהיר, ו-🔊, \"לא יודעים?\", מביא את הכתב",
    probes.heard.step === "say" && probes.heard.text && probes.heard.lane === "off" && probes.skipped === "off"
      && probes.help === "לֹא יוֹדְעִים?", probes);

  // ועוד: נגיעה לפני שמיעה, נגיעה כפולה ב-🔊, ומה ש"להבין" מסמן כשיוצאים ממנו.
  const more = await page.evaluate(async () => {
    const out = {};
    // לפני שהמילה נשמעה, נגיעה בתמונה רק משמיעה אותה.
    uTest.lane("off");
    Object.defineProperty(navigator, "userActivation", { value: { hasBeenActive: false }, configurable: true });
    try{ uTest.show("dog"); } finally { delete navigator.userActivation; }
    uTest.spoken = [];
    const picksBefore = uTest.log().filter(e => e[4] === "pick").length;
    uTest.choice(true).click();
    out.early = { spoken: uTest.spoken.slice(), step: turn.step, picks: uTest.log().filter(e => e[4] === "pick").length - picksBefore,
                  rec: (uTest.store() || { w: {} }).w.dog };
    await uTest.wait(HEAR_MS + 50);
    uTest.choice(true).click();
    out.afterHeard = (uTest.store().w.dog || {}).u !== undefined;
    await uTest.wait(UNDERSTOOD_MS + 200);
    // נגיעה כפולה ב-🔊 לפני שההקראה התחילה אינה תקלה.
    uTest.lane("off");
    uTest.speech = "slow";
    uTest.show("cat");
    $("playWord").click();
    await uTest.wait(80);
    $("playWord").click();
    await uTest.wait(SPEECH_START_MS + 500);
    out.double = { step: turn.step, broken: speechBroken };
    uTest.speech = "start";
    speechBroken = false;
    // מי ששמע את המילה ב"להבין" ויצא ממנו ב-🔇 חוזר עליה: האמירה נעזרה.
    uTest.lane("off");
    uTest.show("sun");
    await uTest.wait(HEAR_MS + 50);
    toggleSound();
    await uTest.say("sun");
    out.mutedSay = uTest.store().w.sun;
    await uTest.wait(GOOD_MS + 200);
    toggleSound();
    // מילה שהילד כבר אמר לבד, ומילה שכבר זוהתה בשמיעה, לא מקבלות "להבין".
    const d = dayNumber();
    localStorage.setItem("say-the-word-progress", JSON.stringify({ v: 1, lane: "off", w: {
      dog: { met: d - 9, seen: d - 2, box: 2, due: d + 1, ok: [d - 3, d - 2], n: 3, k: 2, got: d - 5 },
      cat: { met: d, seen: d, box: 0, due: d, ok: [], n: 1, k: 0, u: d } } }));
    uTest.show("dog");
    out.known = { step: turn.step, text: uTest.seen("word") };
    uTest.show("cat");
    out.understood = turn.step;
    // ילד שכבר ניסה מילים, בלי מסלול כתוב, אינו ילד חדש.
    localStorage.setItem("say-the-word-progress", JSON.stringify({ v: 1, w: {
      dog: { met: d - 9, seen: d - 2, box: 2, due: d + 1, ok: [d - 3], n: 3, k: 2, got: d - 5 } } }));
    uTest.show("cat");
    out.veteran = { step: turn.step, lane: uTest.store().lane };
    // מילה מעברית שנאמרה נכון אצל מי שלא במסלול לא מחזירה אותו למסלול.
    uTest.lane("off", FIRST_MODEL_TURNS);
    uTest.show("banana");
    const wasProbe = turn.step;
    await uTest.say("banana");
    out.loanOk = { wasProbe, lane: uTest.store().lane };
    await uTest.wait(GOOD_MS + 200);
    // הצלחה בבדיקה מסיימת אותה מיד, ו-🔊 בזמן ההצלחה לא מוציא מהמסלול.
    uTest.probing();
    uTest.show("moon");
    await uTest.say("moon");
    out.probeDone = turn.step;
    $("playWord").click();
    out.laneAfterCheer = uTest.store().lane;
    await uTest.wait(GOOD_MS + 200);
    // אמירה אחרי ששמעו את המילה, למשל מ-🔊 ברשימה, אינה הצלחה של הבדיקה.
    uTest.probing();
    uTest.show("fish");
    turn.heard = true;
    await uTest.say("fish");
    out.helpedProbe = uTest.store().lane;
    await uTest.wait(GOOD_MS + 200);
    // הדלקת השמע בבדיקה, כמו 🔊: הכתב מופיע והמסלול נגמר.
    uTest.probing();
    setSound(false);
    uTest.show("apple");
    toggleSound();
    out.soundOn = { step: turn.step, text: uTest.seen("word"), lane: uTest.store().lane };
    return out;
  });
  check("נגיעה בתמונה לפני שהמילה נשמעה רק משמיעה אותה, ואינה בחירה",
    JSON.stringify(more.early.spoken) === '["dog"]' && more.early.step === "understand" && more.early.picks === 0
      && !more.early.rec && more.afterHeard, more);
  check("נגיעה כפולה ב-🔊 לפני שההקראה התחילה אינה תקלה", more.double.step === "understand" && !more.double.broken, more);

  // מתחת להגדרות, ובזמן שהמנוע עוד נטען או שהמיקרופון נפתח.
  const covered = await page.evaluate(async () => {
    const out = {};
    uTest.lane("off");
    // נגיעה כפולה בתמונה לפני שהמילה נשמעה: השנייה, ממש כשהיא מתחילה, אינה בחירה.
    Object.defineProperty(navigator, "userActivation", { value: { hasBeenActive: false }, configurable: true });
    try{ uTest.show("tea"); } finally { delete navigator.userActivation; }
    const picksBefore = uTest.log().filter(e => e[4] === "pick").length;
    uTest.choice(false).click();
    await uTest.wait(50);
    uTest.choice(false).click();
    out.doubleTap = uTest.log().filter(e => e[4] === "pick").length - picksBefore;
    // בדיקה מהתמונה רק כשהמנוע מוכן. לפני כן אין 🎤, וכל מילה היא "להבין".
    const realModel = model;
    model = null;
    try{
      uTest.probing();
      uTest.show("dog");
      out.loading = { step: turn.step, mic: $("say").checkVisibility() };
      uTest.show("dog", true);
      out.loadingAgain = turn.step;
    } finally { model = realModel; }
    // קולות שמגיעים בזמן שהמיקרופון נפתח לא מחליפים את התור.
    uTest.lane("off");
    voices = [];
    uTest.show("ship");
    opening = true;
    refreshVoices = () => { voices = [uTest.voice]; };
    try{
      speechSynthesis.dispatchEvent(new Event("voiceschanged"));
      out.opening = turn.step;
    } finally {
      opening = false;
      refreshVoices = () => {};
      voices = [uTest.voice];
    }
    return out;
  });
  check("נגיעה שנייה ממש כשהמילה מתחילה להישמע אינה בחירה", covered.doubleTap === 0, covered);
  check("בזמן שהמנוע נטען אין בדיקה מהתמונה ואין 🎤: כל מילה, גם כשהיא חוזרת, היא \"להבין\"",
    covered.loading.step === "understand" && !covered.loading.mic && covered.loadingAgain === "understand", covered);
  check("קולות שמגיעים בזמן שהמיקרופון נפתח לא מחליפים את התור", covered.opening === "say", covered);

  // המילה הראשונה בכל פתיחה מוצגת לפני שהמנוע מוכן. כשהוא מוכן היא לא מתחלפת
  // מתחת לאצבע, וילד חדש שאמר אותה נשאר במסלול המהיר. בדיקה שלא הצליחה מסיימת
  // אותו גם אם הילד אומר שוב באותו תור.
  const startup = await page.evaluate(async () => {
    const out = {}, realModel = model;
    try{
      Object.defineProperty(navigator, "userActivation", { value: { hasBeenActive: false }, configurable: true });
      try{
        model = null;
        uTest.lane(null);
        uTest.show("dog");
        out.before = { step: turn.step, choices: uTest.seen("choices") };
        model = realModel;
        modelReady();
        out.after = { step: turn.step, choices: uTest.seen("choices") };
      } finally { delete navigator.userActivation; }
      model = null;
      setSound(false);
      uTest.lane(null);
      uTest.show("cat");
      out.saidFirst = turn.step;
      model = realModel;
      await uTest.say("cat");
      out.lane = uTest.store().lane;
      await uTest.wait(GOOD_MS + 200);
    } finally {
      model = realModel;
      setSound(true);
    }
    out.again = [];
    for(const how of ["miss", "hear", "sound"]){
      uTest.probing();
      if(how === "sound") setSound(false);
      uTest.show("tree");
      if(how === "miss"){ await uTest.say("zzz"); await uTest.wait(100); }
      if(how === "hear") $("playWord").click();
      if(how === "sound") toggleSound();
      await uTest.say("tree");
      out.again.push(uTest.store().lane);
      await uTest.wait(Math.max(GOOD_MS, AGAIN_MS) + 200);
      setSound(true);
    }
    return out;
  });
  check("כשהמנוע מוכן, המילה שעל המסך לא מתחלפת מתחת לאצבע",
    startup.before.step === "understand" && startup.after.step === "understand" && startup.after.choices, startup);
  check("בדיקה שלא הצליחה מסיימת את המסלול גם כשהילד אומר שוב באותו תור — אחרי אמירה, 🔊 או הדלקת השמע",
    startup.again.every(l => l === "off"), startup);
  check("ילד חדש שאמר מילה שלא נבדקה נשאר במסלול המהיר", startup.saidFirst === "say" && startup.lane === "fast", startup);
  check("מי ששמע את המילה ב\"להבין\" ויצא ב-🔇 — האמירה שאחר כך נעזרה",
    !!more.mutedSay && more.mutedSay.k === 0 && more.mutedSay.got === undefined, more);
  check("מילה שהילד כבר אמר, או שכבר זוהתה בשמיעה, לא מקבלת \"להבין\"",
    more.known.step === "say" && !more.known.text && more.understood === "say", more);
  check("ילד שכבר ניסה מילים אינו במסלול המהיר", more.veteran.step === "understand" && more.veteran.lane === undefined, more);
  check("מילה מעברית שנאמרה נכון לא מחזירה למסלול המהיר", more.loanOk.wasProbe === "probe" && more.loanOk.lane === "off", more);
  check("בדיקה שהצליחה נגמרת מיד, ו-🔊 בזמן ההצלחה לא מוציא מהמסלול", more.probeDone === "say" && more.laneAfterCheer === "fast", more);
  check("אמירה אחרי ששמעו את המילה אינה הצלחה של הבדיקה", more.helpedProbe === "off", more);
  check("הדלקת השמע בבדיקה מהתמונה — הכתב מופיע והמסלול נגמר",
    more.soundOn.step === "say" && more.soundOn.text && more.soundOn.lane === "off", more);

  // מילה שמורה מוסיפה מהמאגר מתחילה ב"להבין", ומילה מעברית בבדיקה. הקולות
  // שמגיעים אחרי שהמילה הראשונה הוצגה מביאים לה "להבין".
  const catalogAdd = await page.evaluate(async () => {
    const out = {}, before = words;
    uTest.lane("off", FIRST_MODEL_TURNS);
    try{
      const add = w => {
        const [emoji] = PAIRS.find(p => p[1] === w);
        applyWords(words.concat([{ emoji, word: w }]), words.length, false);
        return turn.step;
      };
      out.plain = add("mouse");
      out.loan = add("pizza");
      applyWords(before, 0, false);
      voices = [];
      uTest.show("ship");
      out.before = turn.step;
      refreshVoices = () => { voices = [uTest.voice]; };
      uTest.spoken = [];
      speechSynthesis.dispatchEvent(new Event("voiceschanged"));
      out.after = { step: turn.step, choices: uTest.seen("choices"), spoken: uTest.spoken.slice() };
    } finally {
      refreshVoices = () => {};
      voices = [uTest.voice];
      applyWords(before, 0, false);
    }
    // ושההקראה האמיתית מחזירה את ההקראה, כדי שאפשר לדעת שנכשלה.
    const stub = speak;
    uTest.show("tree");
    speak = uTest.realSpeak;
    voices = [];
    speechSynthesis.speak = u => setTimeout(() => u.dispatchEvent(Object.assign(new Event("error"), { error: "synthesis-failed" })), 5);
    try{
      $("playWord").click();
      await uTest.wait(100);
      out.real = { step: turn.step, broken: speechBroken };
    } finally {
      delete speechSynthesis.speak;
      speak = stub;
      voices = [uTest.voice];
      speechBroken = false;
    }
    return out;
  });
  check("מילה שמורה מוסיפה מהמאגר מתחילה ב\"להבין\", ומילה מעברית בבדיקה מהתמונה",
    catalogAdd.plain === "understand" && catalogAdd.loan === "probe", catalogAdd);
  check("קולות שמגיעים אחרי שהמילה הראשונה הוצגה מביאים לה \"להבין\"",
    catalogAdd.before === "say" && catalogAdd.after.step === "understand" && catalogAdd.after.choices
      && JSON.stringify(catalogAdd.after.spoken) === '["ship"]', catalogAdd);
  check("הקראה אמיתית שנכשלת אחרי נגיעה מעבירה לאמירה", catalogAdd.real.step === "say" && catalogAdd.real.broken, catalogAdd);

  // מה שקורה לצד השלב: ההגדרות, חלון אחר, קולות והקראה שמגיעים באיחור.
  const aside = await page.evaluate(async () => {
    const out = {};
    // ⚙️ בזמן שהמיקרופון עוד נפתח: ההקשבה לא מתחילה מתחת להגדרות.
    const real = { audioReady, ensureAudio };
    setSound(false);
    uTest.lane("off");
    uTest.show("dog");
    audioReady = () => false;
    ensureAudio = () => new Promise(r => setTimeout(r, 200));
    try{
      const opening = listen();
      openPanel();
      await opening;
      out.panel = { step: turn.step, active, listening: $("say").classList.contains("listening") };
    } finally {
      audioReady = real.audioReady;
      ensureAudio = real.ensureAudio;
      stopListening();
      closePanel();
      enterGame();
      setSound(true);
    }
    // 🔊 של המורה ברשימה מבטל את המילה של "להבין" לפני שהתחילה, וזו לא תקלה.
    uTest.speech = "slow";
    uTest.show("cat");
    $("playWord").click();
    openPanel();
    showSettingsView("words");
    $("wordList").querySelector(".speak-word-btn").click();
    await uTest.wait(SPEECH_START_MS + 300);
    out.list = { step: turn.step, broken: speechBroken };
    speechBroken = false;
    closePanel();
    enterGame();
    // ▶ מגן על הכפתורים מנגיעה כפולה, ונגיעה ב-🔊 בזמן הזה לא נספרת.
    await uTest.wait(END_GUARD_MS + 100);
    // הקראה אמיתית שמתחילה באיחור: השלב ירד, והמילים הבאות שוב מתחילות ב"להבין" —
    // גם כשמה שהתחיל הוא נגיעה נוספת ב-🔊, שביטלה את המאחרת.
    out.late = [];
    for(const again of [false, true]){
      uTest.show("sun");
      const stub = speak;
      let last = null, delay = SPEECH_START_MS + 300;
      speak = uTest.realSpeak;
      voices = [];
      speechSynthesis.speak = u => {
        last = u;
        setTimeout(() => { if(last === u) u.dispatchEvent(new Event("start")); }, delay);
      };
      try{
        $("playWord").click();
        await uTest.wait(SPEECH_START_MS + 100);
        const fell = { again, step: turn.step, broken: speechBroken };
        if(again){ delay = 5; $("playWord").click(); }
        await uTest.wait(400);
        speak = stub;
        voices = [uTest.voice];
        uTest.show("moon");
        out.late.push({ ...fell, next: turn.step });
      } finally {
        delete speechSynthesis.speak;
        speak = stub;
        voices = [uTest.voice];
        speechBroken = false;
      }
    }
    await uTest.wait(100);
    // ילד חדש שעבר את הבדיקה, בזמן שבחלון אחר הוא כבר יצא מהמסלול.
    uTest.probing();
    uTest.show("dog");
    out.otherWindow = { step: turn.step };
    uTest.lane("off");
    await uTest.say("dog");
    out.otherWindow.lane = uTest.store().lane;
    await uTest.wait(GOOD_MS + 200);
    // קולות שמגיעים כשהילד כבר רואה את המילה עם הכתב לא מסתירים אותו.
    uTest.lane("off");
    voices = [];
    uTest.show("ship");
    await uTest.wait(VOICES_GRACE_MS + 100);
    refreshVoices = () => { voices = [uTest.voice]; };
    try{
      speechSynthesis.dispatchEvent(new Event("voiceschanged"));
      out.lateVoices = { step: turn.step, text: uTest.seen("word") };
    } finally {
      refreshVoices = () => {};
      voices = [uTest.voice];
    }
    // הדף ירד מהמסך לפני שהמילה נשמעה: הדפדפן עצר את הדיבור, וזו לא תקלה בו.
    uTest.speech = "silent";
    uTest.show("cat");
    $("playWord").click();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    try{ document.dispatchEvent(new Event("visibilitychange")); }
    finally { delete document.hidden; }
    await uTest.wait(SPEECH_START_MS + 200);
    out.hidden = { step: turn.step, broken: speechBroken };
    // הדף ירד מהמסך באמצע המילה, וחזר: התמונות מתעוררות, ו-🔊 שם כדי לשמוע שוב.
    uTest.speech = "hang";
    uTest.show("sun");
    speakStep(true);
    await uTest.wait(50);
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    try{ document.dispatchEvent(new Event("visibilitychange")); }
    finally { delete document.hidden; }
    document.dispatchEvent(new Event("visibilitychange"));
    await uTest.wait(WORD_END_MS + 300);
    out.back = { step: turn.step, awake: turn.awake, asleep: [...$("choices").children].some(b => b.classList.contains("asleep")),
                 help: uTest.seen("playWord") && !$("playWord").classList.contains("away"), broken: speechBroken };
    uTest.speech = "start";
    speechBroken = false;
    return out;
  });
  check("⚙️ בזמן שהמיקרופון נפתח — לא מקשיבים מתחת להגדרות",
    aside.panel.step === "say" && !aside.panel.active && !aside.panel.listening, aside);
  check("🔊 ברשימת המילים בזמן \"להבין\" אינו תקלה בדיבור", aside.list.step === "understand" && !aside.list.broken, aside);
  check("הקראה שמתחילה באיחור מחזירה את \"להבין\" למילים הבאות, גם כשנגיעה נוספת ב-🔊 ביטלה אותה",
    aside.late.length === 2 && aside.late.every(l => l.step === "say" && l.broken && l.next === "understand"), aside);
  check("ילד שיצא מהמסלול בחלון אחד לא חוזר אליו מחלון אחר",
    aside.otherWindow.step === "probe" && aside.otherWindow.lane === "off", aside);
  check("קולות שמגיעים אחרי הרגע הראשון של המילה לא מסתירים את הכתב",
    aside.lateVoices.step === "say" && aside.lateVoices.text, aside);
  check("דף שירד מהמסך לפני שהמילה נשמעה נשאר ב\"להבין\"", aside.hidden.step === "understand" && !aside.hidden.broken, aside);
  check("דף שירד מהמסך באמצע המילה וחזר — התמונות ערות ו-🔊 על המסך",
    aside.back.step === "understand" && aside.back.awake && !aside.back.asleep && aside.back.help && !aside.back.broken, aside.back);

  // שתיקה לא נספרת, ולכן יש לה סולם משלה במקום ⏭️ גדול: בשנייה היד מצביעה על
  // 🔊 והמכשיר לא מדבר; בשלישית המילה עוברת להמשך הסבב, בלי ויתור ובלי לסיים
  // את המסלול המהיר.
  const quiet = await page.evaluate(async () => {
    const realWindow = listenWindowMs, realRetrieve = rec.retrieveFinalResult, out = { steps: [] };
    listenWindowMs = () => 60;
    rec.retrieveFinalResult = () => {};
    const hush = async () => {
      await listen();
      await uTest.wait(60 + FINAL_GRACE_MS + FINAL_ANSWER_MS + 150);
      const hand = $("hand"), r = $("playWord").getBoundingClientRect();
      out.steps.push({ cue: $("cue").dataset.cue, word: word(), hand: hand.classList.contains("tap"),
        onHelp: Math.abs(parseFloat(hand.style.left) + 14 - (r.left + r.width / 2)) < 2, spoken: uTest.spoken.length });
    };
    try{
      uTest.probing();
      round = { queue: ["dog", "sun", "lion", "book", "car"], at: -1, row: [], tried: [], fresh: [], requeued: [], seen: [], said: false };
      shownWord = null;
      next();
      out.first = turn.step;
      uTest.spoken = [];
      $("hand").classList.remove("tap");
      await hush();
      $("hand").classList.remove("tap");
      await hush();
      await hush();
      out.cardAfter = $("card").className;
      await uTest.wait(AGAIN_MS + 100);
      out.after = { word: word(), queue: round.queue.join(), lane: uTest.store().lane,
                    log: uTest.log().slice(-3).map(e => e[2] + ":" + e[4]).join() };
      return out;
    } finally {
      listenWindowMs = realWindow;
      rec.retrieveFinalResult = realRetrieve;
    }
  });
  check("שתיקה ראשונה — \"לא שמעתי\", 🎤 חוזר, ושום דבר לא נאמר",
    quiet.first === "probe" && quiet.steps[0].cue === "quiet" && quiet.steps[0].word === "dog" && !quiet.steps[0].hand
      && quiet.steps[0].spoken === 0, quiet);
  check("שתיקה שנייה — היד מצביעה על 🔊, והמכשיר לא מדבר",
    quiet.steps[1].cue === "quiet" && quiet.steps[1].hand && quiet.steps[1].onHelp && quiet.steps[1].spoken === 0, quiet);
  check("שתיקה שלישית — \"נחזור לזה\", והמילה חוזרת בהמשך הסבב, בלי ויתור ובלי לסיים את המסלול המהיר",
    quiet.steps[2].cue === "pocket" && quiet.cardAfter === "fall" && quiet.after.word === "sun"
      && quiet.after.queue === "dog,sun,lion,dog,book,car" && quiet.after.lane === "fast"
      && quiet.after.log === "dog:quiet,dog:quiet,dog:quiet", quiet);

  // 🔊 בכרטיס של מילה שהילד כבר אמר (💭): המילה נאמרת וגם הכתב מופיע, ו-🎤
  // חוזר רק כשהקול נגמר. הצלחה אחריו נעזרה.
  const recall = await page.evaluate(async () => {
    const d = dayNumber();
    localStorage.setItem("say-the-word-progress", JSON.stringify({ v: 1, lane: "off", w: {
      cat: { met: d - 9, seen: d - 2, box: 2, due: d, ok: [d - 3], n: 3, k: 2, got: d - 5 } } }));
    uTest.show("cat");
    const before = { cue: $("cue").dataset.cue, badge: $("badge").className, text: uTest.seen("word") };
    uTest.speech = "slow";
    $("playWord").click();
    const during = { text: uTest.seen("word"), mic: isShown($("say")), cue: $("cue").dataset.cue };
    await uTest.wait(450);
    const after = { mic: isShown($("say")), cue: $("cue").dataset.cue };
    uTest.speech = "start";
    await uTest.say("cat");
    const rec = uTest.store().w.cat;
    await uTest.wait(GOOD_MS + 200);
    return { before, during, after, rec };
  });
  check("מילה שהילד כבר אמר: \"זוכרים?\", 💭, בלי כתב",
    recall.before.cue === "recall" && recall.before.badge === "recall" && !recall.before.text, recall);
  check("🔊 במילה שהילד כבר אמר מראה גם את הכתב, ו-🎤 חוזר רק כשהקול נגמר",
    recall.during.text && !recall.during.mic && recall.during.cue === "listen" && recall.after.mic && recall.after.cue === "say", recall);
  check("והצלחה אחריו נעזרה", recall.rec.k === 2 && recall.rec.n === 4, recall);

  // בכרטיס עם כתב שהילד הגיע אליו בלי לשמוע, המכשיר לא אומר את המילה מעצמו,
  // גם לא אחרי המתנה: אחרת הצלחה לבד לא הייתה נחשבת.
  const unheard = await page.evaluate(async () => {
    localStorage.setItem("say-the-word-progress", JSON.stringify({ v: 1, lane: "off", w: {
      sun: { met: 1, seen: 1, box: 0, due: 1, ok: [], n: 1, k: 0, u: 1 } } }));
    uTest.spoken = [];
    uTest.show("sun");
    const step = turn.step, text = uTest.seen("word");
    await uTest.wait(DEMO_FIRST_MS + 400);
    return { step, text, spoken: uTest.spoken.slice(), heard: turn.heard };
  });
  check("כרטיס עם כתב בלי ששמעו את המילה — המכשיר לא מדבר מעצמו",
    unheard.step === "say" && unheard.text && unheard.spoken.length === 0 && !unheard.heard, unheard);

  // מילה שכבר הוכרעה ומוצגת שוב — כאן הדלקת התעתיק — ממשיכה לבד: אין ⏭️ גדול
  // שיוציא ממנה.
  const reshown = await page.evaluate(async () => {
    localStorage.setItem("say-the-word-progress", JSON.stringify({ v: 1, lane: "off", w: {} }));
    round = { queue: ["dog", "sun"], at: -1, row: [], tried: [], fresh: [], requeued: [], seen: ["dog", "sun"], said: false };
    shownWord = null;
    next();
    await uTest.say("dog");
    setHebrew(hebrewEnabled);
    await uTest.wait(GOOD_MS + 300);
    return { word: word(), ended };
  });
  check("מילה שהוכרעה ומוצגת שוב עוברת לבד למילה הבאה", reshown.word === "sun" && !reshown.ended, reshown);

  // בלי מנוע זיהוי (או בלי מיקרופון) משחקים בשומעים ובוחרים בלבד: בחירה נכונה
  // עפה למעלה ובאה המילה הבאה, בלי אמירה. זה נרשם כהבנה, לא כאמירה.
  const listening = await page.evaluate(async () => {
    const realModel = model;
    localStorage.setItem("say-the-word-progress", JSON.stringify({ v: 1, lane: "off", w: {} }));
    model = null;
    try{
      round = { queue: ["dog", "sun"], at: -1, row: [], tried: [], fresh: [], requeued: [], seen: [], said: false };
      shownWord = null;
      next();
      await uTest.wait(HEAR_MS + 50);
      uTest.choice(true).click();
      await uTest.wait(UNDERSTOOD_MS + 100);
      const flying = !!$("choices").querySelector(".fly");
      await uTest.wait(GOOD_MS + 100);
      return { flying, word: word(), step: turn.step, dog: uTest.store().w.dog, mic: $("say").checkVisibility() };
    } finally { model = realModel; }
  });
  check("בלי מנוע זיהוי — בחירה נכונה עפה ובאה המילה הבאה, בלי 🎤, ונרשמת כהבנה בלבד",
    listening.flying && listening.word === "sun" && listening.step === "understand" && !listening.mic
      && !!listening.dog && listening.dog.u !== undefined && listening.dog.n === 0, listening);

  // שמע דלוק ואין קול באנגלית: "אין קול", פעם אחת בפתיחה, ואז כרגיל.
  const noVoice = await page.evaluate(async () => {
    const realVoices = voices;
    voices = [];
    noVoiceShown = false;
    try{
      uTest.show("dog");
      const first = $("cue").dataset.cue;
      uTest.show("sun");
      const second = $("cue").dataset.cue;
      return { first, second };
    } finally { voices = realVoices; }
  });
  check("שמע דלוק בלי קול באנגלית — \"אין קול\" פעם אחת", noVoice.first === "novoice" && noVoice.second !== "novoice", noVoice);

  // מצב מעורב, ברירת המחדל: המשחק משלב סבב כתיבה כל SPELL_EVERY סבבים, רק אחרי
  // שהילד כבר אומר SPELL_AFTER_KNOWN מילים, ובו רק מילים שהוא אומר.
  const mixedRounds = await page.evaluate(() => {
    const realDue = mixedSpellDue, d = dayNumber();
    mixedSpellDue = realStep.mixedSpellDue;
    const known = list => Object.fromEntries(list.map(w => [w, { met: d - 9, seen: d - 2, box: 2, due: d + 5, ok: [d - 3], n: 3, k: 2, got: d - 5 }]));
    const rounds = n => Array.from({ length: n }, () => { newRound(); return mode + ":" + [...new Set(round.queue)].sort().join("/"); });
    try{
      setMode("mixed");
      const fresh = { chosen: chosenMode, saved: localStorage.getItem("practice_mode") };
      localStorage.setItem("say-the-word-progress", JSON.stringify({ v: 1, lane: "off", w: known(["dog", "cat"]) }));
      roundsSinceSpell = 0;
      const few = rounds(4).map(r => r.split(":")[0]);
      localStorage.setItem("say-the-word-progress", JSON.stringify({ v: 1, lane: "off", w: known(["dog", "cat", "sun"]) }));
      roundsSinceSpell = 0;
      const enough = rounds(6);
      const switchShows = document.querySelector('#modeSwitch [aria-checked="true"]').dataset.mode;
      setMode("say");
      roundsSinceSpell = 0;
      const sayOnly = rounds(4).map(r => r.split(":")[0]);
      setMode("spell");
      newRound();
      const spellOnly = { mode, size: new Set(round.queue).size };
      return { fresh, few, enough, switchShows, sayOnly, spellOnly };
    } finally {
      mixedSpellDue = realDue;
      setMode("say");
      localStorage.removeItem("say-the-word-progress");
    }
  });
  check("מעורב כשהילד אומר פחות משלוש מילים — רק סבבי אמירה", mixedRounds.few.every(m => m === "say"), mixedRounds);
  check("מעורב — כל סבב שלישי כתיבה, ובו רק המילים שהילד כבר אומר, גם אם הסבב קצר",
    mixedRounds.enough.map(r => r.split(":")[0]).join() === "say,say,spell,say,say,spell"
      && mixedRounds.enough[2] === "spell:cat/dog/sun" && mixedRounds.switchShows === "mixed", mixedRounds);
  check("\"רק אומרים\" לא משלב כתיבה, ו\"רק כותבים\" מתמלא גם במילים אחרות",
    mixedRounds.sayOnly.every(m => m === "say") && mixedRounds.spellOnly.mode === "spell" && mixedRounds.spellOnly.size > 3, mixedRounds);

  // כתיבה: המשבצת הבאה זוהרת, חץ מראה את כיוון הכתיבה, המילה נאמרת כשהיא
  // מופיעה, תקתוק רך על כל אות, ואחרי מילה שגויה המילה נשמעת שוב.
  const spelling = await page.evaluate(async () => {
    const out = {};
    setMode("spell");
    try{
      uTest.spoken = []; uTest.chimes = [];
      turn.word = null;
      i = words.findIndex(w => w.word === "cake");
      show();
      out.entry = { spoken: uTest.spoken.slice(), arrow: $("spellArrow").checkVisibility(), during: $("cue").dataset.cue,
                    next: slotList().findIndex(s => s.classList.contains("next")), he: uTest.seen("wordHe") };
      await uTest.wait(100);
      out.entry.cue = $("cue").dataset.cue;
      const target = word();
      [...$("bank").children].find(t => !t.disabled && t.dataset.letter === target[0]).click();
      out.afterOne = { next: slotList().findIndex(s => s.classList.contains("next")), tick: uTest.chimes.includes(TICK) };
      uTest.spoken = [];
      for(const ch of [...target.slice(1)].reverse()) [...$("bank").children].find(t => !t.disabled && t.dataset.letter === ch).click();
      out.wrong = { spoken: uTest.spoken.slice(), card: $("card").className };
      await uTest.wait(100);
      out.wrong.cue = $("cue").dataset.cue;
      await uTest.wait(WRONG_MS + 200);
      out.backTo = slotList().findIndex(s => s.classList.contains("next"));
      out.hint = $("hint").checkVisibility() && !$("hint").disabled;
      return out;
    } finally { setMode("say"); }
  });
  check("כתיבה: המילה נאמרת כשהיא מופיעה, חץ לכיוון הכתיבה, התעתיק נשאר, והמשבצת הראשונה זוהרת",
    JSON.stringify(spelling.entry.spoken) === '["cake"]' && spelling.entry.arrow && spelling.entry.during === "listen" && spelling.entry.cue === "spell"
      && spelling.entry.next === 0 && spelling.entry.he, spelling);
  check("אות שהונחה — תקתוק רך, והזוהר עובר למשבצת הבאה", spelling.afterOne.tick && spelling.afterOne.next === 1, spelling);
  check("מילה שגויה — רעידה, \"עוד פעם\", המילה נשמעת שוב, הזוהר על המשבצת הריקה הראשונה, ו-💡 נשאר",
    spelling.wrong.card === "again" && spelling.wrong.cue === "again" && JSON.stringify(spelling.wrong.spoken) === '["cake"]'
      && spelling.backTo === 1 && spelling.hint, spelling);

  // מילה שנפלה לכיס חוזרת ממנו בהמשך הסבב; מילה שהילד כבר אומר חוזרת בלי כתב.
  const popped = await page.evaluate(async () => {
    const d = dayNumber();
    localStorage.setItem("say-the-word-progress", JSON.stringify({ v: 1, lane: "off", w: {
      cat: { met: d - 9, seen: d - 2, box: 2, due: d, ok: [d - 3], n: 3, k: 2, got: d - 5 } } }));
    round = { queue: ["cat", "sun", "lion", "book", "car"], at: -1, row: [], tried: [], fresh: [], requeued: [],
              seen: ["cat", "sun", "lion", "book", "car"], said: false, pocketed: [] };
    shownWord = null;
    next();
    for(let k = 0; k < 2; k++){ await uTest.say("zzz"); await uTest.wait(AGAIN_MS + 150); }
    const out = { after: word(), pocketed: round.pocketed.slice() };
    next(); next();
    out.back = { word: word(), card: $("card").className, pocket: !$("pocket").hidden, text: uTest.seen("word"),
                 cue: $("cue").dataset.cue };
    next();
    out.later = { card: $("card").className, pocket: !$("pocket").hidden };
    return out;
  });
  check("מילה שנפלה לכיס קופצת ממנו כשהיא חוזרת, ומילה שהילד אומר חוזרת בלי כתב",
    popped.after === "sun" && popped.pocketed.join() === "cat" && popped.back.word === "cat" && popped.back.card === "pop"
      && popped.back.pocket && !popped.back.text && popped.back.cue === "recall" && popped.later.card === "" && !popped.later.pocket, popped);

  // שורת נקודות דקה: נקודה לכל מילה בסבב, מה שעבר, מה שעכשיו ומה שנשאר.
  const dots = await page.evaluate(() => {
    round = { queue: ["dog", "sun", "lion", "book"], at: -1, row: [], tried: [], fresh: [], requeued: [], seen: [], said: false, pocketed: [] };
    shownWord = null;
    next(); next();
    const out = { classes: [...$("dots").children].map(d => d.className || "-").join(), text: $("dots").textContent,
                  hidden: $("dots").getAttribute("aria-hidden"), tappable: $("dots").querySelector("button") };
    return out;
  });
  check("שורת נקודות: כמה מילים נשארו בסבב, בלי תמונות ובלי מספרים",
    dots.classes === "done,now,-,-" && dots.text === "" && dots.hidden === "true" && !dots.tappable, dots);

  // הטבעות סביב 🎤 זזות עם הקול שהמיקרופון שומע. המיקרופון המזויף של כרומיום
  // משמיע צפצוף, ולכן העוצמה גדולה מאפס בזמן ההקשבה, וחוזרת לאפס אחריה.
  const rings = await page.evaluate(async () => {
    const realProcess = processRecognition;
    processRecognition = () => {};
    try{
      uTest.show("dog", true);
      await ensureAudio();
      await listen();
      let during = 0;
      for(let k = 0; k < 40; k++){
        await uTest.wait(20);
        during = Math.max(during, parseFloat($("say").style.getPropertyValue("--level")) || 0);
      }
      stopListening();
      return { during, after: parseFloat($("say").style.getPropertyValue("--level")) };
    } finally { processRecognition = realProcess; }
  });
  check("בזמן ההקשבה הטבעות זזות עם הקול, ואחריה נעצרות", rings.during > 0 && rings.after === 0, rings);

  // דפדפן שכבר הסיר את createScriptProcessor, שהוצא משימוש: המיקרופון עובר
  // דרך AudioWorklet, ואותו אודיו מגיע למפענח ולטבעות. בדפדפן נפרד, בלי מודל:
  // המפענח כאן הוא רק מונה.
  const noProc = await browser.newContext({ permissions: ["microphone"], serviceWorkers: "block" });
  await noProc.addInitScript(() => {
    delete BaseAudioContext.prototype.createScriptProcessor;
    delete AudioContext.prototype.createScriptProcessor;
  });
  await noProc.route("**/model.tar.gz", route => route.abort());
  const noProcPage = await noProc.newPage();
  await noProcPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  const worklet = await noProcPage.evaluate(async () => {
    await ensureAudio();
    const chunks = [];
    rec = { acceptWaveformFloat: (samples, rate) => chunks.push([samples.length, rate]), retrieveFinalResult(){}, remove(){} };
    active = true;
    let level = 0;
    for(let k = 0; k < 40; k++){
      await new Promise(r => setTimeout(r, 20));
      level = Math.max(level, parseFloat($("say").style.getPropertyValue("--level")) || 0);
    }
    active = false;
    return { node: procNode && procNode.constructor.name, chunks: chunks.length, size: chunks.length && chunks[0][0],
             rate: chunks.length && chunks[0][1] === ctx.sampleRate, level };
  }).catch(e => ({ error: e.message }));
  await noProc.close();
  check("בלי createScriptProcessor המיקרופון עובר דרך AudioWorklet, למפענח ולטבעות",
    worklet.node === "AudioWorkletNode" && worklet.chunks > 0 && worklet.size === 4096 && worklet.rate && worklet.level > 0, worklet);

  // מקלדת, ומסך של טלפון: התמונות בגובה של אצבע, על המסך, והתחתונה רחוקה מ-⏭️.
  await page.setViewportSize({ width: 360, height: 640 });
  const reachChoices = await page.evaluate(() => {
    uTest.lane("off");
    uTest.show("dog");
    const first = $("choices").children[0];
    first.focus();
    const focused = document.activeElement === first;
    const rects = [...$("choices").children].map(b => b.getBoundingClientRect()), row = $("buttons").getBoundingClientRect();
    const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const out = { focused, tabbable: [...$("choices").children].every(b => b.tabIndex === 0), heights: rects.map(r => Math.round(r.height)),
             onScreen: rects.every(r => r.top >= 0 && r.bottom <= innerHeight), gap: Math.round(row.top - Math.max(...rects.map(r => r.bottom))),
             rowOnScreen: row.bottom <= innerHeight, apart: !rects.some((r, k) => rects.some((q, j) => j > k && overlap(r, q))),
             columns: new Set(rects.map(r => Math.round(r.left))).size };
    openPanel();
    out.inert = $("game").inert;
    closePanel();
    enterGame();
    return out;
  });
  check("אפשר להגיע לתמונות במקלדת, ולא כשההגדרות פתוחות",
    reachChoices.focused && reachChoices.tabbable && reachChoices.inert, reachChoices);
  check("בטלפון בגובה 640 שלוש התמונות על המסך, כל אחת בגובה של אצבע, והתחתונה רחוקה מהכפתורים",
    reachChoices.onScreen && reachChoices.rowOnScreen && reachChoices.heights.every(h => h >= 64) && reachChoices.gap >= 40, reachChoices);
  check("התמונות בעיגולים מפוזרים, לא בטור, ולא עולות זו על זו",
    reachChoices.apart && reachChoices.columns > 1, reachChoices);
  await page.setViewportSize(viewport);

  // בזמן החגיגה של תמונה נכונה אין ⏭️ ואין 🔊: ⏭️ שם רשם ויתור על מילה שהילד
  // בדיוק הבין, ובמילה האחרונה בסבב הטיימר של החגיגה אמר אותה על מסך הסיום.
  const celebration = await page.evaluate(async () => {
    uTest.lane("off");
    uTest.show("dog");
    await uTest.wait(HEAR_MS + 200);
    uTest.choice(true).click();
    const out = { picked: turn.picked, next: isShown($("next")), help: isShown($("playWord")) };
    // הסבב נגמר באמצע החגיגה, ומסך הסיום האמיתי מופיע.
    const spoken = uTest.spoken.length;
    showRoundEnd = realShowRoundEnd;
    try{
      round.at = round.queue.length;
      next();
      await uTest.wait(UNDERSTOOD_MS + GOOD_MS + 300);
      out.ended = ended;
      out.spokenOnEnd = uTest.spoken.slice(spoken);
    } finally {
      showRoundEnd = () => newRound();
      hideRoundEnd();
    }
    return out;
  });
  check("בחגיגה של תמונה נכונה אין ⏭️ ו-🔊, ומסך הסיום שבא אחריה שקט",
    celebration.picked && !celebration.next && !celebration.help && celebration.ended && celebration.spokenOnEnd.length === 0, celebration);

  // בלי מיקרופון וגם בלי קול שעובד אין מה לעשות בכרטיס אמירה: הסבב הופך לכתיבה,
  // ולא לשורה של "אִמְרוּ בְּאַנְגְּלִית" בלי 🎤.
  const deadEnd = await page.evaluate(async () => {
    uTest.lane("off");
    micBlocked = true;
    uTest.speech = "silent";
    let cancels = 0;
    speechSynthesis.cancel = () => { cancels++; };
    try{
      uTest.show("cat");
      const before = turn.step;
      uTest.choice(true).click();
      await uTest.wait(SPEECH_START_MS + 300);
      // הקראה שתתחיל באיחור לא תישמע מעל הכרטיס של הכתיבה.
      return { before, mode, step: turn.step, spell: $("spell").checkVisibility(), say: isShown($("say")), broken: speechBroken, cancels };
    } finally {
      delete speechSynthesis.cancel;
      micBlocked = false;
      uTest.speech = "start";
      speechBroken = false;
      mode = "say";
      startRound();
    }
  });
  check("בלי מיקרופון, כשהקול מפסיק לעבוד, הסבב עובר לכתיבה",
    deadEnd.before === "understand" && deadEnd.broken && deadEnd.mode === "spell" && deadEnd.spell && deadEnd.cancels > 0, deadEnd);
  // אחרי שהמילה נשמעה, תזכורת של היד אומרת אותה שוב ועוברת על כל שלוש התמונות,
  // גם בזמן שהיא נשמעת, ולא רק על האחרונה, שאולי היא התשובה.
  const sweep = await page.evaluate(async () => {
    uTest.lane("off");
    uTest.speech = "hang";
    try{
      uTest.show("dog");
      await uTest.wait(WORD_END_MS + 200);
      const spots = new Set(), hand = $("hand");
      const obs = new MutationObserver(() => { if(hand.classList.contains("tap")) spots.add(hand.style.left + "," + hand.style.top); });
      obs.observe(hand, { attributes: true, attributeFilter: ["class"] });
      speakStep(false);
      demoOver([...$("choices").children].filter(b => !b.disabled), "pick");
      await uTest.wait(3 * 700 + 200);
      obs.disconnect();
      return { spots: spots.size };
    } finally { uTest.speech = "start"; }
  });
  check("תזכורת בשומעים ובוחרים עוברת על כל התמונות", sweep.spots === 3, sweep);

  // מילים חדשות שכבר הוצעו ולא נאמרו — רק בחרו תמונה, דילגו או שתקו — מפנות מקום
  // לאחרות. בלי זה, כשהמנוע עוד יורד, כל סבב היה אותן שתי מילים לנצח.
  const rotation = await page.evaluate(() => {
    const day = dayNumber(), first = sayRound({}, day, 2).fresh;
    const second = sayRound({}, day, 2, new Map(first.map((w, k) => [w, k]))).fresh;
    // דרך startRound, מהיומן של הילד.
    const saved = { log: localStorage.getItem(childKey(LOG_KEY)), round, mode };
    try{
      mode = "say";
      startRound();
      const opened = round.fresh.slice();
      localStorage.setItem(childKey(LOG_KEY), JSON.stringify({ v: 1, a: opened.map(w => [day, 0, w, "say", "pick", 1, "hu", null, w, "normal", words.length]) }));
      startRound();
      return { first, second, opened, after: round.fresh.slice() };
    } finally {
      if(saved.log === null) localStorage.removeItem(childKey(LOG_KEY)); else localStorage.setItem(childKey(LOG_KEY), saved.log);
      round = saved.round;
      mode = saved.mode;
    }
  });
  check("מילים חדשות שהוצעו ולא נאמרו מפנות מקום למילים חדשות אחרות",
    rotation.first.length === 2 && rotation.second.length === 2 && !rotation.second.some(w => rotation.first.includes(w))
      && rotation.opened.length === 2 && !rotation.after.some(w => rotation.opened.includes(w)), rotation);

  await page.evaluate(([P, L]) => {
    speak = uTest.realSpeak;
    chime = uTest.realChime;
    refreshVoices = uTest.realRefresh;
    voices = [];
    laneFast = () => false;
    canSpeak = () => false;
    listenOnly = () => false;
    LOANWORD_SET.clear();
    setSound(uTest.realSound);
    if(screen !== "game") enterGame();
    localStorage.removeItem(P); localStorage.removeItem(L);
    turn.word = null;
    applyWords(uTest.before, 0, false);
  }, [P, L]);

  // באזור המבוגר שנפתח בסוף סבב, החלפת סוג התרגול נשמרת ולא בונה סבב מאחוריו:
  // שום מילה לא נאמרת שם, ו"הסבב האחרון" שהמבוגר מסתכל עליו נשאר.
  const behindPanel = await page.evaluate(async () => {
    const real = { speak, canSpeak, sound: soundEnabled, words, i }, said = [], chosen = chosenMode;
    speak = text => { said.push(text); return null; };
    canSpeak = () => true;
    soundEnabled = true;
    showRoundEnd = realShowRoundEnd;
    try{
      round.tried = [word()];
      round.at = round.queue.length;
      next();
      openPanel();
      setMode("spell");
      // וגם רשימה חדשה ("▶ תרגלו רק את האלה"), שמתחילה סבב במילה הראשונה בו.
      applyWords(PAIRS.slice(0, 6).map(([emoji, word]) => ({ emoji, word })), null, false);
      const out = { said: said.slice(), ended, chosen: chosenMode, tried: round.tried.length,
                    summary: getComputedStyle($("lastRoundSection")).display !== "none" };
      closePanel();
      setMode(chosen);
      applyWords(real.words, real.i, false);
      return out;
    } finally {
      speak = real.speak;
      canSpeak = real.canSpeak;
      soundEnabled = real.sound;
      showRoundEnd = () => newRound();
      if(screen !== "game") enterGame();
    }
  }).catch(e => ({ error: e.message }));
  check("סוג תרגול שנבחר באזור המבוגר בסוף סבב נשמר, בלי סבב ובלי מילה מאחוריו",
    behindPanel.said && behindPanel.said.length === 0 && behindPanel.ended && behindPanel.chosen === "spell" && behindPanel.tried === 1 && behindPanel.summary, behindPanel);

  // --------------------------------------------------------------
  group("מסך הפתיחה וכניסת מבוגר");
  // ▶ מבקש את המיקרופון, ורק אחריו מופיעה המילה הראשונה. בהקשר נפרד, בלי מה
  // שהבדיקות כאן מכבות. הכרומיום של הבדיקות מאשר מיקרופון מזויף.
  const doorCtx = await browser.newContext({ serviceWorkers: "block", permissions: ["microphone"] });
  const doorPage = await doorCtx.newPage();
  await doorPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  const atDoor = await doorPage.evaluate(async () => {
    const taps = [];
    new MutationObserver(() => { if($("hand").classList.contains("tap")) taps.push(Math.round(performance.now())); })
      .observe($("hand"), { attributes: true });
    await new Promise(r => setTimeout(r, DEMO_FIRST_MS + IDLE_MS.door + 400));
    const r = $("play").getBoundingClientRect(), h = $("hand");
    return { screen, mic: !!micStream, word: $("word").textContent, taps: taps.length, still: h.classList.contains("tap"),
      onPlay: Math.abs(parseFloat(h.style.left) + 14 - (r.left + r.width / 2)) < 2,
      buttons: [...document.querySelectorAll("button")].filter(b => b.checkVisibility()).map(b => b.id || b.dataset.mode) };
  });
  await doorPage.click("#play", { force: true });
  await doorPage.waitForFunction(() => screen === "game", null, { timeout: 5000 }).catch(() => {});
  const pressed = await doorPage.evaluate(() => ({ screen, mic: micLive(), word: word(), back: history.state }));
  // "חזור" של המערכת מחזיר למסך הפתיחה, והתור שלא נגמר לא נרשם.
  await doorPage.goBack();
  await doorPage.waitForTimeout(200);
  const backed = await doorPage.evaluate(() => ({ screen, log: localStorage.getItem("say-the-word-log") }));
  // מיקרופון שנחסם: "קראו למבוגר", ומשם ▶ ממשיך בלי לדבר.
  await doorPage.evaluate(() => {
    releaseMic();
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
  });
  await doorPage.evaluate(() => $("play").click());
  await doorPage.waitForFunction(() => screen !== "door", null, { timeout: 5000 }).catch(() => {});
  const blocked = await doorPage.evaluate(() => ({ screen, status: (openPanel(), $("micStatus").checkVisibility()) }));
  // ▶ ואז יציאה מהאפליקציה בזמן שהמיקרופון נפתח: הוא לא נשאר מקליט ברקע.
  const hiddenStart = await doorPage.evaluate(async () => {
    closePanel();
    micBlocked = false;
    const opened = [];
    navigator.mediaDevices.getUserMedia = c => new Promise(r => setTimeout(r, 600)).then(() => {
      const st = new MediaStream([ctx.createMediaStreamDestination().stream.getAudioTracks()[0]]);
      opened.push(st);
      return st;
    });
    $("play").click();
    await new Promise(r => setTimeout(r, 150));
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise(r => setTimeout(r, 1000));
    const out = { opened: opened.length, live: opened.flatMap(st => st.getTracks()).filter(t => t.readyState === "live").length };
    delete document.hidden;
    return out;
  });
  // בקשת מיקרופון שלא נענית לעולם: ▶ לא נעלם לתמיד, והמשחק מתחיל בלעדיו.
  const neverAnswers = await doorPage.evaluate(async () => {
    if(screen !== "door") goDoor();
    releaseMic();
    micBlocked = false;
    navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
    $("play").click();
    await new Promise(r => setTimeout(r, MIC_GIVE_UP_MS + VOICES_GRACE_MS + 600));
    return { screen, starting, playHidden: document.body.classList.contains("starting") };
  }).catch(e => ({ error: e.message }));
  await doorCtx.close();
  check("בקשת מיקרופון שלא נענית — אחרי המתנה המשחק מתחיל, ו-▶ לא נעלם לתמיד",
    neverAnswers.screen === "game" && !neverAnswers.starting && !neverAnswers.playHidden, neverAnswers);
  check("מסך הפתיחה: רק ▶, 🔒, 🔄 וסוג התרגול, בלי מילה ובלי מיקרופון",
    atDoor.screen === "door" && !atDoor.mic && atDoor.word === ""
    && atDoor.buttons.join() === "lock,refresh,play,mixed,say,spell", atDoor);
  check("במסך הפתיחה היד מדגימה לחיצה על ▶, בפעם הראשונה ואחרי המתנה",
    atDoor.taps >= 2 && atDoor.still && atDoor.onPlay, atDoor);
  check("▶ פותח את המיקרופון ואז את המילה הראשונה", pressed.screen === "game" && pressed.mic && !!pressed.word
    && !!pressed.back && pressed.back.game, pressed);
  check("\"חזור\" מחזיר למסך הפתיחה, בלי לרשום את התור שלא נגמר", backed.screen === "door" && backed.log === null, backed);
  check("מיקרופון חסום — \"קראו למבוגר\", והסיבה באזור המבוגר", blocked.screen === "grownup" && blocked.status, blocked);
  check("יציאה מהאפליקציה בזמן ש-▶ פותח את המיקרופון — הוא לא נשאר מקליט",
    hiddenStart.opened === 1 && hiddenStart.live === 0, hiddenStart);

  // 🔒: נגיעה רגילה לא עושה כלום, החזקה פותחת את שאלת המספר, תשובה שגויה
  // סוגרת בשקט ונכונה פותחת את ההגדרות.
  await page.evaluate(() => goDoor());
  await page.waitForTimeout(200);
  const lockBox = await page.locator("#lock").boundingBox();
  const lx = lockBox.x + lockBox.width / 2, ly = lockBox.y + lockBox.height / 2;
  await page.mouse.click(lx, ly);
  const tapped = await page.evaluate(() => ({ gate: !$("gate").hidden, panel: !$("overlay").hidden }));
  await page.mouse.move(lx, ly);
  await page.mouse.down();
  await page.waitForTimeout(800);
  const early = await page.evaluate(() => !$("gate").hidden);
  await page.waitForTimeout(1400);
  await page.mouse.up();
  const gate = await page.evaluate(() => ({ open: !$("gate").hidden, word: $("gateWord").textContent, n: gateNumber,
    digits: /[0-9]/.test($("gateWord").textContent), matches: $("gateWord").textContent === numberWord(gateNumber) }));
  const wrongN = String(gate.n === 99 ? 98 : gate.n + 1);
  for(const d of wrongN) await page.click(`#gateKeys [data-digit="${d}"]`);
  const wrongAnswer = await page.evaluate(() => {
    const out = { gate: !$("gate").hidden, panel: !$("overlay").hidden, screen };
    if(out.panel) closePanel();
    return out;
  });
  await page.evaluate(() => openGate());
  const n2 = await page.evaluate(() => gateNumber);
  for(const d of String(n2)) await page.click(`#gateKeys [data-digit="${d}"]`);
  const rightAnswer = await page.evaluate(() => ({ gate: !$("gate").hidden, panel: !$("overlay").hidden }));
  const numbers = await page.evaluate(() => [21, 30, 53, 99].map(numberWord));
  await backToGame();
  check("נגיעה רגילה ב-🔒 לא פותחת כלום, ורק החזקה של שתי שניות פותחת את שאלת המספר",
    !tapped.gate && !tapped.panel && !early && gate.open, { tapped, early, gate });
  check("שאלת המספר כתובה באנגלית, בלי ספרות", !gate.digits && gate.matches, gate);
  check("תשובה שגויה סוגרת בשקט, בלי הגדרות", !wrongAnswer.gate && !wrongAnswer.panel && wrongAnswer.screen === "door", wrongAnswer);
  check("תשובה נכונה פותחת את ההגדרות", !rightAnswer.gate && rightAnswer.panel, rightAnswer);
  check("המספרים באנגלית", numbers.join() === "twenty-one,thirty,fifty-three,ninety-nine", numbers);

  // היד שמדגימה לא עוברת מעל השאלה של המבוגר, ולא מדגימה ▶ שמוסתר בזמן
  // שהמיקרופון נפתח.
  const handQuiet = await page.evaluate(async () => {
    const tapped = () => $("hand").classList.contains("tap");
    const fresh = () => { $("hand").classList.remove("tap"); demoSeen.clear(); idleState = ""; armIdle(); };
    goDoor();
    fresh();
    openGate();
    await new Promise(r => setTimeout(r, DEMO_FIRST_MS + 400));
    const out = { gate: tapped() };
    closeGate();
    starting = true;
    document.body.classList.add("starting");
    try{
      fresh();
      await new Promise(r => setTimeout(r, DEMO_FIRST_MS + 400));
      out.starting = tapped();
    } finally {
      starting = false;
      document.body.classList.remove("starting");
    }
    fresh();
    await new Promise(r => setTimeout(r, DEMO_FIRST_MS + 400));
    out.door = tapped();
    // וגם לא מעל ההגדרות שנפתחו אחרי שהטיימר שלה כבר רץ.
    fresh();
    openPanel();
    await new Promise(r => setTimeout(r, DEMO_FIRST_MS + 400));
    out.panel = tapped();
    closePanel();
    enterGame();
    return out;
  });
  check("היד לא מדגימה מעל שאלת המבוגר, ולא על ▶ מוסתר; במסך הפתיחה עצמו היא מדגימה",
    !handQuiet.gate && !handQuiet.starting && !handQuiet.panel && handQuiet.door, handQuiet);
  // בכתיבה, אחרי מילה שגויה, היד מדגימה את המשבצת והאותיות, ולא את ⏭️.
  const spellDemo = await page.evaluate(async () => {
    const chosen = chosenMode;
    setMode("spell");
    turn.word = null;
    show();
    const target = word(), tiles = [...$("bank").children];
    const first = tiles.find(t => t.dataset.letter !== target[0]);
    for(const t of [first, ...tiles.filter(t => t !== first)]) tapTile(t);
    await new Promise(r => setTimeout(r, WRONG_MS + 200));
    demoSeen.delete("again");
    idleState = "";
    $("hand").classList.remove("tap");
    armIdle();
    await new Promise(r => setTimeout(r, DEMO_FIRST_MS + 200));
    const r = $("next").getBoundingClientRect(), h = $("hand");
    const out = { cue: cueNow(), tapped: h.classList.contains("tap"),
                  onNext: Math.abs(parseFloat(h.style.left) + 14 - (r.left + r.width / 2)) < 2 && Math.abs(parseFloat(h.style.top) + 8 - (r.top + r.height / 2)) < 2 };
    setMode(chosen);
    return out;
  });
  check("בכתיבה, אחרי מילה שגויה, היד לא מדגימה ⏭️", spellDemo.cue === "again" && spellDemo.tapped && !spellDemo.onNext, spellDemo);
  // הדלקת השמע באזור המבוגר שנפתח ממסך הפתיחה לא אומרת מילה שאינה על המסך.
  const doorSound = await page.evaluate(() => {
    const real = speak;
    let spoken = 0;
    speak = () => { spoken++; return null; };
    try{
      goDoor();
      openPanel();
      toggleSound();
      toggleSound();
      closePanel();
      return { spoken, screen };
    } finally { speak = real; enterGame(); }
  });
  check("הדלקת השמע מחוץ למשחק לא אומרת מילה", doorSound.spoken === 0, doorSound);
  // קולות שמגיעים אחרי "אין קול" מורידים אותו מיד.
  const voicesArrive = await page.evaluate(() => {
    const real = { canSpeak, voices, refreshVoices, speak, sound: soundEnabled };
    canSpeak = realStep.canSpeak;
    speak = () => null;
    soundEnabled = true;
    voices = [];
    refreshVoices = () => { voices = [{ name: "Test", lang: "en-US", localService: true, default: true, voiceURI: "test" }]; };
    try{
      turn.cue = "novoice";
      turn.first = false;
      speechSynthesis.dispatchEvent(new Event("voiceschanged"));
      return { cue: turn.cue, again: noVoiceShown };
    } finally { canSpeak = real.canSpeak; voices = real.voices; refreshVoices = real.refreshVoices; speak = real.speak; soundEnabled = real.sound; }
  });
  check("\"אין קול\" יורד כשהקולות מגיעים", voicesArrive.cue === null && voicesArrive.again === false, voicesArrive);
  // מסד שלא עונה לא תוקע את הטעינה.
  const idbHang = await page.evaluate(async () => {
    const real = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function(){ return {}; };
    const t0 = performance.now();
    try{ return { extracted: await modelExtracted(), ms: Math.round(performance.now() - t0) }; }
    finally { IDBFactory.prototype.open = real; }
  });
  check("IndexedDB שלא עונה — modelExtracted עונה \"לא\" אחרי IDB_WAIT_MS", idbHang.extracted === false && idbHang.ms < 6000, idbHang);

  // אייפד עם ספארי שלפני 17.4, בלי checkVisibility: היד שמדגימה עדיין מופיעה,
  // והדף לא זורק שגיאה בכל הדגמה.
  const oldSafari = await browser.newContext({ serviceWorkers: "block" });
  await oldSafari.addInitScript(() => { delete Element.prototype.checkVisibility; });
  const oldSafariPage = await oldSafari.newPage();
  const oldSafariErrors = [];
  oldSafariPage.on("pageerror", e => oldSafariErrors.push(e.message));
  await oldSafariPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  const oldDemo = await oldSafariPage.evaluate(async () => {
    let taps = 0;
    new MutationObserver(() => { if($("hand").classList.contains("tap")) taps++; }).observe($("hand"), { attributes: true });
    await new Promise(r => setTimeout(r, DEMO_FIRST_MS + 400));
    return { taps, api: "checkVisibility" in Element.prototype };
  });
  await oldSafari.close();
  check("בלי checkVisibility היד מדגימה, בלי שגיאות",
    !oldDemo.api && oldDemo.taps > 0 && oldSafariErrors.length === 0, { oldDemo, oldSafariErrors });

  // --------------------------------------------------------------
  group("עדכון");
  // GitHub Pages מרשה לדפדפן לשמור את הדף כמה דקות, ופתיחה רגילה מקבלת את
  // העותק הזה. כאן שרת עם אותה כותרת, ודף שמשתנה אחרי שה-service worker כבר
  // שולט: 🔄 צריך להביא את החדש, וגם בלי רשת לעלות מהמטמון ולא לדף שגיאה.
  let build = 1;
  const pages = staticServer();
  const serveFile = pages.listeners("request")[0];
  pages.removeAllListeners("request");
  pages.on("request", (req, res) => {
    const head = res.writeHead;
    res.writeHead = (status, headers) => head.call(res, status, { ...headers, "Cache-Control": "max-age=600" });
    if(decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") !== "") return serveFile(req, res);
    const html = fs.readFileSync(path.join(DIR, "index.html"), "utf8")
      .replace("<head>", `<head><meta name="build" content="${build}">`);
    res.writeHead(200, { "Content-Type": TYPES[".html"] });
    res.end(html);
  });
  await new Promise(r => pages.listen(0, "127.0.0.1", r));
  const pagesBase = `http://127.0.0.1:${pages.address().port}/`;
  const updCtx = await browser.newContext({ permissions: ["microphone"] });
  const upd = await updCtx.newPage();
  const builtAs = () => upd.evaluate(() => document.querySelector('meta[name="build"]').content);
  const holdRefresh = async ms => {
    const box = await upd.locator("#refresh").boundingBox();
    await upd.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await upd.mouse.down();
    await upd.waitForTimeout(ms);
    await upd.mouse.up();
  };
  await upd.goto(pagesBase, { waitUntil: "domcontentloaded" });
  await upd.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  build = 2;
  await upd.goto(pagesBase, { waitUntil: "domcontentloaded" });
  const reopenedBuild = await builtAs();
  await holdRefresh(800);
  await upd.waitForTimeout(500);
  const tappedBuild = await builtAs();
  const reloaded = upd.waitForEvent("load", { timeout: 10000 }).catch(() => null);
  await holdRefresh(2200);
  await reloaded;
  const refreshed = { build: await builtAs(), screen: await upd.evaluate(() => screen) };
  await updCtx.setOffline(true);
  const offlineLoad = upd.waitForEvent("load", { timeout: 10000 }).catch(() => null);
  await holdRefresh(2200);
  await offlineLoad;
  const offline = await upd.evaluate(() => ({ pairs: typeof PAIRS === "undefined" ? 0 : PAIRS.length,
    build: (document.querySelector('meta[name="build"]') || {}).content }));
  await updCtx.close();
  pages.closeAllConnections();
  await new Promise(r => pages.close(r));
  check("נגיעה קצרה ב-🔄 לא טוענת מחדש", tappedBuild === "1", tappedBuild);
  check("החזקה על 🔄 מביאה את הגרסה החדשה, כשפתיחה רגילה עוד מקבלת את הישנה",
    reopenedBuild === "1" && refreshed.build === "2" && refreshed.screen === "door", { reopenedBuild, ...refreshed });
  check("🔄 בלי רשת עולה מהמטמון", offline.pairs > 0 && offline.build === "2", offline);

  // --------------------------------------------------------------
  group("🏠 וסוג התרגול במסך הפתיחה");
  // שניהם בלחיצה ארוכה, כמו 🔒, כדי שנגיעה מקרית של ילד לא תוציא מהמשחק ולא
  // תחליף את התרגול.
  const holdOn = async (selector, ms) => {
    const box = await page.locator(selector).boundingBox();
    if(!box) return;   // כבר לא על המסך: הבדיקה שאחריה תיכשל ותראה למה
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
  };
  // בסוף סבב 🔒 מופיע מתחת ל-🏠, ושניהם לא מכסים את הבועה.
  const corners = await page.evaluate(() => {
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    document.body.classList.add("ended");
    const home = $("home").getBoundingClientRect(), lock = $("lock").getBoundingClientRect(),
          cue = $("cue").getBoundingClientRect();
    document.body.classList.remove("ended");
    return { both: home.width > 0 && lock.width > 0, overlap: hit(home, lock), lockBelow: lock.top >= home.bottom,
             onCue: hit(home, cue) || hit(lock, cue) };
  });
  const homeBox = await page.locator("#home").boundingBox();
  await page.mouse.click(homeBox.x + homeBox.width / 2, homeBox.y + homeBox.height / 2);
  const homeTapped = await page.evaluate(() => screen);
  await holdOn("#home", 800);
  const homeEarly = await page.evaluate(() => screen);
  await holdOn("#home", 2200);
  const homeHeld = await page.evaluate(() => ({ screen, home: $("home").checkVisibility() }));
  const startMode = await page.evaluate(() => chosenMode);
  const target = startMode === "say" ? "spell" : "say";
  const segment = `#doorMode [data-mode="${target}"]`;
  await page.click(segment);
  const segmentTapped = await page.evaluate(() => chosenMode);
  await holdOn(segment, 2200);
  const segmentHeld = await page.evaluate(() => ({ chosen: chosenMode, screen, word: turn.word,
    door: document.querySelector('#doorMode [aria-checked="true"]').dataset.mode,
    adult: document.querySelector('#modeSwitch [aria-checked="true"]').dataset.mode }));
  await page.evaluate(() => enterGame());
  const playedMode = await page.evaluate(() => mode);
  await page.evaluate(m => setMode(m), startMode);
  check("נגיעה קצרה ב-🏠 לא יוצאת מהמשחק, ורק החזקה של שתי שניות חוזרת למסך הפתיחה",
    homeTapped === "game" && homeEarly === "game" && homeHeld.screen === "door" && !homeHeld.home,
    { homeTapped, homeEarly, homeHeld });
  check("בסוף סבב 🔒 מתחת ל-🏠, ושניהם לא על הבועה",
    corners.both && !corners.overlap && corners.lockBelow && !corners.onCue, corners);
  check("נגיעה קצרה בסוג התרגול לא מחליפה אותו", segmentTapped === startMode, { startMode, segmentTapped });
  check("החזקה על סוג התרגול בוחרת אותו גם באזור המבוגר, בלי להציג מילה מאחורי מסך הפתיחה",
    segmentHeld.chosen === target && segmentHeld.door === target && segmentHeld.adult === target
    && segmentHeld.screen === "door" && segmentHeld.word === null, { target, ...segmentHeld });
  check("▶ אחרי הבחירה משחק בתרגול שנבחר", playedMode === target, { target, playedMode });

  // --------------------------------------------------------------
  group("כפתור ההקשבה");
  // ילדים מחזיקים את הכפתור בזמן שהם מדברים, ונוגעים בו שוב כדי "לסיים". לכן
  // לחוץ ומקשיב הם אותו מצב, וטורקיז נשאר טורקיז תחת האצבע. הצבע נקרא אחרי
  // שהמעבר של ה-CSS נגמר, אחרת יוצא גוון באמצע הדרך.
  const sayState = () => page.evaluate(() => ({ active, bg: getComputedStyle($("say")).backgroundColor,
    cue: $("cue").dataset.cue, help: isShown($("playWord")), next: isShown($("next")) }));
  const press = async () => { await page.mouse.down(); await page.waitForTimeout(300); return sayState(); };
  const lift = async () => { await page.mouse.up(); await page.waitForTimeout(300); return sayState(); };
  // מה שהמיקרופון המזויף משמיע לא יסיים את ההקשבה באמצע הבדיקה.
  await page.evaluate(() => { window.realProcess = processRecognition; processRecognition = () => {}; });
  // ▶ של הקבוצה הקודמת עוד מגן על הכפתורים מנגיעה כפולה.
  await page.waitForTimeout(700);
  try{
    await page.evaluate(() => ensureAudio());
    const idle = await sayState();
    await page.locator("#say").hover();
    const held = await press();
    check("נגיעה בכפתור כבר מקשיבה", held.active, held);
    const listening = await lift();
    const pressedRed = await press();
    check("כפתור מקשיב נשאר טורקיז תחת האצבע, ושורת ההנחיה אומרת לדבר",
      pressedRed.active && pressedRed.bg === listening.bg && listening.bg !== idle.bg && listening.cue === "listening"
        && !listening.help && !listening.next, { idle, listening, pressedRed });
    await lift();
    await page.evaluate(() => stopListening());

    // ניסיון שנגמר בזמן שהאצבע עוד על הכפתור, כאן בהצלחה, לא מתחיל אחר
    // כשהיא מורמת. אחרת הניסיון שאף אחד לא ביקש רץ על המילה הבאה ונגמר
    // ב"נסו שוב". האצבע מורמת אחרי שהמילה הבאה כבר על המסך, כמו אצל ילד
    // שמחזיק עד שה-🎉 מתחלף.
    const shownBefore = await page.evaluate(() => shownCount);
    const heldWin = await press();
    await page.evaluate(() => {
      const w = word();
      processRecognition = window.realProcess;
      try{ rec.dispatchEvent(new CustomEvent("result", { detail: { result: { result: [{ word: w, conf: 1 }], text: w } } })); }
      finally{ processRecognition = () => {}; }
    });
    const wonHeld = await page.evaluate(() => ({ active, card: $("card").className }));
    await page.waitForFunction(n => shownCount > n, shownBefore, { timeout: 5000 }).catch(() => {});
    await lift();
    const afterLift = await page.evaluate(() => ({ active, listening: $("say").classList.contains("listening"), moved: shownCount }));
    check("ניסיון שנגמר כשהאצבע על הכפתור לא מתחיל אחר בהרמתה",
      heldWin.active && !wonHeld.active && wonHeld.card === "good" && afterLift.moved > shownBefore
        && !afterLift.active && !afterLift.listening, { heldWin, wonHeld, afterLift });
    await page.evaluate(() => stopListening());

    // במקלדת אין נגיעה לפני ה-click, ולכן Enter ו-Space תמיד מתחילים להקשיב.
    // גם אחרי לחיצה שהתחילה להקשיב והאצבע הורמה מחוץ לכפתור, כך שלא הגיע
    // click שסוגר אותה.
    await press();
    const off = await page.locator("#picture").boundingBox();
    await page.mouse.move(off.x + off.width / 2, off.y + off.height / 2);
    await page.mouse.up();
    await page.evaluate(() => stopListening());
    const keys = {};
    for(const key of ["Enter", "Space"]){
      await page.focus("#say");
      await page.keyboard.press(key);
      keys[key] = await page.evaluate(() => active);
      await page.evaluate(() => stopListening());
    }
    check("Enter ו-Space על 🎤 מתחילים להקשיב", keys.Enter && keys.Space, keys);
    await page.locator("#say").hover();

    // כשהמיקרופון סגור, נגיעה לא מותרת לפתוח אותו במסך מגע, וההקשבה מחכה להרמה.
    await page.evaluate(() => releaseMic());
    const closedHeld = await press();
    await page.mouse.up();
    await page.waitForFunction(() => active, null, { timeout: 5000 }).catch(() => {});
    const closedLifted = await sayState();
    check("כשהמיקרופון סגור, ההקשבה מתחילה בהרמת האצבע",
      !closedHeld.active && closedLifted.active, { closedHeld, closedLifted });
  } finally {
    await page.evaluate(() => { stopListening(); processRecognition = window.realProcess; });
  }

  // --------------------------------------------------------------
  group("פריסה במסכים קטנים");
  // טלפון שוכב, טלפון קטן לאורך, ודפדפן ישן. בכל אחד מהם משהו כבר ירד מתחת
  // לקצה המסך או כוסה. נמדד מה שנראה: המלבן מול גודל המסך, ומה יושב בנקודת
  // האמצע של כפתור (elementFromPoint) — זה מה שמקבל את הנגיעה. בהקשר נפרד,
  // כדי שהגדלים לא ייגעו בקבוצות האחרות.
  const LANDSCAPE = [[568, 320], [640, 360], [667, 375], [740, 360], [812, 375], [844, 390]];
  const layCtx = await browser.newContext({ serviceWorkers: "block", permissions: ["microphone"] });
  const lay = await layCtx.newPage();
  await lay.addInitScript(() => {
    localStorage.setItem("sound_enabled", "0");
    window.addEventListener("DOMContentLoaded", () => {
      window.inView = el => { const r = el.getBoundingClientRect();
        return r.width > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5; };
      window.onTop = el => { const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        const h = document.elementFromPoint(x, y);
        return h && (h === el || el.contains(h)) ? true : (h ? h.id || String(h.className.baseVal ?? h.className) : "null"); };
      window.basketOf = n => {
        const ok2 = { met: 1, seen: 9, box: 3, due: 20, ok: [5, 9], n: 4, k: 3, got: 1 };
        const names = ["dog", "cat", "sun", "moon", "fish", "apple", "car", "book", "lion", "tree", "bird", "house"].slice(0, n);
        localStorage.setItem("say-the-word-progress", JSON.stringify({ v: 1, w: Object.fromEntries(names.map(w => [w, ok2])) }));
      };
    });
  });
  await lay.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await lay.waitForTimeout(800);
  const at = async ([width, height], fn, arg) => {
    await lay.setViewportSize({ width, height });
    await lay.waitForTimeout(60);
    return { at: `${width}x${height}`, ...await lay.evaluate(fn, arg) };
  };

  // מסך הפתיחה בטלפון שוכב: ▶ היה מתחת לקצה המסך, ולילד לא היה על מה ללחוץ.
  const doorLand = [];
  for(const vp of LANDSCAPE) for(const n of [0, 12]) doorLand.push(await at(vp, n => {
    basketOf(n);
    goDoor();
    return { n, play: onTop($("play")), playIn: inView($("play")), mode: [...$("doorMode").children].every(inView),
      scroll: document.documentElement.scrollHeight - innerHeight };
  }, n));
  check("בטלפון שוכב ▶ במסך הפתיחה על המסך ומקבל את הנגיעה, וגם סוג התרגול, בלי גלילה",
    doorLand.every(d => d.play === true && d.playIn && d.mode && d.scroll <= 0), doorLand.filter(d => !(d.play === true && d.playIn && d.mode && d.scroll <= 0)));

  // ובטלפון נמוך לאורך הסל נמחץ לאפס, ובגובה 568 ▶ וסוג התרגול ירדו מהמסך.
  const doorLow = [];
  for(const vp of [[320, 568], [360, 640], [375, 667]]) doorLow.push(await at(vp, () => {
    basketOf(12);
    goDoor();
    const basket = $("doorBasket").getBoundingClientRect(), pic = $("doorBasketPics").children[0].getBoundingClientRect();
    return { play: onTop($("play")), mode: [...$("doorMode").children].every(inView), basket: Math.round(basket.height),
      firstRow: pic.top >= basket.top && pic.bottom <= basket.bottom + 0.5 && inView($("doorBasket")),
      scroll: document.documentElement.scrollHeight - innerHeight };
  }));
  check("בטלפון נמוך לאורך הסל במסך הפתיחה בגובה שורה של תמונות לפחות, ו-▶ וסוג התרגול על המסך",
    doorLow.every(d => d.play === true && d.mode && d.firstRow && d.scroll <= 0), doorLow);

  // קראו למבוגר: גם שם ▶ הוא הדבר היחיד ללחוץ עליו.
  const grownLand = [];
  for(const vp of LANDSCAPE) grownLand.push(await at(vp, () => {
    goGrownup();
    const out = { resume: onTop($("resume")), inView: inView($("resume")) };
    goDoor();
    return out;
  }));
  check("בטלפון שוכב ▶ ב\"קראו למבוגר\" על המסך", grownLand.every(g => g.resume === true && g.inView), grownLand);

  // שאלת המספר בטלפון שוכב: הקופסה הייתה גבוהה מהמסך, ממורכזת, וה-× יצא
  // מעל הקצה העליון. עכשיו היא בתוך המסך ונגללת בתוכה עד המקש האחרון, וכל
  // פתיחה מתחילה למעלה, גם אחרי שגללו בפעם הקודמת.
  const gateLand = [];
  for(const vp of LANDSCAPE) gateLand.push(await at(vp, () => {
    openGate();
    const box = document.querySelector("#gate .gate-box");
    const out = { close: onTop($("gateClose")), box: inView(box) };
    box.scrollTop = box.scrollHeight;
    out.zero = onTop(document.querySelector('#gateKeys [data-digit="0"]'));
    closeGate();
    return out;
  }));
  check("בטלפון שוכב שאלת המספר על המסך: ה-× מקבל נגיעה, וה-0 נגיש בגלילה",
    gateLand.every(g => g.close === true && g.box && g.zero === true), gateLand);

  // המשחק עצמו, כמו בשאר הקבוצות: בלי שלב "להבין" מעצמו, בלי קול, ורשימה
  // עם מילים ארוכות.
  await lay.evaluate(() => {
    localStorage.removeItem("say-the-word-progress");
    mixedSpellDue = () => false; laneFast = () => false; canSpeak = () => false; listenOnly = () => false;
    LOANWORD_SET.clear();
    const names = ["dog", "cat", "sun", "moon", "fish", "banana", "crocodile", "watermelon", "strawberry", "butterfly"];
    applyWords(PAIRS.filter(p => names.includes(p[1])).map(([emoji, word]) => ({ emoji, word })), 0, false);
    enterGame();
  });
  const spellAt = (vp, w) => at(vp, w => {
    setMode("spell");
    i = words.findIndex(x => x.word === w);
    turn.word = null;
    show();
    const dock = $("buttons").getBoundingClientRect().top;
    const parts = [...$("slots").children, ...$("bank").children];
    return { w, hint: onTop($("hint")), next: onTop($("next")),
      lettersOn: parts.every(inView), aboveDock: parts.every(t => t.getBoundingClientRect().bottom <= dock + 0.5),
      rows: new Set([...$("bank").children].map(t => Math.round(t.getBoundingClientRect().top))).size,
      tile: Math.round($("bank").children[0].getBoundingClientRect().width), tilesFree: [...$("bank").children].every(t => onTop(t) === true) };
  }, w);

  // כתיבה בטלפון שוכב: הכרטיס, המשבצות והאותיות גלשו מהבמה, ומפני שהבמה
  // ממוקמת הם נצבעו מעל 💡 ו-⏭️ ובלעו את הנגיעות שלהם. ובמילה ארוכה השורה
  // השנייה של האותיות ירדה מתחת לקצה המסך.
  const spellLand = [];
  for(const vp of LANDSCAPE) for(const w of ["cat", "crocodile", "watermelon"]) spellLand.push(await spellAt(vp, w));
  check("בכתיבה בטלפון שוכב כל המשבצות והאותיות על המסך, מעל שורת הכפתורים, ו-💡 ו-⏭️ מקבלים את הנגיעה",
    spellLand.every(s => s.hint === true && s.next === true && s.lettersOn && s.aboveDock && s.tilesFree),
    spellLand.filter(s => !(s.hint === true && s.next === true && s.lettersOn && s.aboveDock && s.tilesFree)));
  // ונגיעה אמיתית: 💡 נותן רמז, ו-⏭️ מחליף את המילה.
  await at([568, 320], () => { i = words.findIndex(x => x.word === "watermelon"); turn.word = null; show(); buttonsGuardAt = -Infinity; });
  const tapAt = async sel => { const b = await lay.locator(sel).boundingBox(); await lay.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
  await tapAt("#hint");
  const hinted = await lay.evaluate(() => ({ hinted: turn.hinted, filled: $("slots").querySelectorAll(".hinted").length, shown: shownCount }));
  await lay.evaluate(() => { buttonsGuardAt = -Infinity; });
  await tapAt("#next");
  const skipped = await lay.evaluate(() => shownCount);
  check("בכתיבה בטלפון שוכב נגיעה ב-💡 נותנת רמז, ונגיעה ב-⏭️ מדלגת",
    hinted.hinted && hinted.filled === 1 && skipped !== hinted.shown, { hinted, skipped });
  // ושורת הכפתורים מעל הבמה גם כשמשהו בה גולש, בכל גודל.
  const overflowing = await at([360, 640], () => {
    i = words.findIndex(x => x.word === "cat"); turn.word = null; show();
    $("bank").style.paddingBottom = "600px";
    const out = { hint: onTop($("hint")), next: onTop($("next")) };
    $("bank").style.paddingBottom = "";
    return out;
  });
  check("גם כשהבמה גולשת, 💡 ו-⏭️ מעליה ומקבלים את הנגיעה", overflowing.hint === true && overflowing.next === true, overflowing);

  // ובמסך של 320 ארבע אותיות נכנסו בשורה: מילה של עשר אותיות הייתה שלוש
  // שורות, והשלישית כיסתה את 💡 ואת ⏭️.
  const spellNarrow = [];
  for(const w of ["crocodile", "watermelon", "strawberry"]) spellNarrow.push(await spellAt([320, 568], w));
  check("בטלפון של 320 מילה של עשר אותיות בשתי שורות, מעל שורת הכפתורים, ו-💡 ו-⏭️ מקבלים את הנגיעה",
    spellNarrow.every(s => s.rows <= 2 && s.lettersOn && s.aboveDock && s.hint === true && s.next === true && s.tilesFree), spellNarrow);
  await lay.evaluate(() => setMode("say"));

  // ברוחב 320 שורת הכפתורים הייתה רחבה מהמסך: ⏭️ נחתך והדף זז לצדדים. גם
  // בבדיקה מהתמונה, כש-🔊 רחב יותר בגלל "לא יודעים?".
  const narrowDock = [];
  for(const step of ["say", "probe"]) narrowDock.push(await at([320, 568], step => {
    i = words.findIndex(x => x.word === "dog"); turn.word = null; show();
    turn.step = step; ui();
    const dock = ["playWord", "say", "next"].map($), rects = dock.map(b => b.getBoundingClientRect());
    const out = { step, width: document.documentElement.scrollWidth, max: innerWidth, inView: dock.every(inView),
      onTop: dock.filter(isShown).map(onTop), apart: rects.every((r, k) => rects.every((q, j) => j <= k || r.right <= q.left || q.right <= r.left)),
      label: !!$("playWord").querySelector(".lbl") };
    turn.step = "say"; ui();
    return out;
  }, step));
  check("ברוחב 320 שורת הכפתורים בתוך המסך, בלי גלילה לצדדים, והכפתורים לא עולים זה על זה",
    narrowDock.every(d => d.width <= d.max && d.inView && d.onTop.every(h => h === true) && d.apart) && narrowDock[1].label, narrowDock);

  // שומעים ובוחרים בטלפון שוכב: בשתי שורות העיגולים התכווצו ל-31px.
  const pickLand = [];
  for(const vp of LANDSCAPE) pickLand.push(await at(vp, () => {
    turn.step = "understand"; turn.choices = ["dog", "cat", "sun"]; turn.faded = []; turn.awake = true; turn.picked = false;
    const out = [];
    for(const layout of [0, 1, 2]){
      turn.layout = layout;
      ui();
      const rects = [...$("choices").children].map(b => b.getBoundingClientRect()), dock = $("buttons").getBoundingClientRect();
      const apart = !rects.some((r, k) => rects.some((q, j) => j > k && r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom));
      out.push({ d: Math.round(Math.min(...rects.map(r => r.width))), apart,
        on: [...$("choices").children].every(b => inView(b) && onTop(b) === true), clear: rects.every(r => r.bottom <= dock.top) });
    }
    turn.step = "say"; ui();
    return { layouts: out };
  }));
  check("שומעים ובוחרים בטלפון שוכב: שלושה עיגולים של 64px לפחות, על המסך, לא זה על זה ולא על שורת הכפתורים",
    pickLand.every(p => p.layouts.every(l => l.d >= 64 && l.apart && l.on && l.clear)), pickLand);

  // דפדפן בלי יחידות cq (ספארי לפני 16): --d היה מקבל את הערך עם cq, שנפסל רק
  // בחישוב הרוחב, והעיגולים התכווצו לגודל האימוג'י. כאן היחידות מוחלפות
  // ביחידה שאף דפדפן לא מכיר, וכך גם @supports עליהן.
  const noCq = [];
  const sheet = await lay.evaluate(() => {
    const css = document.querySelector("style");
    window.realCss = css.textContent;
    css.textContent = realCss.replace(/(\d)cq(w|h|i|b|min|max)\b/g, "$1zz$2");
    return realCss !== css.textContent;
  });
  for(const vp of [[360, 640], [640, 360]]) noCq.push(await at(vp, () => {
    turn.step = "understand"; turn.choices = ["dog", "cat", "sun"]; turn.faded = []; turn.awake = true; turn.picked = false;
    ui();
    const d = [...$("choices").children].map(b => Math.round(b.getBoundingClientRect().width));
    turn.step = "say"; ui();
    return { d };
  }));
  await lay.evaluate(() => { document.querySelector("style").textContent = realCss; });
  check("בדפדפן בלי יחידות cq העיגולים בגודל הקבוע, ולא מתכווצים", sheet && noCq.every(n => n.d.every(d => d >= 64)), noCq);

  // סוף סבב בטלפון שוכב ובטלפון קטן: ▶ היה בתחתית של קופסה שנגללת, וכמעט
  // כולו מחוץ לה.
  const endAt = [];
  for(const vp of [...LANDSCAPE, [320, 568]]) endAt.push(await at(vp, async () => {
    const ok2 = { met: 1, seen: 9, box: 3, due: 20, ok: [5, 9], n: 4, k: 3, got: 1 };
    localStorage.setItem("say-the-word-progress", JSON.stringify({ v: 1, w: { dog: ok2, cat: ok2 } }));
    round = { queue: ["fish"], at: 0, row: [], tried: ["dog", "cat", "sun", "moon", "fish", "banana", "butterfly", "crocodile"],
              fresh: [], requeued: [], seen: [], basket: [], pocketed: [] };
    showRoundEnd();
    await new Promise(r => setTimeout(r, END_GUARD_MS + 100));
    const end = $("roundEnd").getBoundingClientRect(), again = $("againBtn").getBoundingClientRect();
    const out = { again: onTop($("againBtn")), inView: inView($("againBtn")),
      inBox: again.top >= end.top && again.bottom <= end.bottom, basket: $("endBasket").checkVisibility() };
    hideRoundEnd();
    localStorage.removeItem("say-the-word-progress");
    return out;
  }));
  check("בסוף סבב ▶ כולו על המסך ומקבל את הנגיעה, גם בטלפון שוכב ובטלפון של 320",
    endAt.every(e => e.again === true && e.inView && e.inBox && e.basket), endAt);

  // הנקודות של הסבב: --line ו---act-soft על הרקע היו 1.5:1 ו-1.9:1, כמעט
  // בלתי נראות. הנוכחית שונה מאלה שכבר עברו.
  const dotColors = await lay.evaluate(() => {
    const rgb = c => c.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = c => { const [r, g, b] = rgb(c).map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    round.queue = ["dog", "cat", "sun", "moon"]; round.at = 1;
    renderDots();
    const bg = getComputedStyle(document.body).backgroundColor, style = cls => getComputedStyle($("dots").querySelector(cls));
    const [done, now, rest] = ["i.done", "i.now", "i:not(.done):not(.now)"].map(style);
    return { done: +ratio(done.backgroundColor, bg).toFixed(2), now: +ratio(now.backgroundColor, bg).toFixed(2), rest: +ratio(rest.backgroundColor, bg).toFixed(2),
      distinct: now.backgroundColor !== done.backgroundColor && (now.boxShadow !== done.boxShadow || now.width !== done.width) };
  });
  check("נקודות הסבב לפחות 3:1 מול הרקע, והנוכחית שונה מאלה שעברו",
    dotColors.done >= 3 && dotColors.now >= 3 && dotColors.rest >= 3 && dotColors.distinct, dotColors);

  // ובמכשיר שמבקש פחות תנועה, היד שמדגימה הופיעה לאורך כל הדרך שקופה: רק
  // האנימציה שלה, שכובתה, הראתה אותה.
  await lay.setViewportSize({ width: 360, height: 640 });
  await lay.emulateMedia({ reducedMotion: "reduce" });
  const stillHand = await lay.evaluate(async () => {
    goDoor();
    demo($("play"));
    await new Promise(r => setTimeout(r, 500));
    const s = getComputedStyle($("hand"));
    return { opacity: +s.opacity, transform: s.transform };
  });
  await lay.emulateMedia({ reducedMotion: null });
  check("במכשיר שמבקש פחות תנועה היד שמדגימה נראית, בלי לזוז",
    stillHand.opacity >= 0.5 && stillHand.transform === "none", stillHand);
  await layCtx.close();

  // --------------------------------------------------------------
  group("הכנת המכשיר");
  // מכשיר חדש נפתח במסך הכנה למבוגר: מנוע הדיבור יורד מולו, הוא מאשר את
  // המיקרופון ושומע את הקול, ולומד איפה ההגדרות. הילד לא פוגש אף אחד מאלה.
  const setupCtx = await browser.newContext({ setup: true, permissions: ["microphone"] });
  const setupPage = await setupCtx.newPage();
  await setupPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  const setupStart = await setupPage.evaluate(() => ({ screen, saved: localStorage.getItem("say-the-word-setup"),
    shown: $("setup").checkVisibility(), door: $("door").checkVisibility(), lock: $("lock").checkVisibility() }));
  check("מכשיר חדש נפתח בהכנת המכשיר, ונכתב רק שהיא התחילה",
    setupStart.screen === "setup" && setupStart.shown && !setupStart.door && !setupStart.lock && setupStart.saved === "0", setupStart);
  // אזור שמוסתר (hidden) באמת לא נראה, גם כשהוא כרטיס עם display משלו.
  const setupInstallShown = await setupPage.evaluate(() => ({ prompt: deferredPrompt !== null, ios: isIOS, shown: $("setupInstall").checkVisibility() }));
  check("התקנה בהכנה מופיעה רק כשהדפדפן מציע אותה",
    setupInstallShown.shown === (setupInstallShown.prompt || setupInstallShown.ios), setupInstallShown);
  await setupPage.waitForFunction(() => model !== null, null, { timeout: 60000 });
  // "בלי אינטרנט" רק כשהקבצים שבלעדיהם אין משחק באמת במטמון.
  const setupModel = await setupPage.evaluate(async () => {
    const all = async () => (await Promise.all(OFFLINE_FILES.map(u => caches.match(new URL(u, location.href).href, { ignoreSearch: true })))).every(Boolean);
    for(let k = 0; k < 50 && !$("setupModel").textContent.includes("בלי אינטרנט"); k++) await new Promise(r => setTimeout(r, 100));
    const out = { text: $("setupModel").textContent, bar: $("setupBar").checkVisibility(), cached: await all() };
    const c = await caches.open(CACHE_NAME), url = new URL("./words.js", location.href).href;
    const copy = await c.match(url, { ignoreSearch: true });
    await c.delete(url, { ignoreSearch: true });
    offlineReady = false;
    renderSetup();
    await new Promise(r => setTimeout(r, 300));
    out.missing = $("setupModel").textContent;
    if(copy) await c.put(url, copy);
    return out;
  }).catch(e => ({ error: e.message, text: "", missing: "" }));
  check("כשמנוע הדיבור במכשיר זה כתוב, בלי פס, ו\"בלי אינטרנט\" רק כשהקבצים במטמון",
    setupModel.text.startsWith("✓") && !setupModel.bar && setupModel.cached && setupModel.text.includes("בלי אינטרנט")
      && setupModel.missing.startsWith("✓") && !setupModel.missing.includes("בלי אינטרנט"), setupModel);
  // כל זרם שנפתח נספר, כי micStream === null לבדו לא אומר שהמיקרופון נסגר.
  await setupPage.evaluate(() => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.opened = [];
    navigator.mediaDevices.getUserMedia = async c => { const st = await real(c); opened.push(st); return st; };
  });
  await setupPage.click("#setupMicBtn");
  await setupPage.waitForFunction(() => $("setupMic").classList.contains("ok") || $("setupMic").classList.contains("bad"), null, { timeout: 5000 }).catch(() => {});
  const setupMicState = await setupPage.evaluate(() => ({ text: $("setupMic").textContent, ok: $("setupMic").classList.contains("ok"),
    streams: opened.length, live: opened.flatMap(st => st.getTracks()).filter(t => t.readyState === "live").length,
    button: $("setupMicBtn").checkVisibility() }));
  check("אישור המיקרופון בהכנה — מאושר, והמיקרופון נסגר עד ▶",
    setupMicState.ok && setupMicState.streams === 1 && setupMicState.live === 0 && !setupMicState.button, setupMicState);
  // אישור בהכנה ו-▶ כמעט יחד: מיקרופון אחד, ולא שניים שאחד מהם מקליט בלי בעלים.
  const twoOpens = await setupPage.evaluate(async () => {
    const before = opened.length;
    await Promise.all([ensureAudio(), ensureAudio()]);
    const out = { streams: opened.length - before, live: micLive() };
    releaseMic();
    out.leftLive = opened.flatMap(st => st.getTracks()).filter(t => t.readyState === "live").length;
    return out;
  });
  check("שתי פתיחות של המיקרופון בבת אחת פותחות זרם אחד",
    twoOpens.streams === 1 && twoOpens.live && twoOpens.leftLive === 0, twoOpens);
  // בכרומיום של הבדיקות אין קול באנגלית: ההקראה לא מתחילה, וזה כתוב.
  await setupPage.click("#setupVoiceBtn");
  await setupPage.waitForTimeout(1800);
  const setupVoiceState = await setupPage.evaluate(() => ({ text: $("setupVoice").textContent, bad: $("setupVoice").classList.contains("bad") }));
  check("בדיקת קול בלי קול באנגלית — כתוב שהמשחק יעבוד בלי השמיעה", setupVoiceState.bad, setupVoiceState);
  await setupPage.fill("#setupName", "  נועה  ");
  await setupPage.click("#setupDone");
  const setupDone = await setupPage.evaluate(() => ({ screen, child: childName(), door: $("childName").textContent,
    saved: localStorage.getItem("say-the-word-setup"), focus: document.activeElement.id }));
  await setupPage.reload({ waitUntil: "domcontentloaded" });
  const setupAfter = await setupPage.evaluate(() => screen);
  check("\"סיימנו\" — מסך הפתיחה עם השם שנכתב, ובפתיחה הבאה אין הכנה",
    setupDone.screen === "door" && setupDone.child === "נועה" && setupDone.door === "נועה" && setupDone.saved === "1"
      && setupDone.focus === "play" && setupAfter === "door", { setupDone, setupAfter });
  // מאזור המבוגר חוזרים אליה, למשל כדי לבדוק את הקול שוב.
  const setupAgain = await setupPage.evaluate(() => { openPanel(); $("setupBtn").click();
    return { screen, overlay: !$("overlay").hidden }; });
  check("\"בדיקת המכשיר\" באזור המבוגר פותח את ההכנה שוב", setupAgain.screen === "setup" && !setupAgain.overlay, setupAgain);
  // יש קולות, ואף אחד לא באנגלית: כתוב מיד שאין קול, בלי להקריא בקול אחר.
  const setupHebrewVoice = await setupPage.evaluate(() => {
    const real = { voices, refreshVoices }, synth = speechSynthesis;
    let spoken = 0;
    synth.speak = () => { spoken++; };
    voices = [{ lang: "he-IL", name: "Carmit", localService: true, voiceURI: "he" }];
    refreshVoices = () => {};
    try{
      setupVoice();
      return { bad: $("setupVoice").classList.contains("bad"), spoken };
    } finally { voices = real.voices; refreshVoices = real.refreshVoices; delete synth.speak; }
  });
  check("בדיקת קול בהכנה בלי קול באנגלית — כתוב מיד, בלי להקריא", setupHebrewVoice.bad && setupHebrewVoice.spoken === 0, setupHebrewVoice);
  // "סיימנו" בזמן שבקשת המיקרופון עוד פתוחה: המיקרופון לא נשאר מקליט במסך הפתיחה.
  const setupPending = await setupPage.evaluate(async () => {
    releaseMic();
    const opened = [], real = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = c => new Promise(r => setTimeout(r, 800))
      .then(() => real.call(navigator.mediaDevices, c)).then(st => { opened.push(st); return st; });
    try{
      setupMic();
      finishSetup();
      await new Promise(r => setTimeout(r, 1500));
      return { screen, opened: opened.length, live: opened.flatMap(st => st.getTracks()).filter(t => t.readyState === "live").length };
    } finally { navigator.mediaDevices.getUserMedia = real; }
  });
  check("\"סיימנו\" בזמן שהמיקרופון נפתח — הוא לא נשאר מקליט", setupPending.screen === "door" && setupPending.opened === 1 && setupPending.live === 0, setupPending);
  // שם שלא נשמר כי המקום נגמר: כתוב בהכנה, וההכנה לא נגמרת בלעדיו.
  const setupFull = await setupPage.evaluate(() => {
    openSetup();
    for(let size = 1 << 20, k = 0; size >= 1; ){
      try{ localStorage.setItem("fill" + k++, "x".repeat(size)); }catch(e){ size >>= 1; }
    }
    $("setupName").value = "יואב";
    finishSetup();
    return { screen, note: $("setupNameNote").classList.contains("bad"), child: childName() };
  }).catch(e => ({ error: e.message }));
  check("שם שלא נשמר בהכנה — כתוב שם, וההכנה נשארת", setupFull.screen === "setup" && setupFull.note && setupFull.child !== "יואב", setupFull);
  await setupCtx.close();
  // באייפד ובאייפון: קודם "הוספה למסך הבית", כי לאפליקציה שעל מסך הבית יש אחסון
  // משלה, ומה שירד בספארי לא עובר אליה.
  const iosCtx = await browser.newContext({ setup: true, serviceWorkers: "block", userAgent: safariMac, hasTouch: true });
  await iosCtx.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
    Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => 5 });
  });
  await iosCtx.route("**/model.tar.gz", route => route.abort());
  const iosPage = await iosCtx.newPage();
  await iosPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  const iosSetup = await iosPage.evaluate(() => ({ screen, first: $("setup").children[1].id, shown: $("setupInstall").checkVisibility(),
    text: $("setupInstallText").textContent }));
  await iosCtx.close();
  check("באייפד, בהכנה, ההוספה למסך הבית באה קודם",
    iosSetup.screen === "setup" && iosSetup.first === "setupInstall" && iosSetup.shown && iosSetup.text.includes("קודם"), iosSetup);
  // מכשיר שכבר שיחקו בו, מגרסה שלפני ההכנה, נפתח כרגיל במסך הפתיחה.
  const usedCtx = await browser.newContext({ setup: true, serviceWorkers: "block" });
  const usedPage = await usedCtx.newPage();
  await usedPage.goto(base + "/manifest.json");
  await usedPage.evaluate(() => localStorage.setItem("say-the-word-progress", JSON.stringify({ v: 1, w: {} })));
  await usedPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  const usedScreen = await usedPage.evaluate(() => ({ screen, saved: localStorage.getItem("say-the-word-setup") }));
  await usedCtx.close();
  check("מכשיר שכבר שיחקו בו נפתח במסך הפתיחה, בלי הכנה", usedScreen.screen === "door" && usedScreen.saved === null, usedScreen);
  // מכשיר שהוכן לכיתה בגרסה שלפני ההכנה: הורידו בו את המודל ואף ילד עוד לא
  // שיחק, אז אין בו אף מפתח. ה-service worker כבר שולט בדף, וזה הסימן.
  const preparedCtx = await browser.newContext({ setup: true });
  const preparedPage = await preparedCtx.newPage();
  await preparedPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await preparedPage.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  await preparedPage.evaluate(() => localStorage.clear());
  await preparedPage.reload({ waitUntil: "domcontentloaded" });
  const preparedScreen = await preparedPage.evaluate(() => ({ screen, saved: localStorage.getItem("say-the-word-setup") }));
  await preparedCtx.close();
  check("מכשיר שהאפליקציה כבר נפתחה בו, בלי אף מפתח, נפתח במסך הפתיחה",
    preparedScreen.screen === "door" && preparedScreen.saved === null, preparedScreen);

  // --------------------------------------------------------------
  group("שמע");
  // השמע דלוק כברירת מחדל, ונשמר רק כשמבוגר מכבה. הבדיקות כאן כיבו אותו
  // בכתיבה ל-sound_enabled, ולכן בודקים מכשיר נקי בהקשר נפרד.
  const cleanDevice = await browser.newContext({ serviceWorkers: "block" });
  const cleanPage = await cleanDevice.newPage();
  await cleanPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  const soundDefault = await cleanPage.evaluate(() => ({ on: soundEnabled, saved: localStorage.getItem("sound_enabled"),
    toggle: $("soundToggle").checked, practice: chosenMode, practiceSaved: localStorage.getItem("practice_mode") }));
  await cleanDevice.close();
  check("במכשיר חדש השמע דלוק, ולא נכתב כלום", soundDefault.on && soundDefault.saved === null && soundDefault.toggle, soundDefault);
  check("במכשיר חדש סוג התרגול מעורב, ולא נכתב כלום", soundDefault.practice === "mixed" && soundDefault.practiceSaved === null, soundDefault);
  // המתג באזור המבוגר, והבחירה נשמרת בין פתיחות.
  await openSettings();
  const soundOn = await page.evaluate(() => soundEnabled);
  await page.click("#soundToggle");
  const flipped = await page.evaluate(() => ({ on: soundEnabled, saved: localStorage.getItem("sound_enabled") }));
  await reload();
  const afterReload = await page.evaluate(() => soundEnabled);
  check("מתג השמע באזור המבוגר מחליף ונשמר בין טעינות",
    flipped.on === !soundOn && flipped.saved === (flipped.on ? "1" : "0") && afterReload === flipped.on, { soundOn, flipped, afterReload });
  await page.evaluate(() => setSound(false));

  // --------------------------------------------------------------
  group("ילדים במכשיר");
  // כמה ילדים על אותו מכשיר, לכל אחד רשימה והגדרות משלו. מה שנשמר לפני שהיו
  // שמות הוא "בלי שם", ונשאר במפתחות שלו בלי שינוי: שינוי שלהם היה מוחק לילד
  // את הרשימה, וגרסה קודמת של הדף לא הייתה מוצאת אותה.
  const LEGACY = ["words", "speech_match_config", "hebrew_spelling", "practice_mode", "sound_enabled"];
  const PER_CHILD = LEGACY.slice(0, 4);
  const dumpStorage = p => p.evaluate(() =>
    JSON.stringify(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)])));

  // מכשיר שכבר יש בו הגדרות פותח את הגרסה החדשה, בהקשר נפרד.
  const oldDevice = await browser.newContext({ serviceWorkers: "block" });
  const oldPage = await oldDevice.newPage();
  await oldPage.goto(base + "/manifest.json");
  await oldPage.evaluate(() => {
    localStorage.setItem("words", JSON.stringify([{ emoji: "🐶", word: "dog" }, { emoji: "🐱", word: "cat" }]));
    localStorage.setItem("speech_match_config", "strict");
    localStorage.setItem("hebrew_spelling", "0");
    localStorage.setItem("practice_mode", "spell");
    localStorage.setItem("sound_enabled", "1");
  });
  const oldBefore = await dumpStorage(oldPage);
  await oldPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await oldPage.waitForTimeout(300);
  const oldState = await oldPage.evaluate(() => {
    openPanel();
    return { words: words.map(w => w.word).join(), preset: preset.id, hebrew: hebrewEnabled, mode, sound: soundEnabled,
             childId, note: $("childName").textContent, chips: [...$("childChips").children].map(c => c.textContent),
             del: $("deleteChildBtn").checkVisibility() };
  });
  const oldAfter = await dumpStorage(oldPage);
  await oldDevice.close();
  check("מכשיר עם הגדרות מלפני השמות טוען אותן כמו שהן, בלי שם במסך הפתיחה",
    oldState.words === "dog,cat" && oldState.preset === "strict" && !oldState.hebrew && oldState.mode === "spell"
      && oldState.sound && oldState.childId === "" && oldState.note === "", oldState);
  check("ולא כותב במכשיר שום דבר", oldBefore === oldAfter, { oldBefore, oldAfter });
  check("בלי שמות, בהגדרות יש רק ➕ ואין כפתור מחיקה",
    oldState.chips.join() === "➕ הוספת שם" && !oldState.del, oldState);

  // מכאן בדף הראשי, שעוד אין בו שמות.
  const legacyRaw = () => page.evaluate(keys => JSON.stringify(keys.map(k => localStorage.getItem(k))), LEGACY);
  const childKeys = id => page.evaluate(([keys, id]) => keys.map(k => localStorage.getItem(k + "@" + id)), [PER_CHILD, id]);
  const registry = () => page.evaluate(() => localStorage.getItem("say-the-word-children"));
  const childState = () => page.evaluate(() => ({
    childId, words: words.map(w => w.word).join(), preset: preset.id, hebrew: hebrewEnabled, mode,
    ui: { hebrew: $("hebrewToggle").checked, badge: $("matchLevelBadge").textContent,
          mode: document.querySelector('#modeSwitch [aria-checked="true"]').dataset.mode },
    shownListed: words.some(w => w.word === $("word").textContent),
    chips: [...$("childChips").children].map(c => c.textContent + (c.getAttribute("aria-pressed") === "true" ? "*" : "")).join("|"),
    meta: $("panelMeta").textContent,
    del: $("deleteChildBtn").checkVisibility() ? $("deleteChildBtn").textContent : null,
    notice: { cls: $("childNotice").className, text: $("childNotice").textContent }
  }));
  const settingsOf = s => JSON.stringify([s.childId, s.words, s.preset, s.hebrew, s.mode, s.ui]);
  const addName = async name => {
    page.once("dialog", d => d.accept(name));
    await page.click("#childChips [data-add]");
    await page.waitForTimeout(150);
  };
  const tapChild = async id => {
    await page.click(`#childChips [data-child="${id}"]`);
    await page.waitForTimeout(150);
  };

  await page.evaluate(() => { round.row = ["dog", "cat"]; window.sameDocument = true; });
  await openSettings();
  const legacyBefore = await legacyRaw();
  const unnamed = await childState();
  const onScreen = await page.evaluate(() => [JSON.stringify(words), preset.id, hebrewEnabled ? "1" : "0", mode]);

  await addName("נועה");
  const added = await page.evaluate(() => ({
    reg: JSON.parse(localStorage.getItem("say-the-word-children")), pointer: localStorage.getItem("say-the-word-child"),
    sameDocument: window.sameDocument === true, row: round.row.join(), at: round.at
  }));
  const noaId = added.reg && added.reg[0] && added.reg[0].id;
  const onNoa = await childState();
  check("➕ לא מעתיק לילד החדש את ההתקדמות ואת היומן",
    await page.evaluate(id => !["say-the-word-progress@", "say-the-word-log@"].some(k => localStorage.getItem(k + id) !== null), noaId));
  check("➕ מוסיף שם ועובר אליו בלי לטעון את הדף מחדש",
    added.sameDocument && Array.isArray(added.reg) && added.reg.length === 1 && added.reg[0].name === "נועה" && /^[a-z0-9]+$/.test(noaId)
      && onNoa.childId === noaId && added.pointer === noaId, { added, onNoa });
  check("ילד חדש מתחיל מההגדרות שהיו על המסך",
    JSON.stringify(await childKeys(noaId)) === JSON.stringify(onScreen)
      && settingsOf({ ...onNoa, childId: "" }) === settingsOf(unnamed), { onScreen, onNoa, unnamed });
  check("מעבר לילד אחר מתחיל סבב חדש, במילה הראשונה בו, והשורה ריקה", added.row === "" && added.at === 0, added);
  check("בהגדרות: בלי שם, השם המסומן, ➕, וכפתור מחיקה עם השם",
    onNoa.chips === "בלי שם|נועה*|➕ הוספת שם" && onNoa.meta.includes("של נועה") && onNoa.del === "🗑️ מחיקת נועה", onNoa);

  // כל הגדרה משתנה אצל נועה לערך אחר ממה שהיה. התעתיק דרך תיבת הסימון,
  // כי setHebrew לבדו לא מזיז אותה.
  await page.evaluate(() => {
    removeAt(0);
    setPreset(PRESETS.find(p => p !== preset));
    $("hebrewToggle").click();
    setMode(mode === "say" ? "spell" : "say");
  });
  const noaChanged = await childState();
  const noaSaved = await page.evaluate(() => [JSON.stringify(words), preset.id, hebrewEnabled ? "1" : "0", mode]);
  check("שינוי אצל ילד נשמר אצלו, ומה שנשמר בלי שם לא משתנה",
    JSON.stringify(await childKeys(noaId)) === JSON.stringify(noaSaved) && await legacyRaw() === legacyBefore
      && noaChanged.words !== unnamed.words && noaChanged.preset !== unnamed.preset
      && noaChanged.hebrew !== unnamed.hebrew && noaChanged.mode !== unnamed.mode, { noaChanged, unnamed });

  await tapChild("");
  const backUnnamed = await childState();
  check("הודעה על ילד אחד לא נשארת אחרי מעבר לאחר",
    onNoa.notice.text.includes("נוסף") && backUnnamed.notice.text === "", { before: onNoa.notice, after: backUnnamed.notice });
  check("בלי שם מחזיר את ההגדרות שהיו לפני השמות, גם על המסך",
    settingsOf(backUnnamed) === settingsOf(unnamed) && backUnnamed.shownListed && backUnnamed.del === null
      && !backUnnamed.meta.includes(" של ") && await legacyRaw() === legacyBefore
      && await page.evaluate(() => localStorage.getItem("say-the-word-child")) === "", { backUnnamed, unnamed });
  await tapChild(noaId);
  const backNoa = await childState();
  check("והשם מחזיר את ההגדרות שלו", settingsOf(backNoa) === settingsOf(noaChanged) && backNoa.shownListed,
    { backNoa, noaChanged });

  await reload();
  const reloadedNoa = await childState();
  const greeting = await page.textContent("#childName");
  check("אחרי טעינה מחדש הדף נשאר על אותו ילד, והשם שלו במסך הפתיחה",
    settingsOf(reloadedNoa) === settingsOf(noaChanged) && greeting === "נועה", { reloadedNoa, greeting });

  // השמע תלוי בחדר ולא בילד. מדליקים אותו, ההפך מברירת המחדל, כדי שמעבר
  // שקורא אותו מחדש לפי הילד ייראה.
  const sound = await page.evaluate(id => {
    const was = soundEnabled;
    setSound(true);
    const set = soundEnabled;
    switchChild("");
    const unnamedSound = soundEnabled;
    switchChild(id);
    const out = { set, unnamedSound, back: soundEnabled, raw: localStorage.getItem("sound_enabled"),
                  perChild: Object.keys(localStorage).filter(k => k.startsWith("sound_enabled@")) };
    setSound(was);
    return out;
  }, noaId);
  check("השמע משותף לכל המכשיר",
    sound.set === sound.unnamedSound && sound.set === sound.back && sound.raw === (sound.set ? "1" : "0") && sound.perChild.length === 0, sound);

  await openSettings();
  let resetText = "";
  page.once("dialog", d => { resetText = d.message(); d.accept(); });
  await page.click("#resetBtn");
  await page.waitForTimeout(150);
  const afterReset = await childKeys(noaId);
  check("איפוס אצל ילד מאפס רק אותו",
    resetText.includes("נועה") && afterReset[0] === await page.evaluate(() => JSON.stringify(DEFAULT_WORDS))
      && afterReset[1] === "normal" && await legacyRaw() === legacyBefore, { resetText, afterReset });

  // שם שכבר קיים רק עובר אליו. אילו הוסיף ילד חדש, ההגדרות שעל המסך היו
  // נכתבות על אלה של נועה.
  await tapChild("");
  const regBefore = await registry();
  await addName("נועה");
  const sameName = await childState();
  check("הוספת שם שכבר קיים עוברת אליו בלי לדרוס את ההגדרות שלו, ואומרת את זה",
    sameName.childId === noaId && await registry() === regBefore && sameName.notice.text.includes("כבר קיים")
      && JSON.stringify(await childKeys(noaId)) === JSON.stringify(afterReset), { sameName, keys: await childKeys(noaId) });

  // ילד שני נוסף כשנועה על המסך. ההגדרות שלה שונות מאלה של "בלי שם", ולכן
  // רק כאן רואים שההעתק הוא של המסך ולא של מה שנשמר בלי שם. השם ארוך מ-20
  // תווים, והחיתוך נופל באמצע אימוג'י אם סופרים חצאי תווים.
  const noaOnScreen = await page.evaluate(() => [JSON.stringify(words), preset.id, hebrewEnabled ? "1" : "0", mode]);
  const longName = "<b>x</b> " + "🦄".repeat(12), cutName = "<b>x</b> " + "🦄".repeat(11);
  await addName(longName);
  const marked = await page.evaluate(cut => ({
    chip: [...$("childChips").children].some(c => c.textContent === cut),
    tags: $("childChips").querySelectorAll("b").length + $("deleteChildBtn").querySelectorAll("b").length,
    names: JSON.parse(localStorage.getItem("say-the-word-children")).map(c => c.name),
    id: childId
  }), cutName);
  check("שם עם תגיות מוצג כטקסט", marked.chip && marked.tags === 0 && marked.id !== noaId, marked);
  check("שם ארוך נחתך בלי לשבור אימוג'י", marked.names.includes(cutName), marked.names);
  check("ילד שנוסף כשילד אחר על המסך מתחיל מההגדרות שעל המסך",
    JSON.stringify(await childKeys(marked.id)) === JSON.stringify(noaOnScreen)
      && noaOnScreen[2] !== JSON.parse(legacyBefore)[2], { noaOnScreen, copied: await childKeys(marked.id) });

  // ערך פגום ברשימת השמות לא נדרס: אולי אפשר עוד לשחזר ממנו את השמות.
  await page.evaluate(() => localStorage.setItem("say-the-word-children", "{"));
  await addName("דן");
  const brokenAdd = { raw: await registry(), notice: (await childState()).notice };
  await page.evaluate(([reg, id]) => {
    localStorage.setItem("say-the-word-child", id);
    localStorage.setItem("say-the-word-children", "{");
  }, [regBefore, noaId]);
  await reload();
  const brokenLoad = await page.evaluate(() => ({ childId, words: words.map(w => w.word).join() }));
  await page.evaluate(reg => localStorage.setItem("say-the-word-children", reg),
    JSON.stringify(JSON.parse(regBefore).concat({ id: marked.id, name: cutName })));
  check("רשימת שמות פגומה לא נדרסת כשמוסיפים שם", brokenAdd.raw === "{" && brokenAdd.notice.cls.includes("error"), brokenAdd);
  check("ובפתיחה הדף עולה בלי שם, עם ההגדרות שמלפני השמות",
    brokenLoad.childId === "" && brokenLoad.words === unnamed.words, brokenLoad);

  // כתיבה שנכשלת (מכשיר מלא) לא מדווחת כהצלחה ולא עוברת לשם.
  await openSettings();
  const regFull = await registry();
  await page.evaluate(() => {
    window.realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(){ throw new DOMException("full", "QuotaExceededError"); };
  });
  try{ await addName("דן"); }
  finally{ await page.evaluate(() => { Storage.prototype.setItem = window.realSetItem; delete window.realSetItem; }); }
  const fullAdd = await childState();
  check("כשאין מקום במכשיר, שם חדש לא נוסף ומוצגת שגיאה",
    fullAdd.childId === "" && fullAdd.notice.cls.includes("error") && await registry() === regFull, fullAdd);

  // מחיקה: ביטול לא משנה כלום, ואישור מוחק את השם ואת כל מה שנשמר לו.
  await page.evaluate(id => {
    localStorage.setItem("say-the-word-progress@" + id, JSON.stringify({ v: 1, w: {} }));
    localStorage.setItem("say-the-word-log@" + id, JSON.stringify({ v: 1, a: [] }));
  }, marked.id);
  await tapChild(marked.id);
  page.once("dialog", d => d.dismiss());
  await page.click("#deleteChildBtn");
  await page.waitForTimeout(150);
  const cancelled = { reg: await registry(), id: await page.evaluate(() => childId) };
  check("ביטול המחיקה לא משנה כלום", cancelled.reg === regFull && cancelled.id === marked.id, cancelled);
  // אם הביטול מחק בכל זאת, הכפתור כבר מוסתר והלחיצה הייתה נתקעת.
  if(cancelled.id === marked.id){
    page.once("dialog", d => d.accept());
    await page.click("#deleteChildBtn");
    await page.waitForTimeout(150);
  }
  const deleted = await childState();
  const leftover = await page.evaluate(id => Object.keys(localStorage).filter(k => k.endsWith("@" + id)), marked.id);
  check("מחיקה מוחקת גם את ההתקדמות ואת היומן של הילד",
    await page.evaluate(id => ["say-the-word-progress@", "say-the-word-log@"].every(k => localStorage.getItem(k + id) === null), marked.id));
  check("מחיקה מוחקת את השם ואת ההגדרות שלו, ורק אותם",
    await registry() === regBefore && leftover.length === 0 && deleted.childId === "" && deleted.del === null
      && await legacyRaw() === legacyBefore && JSON.stringify(await childKeys(noaId)) === JSON.stringify(afterReset),
    { leftover, deleted });

  // שתי לשוניות: כל אחת מקשיבה רק לרשימה של הילד שעל המסך שלה. הלשונית
  // השנייה היא manifest.json, בלי האפליקציה עצמה.
  await tapChild(noaId);
  const tab = await ctx.newPage();
  await tab.goto(base + "/manifest.json");
  // הרשימה נטענת תמיד מהמפתח של הילד שעל המסך, ולכן תגובה לרשימה של ילד
  // אחר לא משנה אותה. מה שמסגיר אותה הוא הצגה מחדש של המילה.
  const noaShown = await page.evaluate(() => ({ words: words.map(w => w.word).join(), shownCount }));
  const fromTab = (fn, arg) => tab.evaluate(fn, arg);
  const legacyList = [{ emoji: "🐶", word: "dog" }, { emoji: "🐱", word: "cat" }];
  await fromTab(raw => localStorage.setItem("words", raw), JSON.stringify(legacyList));
  await page.waitForTimeout(500);
  const ignored = await page.evaluate(() => ({ words: words.map(w => w.word).join(), shownCount }));
  const noaList = JSON.stringify([{ word: "dog", emoji: "🐶" }]);
  await fromTab(([id, raw]) => localStorage.setItem("words@" + id, raw), [noaId, noaList]);
  await page.waitForFunction(() => words.map(w => w.word).join() === "dog", null, { timeout: 5000 }).catch(() => {});
  const synced = await page.evaluate(([id, raw]) => ({
    words: words.map(w => w.word).join(), notWrittenBack: localStorage.getItem("words@" + id) === raw
  }), [noaId, noaList]);
  await fromTab(([id, keys]) => {
    localStorage.setItem("say-the-word-children", "[]");
    for(const k of keys) localStorage.removeItem(k + "@" + id);
  }, [noaId, PER_CHILD]);
  await page.waitForFunction(() => childId === "", null, { timeout: 5000 }).catch(() => {});
  const fellBack = await page.evaluate(() => ({ childId, words: words.map(w => w.word).join(),
    pointer: localStorage.getItem("say-the-word-child") }));
  await fromTab(raw => localStorage.setItem("words", raw), JSON.parse(legacyBefore)[0]);
  await page.waitForFunction(w => words.map(w => w.word).join() === w, unnamed.words, { timeout: 5000 }).catch(() => {});
  await tab.close();
  check("רשימה של ילד אחר שנשמרה בחלון אחר לא נוגעת במה שעל המסך",
    ignored.words === noaShown.words && ignored.shownCount === noaShown.shownCount, { ignored, noaShown });
  check("רשימה של הילד שעל המסך מחלון אחר מוצגת ולא נשמרת בחזרה",
    synced.words === "dog" && synced.notWrittenBack, synced);
  check("ילד שנמחק בחלון אחר — עוברים לבלי שם, לא לרשימת ברירת המחדל",
    fellBack.childId === "" && fellBack.words === "dog,cat" && fellBack.pointer === noaId, fellBack);

  // ממסך הפתיחה החלפת ילד לא בונה סבב חדש. "הסבב האחרון" באזור המבוגר הוא של
  // הילד שהסבב שלו, ולא מופיע תחת השם של ילד אחר.
  const doorSwitch = await page.evaluate(() => {
    const shown = () => getComputedStyle($("lastRoundSection")).display !== "none";
    goDoor();
    round.tried = ["dog"]; round.row = ["dog"];
    openPanel();
    const out = { own: shown() };
    addChild("בדיקה");
    const id = childId;
    out.other = shown();
    out.text = $("lastRound").textContent;
    switchChild("");
    out.back = shown();
    for(const k of Object.keys(localStorage)) if(k.endsWith("@" + id)) localStorage.removeItem(k);
    closePanel();
    return out;
  });
  check("\"הסבב האחרון\" של ילד אחד לא מופיע אחרי מעבר לילד אחר ממסך הפתיחה",
    doorSwitch.own && !doorSwitch.other && doorSwitch.back, doorSwitch);

  await page.evaluate(() => {
    localStorage.removeItem("say-the-word-children");
    localStorage.removeItem("say-the-word-child");
  });
  await reload();
  check("בסוף, מה שנשמר בלי שם זהה למה שהיה לפני השמות",
    await legacyRaw() === legacyBefore && await page.evaluate(() => Object.keys(localStorage).filter(k => k.includes("@")).length) === 0,
    await dumpStorage(page));

  // --------------------------------------------------------------
  group("צלילי משוב");
  // ההצלחה באמירה מגיעה מהמזהה, מחוץ ללחיצה, ולכן הצליל תלוי בקשר שלחיצה
  // קודמת כבר הפעילה, כמו ▶. good() מקדם את המילה; הקבוצה הבאה טוענת את הדף
  // מחדש בכל מקרה.
  await page.evaluate(() => { setSound(true); goDoor(); });
  await page.click("#play", { force: true });
  await page.waitForTimeout(300);
  const chimes = await page.evaluate(() => {
    const state = fxCtx && fxCtx.state;
    if(state !== "running") return { state };
    const played = [];
    const create = fxCtx.createOscillator.bind(fxCtx);
    fxCtx.createOscillator = () => { const o = create(); played.push(o.frequency); return o; };
    const heard = run => { run(); return played.splice(0).map(f => f.value); };
    const cheer = heard(good), oops = heard(again);
    soundEnabled = false;
    const muted = heard(() => { good(); again(); });
    soundEnabled = true;
    delete fxCtx.createOscillator;
    return { state, cheer, oops, muted };
  });
  const rising = notes => notes.length > 1 && notes.every((f, k) => k === 0 || f > notes[k - 1]);
  check("לחיצה מפעילה את הצלילים", chimes.state === "running", chimes);
  check("הצלחה מנגנת צליל עולה", !!chimes.cheer && rising(chimes.cheer), chimes);
  check("אין צליל טעות", !!chimes.oops && chimes.oops.length === 0, chimes);
  check("שמע מכובה — אין צלילים", !!chimes.muted && chimes.muted.length === 0, chimes);
  // המשוב הוא הצליל והתמונה. speak() נשאר רק להקראת המילה באנגלית.
  const spokenFeedback = await page.evaluate(() => {
    const calls = [], original = speak;
    speak = (text, lang) => { calls.push({ text, lang }); return original(text, lang); };
    try { good(); again(); } finally { speak = original; }
    return calls;
  });
  check("הצלחה וניסיון נוסף לא מקריאים כלום", spokenFeedback.length === 0, spokenFeedback);
  await page.evaluate(() => setSound(false));

  // --------------------------------------------------------------
  group("עבודה ללא אינטרנט");
  // סקריפט שחסר במטמון לא יכול לחזור כ-index.html: הוא לא נטען והדף קורס.
  await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  await page.waitForTimeout(2500);

  const cached = await page.evaluate(async () => {
    const c = await caches.open(CACHE_NAME);
    return (await c.keys()).map(r => new URL(r.url).pathname.split("/").pop() || "index");
  });
  // הדף פותח את המטמון בשם CACHE_NAME ומוצא בו את מה שה-service worker שמר.
  check("הדף וה-service worker על אותו מטמון", cached.length > 0, cached);
  check("words.js נשמר במטמון", cached.includes("words.js"), cached);
  // Vosk חילץ את המודל ל-IndexedDB כשהדף נטען לראשונה, ומאז קורא רק משם. את
  // הארכיון במטמון אף אחד כבר לא קורא, והוא נמחק אחרי הטעינה.
  await page.waitForFunction(() => model !== null, null, { timeout: 30000 });
  const stored = await page.evaluate(async () => {
    const c = await caches.open(CACHE_NAME);
    let archive = true;
    for(let k = 0; k < 50 && archive; k++){
      archive = !!(await c.match(MODEL_URL));
      if(archive) await new Promise(r => setTimeout(r, 100));
    }
    return { archive, extracted: await modelExtracted() };
  });
  check("אחרי הטעינה המודל שמור מחולץ, והארכיון לא נשאר במטמון", stored.extracted && !stored.archive, stored);
  // ההורדה עצמה נכתבת למטמון בזרימה, בלי לצבור 29MB בזיכרון. אם הזרימה
  // נקטעת הקובץ נשמר חסר, והמנוע נופל רק כשהוא מחלץ אותו. כאן הדף מוריד שוב,
  // כאילו המודל עוד לא חולץ.
  const modelBytes = await page.evaluate(async () => {
    const real = modelExtracted;
    modelExtracted = async () => false;
    try{
      await fetchModel();
      const c = await caches.open(CACHE_NAME), hit = await c.match(MODEL_URL);
      // כל עוד העותק המחולץ לא שמור, הארכיון לא נמחק.
      await dropArchive();
      return hit && await c.match(MODEL_URL) ? (await hit.blob()).size : 0;
    } finally {
      modelExtracted = real;
      await dropArchive();
      $("loading").hidden = true;
      renderStatus();
    }
  });
  const realBytes = fs.statSync(path.join(DIR, "model.tar.gz")).size;
  check("המודל נשמר במטמון במלואו", modelBytes === realBytes, { modelBytes, realBytes });
  // פתיחה נוספת לא מורידה את המודל שוב, ובלי רשת המנוע נטען מהעותק המחולץ.
  const downloads = () => served.get("model.tar.gz") || 0;
  const before = downloads();
  await reload();
  await page.waitForFunction(() => model !== null, null, { timeout: 30000 });
  const reopened = { downloads: downloads() - before, error: await page.evaluate(() => modelError) };
  check("בפתיחה הבאה המודל לא יורד שוב", reopened.downloads === 0 && !reopened.error, reopened);
  await ctx.setOffline(true);
  await reload();
  const offlineModel = await page.waitForFunction(() => model !== null || modelError !== "", null, { timeout: 30000 })
    .then(() => page.evaluate(() => ({ model: model !== null, error: modelError }))).catch(e => ({ timeout: e.message }));
  await ctx.setOffline(false);
  check("בלי רשת, אחרי שהמודל ירד, מנוע הדיבור נטען", offlineModel.model === true, offlineModel);
  // וגם כשהדף לא מצליח לבדוק את IndexedDB בעצמו (באג ידוע בספארי) ולכן מנסה
  // להוריד: ההורדה נכשלת בלי רשת, ו-Vosk עדיין קורא את העותק המחולץ.
  const blindPage = await ctx.newPage();
  await blindPage.addInitScript(() => { IDBFactory.prototype.open = () => { throw new Error("blocked"); }; });
  await ctx.setOffline(true);
  await blindPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" }).catch(() => {});
  const blindModel = await blindPage.waitForFunction(() => model !== null || modelError !== "", null, { timeout: 30000 })
    .then(() => blindPage.evaluate(() => ({ model: model !== null, error: modelError }))).catch(e => ({ timeout: e.message }));
  await ctx.setOffline(false);
  await blindPage.close();
  check("בלי רשת, גם כשההורדה של הדף נכשלת, מנוע הדיבור נטען מהעותק המחולץ", blindModel.model === true, blindModel);
  await reload();

  // ב-GitHub Pages כל הריפו של אותו משתמש חולקים origin אחד, ואיתו את
  // Cache Storage. ה-service worker מנקה בהפעלה רק מטמונים ישנים שלנו; מחיקה
  // של כל השאר השאירה את AlefBet בלי עבודה ללא אינטרנט אחרי ביקור אחד כאן.
  // דפדפן נקי, כדי שההפעלה תקרה אחרי שהמטמונים כבר שם.
  const fresh = await browser.newContext();
  const freshPage = await fresh.newPage();
  await freshPage.goto(base + "/manifest.json");
  const ours = await page.evaluate(() => CACHE_NAME);
  const planted = { foreign: "alefbet-release-test", old: ours + "-old" };
  await freshPage.evaluate(async names => {
    for(const name of Object.values(names)) await caches.open(name);
  }, planted);
  await freshPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  // controller מופיע רק אחרי clients.claim, שבא אחרי הניקוי
  await freshPage.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  const keys = await freshPage.evaluate(() => caches.keys());
  await fresh.close();
  check("מטמון של אפליקציה אחרת שורד את ההפעלה", keys.includes(planted.foreign), keys);
  check("מטמון ישן שלנו נמחק בהפעלה", !keys.includes(planted.old) && keys.includes(ours), keys);

  // קובץ כבד מוגש מהמטמון בלי לשאול את הרשת, ולכן תשובת שגיאה שנשמרה פעם
  // אחת (סינון אתרים בבית הספר, תקלה בשרת) מוגשת לנצח, והמכשיר נשאר בלי
  // זיהוי דיבור. הענף הכבד מזהה לפי שם הקובץ בלבד, אז no-such-dir/vosk.js
  // עובר בו ומקבל 404 מהשרת.
  const heavyMissing = new URL("no-such-dir/vosk.js", base + "/").href;
  const missingLine = expectConsoleError(m => m.location().url === heavyMissing);
  const notStored = await page.evaluate(async url => {
    const status = (await fetch(url)).status;
    await new Promise(r => setTimeout(r, 500));   // ה-service worker שומר בלי לחכות
    return { status, stored: !!(await caches.match(url)) };
  }, heavyMissing);
  await missingLine();
  check("קובץ כבד שחזר עם שגיאה לא נשמר במטמון", notStored.status === 404 && !notStored.stored, notStored);
  // כשהקובץ הכבד חסר במטמון — ההתקנה לא הצליחה להוסיף את vosk.js, או
  // שהדף לא הוריד את המודל בעצמו — הענף הכבד הוא מה ששומר אותו מהרשת,
  // ובלעדיו המכשיר עובד ברשת ונתקע במצב טיסה.
  const restored = await page.evaluate(async names => {
    const url = new URL("vosk.js", location.href).href;
    const c = await caches.open(names.ours);
    const real = await c.match(url);
    await c.delete(url);
    const r = await fetch(url);
    const bytes = (await r.arrayBuffer()).byteLength;
    let stored = null;
    for(let n = 0; n < 20 && !stored; n++){
      await new Promise(res => setTimeout(res, 100));   // ה-service worker שומר בלי לחכות
      stored = await c.match(url);
    }
    if(!stored && real) await c.put(url, real);
    return { status: r.status, bytes, storedOk: !!stored && stored.ok,
             storedBytes: stored ? (await stored.clone().arrayBuffer()).byteLength : 0 };
  }, { ours });
  check("קובץ כבד שאין במטמון נשמר מהרשת",
        restored.status === 200 && restored.bytes > 0 && restored.storedOk && restored.storedBytes === restored.bytes, restored);

  server.closeAllConnections();
  await new Promise(r => server.close(r));

  const fetchOffline = url => page.evaluate(async url => {
    try {
      const r = await fetch(url, { cache: "no-store" });
      const t = await r.text();
      return { status: r.status, type: r.headers.get("content-type") || "", html: t.trim().startsWith("<!DOCTYPE"),
               start: t.slice(0, 40) };
    } catch(e) { return { threw: e.name }; }
  }, url);
  // ?v= הוא רק שובר-מטמון, והסקריפט שבמטמון חוזר גם לגרסה שלא נשמרה.
  const versioned = await fetchOffline("./words.js?v=999");
  check("סקריפט שבמטמון עם ?v= אחר חוזר כסקריפט",
        versioned.html === false && versioned.type.includes("javascript"), versioned);
  // אבל כשה-?v= המדויק במטמון, הוא זה שחוזר ולא words.js מההתקנה. אחרת
  // דף חדש שנפתח בלי רשת רץ עם words.js ישן.
  const exactUrl = new URL("words.js?v=exact-test", base + "/").href;
  const exactBody = "// exact ?v= copy";
  await page.evaluate(async ([url, body]) => {
    const c = await caches.open(CACHE_NAME);
    await c.put(url, new Response(body, { headers: { "Content-Type": "text/javascript" } }));
  }, [exactUrl, exactBody]);
  const exact = await fetchOffline(exactUrl);
  await page.evaluate(async url => (await caches.open(CACHE_NAME)).delete(url), exactUrl);
  check("בלי רשת חוזר העותק של ה-?v= המדויק", exact.start === exactBody, exact);
  // ומה שאין במטמון בכלל נכשל. הדפדפן מדווח על הכישלון בקונסולה, וזו
  // השורה היחידה שלא נחשבת שגיאה.
  const failLine = expectConsoleError(m => m.text().includes("net::ERR_FAILED") &&
                                           m.location().url.endsWith("/not-in-cache.js"));
  const missing = await fetchOffline("./not-in-cache.js");
  await failLine();
  check("סקריפט שאין במטמון לא חוזר כ-HTML", missing.html !== true, missing);

  // ניווט עם מחרוזת שאילתה עולה בלי רשת מהרשומה של ./, זו שמתעדכנת בכל
  // פתיחה עם רשת מהמסך הבית. ./index.html הוא רק חלופה אחרונה לניווט ויכול
  // להיות ישן, ולכן כאן הוא מוחלף בדף שאינו האפליקציה: אם הוא זה שחוזר, זה נראה.
  // בדף נפרד באותו דפדפן, כדי שהדף הראשי לא יעזוב את מה שהבדיקות כאן בנו.
  const indexEntry = (cmd, body) => page.evaluate(async ([cmd, body]) => {
    const c = await caches.open(CACHE_NAME), url = new URL("index.html", location.href).href;
    if(cmd === "plant"){
      window.realIndexEntry = await c.match(url);
      await c.put(url, new Response(body, { headers: { "Content-Type": "text/html" } }));
    } else if(window.realIndexEntry) await c.put(url, window.realIndexEntry);
    else await c.delete(url);
  }, [cmd, body]);
  await indexEntry("plant", "<!DOCTYPE html><title>not the app</title>");
  // PAIRS מגיע מ-words.js, אז הוא לבדו לא אומר שהסקריפט של הדף רץ בלי לקרוס.
  const queryPage = await ctx.newPage();
  const queryErrors = [];
  queryPage.on("pageerror", e => queryErrors.push(e.message));
  let queryNav;
  try{
    await queryPage.goto(base + "/?q=1", { waitUntil: "domcontentloaded" });
    queryNav = await queryPage.evaluate(() => ({
      title: document.title, pairs: typeof PAIRS === "undefined" ? null : PAIRS.length
    }));
  } catch(e){ queryNav = { threw: e.message }; }
  finally{
    await queryPage.close();
    await indexEntry("restore");
  }
  check("ניווט עם ?q= בלי רשת עולה מהרשומה של ./",
    queryNav.pairs > 0 && queryErrors.length === 0, { ...queryNav, queryErrors });

  // --------------------------------------------------------------
  group("שגיאות");
  check("אין שגיאות בקונסולה", errors.length === 0, errors);

  await browser.close();

  // --------------------------------------------------------------
  group("server.js");
  // השרת מגיש רק קבצים, בלי נפילה ל-index.html: לאפליקציה אין נתיב מלבד /.
  // אותו כלל כמו ב-sw.js: קובץ חסר לא מקבל את index.html עם 200.
  const port = 8000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(DIR, "server.js")],
                      { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  let up = false;
  for(let n = 0; n < 40 && !up; n++){
    try { await fetch(url + "/words.js"); up = true; }
    catch { await new Promise(r => setTimeout(r, 250)); }
  }

  if(!up){
    check("server.js עולה", false, "לא הצליח לעלות. הריצו npm install");
  } else {
    // 404 עם דף שגיאה קטן זה בסדר גמור. מה שאסור זה 200 עם כל הדף.
    const appPage = fs.readFileSync(path.join(DIR, "index.html"), "utf8").length;
    const get = async u => {
      const r = await fetch(url + u);
      const body = await r.text();
      return { status: r.status, type: r.headers.get("content-type") || "",
               bytes: body.length, isAppPage: body.includes("vosk.js") || body.length > appPage / 2 };
    };
    const real = await get("/words.js");
    check("קובץ קיים מוגש כסקריפט", real.status === 200 && real.type.includes("javascript"), real);
    const root = await get("/");
    check("השורש מגיש את הדף", root.status === 200 && root.type.includes("html"), root);
    const missingJs = await get("/missing.js");
    check("סקריפט חסר לא מקבל את הדף", missingJs.status === 404 && !missingJs.isAppPage, missingJs);
    const missingPng = await get("/icon-999.png");
    check("תמונה חסרה לא מקבלת את הדף", missingPng.status === 404 && !missingPng.isAppPage, missingPng);

    // השרת מגיש את שורש הריפו לכל מי שברשת, ושם גם .git ו-.env.local. בעותק
    // שבו .git הוא קובץ ולא תיקייה (git worktree) רק הבדיקה השנייה יכולה ליפול.
    const text = async u => (await fetch(url + u)).text();
    const gitHead = await text("/.git/HEAD");
    check("תיקיית .git לא מוגשת", !gitHead.startsWith("ref:"), gitHead.slice(0, 40));
    const envFile = fs.readFileSync(path.join(DIR, ".env.example"), "utf8").trim();
    const envServed = await text("/.env.example");
    check("קובץ שמתחיל בנקודה לא מוגש", !envServed.includes(envFile), envServed.slice(0, 40));
  }
  child.kill("SIGKILL");

  console.log(`\n${passed} עברו, ${failed.length} נכשלו`);
  if(failed.length) process.exit(1);
}

main().catch(e => { console.error("\nהבדיקות נפלו:", e.message); process.exit(1); });
