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
  // סבב שנגמר מציג מסך סיום ומסתיר את 🎤. רוב הקבוצות קוראות ל-next() שוב
  // ושוב בלי קשר לסבבים, ולכן בהן הילד לוחץ ▶ מיד, בכל טעינה של הדף.
  // קבוצת הסבב מחזירה את מסך הסיום האמיתי, realShowRoundEnd, בזמן שהיא רצה.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      if(typeof showRoundEnd !== "function") return;
      window.realShowRoundEnd = showRoundEnd;
      showRoundEnd = () => newRound();
    });
  });
  // טעינה מחדש של הדף הראשי, עם זמן לסקריפט שלו לעלות.
  const reload = () => page.reload({ waitUntil: "domcontentloaded" }).then(() => page.waitForTimeout(800));

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
      lenient: decide(farm, "sheep", "ship", lenient)
    };
  });
  check("מילה אחרת מהרשימה לא מתקבלת מעל הרמה הסלחנית",
        Object.values(listNeighbour.rejected).every(ok => ok === false), listNeighbour);
  check("מילת היעד מתקבלת בכל רמה כששכנותיה ברשימה",
        listNeighbour.target.every(ok => ok === true), listNeighbour);
  check("מילת היעד מתקבלת גם לפני או אחרי שכנה מהרשימה באותה תוצאה",
        listNeighbour.withNeighbour.every(ok => ok === true), listNeighbour);
  check("ברמה הסלחנית שכנה קרובה מהרשימה מתקבלת", listNeighbour.lenient === true, listNeighbour);

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
  await page.click("#openSettings");
  await page.waitForTimeout(150);
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
  await page.click("#openSettings");
  await page.click("#openWordsViewBtn");
  await page.click("#openCatalogBtn");
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    window.visibleCatalogItems = () =>
      [...document.querySelectorAll("#catalog .catalog-item")].filter(b => getComputedStyle(b).display !== "none");
  });
  const built = await page.evaluate(() => document.querySelectorAll("#catalog .catalog-item").length);
  check("כל המאגר נבנה", built === pairsInFile, { built, pairsInFile });

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
  await page.click("#openSettings");
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
  await page.evaluate(({ list, at }) => { applyWords(list, at); closePanel(); }, beforeSync);
  check("רשימה שנשמרה בחלון אחר מוצגת, והמילה שעל המסך נשארת",
    keptWord.words === keptWord.want && keptWord.rows === keptWord.want && keptWord.shown === beforeSync.current.word,
    keptWord);
  check("מילה שנמחקה בחלון אחר מתחלפת במילה מהרשימה החדשה",
    lostWord.words === lostWord.want && lostWord.rows === lostWord.want && lostWord.want.split(",").includes(lostWord.shown),
    lostWord);
  check("רשימה מחלון אחר לא נשמרת בחזרה", keptWord.notWrittenBack && lostWord.notWrittenBack, { keptWord, lostWord });

  // --------------------------------------------------------------
  group("שורת התמונות");
  // השורה למעלה מראה את המילים שהילד אמר או כתב בסבב הזה בניסיון הראשון,
  // בלי עזרה: התמונות של המילים עצמן, ולא כוכבים שנספרים. הצלחה עם עזרה
  // מקבלת 🎉 וצליל, בלי תמונה. ההחלטה עוברת דרך finish(), כמו מהמזהה, כבר
  // לפני שהמודל נטען. כל מקרה מתחיל סבב חדש ומחכה למעבר ש-good() מזמן.
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
      out.card = $("picture").textContent;
      out.row = $("roundRow").textContent;
      if(how === "fresh"){ newRound(); out.fresh = $("roundRow").textContent; }
      await new Promise(r => setTimeout(r, Math.max(GOOD_MS, AGAIN_MS) + 300));
      return out;
    } finally {
      if(soundEnabled !== realSound) setSound(realSound);
      delete synth.speak;
    }
  }, how);
  const cleanRow = await rowAfter("clean");
  check("מילה שנאמרה בניסיון הראשון בלי עזרה — 🎉, והתמונה שלה בשורה",
    cleanRow.card === "🎉" && cleanRow.row === cleanRow.emoji, cleanRow);
  const heardRow = await rowAfter("heard");
  check("הצלחה אחרי ששמעו את המילה — 🎉 בלי תמונה בשורה", heardRow.card === "🎉" && heardRow.row === "", heardRow);
  const secondRow = await rowAfter("second");
  check("הצלחה בניסיון השני — 🎉 בלי תמונה בשורה", secondRow.card === "🎉" && secondRow.row === "", secondRow);
  const twiceRow = await rowAfter("twice");
  check("מילה שחוזרת בסבב נכנסת לשורה פעם אחת", twiceRow.row === twiceRow.emoji, twiceRow);
  const freshRow = await rowAfter("fresh");
  check("סבב חדש מתחיל בשורה ריקה", freshRow.row === freshRow.emoji && freshRow.fresh === "", freshRow);

  // הכפתורים שבצדי הסרגל מונחים מעליו, ושורה שנכנסת מתחתם מסתירה דווקא
  // את התמונה שהילד הרגע הרוויח. בודקים כל תמונה בנפרד, ברוחב של טלפון צר:
  // המלבן של השורה כולה רחב מהתמונות שבה, והשאלה היא איפה הן. הרחבות במאגר
  // הן אלה שבנויות מכמה אימוג'ים, כמו 👩‍⚕️.
  const rowLayout = (n, avoid) => page.evaluate(([n, avoid]) => {
    round.row = PAIRS.slice().sort((a, b) => b[0].length - a[0].length).slice(0, n).map(p => p[1]);
    renderRow();
    const box = r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    const others = avoid.map(id => box($(id).getBoundingClientRect()));
    const text = $("roundRow").firstChild;
    const glyphs = [...new Intl.Segmenter().segment(text.data)].map(({ index, segment }) => {
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + segment.length);
      return box(range.getBoundingClientRect());
    });
    const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const bad = glyphs.filter(g => g.left < 0 || g.top < 0 || g.right > innerWidth || g.bottom > innerHeight
                                   || others.some(b => hits(g, b)));
    const lines = new Set(glyphs.map(g => Math.round(g.top))).size;
    return { word: word(), glyphs: glyphs.length, lines, bad, others };
  }, [n, avoid]);
  const roundSize = await page.evaluate(() => ROUND_SIZE);
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 640 });
  const fullRow = await rowLayout(roundSize, ["openSettings", "openFeedback", "toggleSound"]);
  check("בטלפון צר סבב שלם נכנס בשורה אחת, על המסך ולא מתחת לכפתורים",
        fullRow.glyphs === roundSize && fullRow.lines === 1 && fullRow.bad.length === 0, fullRow);
  // מילים שמורה קפצה אליהן מתווספות לסבב, ואז השורה נשברת.
  const longRow = await rowLayout(2 * roundSize, ["openSettings", "openFeedback", "toggleSound"]);
  check("שורה ארוכה מסבב נשברת, וכל תמונה על המסך ולא מתחת לכפתורים",
        longRow.glyphs === 2 * roundSize && longRow.bad.length === 0, longRow);
  // והמרווח ליד ⚙️💬 רחב מזה שליד 🔇, אבל שורה קצרה לא זזה בגללו הצידה:
  // היא ממורכזת כמו המתג שמתחתיה, כמו שההערה ב-#topBar מבטיחה.
  const centred = await page.evaluate(() => {
    round.row = ["dog", "cat"];
    renderRow();
    const range = document.createRange();
    range.selectNodeContents($("roundRow"));
    const r = range.getBoundingClientRect(), m = $("modeSwitch").getBoundingClientRect();
    return { row: $("roundRow").textContent, at: (r.left + r.right) / 2, modeSwitch: (m.left + m.right) / 2 };
  });
  check("בטלפון צר שורה קצרה ממורכזת מעל המתג",
        centred.row === "🐶🐱" && Math.abs(centred.at - centred.modeSwitch) <= 1, centred);
  // במצב כתיבה, עם מילה שהבנק שלה נשבר לשתי שורות, לא נשאר גובה פנוי. אילו
  // הסרגל היה מתכווץ, שורה של שתי שורות הייתה נדחסת בו וגולשת מעל קצה המסך
  // ועל המתג שמתחתיו; ובטלפון בגובה 640 גם הכפתורים בתחתית נשארים על המסך.
  const beforeSpell = await page.evaluate(() => {
    const before = { mode, at: i };
    setMode("spell");
    i = Math.max(0, words.findIndex(w => w.word === "banana"));
    show();
    return before;
  });
  const spellRow = await rowLayout(2 * roundSize, ["modeSwitch", "openSettings", "openFeedback", "toggleSound"]);
  const spellButtons = await page.evaluate(() => ["playWord", "hint", "next"]
    .filter(id => $(id) && $(id).offsetParent !== null)
    .map(id => ({ id, bottom: $(id).getBoundingClientRect().bottom, max: innerHeight })));
  await page.evaluate(b => { setMode(b.mode); i = b.at; show(); }, beforeSpell);
  check("במצב כתיבה בטלפון נמוך כל תמונה בשורה על המסך ולא על המתג",
        spellRow.word === "banana" && spellRow.glyphs > 0 && spellRow.bad.length === 0, spellRow);
  check("במצב כתיבה בטלפון בגובה 640 הכפתורים בתחתית על המסך",
        spellButtons.length > 0 && spellButtons.every(b => b.bottom <= b.max), spellButtons);
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
    const before = round.row.length;
    const tile = [...$("bank").children].find(t => t.dataset.letter !== word()[0]);
    tile.click();
    const slot = $("slots").children[0];
    return { letter: tile.dataset.letter, slot: slot.textContent, row: round.row.length - before, inBank: !tile.disabled };
  });
  check("אות לא נכונה נכנסת למשבצת, בלי תמונה בשורה",
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
      target, order, row: round.row.length - before, again: $("picture").className,
      right: slots.map((s, k) => s.classList.contains("right") === (order[k] === target[k])),
      red: slots.map((s, k) => s.classList.contains("wrong") === (order[k] !== target[k]))
    };
  });
  check("מילה מלאה ושגויה — נסו שוב, בלי תמונה בשורה",
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
    return { row: round.row.length - before, card: $("picture").textContent };
  });
  check("כתיבה נכונה אחרי מילה שגויה — 🎉, בלי תמונה בשורה", fixed.row === 0 && fixed.card === "🎉", fixed);
  await newBoard();

  // good() עובר למילה הבאה אחרי המשוב, ושם הלוח מתחיל מחדש.
  const spellAll = async withHint => {
    await newBoard();
    return page.evaluate(withHint => {
      const before = round.row.length, emoji = words[i].emoji;
      if(withHint) $("hint").click();
      completeWord();
      return { added: round.row.length - before, card: $("picture").textContent, emoji,
               last: [...new Intl.Segmenter().segment($("roundRow").textContent)].map(s => s.segment).pop(),
               hinted: $("slots").querySelectorAll(".hinted").length, hintOff: $("hint").disabled };
    }, withHint);
  };
  const clean = await spellAll(false);
  check("מילה שנכתבה בלי עזרה — 🎉, והתמונה שלה בשורה, כמו באמירה",
    clean.added === 1 && clean.card === "🎉" && clean.last === clean.emoji, clean);
  const helped = await spellAll(true);
  check("רמז ממלא אות אחת, והמילה מקבלת 🎉 בלי תמונה בשורה",
    helped.added === 0 && helped.hinted === 1 && helped.card === "🎉", helped);
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
    renderRow();
    const word = $("word").textContent;
    setMode("say");
    return { row: $("roundRow").textContent, kept: $("word").textContent === word, mode };
  });
  check("מעבר בין אומרים לכותבים מתחיל סבב חדש, והמילה שעל המסך נשארת",
    apart.row === "" && apart.kept && apart.mode === "say", apart);
  await page.evaluate(() => setMode("spell"));

  await reload();
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
  check("שני קישורי משוב על הדף, ושניהם מצביעים על אותו טופס",
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
      await new Promise(r => setTimeout(r, 1500));
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
        // רשימה חדשה, כמו מ-#practiceSetBtn במאגר, ועל המסך המילה שאחרי זו שהייתה.
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
      stopListening();
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

  // אמירה שלא התקבלה: בפעם הראשונה "נסו שוב" כמו היום, ואחרי הצליל, עם שמע,
  // המילה נאמרת פעם אחת באנגלית. בפעם השנייה עוברים למילה אחרת בלי סימן.
  // הדיבור נספר ב-speechSynthesis עצמו: speak() נקראת גם כשהשמע כבוי, ופשוט
  // חוזרת. כל מקרה מתחיל ממילה חדשה ומחכה עד שהטיימרים שלו נגמרים.
  const notYetRun = scenario => page.evaluate(async scenario => {
    const real = { again, chime, soundEnabled }, synth = speechSynthesis, pic = $("picture");
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
  check("אמירה ראשונה שלא התקבלה — \"נסו שוב\" כמו היום, ונשארים על המילה",
    firstMiss.misses === 1 && firstMiss.shown === firstMiss.start && firstMiss.log.again === 1
      && firstMiss.log.classes.includes("again"), firstMiss);
  check("עם שמע, אחרי אמירה ראשונה שלא התקבלה המילה נאמרת פעם אחת באנגלית",
    JSON.stringify(firstMiss.log.spoken) === JSON.stringify([[firstMiss.target, "en-US"]]), firstMiss.log);
  const mutedMiss = await notYetRun("muted");
  check("בלי שמע אין הקראה אחרי אמירה שלא התקבלה",
    mutedMiss.misses === 1 && mutedMiss.log.spoken.length === 0, mutedMiss.log);
  const secondMiss = await notYetRun("second");
  check("אמירה שנייה שלא התקבלה — עוברים למילה אחרת בלי אדום, בלי צליל ובלי הקראה",
    secondMiss.shown === secondMiss.start + 1 && secondMiss.after.again === secondMiss.before.again
      && secondMiss.after.chime === secondMiss.before.chime && secondMiss.after.spoken === secondMiss.before.spoken
      && !secondMiss.log.classes.slice(secondMiss.before.classes).includes("again"), secondMiss);
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
        await new Promise(r => setTimeout(r, 100 + FINAL_GRACE_MS + 300));
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
        round = { queue: queue.slice(), at: -1, row: [], tried: tried.slice(), fresh: [], requeued: [] };
        shownWord = null;
        next();
      },
      end: (last = "fish") => { roundTest.plan([last]); skipWord(); }
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
      seed();
      setMode("spell");
      roundTest.end();
      return { say, spell: { ended, pace: pace() } };
    } finally {
      setMode("say");
      localStorage.removeItem(P); localStorage.removeItem(L);
    }
  }, [P, L]);
  check("בסוף סבב באמירה הקצב זז לפי היומן", paceAtEnd.say.ended && paceAtEnd.say.pace === 2, paceAtEnd);
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
      round = { queue: queue.slice(), at: -1, row: [], tried: [], fresh: [], requeued: [] };
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

  // מסך הסיום: מה שניסו בסבב, בלי מספרים, ו-▶ שמתחיל סבב חדש. ⏭️ על המילה
  // האחרונה מסיים את הסבב כמו הצלחה.
  await page.setViewportSize({ width: 360, height: 640 });
  const ending = await page.evaluate(async ([P, L]) => {
    const realChime = chime, chimes = [];
    chime = sound => { chimes.push(sound); return realChime(sound); };
    const visible = id => $(id).checkVisibility();
    try{
      localStorage.removeItem(P); localStorage.removeItem(L);
      const tried = ["dog", "cat", "sun", "lion", "book", "ship", "tea", "ball"];
      round = { queue: ["fish"], at: -1, row: tried.slice(0, 5), tried, fresh: ["sun"], requeued: [] };
      shownWord = null;
      next();
      // ה-🎉 מזמן מעבר, ו-⏭️ בזמנו מסיים את הסבב לפניו.
      good();
      skipWord();
      const box = r => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      const end = $("roundEnd").getBoundingClientRect();
      const out = {
        ended, end: visible("roundEnd"), say: visible("say"), picture: visible("picture"), next: visible("next"),
        pics: [...$("roundPics").children].map(b => b.dataset.word + (b.classList.contains("big") ? "+" : "")
          + (b.classList.contains("fresh") ? "*" : "")),
        focus: document.activeElement.id,
        text: $("roundEnd").innerText + $("roundRow").innerText,
        inView: [end, $("againBtn").getBoundingClientRect(), $("basketBtn").getBoundingClientRect(),
                 ...[...$("roundPics").children].map(b => b.getBoundingClientRect())]
          .every(r => r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth),
        sizes: box(end)
      };
      // והמעבר שה-🎉 זימן לא מחזיר מילה ולא מסיים את הסבב פעם שנייה.
      await new Promise(r => setTimeout(r, GOOD_MS + 200));
      out.stillEnded = ended;
      out.chimes = chimes.filter(c => c === ROUND_CHEER).length;
      return out;
    } finally { chime = realChime; }
  }, [P, L]);
  check("בסוף הסבב — מסך סיום במקום התמונה והכפתורים",
    ending.ended && ending.end && !ending.say && !ending.picture && !ending.next && ending.stillEnded, ending);
  check("במסך הסיום כל מה שניסו: בלי עזרה בגדול, ו-✨ על מילה חדשה",
    ending.pics.join() === "dog+,cat+,sun+*,lion+,book+,ship,tea,ball", ending);
  check("צליל אחד בסוף הסבב, והפוקוס על ▶", ending.chimes === 1 && ending.focus === "againBtn", ending);
  check("אין מספרים במסך הסיום ובשורה", !/[0-9]/.test(ending.text), ending.text);
  check("בטלפון בגובה 640 מסך הסיום, ▶ ו-🧺 על המסך", ending.inView, ending);

  // ההגדרות מעל מסך הסיום: Tab לא מגיע אליו.
  const endInert = await page.evaluate(() => {
    openPanel();
    const inert = $("roundEnd").inert;
    closePanel();
    return { inert, after: $("roundEnd").inert, ended };
  });
  check("מסך הסיום לא נגיש במקלדת כשההגדרות פתוחות, וחוזר אחריהן",
    endInert.inert && !endInert.after && endInert.ended, endInert);

  // הסל: מילים שהילד אמר לבד מהתמונה בשני ימים שונים. מילה שחזרה לתרגול
  // נשארת בו, ונגיעה אומרת את המילה רק כשהשמע דלוק.
  const basket = await page.evaluate(async P => {
    const synth = speechSynthesis, spoken = [], realSound = soundEnabled;
    synth.speak = u => spoken.push(u.text);
    try{
      $("basketBtn").click();
      const empty = { shown: !$("basketEmpty").hidden, items: $("basketPics").children.length };
      $("basketBack").click();
      localStorage.setItem(P, JSON.stringify({ v: 1, w: {
        dog: { met: 1, seen: 9, box: 3, due: 20, ok: [5, 9], n: 4, k: 3, got: 1 },
        lion: { met: 1, seen: 12, box: 0, due: 13, ok: [6, 8], n: 6, k: 2, got: 2, wrote: 7 },
        sun: { met: 1, seen: 9, box: 1, due: 10, ok: [9], n: 2, k: 1, got: 9 },
        cat: { met: 1, seen: 9, box: 1, due: 10, ok: [], n: 1, k: 1, got: 9 },
        sax: { met: 1, seen: 4, box: 2, due: 6, ok: [3, 4], n: 2, k: 2, got: 3 } } }));
      $("basketBtn").click();
      const out = { empty, items: [...$("basketPics").children].map(b => b.innerText.replace(/\s+/g, " ").trim()),
                    focus: document.activeElement.id, endHidden: $("endView").hidden };
      setSound(false);
      $("basketPics").children[0].click();
      out.mutedSpoke = spoken.length;
      out.mutedKept = !soundEnabled;
      setSound(true);
      $("basketPics").children[0].click();
      out.spoken = spoken.slice();
      $("basketBack").click();
      out.back = !$("endView").hidden && $("basketView").hidden && document.activeElement.id === "againBtn";
      return out;
    } finally {
      setSound(realSound);
      delete synth.speak;
      localStorage.removeItem(P);
    }
  }, P);
  check("סל ריק אומר מה ייכנס אליו", basket.empty.shown && basket.empty.items === 0, basket);
  check("בסל: מה שנאמר בשני ימים שונים, עם המילה באנגלית, גם אחרי שחזר לתרגול או יצא מהמאגר, ו-✏️ למה שגם נכתב",
    basket.items.join("|") === "🐶 dog|🦁 lion ✏️|sax" && basket.endHidden && basket.focus === "basketBack", basket);
  check("נגיעה בתמונה בסל אומרת אותה רק כשהשמע דלוק, ולא מדליקה אותו",
    basket.mutedSpoke === 0 && basket.mutedKept && basket.spoken.join() === "dog", basket);
  check("חזרה מהסל למסך הסיום", basket.back, basket);

  const again = await page.evaluate(() => {
    $("againBtn").click();
    const visible = id => $(id).checkVisibility();
    return { ended, end: visible("roundEnd"), say: visible("say"), picture: visible("picture"),
             row: $("roundRow").textContent, at: round.at, word: word() };
  });
  check("▶ מתחיל סבב חדש: המילה הראשונה בו על המסך, והשורה ריקה",
    !again.ended && !again.end && again.say && again.picture && again.row === "" && again.at === 0, again);

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
    roundTest.end();
    $("basketBtn").click();
    return { kept, moved, endView: !$("endView").hidden, basket: !$("basketView").hidden };
  });
  check("נגיעה שנייה מיד אחרי ▶ לא מדלגת על המילה הראשונה בסבב, ואחר כך ⏭️ עובד",
    tapAfterPlay.kept && tapAfterPlay.moved, tapAfterPlay);
  check("🧺 שנלחץ מיד כשמסך הסיום מופיע לא מחליף אותו", tapAfterPlay.endView && !tapAfterPlay.basket, tapAfterPlay);
  // והמגן הזה לא חוסם את הכפתורים כשהדף רק נפתח, עוד לפני כל סבב. הדף נפתח
  // בהקשר נפרד, והנגיעה קורית מיד, בחלק השנייה הראשון שלו.
  const earlyCtx = await browser.newContext({ serviceWorkers: "block" });
  const earlyPage = await earlyCtx.newPage();
  await earlyPage.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  const earlySkip = await earlyPage.evaluate(() => {
    const before = word(), at = performance.now();
    $("next").click();
    return { at, moved: word() !== before };
  });
  await earlyCtx.close();
  check("⏭️ עובד כבר כשהדף נפתח", earlySkip.moved, earlySkip);

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
    renderRow();
    const gone = words.findIndex(x => x.word === "moon");
    removeAt(gone);
    out.removed = { ended, picture: picture(), row: $("roundRow").textContent };
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
    roundTest.end("fish");
    openPanel();
    showSettingsView("words");
    const target = words.findIndex(x => x.word === "lion");
    $("wordList").querySelector(`li[data-index="${target}"] .jump`).click();
    out.jump = { ended, word: word(), at: round.at, queue: round.queue.length, open: !$("overlay").hidden };
    return out;
  });
  check("מחיקת מילה בסוף הסבב משאירה את מסך הסיום ואת השורה שלו, והסבב הבא בלעדיה",
    whileEnded.removed.ended && !whileEnded.removed.picture && whileEnded.removed.row === "🐶" && !whileEnded.spell.moon, whileEnded);
  check("שינוי התעתיק בסוף הסבב משאיר את מסך הסיום", whileEnded.hebrew.ended && !whileEnded.hebrew.picture, whileEnded);
  check("הדלקת השמע בסוף הסבב לא אומרת את המילה האחרונה",
    whileEnded.sound.ended && whileEnded.sound.spoken.length === 0, whileEnded);
  check("מעבר לכתיבה בסוף הסבב מתחיל סבב חדש, לא במילה האחרונה",
    !whileEnded.spell.ended && whileEnded.spell.word !== "fish" && whileEnded.spell.at === 0, whileEnded);
  check("קפיצה מהרשימה בסוף הסבב מציגה את המילה, וסבב חדש אחריה",
    !whileEnded.jump.ended && whileEnded.jump.word === "lion" && whileEnded.jump.at === -1 && whileEnded.jump.queue > 0
      && !whileEnded.jump.open, whileEnded);

  // מילה שמורה קפצה אליה, כשהיא האחרונה בסבב והילד כבר ניסה אותה, לא חוזרת
  // מיד; סבב חדש שיש בו רק אותה מילה מציג אותה.
  const repeat = await page.evaluate(() => {
    roundTest.plan(["dog", "fish"]);
    i = words.findIndex(x => x.word === "fish");
    show();
    noteTried("fish");
    next();
    const jumped = { ended, word: word() };
    round = { queue: ["fish"], at: -1, row: [], tried: [], fresh: [], requeued: [] };
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

  // מה שהילד עשה בפועל מגיע למסך הסיום: אמירה נקייה בגדול, אמירה בניסיון
  // השני בקטן, וכתיבה נקייה בגדול.
  const played = await page.evaluate(async ([P, L]) => {
    const { plan, say, wait } = roundTest, synth = speechSynthesis;
    const pics = () => [...$("roundPics").children].map(b => b.dataset.word + (b.classList.contains("big") ? "+" : ""));
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
  check("מסך הסיום אחרי סבב אמיתי: מה שנאמר בניסיון הראשון בגדול, בניסיון השני בקטן",
    played.say.ended && played.say.pics.join() === "dog+,sun", played);
  check("ובכתיבה: מילה שנכתבה בלי עזרה בגדול", played.spell.ended && played.spell.pics.join() === "cat+", played);

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
      return { cls: $("picture").className, card: $("picture").textContent };
    } finally { next = realNext; }
  });
  check("🎉 מהר אחרי \"נסו שוב\" נשאר ירוק עד סופו", cheerStays.cls === "good" && cheerStays.card === "🎉", cheerStays);

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
  await reload();
  check("מצב השמע נשמר בין טעינות", await page.evaluate(() => soundEnabled) === soundOn, { soundOn });

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
             childId, note: $("note").textContent, chips: [...$("childChips").children].map(c => c.textContent),
             del: $("deleteChildBtn").checkVisibility() };
  });
  const oldAfter = await dumpStorage(oldPage);
  await oldDevice.close();
  check("מכשיר עם הגדרות מלפני השמות טוען אותן כמו שהן, בלי ברכה",
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

  await page.evaluate(() => { round.row = ["dog", "cat"]; renderRow(); window.sameDocument = true; });
  await page.click("#openSettings");
  await page.waitForTimeout(150);
  const legacyBefore = await legacyRaw();
  const unnamed = await childState();
  const onScreen = await page.evaluate(() => [JSON.stringify(words), preset.id, hebrewEnabled ? "1" : "0", mode]);

  await addName("נועה");
  const added = await page.evaluate(() => ({
    reg: JSON.parse(localStorage.getItem("say-the-word-children")), pointer: localStorage.getItem("say-the-word-child"),
    sameDocument: window.sameDocument === true, row: $("roundRow").textContent, at: round.at
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
  const greeting = await page.textContent("#note");
  check("אחרי טעינה מחדש הדף נשאר על אותו ילד ומברך אותו",
    settingsOf(reloadedNoa) === settingsOf(noaChanged) && greeting === "שלום נועה! 👋", { reloadedNoa, greeting });

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

  await page.click("#openSettings");
  await page.waitForTimeout(150);
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
  await page.click("#openSettings");
  await page.waitForTimeout(150);
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
  // קודמת כבר הפעילה. 🔊 גם מדליק את השמע, כך שהלחיצה הזו לבדה צריכה להספיק.
  // good() מקדם את המילה; הקבוצה הבאה טוענת את הדף מחדש בכל מקרה.
  await page.click("#playWord");
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
  check("ניסיון נוסף מנגן צליל יורד", !!chimes.oops && rising(chimes.oops.slice().reverse()), chimes);
  check("שמע מכובה — אין צלילים", !!chimes.muted && chimes.muted.length === 0, chimes);
  // המשוב הוא הצליל והתמונה. speak() נשאר רק להקראת המילה באנגלית.
  const spokenFeedback = await page.evaluate(() => {
    const calls = [], original = speak;
    speak = (text, lang) => { calls.push({ text, lang }); return original(text, lang); };
    try { good(); again(); } finally { speak = original; }
    return calls;
  });
  check("הצלחה וניסיון נוסף לא מקריאים כלום", spokenFeedback.length === 0, spokenFeedback);

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
