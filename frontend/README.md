# Electronic Batch Record — frontend (Vite + React)

## Development (API + hot reload)

You need **two terminals** from the **repository root**:

1. **PHP** (serves `/includes`, `/uploads`, and the built app on 8080):

   ```bash
   php -S 127.0.0.1:8080 router.php
   ```

2. **Vite** (from this `frontend` folder):

   ```bash
   cd frontend
   npm install
   npm run dev
   ```

Open the URL Vite prints (usually **http://localhost:5173**). The dev server proxies `/includes` and `/uploads` to `http://127.0.0.1:8080`.

If the UI loads but APIs fail, confirm PHP is on **port 8080** (see `vite.config.js`).

### WSL / remote browser

`npm run dev` listens on all interfaces (`host: true`). If `localhost` from Windows does not reach WSL, use the **Network** URL Vite prints, or browse from inside WSL.

## Production build

```bash
npm run build
```

Then serve the repo root with PHP using `router.php` (see main project `README.md`).
