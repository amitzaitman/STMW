import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

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
    }
  }
}));

// Route fallback for index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
