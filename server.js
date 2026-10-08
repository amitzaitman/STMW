import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  next();
});

// Serve static assets from the current directory
app.use(express.static(__dirname, {
  dotfiles: 'allow',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('model.tar.gz')) {
      res.setHeader('Content-Type', 'application/gzip');
    } else if (filePath.endsWith('manifest.json')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
  }
}));

// נפילה ל-index.html רק לנתיב בלי סיומת, כלומר ניווט. קובץ חסר מקבל 404,
// אחרת סקריפט חסר חוזר כ-HTML בתוך תגית script. אותו כלל כמו ב-sw.js.
app.get('*', (req, res, next) => {
  if (path.extname(req.path)) return next();   // בקשה לקובץ: אין לה חלופה
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
