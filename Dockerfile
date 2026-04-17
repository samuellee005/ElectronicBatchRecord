# syntax=docker/dockerfile:1.6

# ---------- Stage 1: build the React/Vite frontend ----------
    FROM node:20-alpine AS frontend-build
    WORKDIR /build

    COPY frontend/package.json frontend/package-lock.json ./
    RUN npm ci

    COPY frontend/ ./
    RUN npm run build

    # ---------- Stage 2: PHP runtime serving the built app ----------
    FROM php:8.3-cli-alpine AS runtime

    # Ghostscript is used by includes/merge-pdfs.php and related PDF tooling.
    # fontconfig/ttf-dejavu give gs usable fonts for PDF rasterization.
    RUN apk add --no-cache \
          ghostscript \
          fontconfig \
          ttf-dejavu \
          poppler-utils

    # PHP extensions used by the app (FPDI/FPDF are pure-PHP).
    # libzip stays installed at runtime; libzip-dev/zlib-dev are build-only.
    RUN apk add --no-cache libzip \
     && apk add --no-cache --virtual .build-deps $PHPIZE_DEPS libzip-dev zlib-dev \
     && docker-php-ext-install zip \
     && apk del .build-deps

    WORKDIR /app

    # Copy application source (respects .dockerignore)
    COPY . /app

    # Overlay the freshly built frontend bundle
    COPY --from=frontend-build /build/dist /app/frontend/dist

    # Ensure writable dirs exist; baked into the image (no persistence requested).
    RUN mkdir -p /app/uploads /app/forms /app/data/batch-records \
     && chmod -R 0777 /app/uploads /app/forms /app/data

    EXPOSE 8080

    # router.php serves built assets from frontend/dist and routes /includes, /uploads, etc.
    CMD ["php", "-S", "0.0.0.0:8080", "router.php"]
