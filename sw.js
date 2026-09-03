/* עבודה בלי אינטרנט, אבל בלי להיתקע על גרסה ישנה של הדף.
   הדף עצמו נבדק ברשת קודם, והקבצים הכבדים נלקחים מהמטמון. */

const CACHE = 'say-the-word-v2';
const HEAVY = ['vosk.js', 'model.tar.gz'];      // כמעט לא משתנים
const NET_TIMEOUT = 3000;                        // WiFi "מחובר" בלי אינטרנט: לא מחכים יותר מזה

// רשת קודם, אבל עם גבול זמן: אחרי NET_TIMEOUT עוברים למטמון.
// בלי רשת בכלל ה-fetch נכשל מיד ועוברים למטמון מיד, כמו תמיד.
// אם אין כלום במטמון (ביקור ראשון על רשת איטית) ממשיכים לחכות לרשת, כי אין חלופה.
// תשובה שהגיעה מאוחר עדיין נכנסת למטמון לפעם הבאה.
function pageOrCache(req){
  const net = fetch(req).then(res=>{
    if(res.ok){
      const copy = res.clone();
      caches.open(CACHE).then(c=>c.put(req, copy)).catch(()=>{});
    }
    return res;
  });
  const slow = new Promise((_, reject)=>setTimeout(()=>reject(new Error('slow network')), NET_TIMEOUT));
  const fromCache = () => caches.match(req).then(hit => hit || caches.match('./index.html'));
  return Promise.race([net, slow])
    .catch(()=> fromCache().then(hit => hit || net));
}

self.addEventListener('install', e=>{
  e.waitUntil(
    caches.open(CACHE)
      // model.tar.gz לא נמצא כאן בכוונה: הדף מוריד אותו בעצמו עם פס התקדמות
      // ומכניס אותו לאותו מטמון. הורדה כאן הייתה מכפילה אותה ל-56MB.
      .then(c => Promise.all(
        ['./', './index.html', './vosk.js']
          .map(u => c.add(u).catch(()=>null))
      ))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', e=>{
  if(e.request.method !== 'GET') return;
  const heavy = HEAVY.some(name => e.request.url.includes(name));

  if(heavy){
    // קודם מהמטמון — לא מורידים 29MB בכל פתיחה
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res=>{
        const copy = res.clone();
        caches.open(CACHE).then(c=>c.put(e.request, copy)).catch(()=>{});
        return res;
      }))
    );
    return;
  }

  // הדף וכל השאר: קודם מהרשת, כדי שעדכון שהעליתם יגיע מיד. בלי רשת: מהמטמון.
  e.respondWith(pageOrCache(e.request));
});
