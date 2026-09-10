from pathlib import Path
Path('deploy/README.md').write_text('''# Production deployment

Target: `https://bitrixameria.duckdns.org/` on Ubuntu/DigitalOcean.

## 1. DNS and packages

Point the DuckDNS A record to the server public IPv4 address, then connect over SSH:

```bash
sudo apt update
sudo apt install -y git nginx mysql-server certbot python3-certbot-nginx ufw curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

## 2. Application and database

```bash
sudo mkdir -p /opt/milon-ameria
sudo chown -R "$USER":"$USER" /opt/milon-ameria
git clone https://github.com/TGG3Consulting/Milon_ameria.git /opt/milon-ameria
cd /opt/milon-ameria
npm ci
sudo mysql < database/schema.sql
```

Create a dedicated MySQL user instead of using root:

```bash
sudo mysql
CREATE USER 'milon_app'@'localhost' IDENTIFIED BY 'CHANGE_THIS_PASSWORD';
GRANT ALL PRIVILEGES ON milon_ameria.* TO 'milon_app'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

Create `/opt/milon-ameria/.env` from `.env.example`. At minimum set:

```env
NODE_ENV=production
CLIENT_ORIGIN=https://bitrixameria.duckdns.org
BITRIX_ALLOWED_DOMAINS=milonmining24.bitrix24.ru
BITRIX_AUTH_REQUIRED=true
AMERIA_BASE_URL=https://online.ameriabank.am/OnlineBanking/CorporateApi/
AMERIA_PROXY_URL=
Ameria_access_Key=YOUR_AMERIA_ACCESS_KEY
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=milon_ameria
DB_USER=milon_app
DB_PASSWORD=CHANGE_THIS_PASSWORD
ADMIN_ACCESS_TOKEN=GENERATE_A_LONG_RANDOM_VALUE
```

Build the server and client:

```bash
npm run build
sudo mkdir -p /opt/milon-ameria/data
sudo chown -R www-data:www-data /opt/milon-ameria/data
sudo chown www-data:www-data /opt/milon-ameria/.env
sudo chmod 600 /opt/milon-ameria/.env
```

## 3. Start the API with systemd

```bash
sudo cp deploy/systemd/milon-ameria.service /etc/systemd/system/milon-ameria.service
sudo systemctl daemon-reload
sudo systemctl enable --now milon-ameria
sudo systemctl status milon-ameria
```

## 4. Nginx and SSL

```bash
sudo cp deploy/nginx/bitrixameria.duckdns.org.conf.example /etc/nginx/sites-available/bitrixameria.duckdns.org
sudo ln -s /etc/nginx/sites-available/bitrixameria.duckdns.org /etc/nginx/sites-enabled/bitrixameria.duckdns.org
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d bitrixameria.duckdns.org
sudo systemctl reload nginx
```

The Nginx template serves the Vite build, proxies `/api/` to port 4000, and allows the Bitrix portal to iframe the app.

## 5. Bitrix local application

In the Bitrix24 portal create/install a local application with application URL:

```text
https://bitrixameria.duckdns.org/
```

Set the portal domain in `BITRIX_ALLOWED_DOMAINS`. Open the application from Bitrix24; direct browser access is intentionally rejected in production. The app verifies the Bitrix launch user, writes users and sessions to MySQL, and records login/logout in `audit_events`.

For updates:

```bash
cd /opt/milon-ameria
git pull origin main
npm ci
npm run build
sudo systemctl restart milon-ameria
```
''',encoding='utf-8')
print('created deployment guide')
