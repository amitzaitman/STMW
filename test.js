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

// שרת סטטי קטן, קרוב ככל האפשר למה ש-GitHub Pages עושה.
function staticServer(){
  return http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
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
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if(m.type() === "error") errors.push("console: " + m.text()); });
  // כל מה ש-🎤 הראה מאז הטעינה האחרונה של הדף הראשי. ⚠️ שהופיע לרגע ונמחק
  // לא נראה במה שמוצג בסוף.
  await page.addInitScript(() => {
    window.sayIcons = [];
    document.addEventListener("DOMContentLoaded", () => {
      const icon = document.getElementById("sayIcon");
      if(!icon) return;
      sayIcons.push(icon.textContent);
      new MutationObserver(() => sayIcons.push(icon.textContent))
        .observe(icon, { childList: true, characterData: true, subtree: true });
    });
  });

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
  // זה נכון לכל מה שנפתר מול כתובת המניפסט. id נפתר מול ה-origin, ושם ./
  // ו-/ הם אותו שורש של האתר, לא /REPO/ (ראו BACKLOG.md).
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
  const absolute = [
    ...["id", "start_url", "scope"].filter(k => String(manifest[k]).startsWith("/")).map(k => `${k}=${manifest[k]}`),
    ...manifest.icons.filter(ic => ic.src.startsWith("/")).map(ic => ic.src)
  ];
  check("כל הנתיבים במניפסט יחסיים", absolute.length === 0, absolute);
  const missingIcons = manifest.icons.map(ic => ic.src).filter(src => !fs.existsSync(path.join(DIR, src)));
  check("כל האייקונים במניפסט קיימים", missingIcons.length === 0, missingIcons);

  await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  // --------------------------------------------------------------
  group("טעינה");
  // words.js נטען מכתובת עם ?v=. אם הוא חוזר כ-HTML, PAIRS ריק.
  check("מאגר המילים נטען", await page.evaluate(() => PAIRS.length) === 344);
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
  const fallback = await junkPage.evaluate(() => ({
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
  // מי שמחכה רק ל-load נשאר על "עוד רגע…" לנצח, בלי ההודעה שאומרת מה קרה.
  // כאן model.tar.gz אינו ארכיון, גם לדף וגם ל-worker; על שגיאת HTTP הדף
  // נכשל עוד ב-fetchModel ולא מגיע ל-worker. בדפדפן נפרד ובלי service
  // worker: הדף לא מחכה לו, וה-route רואה גם את הבקשה של ה-worker.
  const badModel = await browser.newContext();
  await badModel.addInitScript(() => { delete Navigator.prototype.serviceWorker; });
  await badModel.route("**/model.tar.gz", route =>
    route.fulfill({ status: 200, contentType: "application/gzip", body: Buffer.alloc(4096, 7) }));
  const badPage = await badModel.newPage();
  await badPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await badPage.waitForFunction(() => $("note").textContent !== "", null, { timeout: 15000 }).catch(() => {});
  const stuck = await badPage.evaluate(() => ({
    note: $("note").textContent, loading: !$("loading").hidden, model: model !== null,
    icon: $("sayIcon").textContent, disabled: $("say").disabled, label: $("say").getAttribute("aria-label")
  }));
  // ההודעה היא הסימן היחיד שמשהו נכשל, ו-⏭️ מנקה אותה. לכן 🎤 מראה ⚠️,
  // ונגיעה בו מחזירה אותה בלי לנסות להקשיב.
  await badPage.click("#next");
  const skipped = await badPage.evaluate(() => $("note").textContent);
  await badPage.click("#say", { timeout: 3000 }).catch(() => {});
  const tapped = await badPage.evaluate(() => ({
    note: $("note").textContent, active, listening: $("say").classList.contains("listening"), mic: micStream !== null
  }));
  await badModel.close();
  check("מודל שלא נטען — הודעה במקום המתנה בלי סוף",
    stuck.note !== "" && !stuck.loading && !stuck.model, stuck);
  check("מודל שלא נטען — 🎤 מראה ⚠️ ונגיעה בו מחזירה את ההודעה",
    stuck.icon === "⚠️" && !stuck.disabled && skipped === "" && tapped.note === stuck.note
      && !tapped.active && !tapped.listening && !tapped.mic, { stuck, skipped, tapped });
  check("מודל שלא נטען — קורא מסך שומע את ההודעה ולא \"הקלטת קול\"", stuck.label === stuck.note, stuck);

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
    await p.click("#openSettings");
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
  // להסתיר קול מקומי טוב יותר, ובלי קול עברי המשוב שותק ולא מוקרא במבטא זר.
  const voiceSelection = await page.evaluate(() => {
    const original = voices;
    try {
      const remote = {name: "Remote Natural", lang: "en-US", localService: false};
      const compact = {name: "Compact", lang: "en-US", localService: true};
      const enhanced = {name: "Enhanced", lang: "en-US", localService: true};
      const british = {name: "Premium", lang: "en-GB", localService: true};
      voices = [remote, compact, british, enhanced];
      const localQuality = voiceFor(EN) === enhanced;
      const missingHebrew = voiceFor(HE) === null;
      voices = [{name: "Hebrew", lang: "he_IL", localService: true}];
      const hebrew = voiceFor(HE) === voices[0];
      // אנדרואיד ישן מדווח עברית בקוד הישן של Java, iw ולא he.
      voices = [{name: "Hebrew", lang: "iw-IL", localService: true}];
      const legacyHebrew = voiceFor(HE) === voices[0];
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
      return {localQuality, missingHebrew, hebrew, legacyHebrew, notToy, onlyToy};
    } finally { voices = original; }
  });
  check("קול מקומי איכותי במבטא המבוקש מועדף", voiceSelection.localQuality, voiceSelection);
  check("אין קול עברי — לא נבחר קול משפה אחרת", voiceSelection.missingHebrew, voiceSelection);
  check("תג שפה עברי עם קו תחתון נתמך", voiceSelection.hebrew, voiceSelection);
  check("תג השפה הישן iw-IL נחשב עברית", voiceSelection.legacyHebrew, voiceSelection);
  check("קול צעצוע של אפל לא נבחר כשיש קול רגיל", voiceSelection.notToy, voiceSelection);
  check("כשיש רק קול צעצוע — הוא נבחר ולא שותקים", voiceSelection.onlyToy, voiceSelection);

  // מה ש-speak() עושה בלי קול עברי: לא מקריא כלום, ובכל זאת ממשיך הלאה,
  // אחרת הילד נתקע מול ה-🎉.
  const silentHebrew = await page.evaluate(async () => {
    const original = { voices, soundEnabled };
    const queued = [];
    try {
      voices = [{name: "English", lang: "en-US", localService: true}];
      soundEnabled = true;
      speechSynthesis.speak = u => queued.push(u.text);
      const continued = await new Promise(resolve => {
        speak("כל הכבוד!", HE, () => resolve(true));
        setTimeout(() => resolve(false), 2000);
      });
      return { queued, continued };
    } finally {
      delete speechSynthesis.speak;
      voices = original.voices;
      soundEnabled = original.soundEnabled;
    }
  });
  check("אין קול עברי — המשוב שותק וממשיך הלאה",
        silentHebrew.queued.length === 0 && silentHebrew.continued, silentHebrew);

  // --------------------------------------------------------------
  group("מנוע ההתאמה");
  // הניקוד הוא מספר אחד, וההחלטה היא השוואה אחת מולו. אלה התכונות
  // שחייבות להישמר גם אם הנוסחה תשתנה.

  // מילים רחוקות מהיעד. שכנה קרובה מהרשימה, כמו ship מול sheep, מתקבלת ברמה
  // הסלחנית בכוונה, ונבדקת בנפרד.
  const wrongAccepted = await page.evaluate(() => {
    const bad = [];
    for(const [target, spoken] of [["dog","cat"],["lion","house"],["sun","moon"],["apple","car"]])
      for(let th = 30; th <= 95; th += 5)
        for(const conf of [null, 0.5, 0.9, 1])
          if(scoreToken(spoken, conf, target) >= th) bad.push(`${spoken}/${target} th=${th}`);
    return bad;
  });
  check("מילה שגויה ורחוקה מהיעד לא מתקבלת באף אחוז", wrongAccepted.length === 0, wrongAccepted.slice(0, 5));

  // ההחלטה עצמה, דרך processRecognition, בכל אחוז בנפרד: ניקוד שמחושב פעם
  // אחת מחוץ ללולאה לא רואה נוסחה שתלויה באחוז.
  const nonMonotonic = await page.evaluate(() => {
    const saved = { words, i, active, matchThreshold, finish };
    const bad = [];
    try {
      for(const [target, spoken] of [["dog","dog"],["cat","kat"],["butterfly","butterf"],["banana","banan"]])
        for(const conf of [null, 0.4, 0.7, 1]){
          words = [{emoji: "", word: target}];
          i = 0;
          let prev = true;
          for(let th = 30; th <= 95; th += 5){
            let now;
            finish = ok => { now = ok; };
            matchThreshold = th;
            active = true;
            processRecognition({ result: { result: [{ word: spoken, conf }] } });
            if(now === undefined) bad.push(`${spoken}/${target} conf=${conf} th=${th}: אין החלטה`);
            else if(now && !prev) bad.push(`${spoken}/${target} conf=${conf} th=${th}`);
            prev = now;
          }
        }
    } finally {
      words = saved.words; i = saved.i; active = saved.active;
      matchThreshold = saved.matchThreshold; finish = saved.finish;
    }
    return bad;
  });
  check("העלאת האחוז רק מקשה", nonMonotonic.length === 0, nonMonotonic);

  // בדקדוק סגור המנוע מחזיר רק מילים מהרשימה. ship כשהיעד sheep היא מילה
  // אחרת, גם כשהניקוד הפונטי שלה גבוה. הגבול בין הרמות הוא זה שעל הכפתורים.
  // ושכנה שקודמת ליעד באותה תוצאה מדלגים עליה, ולא עוצרים בה.
  const listNeighbour = await page.evaluate(() => {
    const saved = { words, i, active, matchThreshold, finish };
    const decide = (list, target, spoken, th) => {
      words = list.map(w => ({emoji: "", word: w}));
      i = list.indexOf(target);
      let now;
      finish = ok => { now = ok; };
      matchThreshold = th;
      active = true;
      processRecognition({ result: { result: [].concat(spoken).map(word => ({ word, conf: 1 })) } });
      return now;
    };
    try {
      const farm = ["sheep", "ship", "dog"], edge = PRESETS[0].upTo;
      return {
        rejected: {
          shipEdge: decide(farm, "sheep", "ship", edge + 1),
          ship70:   decide(farm, "sheep", "ship", 70),
          ball:     decide(["ball", "balloon"], "balloon", "ball", 70),
          grandma:  decide(["grandpa", "grandma"], "grandpa", "grandma", 70),
          grandpa:  decide(["grandpa", "grandma"], "grandma", "grandpa", 70)
        },
        target: [45, 70, 90].map(th => decide(farm, "sheep", "sheep", th)),
        afterNeighbour: decide(farm, "sheep", ["ship", "sheep"], 70),
        lenient: [45, edge].map(th => decide(farm, "sheep", "ship", th))
      };
    } finally {
      words = saved.words; i = saved.i; active = saved.active;
      matchThreshold = saved.matchThreshold; finish = saved.finish;
    }
  });
  check("מילה אחרת מהרשימה לא מתקבלת מעל הרמה הסלחנית",
        Object.values(listNeighbour.rejected).every(ok => ok === false), listNeighbour);
  check("מילת היעד מתקבלת בכל רמה כששכנותיה ברשימה",
        listNeighbour.target.every(ok => ok === true), listNeighbour);
  check("מילת היעד מתקבלת גם אחרי שכנה מהרשימה באותה תוצאה",
        listNeighbour.afterNeighbour === true, listNeighbour);
  check("ברמה הסלחנית שכנה קרובה מהרשימה מתקבלת",
        listNeighbour.lenient.every(ok => ok === true), listNeighbour);

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
  // האחוז הוא המצב היחיד. שלושת הכפתורים רק קובעים אותו.
  await page.click("#openSettings");
  await page.waitForTimeout(150);
  for(const [id, want] of [["btnLevelLenient",45], ["btnLevelNormal",70], ["btnLevelStrict",90]]){
    await page.click("#" + id);
    check(`הכפתור ${id} קובע ${want}%`, await page.evaluate(() => matchThreshold) === want);
  }
  const windows = await page.evaluate(() => {
    const before = matchThreshold, out = [];
    for(const th of [30, 50, 70, 90, 95]){ matchThreshold = th; out.push(listenWindowMs()); }
    matchThreshold = before;
    return out;
  });
  check("חלון ההקשבה מתקצר ככל שהאחוז עולה",
        windows.every((v, n) => n === 0 || v < windows[n - 1]), windows);

  check("הכפתור נשמר", JSON.parse(await page.evaluate(() => localStorage.getItem("speech_match_config"))).threshold === 90);

  // אחוז שאינו של אחד הכפתורים יכול לשבת שמור במכשיר. הוא נטען כמו שהוא,
  // לא מועבר לכפתור הקרוב, ומסומן על הכפתור שבתחומו.
  await page.evaluate(() => localStorage.setItem("speech_match_config", JSON.stringify({threshold:55})));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  check("אחוז שמור שאינו של כפתור נטען כמו שהוא", await page.evaluate(() => matchThreshold) === 55);
  check("ומסומן על הכפתור שבתחומו",
        (await page.textContent("#matchLevelBadge")).includes("55%") &&
        await page.evaluate(() => $("btnLevelNormal").classList.contains("active")));

  // הגדרה שנשמרה בפורמט הישן, עם level, חייבת להמשיך לעבוד.
  await page.evaluate(() => localStorage.setItem("speech_match_config", JSON.stringify({level:"strict", threshold:90})));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  check("הגדרה מהפורמט הישן נטענת", await page.evaluate(() => matchThreshold) === 90);

  // --------------------------------------------------------------
  group("מאגר המילים");
  // הקטלוג נבנה פעם אחת והסינון רק מסתיר. הבדיקה מודדת מה באמת מוצג
  // ולא את התכונה hidden — כי display של הכפתור יכול לגבור עליה.
  await page.click("#openSettings");
  await page.click("#openWordsViewBtn");
  await page.click("#openCatalogBtn");
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    window.visibleCatalogItems = () =>
      [...document.querySelectorAll("#catalog .catalog-item")]
        .filter(b => getComputedStyle(b).display !== "none").length;
  });
  const built = await page.evaluate(() => document.querySelectorAll("#catalog .catalog-item").length);
  check("כל המאגר נבנה", built === 344, built);

  // בנייה מחדש מלאה נותנת את אותו מספר פריטים, אז נבדק שהצומת עצמו נשאר.
  const firstItem = await page.$("#catalog .catalog-item");
  await page.fill("#search", "lion");
  await page.waitForTimeout(150);
  check("סינון מסתיר בפועל", await page.evaluate(() => visibleCatalogItems()) === 1);
  check("הצמתים לא נבנים מחדש",
        await page.evaluate(() => document.querySelectorAll("#catalog .catalog-item").length) === built &&
        await firstItem.evaluate(b => b.isConnected));

  await page.fill("#search", "zzzz");
  await page.waitForTimeout(150);
  check("אין תוצאות — מוצגת הודעה",
        await page.evaluate(() => visibleCatalogItems() === 0 && !$("catalogEmpty").hidden));

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

  // --------------------------------------------------------------
  group("ערכות");
  // מורה בוחרת נושא ורמה, ומחליפה או מוסיפה בלחיצה אחת את כל מה שמוצג.
  // הכפתורים פועלים על מה שהמאגר מציג, אז גם כאן נמדד מה באמת על המסך.
  const unsorted = await page.evaluate(() =>
    PAIRS.filter(p => ![1, 2, 3].includes(p[3]) || !THEME_BY_WORD[p[1]]).map(p => p[1]));
  check("לכל מילה במאגר יש נושא ורמה", unsorted.length === 0, unsorted);

  const listBeforeSets = await page.evaluate(() => words.slice());
  const shownSet = () => page.evaluate(() =>
    [...document.querySelectorAll("#catalog .catalog-item")]
      .filter(b => getComputedStyle(b).display !== "none").map(b => b.dataset.word).sort().join());
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
  check("תרגלו רק אותן מחליף את הרשימה ושומר",
        await practiced() === easyFruit && replaced.saved === easyFruit &&
        easyFruit.split(",").includes(replaced.current), replaced);

  await page.click('#levelChips [data-level=""]');
  await page.click("#addSetBtn");
  await page.waitForTimeout(150);
  check("הוספה מצרפת רק את החסרות", await practiced() === await fruit(), await practiced());
  check("כשהכל בתרגול אין מה להוסיף", await page.evaluate(() => $("addSetBtn").disabled));

  // מכרטיס הערכות באים לבחור נושא: בלי מקלדת שמכסה אותו, ובלי הסינון הקודם.
  await page.click("#closePanelFromCatalog");
  await page.click("#openSettings");
  await page.click("#openThemesBtn");
  await page.waitForTimeout(150);
  const entry = await page.evaluate(() => ({
    catalog: !$("viewCatalog").hidden,
    focused: document.activeElement === $("search"),
    all: visibleCatalogItems() === PAIRS.length
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

  // לשורה אחרת מזו שעל המסך, אחרת גם קפיצה שלא קרתה נראית נכונה.
  const jumpFrom = await page.evaluate(() => i);
  await page.click("#wordList li:first-child .jump");
  await page.waitForTimeout(200);
  const jumped = await page.evaluate(() => ({ closed: $("overlay").hidden, now: word(), shown: $("word").textContent }));
  check("לחיצה על מילה קופצת אליה וסוגרת",
        jumpFrom !== 0 && jumped.closed && jumped.now === afterDelete.rows[0] && jumped.shown === jumped.now, { jumpFrom, jumped });

  // האפליקציה המותקנת ולשונית בדפדפן, או שתי לשוניות, חולקות את localStorage.
  // כל אחת קוראת את הרשימה רק בעלייה ושומרת את כולה, ובלי האזנה לשינוי הבאה
  // ששומרת מוחקת את מה שהשנייה הוסיפה. הדף השני הוא manifest.json, בלי
  // האפליקציה עצמה. השדות שם בסדר הפוך מזה של save(), כדי ששמירה בחזרה תיראה.
  const beforeSync = await page.evaluate(() => {
    openPanel();
    showSettingsView("words");
    const taken = takenSet();
    return { list: words.slice(), at: i, current: words[i],
             outside: PAIRS.filter(p => !taken.has(p[1])).slice(0, 3).map(([emoji, word]) => ({ emoji, word })) };
  });
  const otherTab = await ctx.newPage();
  await otherTab.goto(base + "/manifest.json");
  const syncTo = async list => {
    const raw = JSON.stringify(list.map(w => ({ word: w.word, emoji: w.emoji })));
    const want = list.map(w => w.word).join();
    await otherTab.evaluate(raw => localStorage.setItem("words", raw), raw);
    await page.waitForFunction(want => words.map(w => w.word).join() === want, want, { timeout: 5000 }).catch(() => {});
    return page.evaluate(([raw, want]) => ({
      want, words: words.map(w => w.word).join(), shown: $("word").textContent,
      rows: [...document.querySelectorAll("#wordList li .w")].map(s => s.textContent).join(),
      notWrittenBack: localStorage.getItem("words") === raw
    }), [raw, want]);
  };
  const keptWord = await syncTo([...beforeSync.outside, beforeSync.current]);
  const lostWord = await syncTo(beforeSync.outside);
  await otherTab.close();
  await page.evaluate(({ list, at }) => { applyWords(list, at); closePanel(); }, beforeSync);
  check("רשימה שנשמרה בחלון אחר מוצגת, והמילה שעל המסך נשארת",
    keptWord.words === keptWord.want && keptWord.rows === keptWord.want && keptWord.shown === beforeSync.current.word,
    keptWord);
  check("מילה שנמחקה בחלון אחר מתחלפת במילה מהרשימה החדשה",
    lostWord.words === lostWord.want && lostWord.rows === lostWord.want && lostWord.want.split(",").includes(lostWord.shown),
    lostWord);
  check("רשימה מחלון אחר לא נשמרת בחזרה", keptWord.notWrittenBack && lostWord.notWrittenBack, { keptWord, lostWord });

  // --------------------------------------------------------------
  group("כוכבים ומדליות");
  // שורת התגמול לא גדלה בלי גבול ולא קופאת: שלוש הצלחות מתחלפות במדליה,
  // וחמישה מכל סמל אחר בסמל שמעליו — גביע, כתר, יהלום.
  const row = async n => await page.evaluate(count => {
    scores[mode] = 0;
    for(let k = 0; k < count; k++) good();
    return $("stars").textContent;
  }, n);
  check("כל הצלחה מוסיפה כוכב", await row(1) === "⭐" && await row(2) === "⭐⭐");
  check("שלושה כוכבים מתחלפים במדליה", await row(3) === "🏅" && await row(4) === "🏅⭐");
  check("חמש מדליות מתחלפות בגביע", await row(15) === "🏆" && await row(16) === "🏆⭐");
  check("ארבע מדליות ושני כוכבים לפני הגביע", await row(14) === "🏅🏅🏅🏅⭐⭐");
  const crown = [await row(75), await row(76)];
  check("חמישה גביעים מתחלפים בכתר", crown[0] === "👑" && crown[1] === "👑⭐", crown);
  const diamond = await row(375);
  check("חמישה כתרים מתחלפים ביהלום", diamond === "💎", diamond);
  const beforeDiamond = await row(374);
  check("ארבעה מכל סמל ושני כוכבים לפני היהלום", beforeDiamond === "👑👑👑👑🏆🏆🏆🏆🏅🏅🏅🏅⭐⭐", beforeDiamond);
  // כל good() מזמן גם מעבר למילה הבאה, ו-show() מנקה את שורת ההודעה.
  // בלי ההמתנה הזאת המעברים של הבדיקה הזאת מוחקים את ההודעה שהבדיקה
  // הבאה מציגה, והיא נופלת בלי קשר למה שהיא באמת בודקת.
  await page.waitForTimeout(1200);

  // הכפתורים שבצדי הסרגל מונחים מעליו, ושורה שנכנסת מתחתם מסתירה דווקא
  // את הכוכב שהילד הרגע הרוויח. בודקים כל סמל בנפרד, ברוחב של טלפון צר:
  // המלבן של השורה כולה רחב מהסמלים שבה, והשאלה היא איפה הם.
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 640 });
  for(const n of [14, 374]){
    const layout = await page.evaluate(n => {
      scores[mode] = n;
      renderScore();
      const box = r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      const buttons = ["openSettings", "openFeedback", "toggleSound"].map(id => box($(id).getBoundingClientRect()));
      const text = $("stars").firstChild;
      const glyphs = [...new Intl.Segmenter().segment(text.data)].map(({ index, segment }) => {
        const range = document.createRange();
        range.setStart(text, index);
        range.setEnd(text, index + segment.length);
        return box(range.getBoundingClientRect());
      });
      const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const bad = glyphs.filter(g => g.left < 0 || g.top < 0 || g.right > innerWidth || g.bottom > innerHeight
                                     || buttons.some(b => hits(g, b)));
      return { glyphs: glyphs.length, bad, buttons };
    }, n);
    check(`בטלפון צר כל סמל בשורה על המסך ולא מתחת לכפתורים (${n})`,
          layout.glyphs > 0 && layout.bad.length === 0, layout);
  }
  // והמרווח ליד ⚙️💬 רחב מזה שליד 🔇, אבל שורה קצרה לא זזה בגללו הצידה:
  // היא ממורכזת כמו המתג שמתחתיה, כמו שההערה ב-#topBar מבטיחה.
  const centred = await page.evaluate(() => {
    scores[mode] = 2;
    renderScore();
    const range = document.createRange();
    range.selectNodeContents($("stars"));
    const r = range.getBoundingClientRect(), m = $("modeSwitch").getBoundingClientRect();
    return { row: $("stars").textContent, at: (r.left + r.right) / 2, modeSwitch: (m.left + m.right) / 2 };
  });
  check("בטלפון צר שורה קצרה ממורכזת מעל המתג",
        centred.row === "⭐⭐" && Math.abs(centred.at - centred.modeSwitch) <= 1, centred);
  await page.setViewportSize(viewport);

  // אחרי ה-🎉 עוברים למילה הבאה, אבל ילד שלחץ ⏭️ או מורה שקפצה למילה
  // מהרשימה בזמן ה-🎉 כבר בחרו מילה, והמעבר המאוחר לא מחליף אותה. ההמתנה
  // היא טיימר בדף שמתחיל אחרי good(), ולכן נגמרת אחרי המעבר שהוא מזמן גם
  // כשהמכונה עמוסה; השמע כבוי כאן, אז המעבר מגיע אחרי כשנייה.
  const afterGood = async skip => await page.evaluate(async skip => {
    const before = i;
    good();
    if(skip === "next") next();
    if(skip === "jump"){
      renderList();
      $("wordList").querySelector(`li[data-index="${(i + 1) % words.length}"] .jump`).click();
    }
    const chosen = i;
    await new Promise(r => setTimeout(r, 1500));
    return { before, chosen, now: i, words: words.length };
  }, skip);
  const advanced = await afterGood(false);
  check("אחרי הצלחה עוברים למילה הבאה", advanced.words > 1 && advanced.now !== advanced.before, advanced);
  for(const skip of ["next", "jump"]){
    const skipped = await afterGood(skip);
    check(`מילה שנבחרה בזמן ה-🎉 לא מוחלפת אחריו (${skip})`,
      skipped.words > 1 && skipped.chosen !== skipped.before && skipped.now === skipped.chosen, skipped);
  }
  await page.evaluate(() => { scores = { say: 0, spell: 0 }; renderScore(); });

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
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const reloadedHe = await page.evaluate(() => ({ text: $("wordHe").innerText, toggle: $("hebrewToggle").checked }));
  check("נשאר כבוי אחרי טעינה מחדש", reloadedHe.text === "" && !reloadedHe.toggle, reloadedHe);
  await page.evaluate(() => $("hebrewToggle").click());
  he = await heLine();
  check("הדלקה מחזירה אותו", he.text === he.he && !!he.he, he);

  // --------------------------------------------------------------
  group("כתיבה");
  // הילד בונה את המילה מבנק של האותיות שלה. מילה שלמה שווה כוכב אחד, עם
  // רמז או בלי, וטעות לא עולה כלום. ההחלפה בין 🎤 ל-💡 נמדדת במה שמוצג
  // בפועל, כי display של כפתורי השורה גובר על התכונה hidden.
  const shown = id => page.evaluate(id => getComputedStyle($(id)).display !== "none", id);
  await page.evaluate(() => { scores = { say: 0, spell: 0 }; renderScore(); });
  await page.click('#modeSwitch [data-mode="spell"]');
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
    const before = scores.spell;
    const tile = [...$("bank").children].find(t => t.dataset.letter !== word()[0]);
    tile.click();
    const slot = $("slots").children[0];
    return { letter: tile.dataset.letter, slot: slot.textContent, stars: scores.spell - before, inBank: !tile.disabled };
  });
  check("אות לא נכונה נכנסת למשבצת ולא עולה כוכב",
    wrongTap.slot === wrongTap.letter && wrongTap.stars === 0 && !wrongTap.inBank, wrongTap);
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
    const before = scores.spell;
    for(const ch of order)
      [...$("bank").children].find(t => !t.disabled && t.dataset.letter === ch).click();
    const slots = slotList();
    return {
      target, order, stars: scores.spell - before, again: $("picture").className,
      right: slots.map((s, k) => s.classList.contains("right") === (order[k] === target[k])),
      red: slots.map((s, k) => s.classList.contains("wrong") === (order[k] !== target[k]))
    };
  });
  check("מילה מלאה ושגויה — נסו שוב, בלי כוכבים",
    filled.stars === 0 && filled.again === "again", filled);
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
    const before = scores.spell;
    completeWord();
    return { stars: scores.spell - before, card: $("picture").textContent };
  });
  check("טעות בדרך לא מורידה כוכב", fixed.stars === 1 && fixed.card === "🎉", fixed);
  await newBoard();

  // good() עובר למילה הבאה אחרי המשוב, ושם הלוח מתחיל מחדש.
  const spellAll = async withHint => {
    await newBoard();
    return page.evaluate(withHint => {
      const before = scores.spell;
      if(withHint) $("hint").click();
      completeWord();
      return { stars: scores.spell - before, card: $("picture").textContent, row: $("stars").textContent,
               hinted: $("slots").querySelectorAll(".hinted").length, hintOff: $("hint").disabled };
    }, withHint);
  };
  await page.evaluate(() => { scores = { say: 0, spell: 0 }; renderScore(); });
  const clean = await spellAll(false);
  check("מילה שנכתבה — כוכב אחד, כמו באמירה",
    clean.stars === 1 && clean.card === "🎉" && clean.row === "⭐", clean);
  const helped = await spellAll(true);
  check("רמז ממלא אות אחת ולא מוריד כוכב",
    helped.stars === 1 && helped.hinted === 1 && helped.card === "🎉", helped);
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

  // לכל תרגול שורה משלו: כוכב של מילה כתובה לא נכנס לשורה של האמירה.
  // רגע לפני הטעינה מחדש, שמבטלת את המעברים ש-good() מזמן.
  const apart = await page.evaluate(() => {
    scores = { say: 0, spell: 0 };
    setMode("say"); good();
    setMode("spell"); good(); good();
    const spellRow = $("stars").textContent;
    setMode("say");
    const sayRow = $("stars").textContent;
    setMode("spell");
    return { sayRow, spellRow, back: $("stars").textContent };
  });
  check("לאמירה ולכתיבה ניקוד נפרד",
    apart.sayRow === "⭐" && apart.spellRow === "⭐⭐" && apart.back === "⭐⭐", apart);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  check("מצב הכתיבה נשמר בין טעינות",
    await page.evaluate(() => mode) === "spell" && !(await shown("say")) && await shown("spell"));
  await page.click('#modeSwitch [data-mode="say"]');
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

  // התמונה היא פקד להשמעת המילה, אז צריך להגיע אליה במקלדת ושיהיה לה שם.
  const pic = await page.evaluate(() => {
    const el = $("picture");
    el.focus();
    return { tag: el.tagName, focused: document.activeElement === el, label: el.getAttribute("aria-label") };
  });
  check("אפשר להגיע לתמונה במקלדת", pic.focused, pic);
  check("לתמונה יש שם נגיש", !!pic.label, pic);

  // ההגדרות מכסות את המסך, ובמקלדת גם הפוקוס צריך להישאר בהן. אחרת Tab עובר
  // על הכפתורים שמאחוריהן, ו-Enter או רווח מפעילים אותם בלי שרואים: Shift+Tab
  // מה-× מגיע ל-⏭️, ורווח מחליף את המילה מתחת לחלונית. BODY הוא היציאה מהדף
  // אל הדפדפן, בדרך חזרה לתחילת החלונית, ולא נחשב יציאה ממנה.
  await page.focus("#openSettings");
  await page.keyboard.press("Enter");
  const opened = await page.evaluate(() => {
    window.behindClicks = [];
    window.recordBehind = e => { if(!e.target.closest("#overlay")) behindClicks.push(e.target.id || e.target.tagName); };
    document.addEventListener("click", recordBehind, true);
    return { open: !$("overlay").hidden, inPanel: $("panel").contains(document.activeElement),
             focus: document.activeElement.id || document.activeElement.tagName, word: word() };
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
    const out = { hidden: $("overlay").hidden, focus: document.activeElement.id, behind: behindClicks,
                  word: word(), active };
    // שהקבוצות הבאות לא יתחילו מתחת לחלונית פתוחה גם כשהבדיקה נופלת.
    if(!$("overlay").hidden) closePanel();
    return out;
  });
  check("⚙️ במקלדת פותח את ההגדרות והפוקוס עובר אליהן", opened.open && opened.inPanel, opened);
  check("Tab ו-Shift+Tab לא מגיעים למה שמאחורי ההגדרות",
    visited.length > 0 && !visited.some(v => v.endsWith(" ✗")), visited);
  check("Esc סוגר את ההגדרות ומחזיר את הפוקוס ל-⚙️, ושום דבר מאחוריהן לא הופעל",
    closed.hidden && closed.focus === "openSettings" && closed.behind.length === 0
      && closed.word === opened.word && !closed.active, { opened, closed });
  // וכשהן סגורות Esc לא עושה כלום. אחרת הוא מקפיץ את הפוקוס ל-⚙️ מכל מקום בדף.
  await page.focus("#next");
  await page.keyboard.press("Escape");
  const escIdle = await page.evaluate(() => ({ hidden: $("overlay").hidden, focus: document.activeElement.id }));
  check("Esc כשההגדרות סגורות לא מזיז את הפוקוס", escIdle.hidden && escIdle.focus === "next", escIdle);

  // --------------------------------------------------------------
  group("קישורי המשוב");
  // הכתובת היא קבוע אחד לשני הקישורים. אם היא תיכתב שוב ב-HTML, החלפת
  // טופס תשאיר קישור אחד על הטופס הישן בלי שאף אחד ישים לב.
  const feedbackHrefs = await page.evaluate(
    () => [...document.querySelectorAll("a[data-feedback]")].map(a => a.href));
  check("שני קישורי משוב על הדף", feedbackHrefs.length === 2, feedbackHrefs);
  check("שניהם מצביעים על אותו טופס",
    feedbackHrefs.length === 2 && feedbackHrefs[0] === feedbackHrefs[1], feedbackHrefs);
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
  // ⚠️ שמור למנוע שלא נטען. בטעינה רגילה הוא לא מופיע, גם לא לרגע.
  const loadedIcon = await page.evaluate(() => ({ now: $("sayIcon").textContent, seen: sayIcons }));
  check("המנוע נטען — 🎤 על הכפתור, ו-⚠️ לא הופיע בדרך",
    loadedIcon.now === "🎤" && !loadedIcon.seen.includes("⚠️"), loadedIcon);
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
                    icon: $("sayIcon").textContent };
      stopListening();
      hide(true);
      out.liveAfterHide = live();
      return out;
    } finally {
      navigator.mediaDevices.getUserMedia = real;
      hide(false);
      setMode("say");
    }
  }, { taps, during });
  // סירוב שהשאיר את הדגל דולק היה נועל את 🎤 עד טעינה מחדש. והמנוע עצמו
  // נטען, אז אין ⚠️: ההודעה מסבירה, ונגיעה נוספת מבקשת שוב.
  const denied = await whileOpening({ during: "deny" });
  check("סירוב למיקרופון לא נועל את הכפתור ולא מראה ⚠️",
    denied.opens === 1 && !denied.active && !denied.opening && denied.icon === "🎤", denied);
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
    const writeList = async (raw, list) => {
      await recTab.evaluate(raw => localStorage.setItem("words", raw), raw);
      await page.waitForFunction(want => words.map(w => w.word).join() === want,
        list.map(w => w.word).join(), { timeout: 5000 }).catch(() => {});
    };
    const longer = recBefore.list.concat([recBefore.added]);
    await writeList(JSON.stringify(longer), longer);
    recSync = await page.evaluate(added => ({
      fresh: !!rec && rec !== recBeforeSync, inGrammar: JSON.parse(grammar()).includes(added),
      sent: recCreated.filter(m => rec && m.recognizerId === rec.id).map(m => JSON.parse(m.grammar).includes(added))
    }), recBefore.added.word);
    await writeList(recBefore.raw, recBefore.list);
  } finally {
    await recTab.close();
    await page.evaluate(() => { delete model.postMessage; delete window.recBeforeSync; delete window.recCreated; });
  }
  check("רשימה שנשמרה בחלון אחר נכנסת גם לדקדוק של המנוע",
    recBefore.had && recSync.fresh && recSync.inGrammar && recSync.sent.length === 1 && recSync.sent[0],
    { had: recBefore.had, added: recBefore.added.word, ...recSync });

  // --------------------------------------------------------------
  group("החלטה");
  // רק תוצאה סופית מחליטה. תוצאה חלקית היא ניחוש באמצע הדיבור, ומול המודל
  // האמיתי "elephant" עובר דרך apple ונגמר כ-[unk], ורעש ורוד נשמע כ-house.
  // האירועים נשלחים ל-recognizer עצמו, כך שגם החיווט ב-buildRecognizer
  // נבדק ולא רק הפונקציה.
  await page.waitForFunction(() => model !== null, null, { timeout: 60000 });
  await page.evaluate(() => { setThreshold(DEFAULT_THRESHOLD); return ensureAudio(); });
  const attempt = async events => await page.evaluate(async evs => {
    await listen();
    const target = word(), before = scores.say;
    for(const [type, detail] of evs)
      rec.dispatchEvent(new CustomEvent(type, { detail: JSON.parse(JSON.stringify(detail).replaceAll("TARGET", target)) }));
    const out = { active, won: scores.say > before };
    if(active) finish(false);
    return out;
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
    const realWindow = listenWindowMs, realRetrieve = rec.retrieveFinalResult;
    listenWindowMs = () => 100;
    rec.retrieveFinalResult = function(){
      if(answer) setTimeout(() => this.dispatchEvent(new CustomEvent("result",
        { detail: { result: { result: [{ word: answer === "TARGET" ? word() : answer, conf: 1 }] } } })), 50);
    };
    try{
      const before = scores.say;
      await listen();
      await new Promise(r => setTimeout(r, 1500));
      return { active, won: scores.say > before };
    } finally {
      listenWindowMs = realWindow;
      rec.retrieveFinalResult = realRetrieve;
      if(active) finish(false);
    }
  }, answer);
  const lateRight = await atWindowEnd("TARGET");
  check("מילה נכונה בסוף החלון מזכה", lateRight.won && !lateRight.active, lateRight);
  const lateNothing = await atWindowEnd(null);
  check("בלי תשובה מהמנוע החלון נסגר בכישלון", !lateNothing.won && !lateNothing.active, lateNothing);

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
  // ההמתנה בדף היא שרשרת של אותם שני טיימרים שסוגרים את החלון, כך שהיא
  // נגמרת אחריהם גם כשהמכונה עמוסה. כל מה שהתמונה הייתה נאסף, כי "נסו שוב"
  // נשאר עליה רק לרגע. גם הקריאות ל-again() ול-good() נספרות: עצירה שאומרת
  // "נסו שוב" לפני ש-show() מנקה את התמונה לא משאירה עליה סימן.
  const skipWhileListening = how => page.evaluate(async how => {
    const real = { listenWindowMs, again, good, words }, pic = $("picture"), seen = [], calls = [];
    listenWindowMs = () => 200;
    again = why => { calls.push("again"); return real.again(why); };
    good = () => { calls.push("good"); return real.good(); };
    try{
      await listen();
      const was = active, from = word();
      if(how === "jump"){
        renderList();
        $("wordList").querySelector(`li[data-index="${(i + 1) % words.length}"] .jump`).click();
      } else if(how === "list"){
        // רשימה חדשה, כמו "תרגלו רק אותן", ועל המסך המילה שאחרי זו שהייתה.
        applyWords(words.slice().reverse(), words.length - 1 - (i + 1) % words.length);
      } else next();
      const out = { was, from, to: word(), active, listening: $("say").classList.contains("listening") };
      const obs = new MutationObserver(ms => { for(const m of ms) seen.push(m.oldValue); });
      obs.observe(pic, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
      if(how === "late") rec.dispatchEvent(new CustomEvent("result",
        { detail: { result: { result: [{ word: from, conf: 1 }], text: from } } }));
      await new Promise(r => setTimeout(r, listenWindowMs()));
      await new Promise(r => setTimeout(r, FINAL_GRACE_MS + 200));
      for(const m of obs.takeRecords()) seen.push(m.oldValue);
      obs.disconnect();
      return { ...out, calls, seen: seen.concat(pic.className) };
    } finally {
      listenWindowMs = real.listenWindowMs;
      again = real.again;
      good = real.good;
      if(active) finish(false);
      // הסדר המקורי חוזר, כדי שהקבוצות הבאות יראו את אותה רשימה.
      if(words !== real.words) applyWords(real.words, real.words.indexOf(words[i]));
    }
  }, how);
  const skips = {
    next: "⏭️ באמצע הקשבה עוצר אותה בלי \"נסו שוב\"",
    jump: "קפיצה מהרשימה באמצע הקשבה עוצרת אותה בלי \"נסו שוב\"",
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
  await page.evaluate(() => { scores = { say: 0, spell: 0 }; renderScore(); });

  // --------------------------------------------------------------
  group("כפתור ההקשבה");
  // ילדים מחזיקים את הכפתור בזמן שהם מדברים, ונוגעים בו שוב כדי "לסיים". לכן
  // לחוץ ומקשיב הם אותו מצב, ואדום נשאר אדום תחת האצבע. הצבע נקרא אחרי
  // שהמעבר של ה-CSS נגמר, אחרת יוצא גוון באמצע הדרך.
  const sayState = () => page.evaluate(() => ({ active, bg: getComputedStyle($("say")).backgroundColor }));
  const press = async () => { await page.mouse.down(); await page.waitForTimeout(300); return sayState(); };
  const lift = async () => { await page.mouse.up(); await page.waitForTimeout(300); return sayState(); };
  // מה שהמיקרופון המזויף משמיע לא יסיים את ההקשבה באמצע הבדיקה.
  await page.evaluate(() => { window.realProcess = processRecognition; processRecognition = () => {}; });
  try{
    await page.evaluate(() => ensureAudio());
    const idle = await sayState();
    await page.locator("#say").hover();
    const held = await press();
    check("נגיעה בכפתור כבר מקשיבה", held.active, held);
    const listening = await lift();
    const pressedRed = await press();
    check("כפתור מקשיב נשאר אדום תחת האצבע",
      pressedRed.active && pressedRed.bg === listening.bg && listening.bg !== idle.bg, { idle, listening, pressedRed });
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
    const wonHeld = await page.evaluate(() => ({ active, card: $("picture").textContent }));
    await page.waitForFunction(n => shownCount > n, shownBefore, { timeout: 5000 }).catch(() => {});
    await lift();
    const afterLift = await page.evaluate(() => ({ active, listening: $("say").classList.contains("listening"), moved: shownCount }));
    check("ניסיון שנגמר כשהאצבע על הכפתור לא מתחיל אחר בהרמתה",
      heldWin.active && !wonHeld.active && wonHeld.card === "🎉" && afterLift.moved > shownBefore
        && !afterLift.active && !afterLift.listening, { heldWin, wonHeld, afterLift });
    await page.evaluate(() => stopListening());

    // במקלדת אין נגיעה לפני ה-click, ולכן Enter ו-Space תמיד מתחילים להקשיב.
    // גם אחרי לחיצה שהתחילה להקשיב והאצבע הורמה מחוץ לכפתור, כך שלא הגיע
    // click שסוגר אותה.
    await press();
    const off = await page.locator("#word").boundingBox();
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
  group("הודעה נעלמת");
  await page.click("#toggleSound");
  await page.waitForTimeout(150);
  const noteShown = (await page.textContent("#note")).length > 0;
  await page.waitForTimeout(2300);
  check("הודעה מוצגת ואז נעלמת", noteShown && (await page.textContent("#note")) === "");

  // השמע נשמר בין פתיחות, כמו המילים ורמת ההתאמה
  const soundOn = await page.evaluate(() => soundEnabled);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  check("מצב השמע נשמר בין טעינות", await page.evaluate(() => soundEnabled) === soundOn, { soundOn });

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
  // המודל נכתב למטמון בזרימה, בלי לצבור 29MB בזיכרון. אם הזרימה נקטעת
  // הקובץ נשמר חסר, והמנוע נופל רק בפתיחה הבאה.
  const modelBytes = await page.evaluate(async () => {
    const c = await caches.open(CACHE_NAME);
    const hit = await c.match(new URL("model.tar.gz", location.href).href);
    return hit ? (await hit.blob()).size : 0;
  });
  const realBytes = fs.statSync(path.join(DIR, "model.tar.gz")).size;
  check("המודל נשמר במטמון במלואו", modelBytes === realBytes, { modelBytes, realBytes });

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
  const missingLine = page.waitForEvent("console", {
    predicate: m => m.type() === "error" && m.location().url === heavyMissing,
    timeout: 2000
  }).catch(() => null);
  const notStored = await page.evaluate(async url => {
    const status = (await fetch(url)).status;
    await new Promise(r => setTimeout(r, 500));   // ה-service worker שומר בלי לחכות
    return { status, stored: !!(await caches.match(url)) };
  }, heavyMissing);
  const missingErr = await missingLine;
  if(missingErr){
    const n = errors.lastIndexOf("console: " + missingErr.text());
    if(n >= 0) errors.splice(n, 1);
  }
  check("קובץ כבד שחזר עם שגיאה לא נשמר במטמון", notStored.status === 404 && !notStored.stored, notStored);

  // ומכשיר שכבר שמר תשובה כזו מתרפא בביקור הבא עם רשת. הרשומה האמיתית של
  // vosk.js מוחלפת ב-503 ומוחזרת למקומה בסוף.
  const healed = await page.evaluate(async () => {
    const url = new URL("vosk.js", location.href).href;
    const c = await caches.open(CACHE_NAME);
    const real = await c.match(url);
    await c.put(url, new Response("x", { status: 503 }));
    const r = await fetch(url);
    const bytes = (await r.blob()).size;
    let stored;
    for(let n = 0; n < 20 && !(stored = await c.match(url))?.ok; n++) await new Promise(r => setTimeout(r, 100));
    const result = { status: r.status, bytes, storedOk: !!stored?.ok };
    if(real) await c.put(url, real);
    return result;
  });
  const voskBytes = fs.statSync(path.join(DIR, "vosk.js")).size;
  check("קובץ כבד שנשמר עם שגיאה מוחלף בעותק תקין",
        healed.status === 200 && healed.bytes === voskBytes && healed.storedOk, { ...healed, voskBytes });

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
  const failLine = page.waitForEvent("console", {
    predicate: m => m.type() === "error" && m.text().includes("net::ERR_FAILED") &&
                    m.location().url.endsWith("/not-in-cache.js"),
    timeout: 2000
  }).catch(() => null);
  const missing = await fetchOffline("./not-in-cache.js");
  const expectedLine = await failLine;
  if(expectedLine){
    const n = errors.lastIndexOf("console: " + expectedLine.text());
    if(n >= 0) errors.splice(n, 1);
  }
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
  const queryPage = await ctx.newPage();
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
  check("ניווט עם ?q= בלי רשת עולה מהרשומה של ./", queryNav.pairs > 0, queryNav);

  // --------------------------------------------------------------
  group("שגיאות");
  check("אין שגיאות בקונסולה", errors.length === 0, errors);

  await browser.close();

  // --------------------------------------------------------------
  group("server.js");
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
