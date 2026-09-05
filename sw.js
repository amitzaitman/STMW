/* עבודה בלי אינטרנט, אבל בלי להיתקע על גרסה ישנה של הדף.
   הדף עצמו נבדק ברשת קודם, והקבצים הכבדים נלקחים מהמטמון. */

importScripts('./cache-name.js');                // CACHE_NAME, משותף עם הדף

const HEAVY = ['vosk.js', 'model.tar.gz'];      // כמעט לא משתנים
const NET_TIMEOUT = 3000;                        // WiFi "מחובר" בלי אינטרנט: לא מחכים יותר מזה

// ?v=4 בכתובת הוא רק שובר-מטמון של הדפדפן, לא קובץ אחר. בלי ignoreSearch
// הרשומה שנשמרה בהתקנה (./words.js) לא נמצאת כשהדף מבקש ./words.js?v=4.
const MATCH = {ignoreSearch: true};

// רשת קודם, אבל עם גבול זמן: אחרי NET_TIMEOUT עוברים למטמון.
// בלי רשת בכלל ה-fetch נכשל מיד ועוברים למטמון מיד, כמו תמיד.
// אם אין כלום במטמון (ביקור ראשון על רשת איטית) ממשיכים לחכות לרשת, כי אין חלופה.
// תשובה שהגיעה מאוחר עדיין נכנסת למטמון לפעם הבאה.
//
// ה-index.html הוא חלופה רק לבקשת ניווט. קודם הוא הוחזר לכל בקשה, כך
// ש-words.js שחסר במטמון חזר כ-HTML, הסקריפט לא נטען, PAIRS נשאר ריק
// והדף קרס. עדיף שבקשה כזו פשוט תיכשל.
function pageOrCache(req){
  const net = fetch(req).then(res=>{
    if(res.ok){
      const copy = res.clone();
      caches.open(CACHE_NAME).then(c=>c.put(req, copy)).catch(()=>{});
    }
    return res;
  });
  const slow = new Promise((_, reject)=>setTimeout(()=>reject(new Error('slow network')), NET_TIMEOUT));
  const fromCache = () => caches.match(req, MATCH).then(hit =>
    hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
  return Promise.race([net, slow])
    .catch(()=> fromCache().then(hit => hit || net));
}

self.addEventListener('install', e=>{
  e.waitUntil(
    caches.open(CACHE_NAME)
      // model.tar.gz לא נמצא כאן בכוונה: הדף מוריד אותו בעצמו עם פס התקדמות
      // ומכניס אותו לאותו מטמון. הורדה כאן הייתה מכפילה אותה ל-56MB.
      .then(c => Promise.all(
        ['./', './index.html', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './vosk.js', './words.js', './cache-name.js']
          .map(u => c.add(u).catch(()=>null))
      ))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', e=>{
  if(e.request.method !== 'GET') return;
  if(!e.request.url.startsWith(self.location.origin)) return;
  // לפי שם הקובץ, לא לפי תת-מחרוזת בכתובת: קודם כל כתובת שהכילה במקרה
  // "vosk.js" באיזשהו מקום נחשבה קובץ כבד ונשמרה לנצח.
  const heavy = HEAVY.includes(new URL(e.request.url).pathname.split("/").pop());

  if(heavy){
    // קודם מהמטמון — לא מורידים 29MB בכל פתיחה
    e.respondWith(
      caches.match(e.request, MATCH).then(hit => hit || fetch(e.request).then(res=>{
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c=>c.put(e.request, copy)).catch(()=>{});
        return res;
      }))
    );
    return;
  }

  // הדף וכל השאר: קודם מהרשת, כדי שעדכון שהעליתם יגיע מיד. בלי רשת: מהמטמון.
  e.respondWith(pageOrCache(e.request));
});
