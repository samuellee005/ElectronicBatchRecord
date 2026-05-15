
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

# Install Composer from the official Composer image
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

# Runtime packages
RUN apk add --no-cache \
      ghostscript \
      fontconfig \
      ttf-dejavu \
      poppler-utils \
      libzip \
      libpq \
      libpng \
      freetype \
      libjpeg-turbo \
      curl

# Build/install PHP extensions
RUN apk add --no-cache --virtual .build-deps \
      $PHPIZE_DEPS \
      libzip-dev \
      zlib-dev \
      postgresql-dev \
      libpng-dev \
      freetype-dev \
      libjpeg-turbo-dev \
      curl-dev \
 && docker-php-ext-configure gd --with-freetype --with-jpeg \
 && docker-php-ext-install zip pdo_pgsql gd curl \
 && apk del .build-deps

WORKDIR /app

# Allow PDF templates up to app limit
COPY docker/php-ebr.ini /usr/local/etc/php/conf.d/ebr-uploads.ini

# Copy composer files first for layer caching
COPY composer.json composer.lock /app/

# Install PHP deps
RUN composer install --no-dev --optimize-autoloader --no-interaction

# Copy application source
COPY . /app

# Overlay the freshly built frontend bundle
COPY --from=frontend-build /build/dist /app/frontend/dist

# Ensure writable dirs exist
RUN mkdir -p /app/uploads /app/forms /app/data/batch-records \
 && chmod -R 0777 /app/uploads /app/forms /app/data

EXPOSE 8080

CMD ["php", "-S", "0.0.0.0:8080", "router.php"]