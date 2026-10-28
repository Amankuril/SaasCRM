# Deploying Zeta Connect on app.zetaaiautomations.in

```
User → https://app.zetaaiautomations.in → Nginx (SSL + gzip)
          ├── /            → React build (/var/www/zeta-app)
          ├── /api/        → API on 127.0.0.1:4000
          └── /socket.io/  → same API process, port 4000 (WebSocket)
       pm2: zeta-api (API + Socket.IO) and zeta-worker (BullMQ jobs)
       MongoDB (Atlas or local) + Redis (local, required)
```

How this differs from the usual SOP:

| Usual SOP | This project |
|---|---|
| `Backend/`, `Frontend/` | `backend/`, `frontend/` (lowercase) |
| `pm2 start server.js` | TypeScript: `npm run build` (esbuild), then run `dist/server.js` |
| API on 5000, separate socket server on 5001 | One process on **4000** serves both `/api` and `/socket.io` |
| No worker | Separate **worker** process (`dist/worker.js`), API runs with `RUN_WORKERS=false` |
| `/health`, `/ready` | Only `/api/health` |
| `/uploads` folder | None needed |
| `VITE_API_BASE_URL=/api` | Nothing to set: the frontend already calls relative `/api` |
| Redis optional | Redis **required** (queues, realtime) |
| DNS `@` and `www`, certbot for both | Only an `app` record, certbot for `app.` only. Main site untouched |

---

## 1. DNS (Hostinger / wherever the domain is)

Add **one** record. Do not edit the existing `@` or `www` records, those keep the main website alive.

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `app` | YOUR_VPS_IP | default |

If the DNS is on Cloudflare, set this record to **DNS only** (grey cloud) until certbot has run.

Check it (from your laptop): `dig +short app.zetaaiautomations.in` should print the VPS IP.

> If the main website is on this same VPS, that's fine: Nginx picks the site by `server_name`.
> Just **don't** delete `/etc/nginx/sites-enabled/default` or the main site's config (SOP step "Remove default").

## 2. Prepare the VPS

```bash
sudo apt update
sudo timedatectl set-timezone Asia/Kolkata
sudo apt install -y nginx git curl unzip redis-server
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
sudo systemctl enable --now redis-server
redis-cli ping        # → PONG
```

Small VPS (1–2 GB RAM): `npm run build` only transpiles (esbuild / Vite, no type-check), so it is quick
and light, but `npm ci` and the Vite bundle still like some headroom. Add swap once and give Node more heap:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'export NODE_OPTIONS=--max-old-space-size=1536' >> ~/.bashrc && source ~/.bashrc
```

Cloud firewall: open inbound TCP **80 and 443** (Azure: VM > Networking > Inbound port rule),
otherwise certbot fails with "Timeout during connect".

MongoDB: use a MongoDB Atlas connection string (easiest), or install MongoDB 7 on the VPS and use `mongodb://127.0.0.1:27017/zeta_connect`.

## 3. Clone

```bash
cd ~
git clone https://github.com/Amankuril/SaasCRM.git
cd zeta-app
```

## 4. Backend

```bash
cd ~/SaasCRM/backend
npm ci
cp .env.example .env
nano .env
```

Production `.env` (everything not listed: keep the value from `.env.example`):

```env
NODE_ENV=production
PORT=4000
MONGODB_URI=<atlas or local uri>

# node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
JWT_ACCESS_SECRET=<generated>
# node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Generate once and never change it: it decrypts saved WhatsApp tokens.
ENCRYPTION_KEY=<generated>

APP_URL=https://app.zetaaiautomations.in
PUBLIC_API_URL=https://app.zetaaiautomations.in

REDIS_URL=redis://127.0.0.1:6379
QUEUE_DRIVER=bullmq
RUN_WORKERS=false

WHATSAPP_PROVIDER=meta
META_APP_ID=
META_APP_SECRET=
META_ES_CONFIG_ID=
META_WEBHOOK_VERIFY_TOKEN=<any random string>

# Required: production refuses business logins without SMTP
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=<gmail app password>
MAIL_FROM="Zeta Connect <no-reply@zetaaiautomations.in>"
# Business logins that skip the emailed code (password only), comma-separated
OTP_BYPASS_EMAILS=

AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=

BILLING_PROVIDER=razorpay
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

ALLOW_PRIVATE_OUTBOUND_URLS=false
```

Build and start (pm2 must start from `backend/`, because `.env` is read from the current folder):

```bash
npm run build
pm2 start dist/server.js --name zeta-api
pm2 start dist/worker.js --name zeta-worker
pm2 save
pm2 startup          # run the command it prints, so pm2 starts on reboot
curl http://127.0.0.1:4000/api/health    # → {"status":"ok","db":"up"}
```

## 5. Frontend

```bash
cd ~/SaasCRM/frontend
npm ci
npm run build
sudo mkdir -p /var/www/zeta-app
sudo rm -rf /var/www/zeta-app/*
sudo cp -r dist/* /var/www/zeta-app/
```

No `.env` needed here.

## 6. Nginx (a new file, separate from the main site)

```bash
sudo nano /etc/nginx/sites-available/app.zetaaiautomations.in.conf
```

