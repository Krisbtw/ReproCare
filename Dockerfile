FROM node:22-alpine
WORKDIR /app

# Install dependencies needed for node native builds if any
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build application bundle and prepare migrations
RUN npm run build

EXPOSE 8080
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

CMD ["npm", "run", "dev"]

