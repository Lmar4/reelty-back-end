FROM node:20-bookworm

WORKDIR /app

# Install ffmpeg and puppeteer dependencies with enhanced FFmpeg libraries
RUN apt-get update && \
    apt-get install -y ffmpeg libavcodec-extra \
    libavformat-dev libavfilter-dev libswscale-dev libavdevice-dev \
    libavutil-dev libpostproc-dev libswresample-dev \
    libmp3lame-dev libx264-dev libx265-dev libvpx-dev libopus-dev \
    libvorbis-dev libtheora-dev libwebp-dev libaom-dev libdav1d-dev \
    libfreetype6-dev libharfbuzz-dev libfribidi-dev libfontconfig1-dev \
    libass-dev libvidstab-dev libzimg-dev libxml2-dev libgme-dev \
    libopenjp2-7-dev libbluray-dev libmodplug-dev libspeex-dev \
    libgnutls28-dev libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libasound2 libpango-1.0-0 libcairo2 && \
    # Add these lines to ensure consistent FFmpeg configuration
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    # Create temp directories with proper permissions
    mkdir -p /app/temp/output \
            /app/temp/map-cache \
            /app/temp/templates \
            /app/temp/validation \
            /app/temp/processing \
            /app/temp/downloads \
            /app/temp/uploads \
            /app/temp/frames && \
    chmod -R 777 /app/temp && \
    # Create log directory
    mkdir -p /app/logs && \
    chmod -R 777 /app/logs

# Set ffmpeg environment variables
ENV PATH="/usr/bin:$PATH" \
    FFMPEG_PATH="/usr/bin/ffmpeg" \
    FFPROBE_PATH="/usr/bin/ffprobe" \
    NODE_OPTIONS="--max-old-space-size=8192" \
    # Add these environment variables
    TEMP_DIR="/app/temp" \
    TEMP_OUTPUT_DIR="/app/temp/output" \
    TEMP_PROCESSING_DIR="/app/temp/processing" \
    TEMP_DOWNLOAD_DIR="/app/temp/downloads" \
    TEMP_UPLOAD_DIR="/app/temp/uploads" \
    TEMP_FRAMES_DIR="/app/temp/frames" \
    FFMPEG_VALIDATION_TIMEOUT="30000" \
    FILE_DOWNLOAD_RETRIES="3" \
    FILE_VALIDATION_RETRIES="3" \
    FILE_VALIDATION_DELAY="1000" \
    FILE_DOWNLOAD_TIMEOUT="60000" \
    LOG_DIR="/app/logs"

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install pnpm
RUN npm install -g pnpm

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy app source
COPY . .

# Build the app
RUN pnpm run build

# Expose port
EXPOSE 8080

# Start the app
CMD ["pnpm", "start"]