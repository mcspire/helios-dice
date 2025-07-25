# --- STUFE 1: Build ---
FROM node:20-alpine AS builder

WORKDIR /app

# Nur was nötig ist, wird kopiert
COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# --- STUFE 2: Ausliefern via Webserver ---
FROM nginx:stable-alpine

# Entferne Standardseiten von nginx
RUN rm -rf /usr/share/nginx/html/*

# Kopiere den Build vom ersten Container
COPY --from=builder /app/dist /usr/share/nginx/html

# Optionale Anpassung der nginx-Konfiguration (falls z. B. History-API nötig ist)
# COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
