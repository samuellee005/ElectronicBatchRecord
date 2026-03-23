# Electronic Batch Record – React Frontend

The app now has a **React frontend** (Vite + React Router) and **PHP backend** (existing API under `includes/*.php`).

## Development

1. **Backend (API)** – from project root:
   ```bash
   php -S localhost:8080
   ```
   Or use the SPA router (serves React build when present):
   ```bash
   php -S localhost:8080 router.php
   ```

2. **Frontend (React)** – from `frontend/`:
   ```bash
   cd frontend && npm install && npm run dev
   ```
   Opens at http://localhost:5173. Vite proxies `/includes`, `/uploads`, `/data`, `/forms` to `http://localhost:8080`.

3. Use **http://localhost:5173** for all navigation. Form Builder and Data Entry load the existing PHP pages in an iframe (same UX; can be ported to full React later).

## Production build

1. Build the React app:
   ```bash
   cd frontend && npm run build
   ```
   Output is in `frontend/dist/`.

2. Serve the project root with PHP and point the web server so that:
   - `/*.php` and `/includes/*`, `/uploads/`, `/data/`, `/forms/` (JSON files) are handled by PHP or as static files.
   - All other routes serve `frontend/dist/index.html` (SPA fallback).

   With PHP built-in server and router (see router.php): run from project root so that SPA and API are on the same port.
   Then open http://localhost:8080.

## Structure

- **Frontend:** `frontend/` – React app (Vite, React Router).
- **Backend:** `includes/*.php` – unchanged JSON APIs (list-forms, save-form, load-form, batch records, templates, upload, etc.).
- **Pages:** Dashboard, Forms List, Batch Record, Templates, Upload Template, View Template, Build Form wizard are React. Form Builder and Data Entry currently embed the PHP pages in iframes; they can be reimplemented in React later.

## API

All API calls go to `/includes/...` (e.g. `/includes/list-forms.php`). The client is in `frontend/src/api/client.js`.