Paste (HTTP only for now; certbot adds the SSL part in step 7):

```nginx
# Rate-limit zones (unique names so they don't clash with other sites' configs)
limit_req_zone $binary_remote_addr zone=zeta_api:10m rate=20r/s;
limit_conn_zone $binary_remote_addr zone=zeta_perip:10m;

map $http_upgrade $zeta_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name app.zetaaiautomations.in;

    root /var/www/zeta-app;
    index index.html;

    client_max_body_size 6M;   # CSV imports up to 5 MB
    keepalive_timeout 65;

    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;

    # Hashed build assets: cache for a year
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # React SPA
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }

    # API (+ Meta / Razorpay webhooks under /api/webhooks)
    location /api/ {
        limit_req zone=zeta_api burst=60 nodelay;
        limit_conn zeta_perip 30;

        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 10s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Socket.IO: same backend port 4000
    location /socket.io/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $zeta_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable it (do **not** remove `default` or the main site's file):

```bash
sudo ln -s /etc/nginx/sites-available/app.zetaaiautomations.in.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Check: `http://app.zetaaiautomations.in` opens the login page.

## 7. SSL for the subdomain only

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d app.zetaaiautomations.in
```

Pick "redirect HTTP to HTTPS" if asked. Only `app.` gets a certificate; the main domain's SSL is untouched.
Renewal check: `sudo certbot renew --dry-run`.

## 8. After it's live

```bash
cd ~/SaasCRM/backend
npm run make-admin -- you@example.com     # after signing up with that email
```

Point the outside services at the subdomain:

- **Meta app** → WhatsApp > Configuration: callback `https://app.zetaaiautomations.in/api/webhooks/whatsapp`, verify token = `META_WEBHOOK_VERIFY_TOKEN`. App settings > Basic: add `app.zetaaiautomations.in` to App Domains. Facebook Login for Business: add `https://app.zetaaiautomations.in/` to valid OAuth redirect URIs / allowed domains for the JS SDK.
- **Razorpay** → Webhooks: `https://app.zetaaiautomations.in/api/webhooks/razorpay`, events `subscription.*`, same secret as `RAZORPAY_WEBHOOK_SECRET`.
- **Google Cloud** (if using private Sheets) → OAuth redirect URI `https://app.zetaaiautomations.in/api/integrations/google/callback`.

## 9. deploy.sh (daily workflow)

The script lives in the repo at `scripts/deploy.sh`. Copy it once (and again whenever it changes;
it is not run from the repo so a `git pull` never rewrites it mid-run):

```bash
cp ~/SaasCRM/scripts/deploy.sh ~/deploy.sh && chmod +x ~/deploy.sh
~/deploy.sh
```

What it does, and why it is fast:

- `npm run build` **does not type-check** on the server (backend: esbuild, ~1 s; frontend: `vite build`).
  Type errors are caught on your machine: run `npm run typecheck` (repo root) before every push.
  The full checks still exist as `npm run build:tsc` (backend) and `npm run build:check` (frontend).
- `npm ci` runs only when that app's `package-lock.json` changed since its last install.
- The backend (and its pm2 restart) or the frontend is skipped when nothing in it changed since the
  last **successful** deploy (stored in `~/.zeta-deployed-commit`, so a failed deploy is fully retried).
- The frontend is swapped into `/var/www/zeta-app` with `rsync --delete` (no empty-site moment).

`FORCE=1 ~/deploy.sh` reinstalls and rebuilds everything.

## 10. Test

- `https://app.zetaaiautomations.in` → app loads, login works (email code arrives)
- `https://app.zetaaiautomations.in/api/health` → `{"status":"ok","db":"up"}`
- `https://zetaaiautomations.in` → main website still the same
- Inbox updates live without refresh (Socket.IO working)

## Troubleshooting

| Problem | Check |
|---|---|
| 502 Bad Gateway | `pm2 list`, `pm2 logs zeta-api` (often a bad `.env` value: the error lists which one) |
| Campaigns/flows stuck, messages not sending | `pm2 logs zeta-worker`, `redis-cli ping` |
| Login code never arrives | `SMTP_*` values; Gmail needs an App Password |
| Logged out on every refresh | `APP_URL` must be exactly `https://app.zetaaiautomations.in` |
| Realtime not updating | `/socket.io/` block in Nginx, `pm2 logs zeta-api` |
| Meta webhook verify fails | `META_WEBHOOK_VERIFY_TOKEN` and `META_APP_SECRET` set, API restarted |
| Server crashes on start: `ALLOW_PRIVATE_OUTBOUND_URLS must not be enabled` | Set it to `false` in `.env` (dev-only setting) |
| Build: "heap out of memory" / hangs | Swap + `NODE_OPTIONS=--max-old-space-size=1536` (step 2) |
| certbot "Timeout during connect" | Cloud firewall blocks port 80/443 (Azure inbound rule) |
| Changed `.env` | `pm2 restart zeta-api zeta-worker --update-env` (no rebuild needed) |
| Nginx error | `sudo nginx -t`, `sudo tail -f /var/log/nginx/error.log` |
| Main site broke | You removed `default`/main config or changed `@`/`www` DNS; restore them |
