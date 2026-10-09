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
  check("מאגר המילים נטען", await page.evaluate(() => PAIRS.length) === 345);
  check("יש מילים לתרגול", await page.evaluate(() => words.length) > 0);
  check("מוצגת מילה על המסך", (await page.textContent("#word")).length > 0);

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
      return {localQuality, missingHebrew, hebrew, legacyHebrew};
    } finally { voices = original; }
  });
  check("קול מקומי איכותי במבטא המבוקש מועדף", voiceSelection.localQuality, voiceSelection);
  check("אין קול עברי — לא נבחר קול משפה אחרת", voiceSelection.missingHebrew, voiceSelection);
  check("תג שפה עברי עם קו תחתון נתמך", voiceSelection.hebrew, voiceSelection);
  check("תג השפה הישן iw-IL נחשב עברית", voiceSelection.legacyHebrew, voiceSelection);

  // --------------------------------------------------------------
  group("מנוע ההתאמה");
  // הניקוד הוא מספר אחד, וההחלטה היא השוואה אחת מולו. אלה התכונות
  // שחייבות להישמר גם אם הנוסחה תשתנה.
  const wrongAccepted = await page.evaluate(() => {
    const bad = [];
    for(const [target, spoken] of [["dog","cat"],["lion","house"],["sun","moon"],["apple","car"]])
      for(let th = 30; th <= 95; th += 5)
        for(const conf of [null, 0.5, 0.9, 1])
          if(scoreToken(spoken, conf, target) >= th) bad.push(`${spoken}/${target} th=${th}`);
    return bad;
  });
  check("מילה שגויה לא מתקבלת באף אחוז", wrongAccepted.length === 0, wrongAccepted.slice(0, 5));

  const nonMonotonic = await page.evaluate(() => {
    const bad = [];
    for(const [target, spoken] of [["dog","dog"],["cat","kat"],["butterfly","butterf"],["banana","banan"]])
      for(const conf of [null, 0.4, 0.7, 1]){
        const score = scoreToken(spoken, conf, target);
        let prev = true;
        for(let th = 30; th <= 95; th += 5){
          const now = score >= th;
          if(now && !prev) bad.push(`${spoken}/${target} conf=${conf} th=${th}`);
          prev = now;
        }
      }
    return bad;
  });
  check("העלאת האחוז רק מקשה", nonMonotonic.length === 0, nonMonotonic);

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
  check("כל המאגר נבנה", built === 345, built);

  await page.fill("#search", "lion");
  await page.waitForTimeout(150);
  check("סינון מסתיר בפועל", await page.evaluate(() => visibleCatalogItems()) === 1);
  check("הצמתים לא נבנים מחדש",
        await page.evaluate(() => document.querySelectorAll("#catalog .catalog-item").length) === built);

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

  const rowsBefore = await page.locator("#wordList li").count();
  await page.click("#wordList li .del-word-btn");
  await page.waitForTimeout(250);
  check("מחיקת מילה", await page.locator("#wordList li").count() === rowsBefore - 1);

  await page.click("#wordList li .jump");
  await page.waitForTimeout(200);
  check("לחיצה על מילה קופצת אליה וסוגרת", await page.evaluate(() => $("overlay").hidden) === true);

  // --------------------------------------------------------------
  group("כוכבים ומדליות");
  // שורת התגמול לא גדלה בלי גבול ולא קופאת: שלוש הצלחות מתחלפות במדליה,
  // וחמש מדליות בגביע.
  const row = async n => await page.evaluate(count => {
    score = 0;
    for(let k = 0; k < count; k++) good();
    return $("stars").textContent;
  }, n);
  check("כל הצלחה מוסיפה כוכב", await row(1) === "⭐" && await row(2) === "⭐⭐");
  check("שלושה כוכבים מתחלפים במדליה", await row(3) === "🏅" && await row(4) === "🏅⭐");
  check("חמש מדליות מתחלפות בגביע", await row(15) === "🏆" && await row(16) === "🏆⭐");
  check("ארבע מדליות ושני כוכבים לפני הגביע", await row(14) === "🏅🏅🏅🏅⭐⭐");
  // כל good() מזמן גם מעבר למילה הבאה, ו-show() מנקה את שורת ההודעה.
  // בלי ההמתנה הזאת המעברים של הבדיקה הזאת מוחקים את ההודעה שהבדיקה
  // הבאה מציגה, והיא נופלת בלי קשר למה שהיא באמת בודקת.
  await page.waitForTimeout(1200);
  await page.evaluate(() => { score = 0; renderScore(); });

  // --------------------------------------------------------------
  group("תעתיק לעברית");
  // ילד שעוד לא קורא אנגלית רואה מתחת למילה איך אומרים אותה. מורה יכולה
  // לכבות, והבחירה נשמרת.
  const noHe = await page.evaluate(() => PAIRS.filter(p => !/^[\u0590-\u05FF'־ ]+$/.test(p[2] || "")).map(p => p[1]));
  check("לכל מילה במאגר יש תעתיק בעברית", noHe.length === 0, noHe);
  const heLine = () => page.evaluate(() => ({ text: $("wordHe").innerText, word: word(), he: HE_BY_WORD[word()] }));
  let he = await heLine();
  check("התעתיק מופיע על המסך מתחת למילה", !!he.he && he.text === he.he, he);
  await page.evaluate(() => $("hebrewToggle").click());
  he = await heLine();
  check("כיבוי מעלים את התעתיק ונשמר",
        he.text === "" && await page.evaluate(() => localStorage.getItem("hebrew_spelling")) === "0", he);
  await page.evaluate(() => { next(); });
  check("נשאר כבוי במילה הבאה", (await heLine()).text === "");
  await page.evaluate(() => $("hebrewToggle").click());
  he = await heLine();
  check("הדלקה מחזירה אותו", he.text === he.he && !!he.he, he);

  // --------------------------------------------------------------
  group("כתיבה");
  // הילד בונה את המילה מבנק של האותיות שלה. מילה שלמה שווה שלושה כוכבים,
  // רמז מוריד לשניים, וטעות לא עולה כלום. ההחלפה בין 🎤 ל-💡 נמדדת במה
  // שמוצג בפועל, כי display של כפתורי השורה גובר על התכונה hidden.
  const shown = id => page.evaluate(id => getComputedStyle($(id)).display !== "none", id);
  await page.evaluate(() => { score = 0; renderScore(); });
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

  const wrongTap = await page.evaluate(() => {
    const before = score;
    const tile = [...$("bank").children].find(t => t.dataset.letter !== word()[0]);
    tile.click();
    return { spelled, slot: $("slots").children[0].textContent, stars: score - before, inBank: !tile.disabled };
  });
  check("אות לא נכונה נשארת בבנק ולא עולה כוכב",
    wrongTap.spelled === 0 && wrongTap.slot === "" && wrongTap.stars === 0 && wrongTap.inBank, wrongTap);

  // good() עובר למילה הבאה אחרי המשוב, ושם הלוח מתחיל מחדש.
  const spellAll = async withHint => {
    await page.waitForFunction(() => spelled === 0);
    return page.evaluate(withHint => {
      const before = score, target = word();
      if(withHint) $("hint").click();
      while(spelled < target.length)
        [...$("bank").children].find(t => !t.disabled && t.dataset.letter === target[spelled]).click();
      return { stars: score - before, card: $("picture").textContent, row: $("stars").textContent,
               hinted: $("slots").querySelectorAll(".hinted").length, hintOff: $("hint").disabled };
    }, withHint);
  };
  const clean = await spellAll(false);
  check("מילה שלמה בלי רמז — שלושה כוכבים", clean.stars === 3 && clean.card === "⭐⭐⭐", clean);
  check("שלושת הכוכבים נכנסים לשורה כמדליה", clean.row === "🏅", clean);
  const helped = await spellAll(true);
  check("רמז ממלא אות אחת ומוריד לשני כוכבים",
    helped.stars === 2 && helped.hinted === 1 && helped.card === "⭐⭐", helped);
  check("אחרי שהמילה הושלמה אין רמז", helped.hintOff, helped);
  await page.waitForFunction(() => spelled === 0);

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
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(200);
  check("המיקרופון משוחרר כשהדף יורד מהמסך", await page.evaluate(() => micStream === null));
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    return ensureAudio();
  });
  await page.waitForTimeout(300);
  check("המיקרופון חוזר לעבוד", await page.evaluate(() => !!micStream));

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
    const target = word(), before = score;
    for(const [type, detail] of evs)
      rec.dispatchEvent(new CustomEvent(type, { detail: JSON.parse(JSON.stringify(detail).replaceAll("TARGET", target)) }));
    const out = { active, won: score > before };
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
      const before = score;
      await listen();
      await new Promise(r => setTimeout(r, 1500));
      return { active, won: score > before };
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
  // good() ו-again() מזמנים מעברים והודעות; שלא ידרסו את הקבוצה הבאה.
  await page.waitForTimeout(1500);
  await page.evaluate(() => { score = 0; renderScore(); });

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

  server.closeAllConnections();
  await new Promise(r => server.close(r));

  const offline = await page.evaluate(async () => {
    try {
      const r = await fetch("./words.js?v=999", { cache: "no-store" });
      const t = await r.text();
      return { type: r.headers.get("content-type") || "", html: t.trim().startsWith("<!DOCTYPE") };
    } catch(e) { return { threw: e.name }; }
  });
  check("סקריפט חסר לא חוזר כ-HTML", offline.html === false, offline);

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
  }
  child.kill("SIGKILL");

  console.log(`\n${passed} עברו, ${failed.length} נכשלו`);
  if(failed.length) process.exit(1);
}

main().catch(e => { console.error("\nהבדיקות נפלו:", e.message); process.exit(1); });
