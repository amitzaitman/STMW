import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname, {
  // התיקייה היא שורש הריפו, ובה .git ו-.env.local. בלי הערך הזה send בודק רק
  // את החלק האחרון בנתיב, ו-/.git/config היה מוגש.
  dotfiles: 'ignore'
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
