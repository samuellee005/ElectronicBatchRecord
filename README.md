# PDF Background Template Uploader

A PHP web application that allows users to upload PDF files and use them as background templates.

## Features

- 📤 **PDF Upload**: Drag-and-drop or click to upload PDF files
- 🔒 **Security**: File type validation, size limits, and MIME type checking
- 📋 **Template Management**: View and manage uploaded PDF templates
- 🎨 **Modern UI**: Clean, responsive design with gradient styling
- 📄 **PDF Viewer**: Built-in PDF viewer to preview uploaded templates

## Requirements

- PHP 8.1 or higher (recommended)
- Web server (Apache, Nginx, or PHP built-in server)
- `fileinfo` PHP extension (usually enabled by default)
- **Composer** dependencies for batch PDF preview/export (FPDI + FPDF): `zlib`, and **`gd`** (for embedded signature images in exported PDFs)

## Installation

1. Clone or download this repository
2. Ensure PHP is installed on your system
3. Install PHP dependencies from the project root:
   ```bash
   composer install
   ```
   (This installs `setasign/fpdi` and `setasign/fpdf` into `vendor/`.)
4. Make sure the `uploads/` directory is writable:
   ```bash
   chmod 755 uploads/
   ```

## Running the Application

### PHP only (production-style, after `cd frontend && npm run build`)

Use the router so React routes and `/includes` work:

```bash
php -S localhost:8080 router.php
```

Then open **http://localhost:8080**

Without `router.php`, or without a built `frontend/dist/`, you will only see a placeholder page.

### Local development (recommended)

Use Vite for the UI and PHP for the API. See **[frontend/README.md](frontend/README.md)** — PHP on **8080** and `npm run dev` in `frontend/`, then open **http://localhost:5173**.

### Using Apache/Nginx

1. Place the project in your web server's document root
2. Configure your web server to point to the project directory
3. Access via your configured domain/URL

## Configuration

Edit `config.php` to customize:

- **UPLOAD_DIR**: Directory where PDFs are stored (default: `uploads/`)
- **MAX_FILE_SIZE**: Maximum file size in bytes (default: 10MB)
- **ALLOWED_EXTENSIONS**: Allowed file extensions (default: `['pdf']`)

## Security Features

- File type validation (extension and MIME type)
- File size limits
- Filename sanitization
- Directory traversal protection
- Secure file upload handling

## Project Structure

```
ElectronicBatchRecord/
├── index.php              # Main upload page
├── view.php               # PDF viewer page
├── config.php             # Configuration settings
├── includes/
│   └── functions.php      # Helper functions
├── uploads/               # Uploaded PDFs directory
└── README.md              # This file
```

## Usage

1. Open the application in your browser
2. Click "Choose PDF File" or drag and drop a PDF file
3. Click "Upload PDF" to upload
4. View uploaded templates in the "Uploaded Templates" section
5. Click "View Template" to preview any uploaded PDF

## License

This project is open source and available for use.
