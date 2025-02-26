FROM node:20-bookworm

WORKDIR /app

# Install ffmpeg at the OS level first
RUN apt-get update && \
    apt-get install -y ffmpeg libavcodec-extra && \
    rm -rf /var/lib/apt/lists/*

# Set ffmpeg environment variables
ENV PATH="/usr/bin:$PATH" \
    FFMPEG_PATH="/usr/bin/ffmpeg" \
    FFPROBE_PATH="/usr/bin/ffprobe" \
    NODE_OPTIONS="--max-old-space-size=8192"

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