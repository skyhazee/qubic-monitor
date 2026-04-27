# Qubic Monitor Bot

Telegram bot untuk monitor Qubic Guardian node, wallet, dan BOB node di beberapa VPS.

Fitur BOB monitor:

- cek tick terbaru dari BOB JSON-RPC
- hitung `tick/sec`
- bandingkan lag dengan reference tick publik
- alert ketika BOB RPC offline, stuck, behind, slow, dan recovered
- bisa monitor 2 VPS atau lebih lewat command Telegram

## BOB Endpoint Yang Dipakai

BOB expose JSON-RPC di:

```text
http://YOUR_VPS_IP:40420/qubic
```

Method yang dipakai monitor:

```json
{"jsonrpc":"2.0","method":"qubic_getTickNumber","params":[],"id":1}
```

Kalau kamu input base URL seperti `http://YOUR_VPS_IP:40420`, bot otomatis menambahkan `/qubic`.

## Local Setup

```bash
npm install
cp .env.example .env
nano .env
npm start
```

Isi `.env`:

```env
TELEGRAM_BOT_TOKEN=token_dari_botfather

BOB_CHECK_INTERVAL_MS=10000
BOB_RPC_TIMEOUT_MS=10000
BOB_OFFLINE_AFTER_ERRORS=3
BOB_STUCK_AFTER_MS=120000
BOB_LAG_THRESHOLD_TICKS=100
BOB_SLOW_TPS_THRESHOLD=0.05
REFERENCE_TICK_TIMEOUT_MS=5000
REFERENCE_TICK_LOG_INTERVAL_MS=300000
REFERENCE_TICK_URLS=https://rpc.qubic.org/v1/tick-info,https://rpc.qubic.org/live/v1/tick-info,https://guardians.qubic.org/api/v1/stats
```

## Telegram Commands

Guardian node:

| Command | Deskripsi |
| --- | --- |
| `/start` | Welcome message |
| `/add <address atau alias>` | Tambah Guardian node ke watchlist |
| `/check` | Lihat semua Guardian node |
| `/info <address atau alias>` | Info Guardian node tanpa menambahkan |
| `/history <address atau alias>` | Lihat epoch history |
| `/wallet` | Lihat saldo wallet dari operator address |
| `/remove <address atau alias>` | Hapus Guardian node |
| `/help` | Bantuan |

BOB VPS:

| Command | Deskripsi |
| --- | --- |
| `/bobadd <alias> <url>` | Tambah BOB RPC endpoint |
| `/bobcheck` | Lihat status BOB tick, tick/sec, lag, latency |
| `/bobremove <alias>` | Hapus BOB RPC endpoint |

Contoh untuk 2 VPS:

```text
/bobadd bob-vps-1 http://1.2.3.4:40420
/bobadd bob-vps-2 http://5.6.7.8:40420
/bobcheck
```

## Alert Rules

Default rule:

- `OFFLINE`: BOB RPC gagal 3x berturut-turut
- `STUCK`: tick tidak maju selama 120 detik
- `BEHIND`: lag lebih dari 100 tick dari reference
- `SLOW`: tick/sec di bawah `0.05` ketika node juga behind
- `RECOVERED`: node balik ke status OK

Threshold bisa diubah lewat `.env`.

Jika log berisi `failed to fetch external reference tick`, bot tetap jalan dan memakai tick tertinggi dari BOB node terdaftar sebagai fallback. Untuk VPS yang koneksinya sering timeout ke `rpc.qubic.org`, naikkan timeout atau pakai endpoint reference lain:

```env
REFERENCE_TICK_TIMEOUT_MS=15000
REFERENCE_TICK_URLS=https://guardians.qubic.org/api/v1/stats,https://rpc.qubic.org/v1/tick-info
```

## Deploy Di VPS

Contoh ini untuk Ubuntu 22.04/24.04.

### 1. Install dependency

```bash
sudo apt update
sudo apt install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Cek:

```bash
node -v
npm -v
pm2 -v
```

### 2. Clone repo

Pakai HTTPS:

```bash
git clone https://github.com/skyhazee/qubic-monitor.git
cd qubic-monitor
```

Atau SSH:

```bash
git clone git@github.com:skyhazee/qubic-monitor.git
cd qubic-monitor
```

### 3. Install package dan konfigurasi

```bash
npm install
cp .env.example .env
nano .env
```

Minimal isi:

```env
TELEGRAM_BOT_TOKEN=ISI_TOKEN_BOT_TELEGRAM
```

### 4. Jalankan dengan PM2

```bash
pm2 start src/index.js --name qubic-monitor
pm2 save
pm2 startup
```

Command `pm2 startup` akan menampilkan satu command `sudo env ...`. Copy dan jalankan command itu supaya bot auto-start setelah reboot.

Cek log:

```bash
pm2 logs qubic-monitor
```

Restart setelah update `.env`:

```bash
pm2 restart qubic-monitor
```

### 5. Daftarkan BOB node dari Telegram

Buka chat bot Telegram, lalu kirim:

```text
/bobadd bob-vps-1 http://IP_VPS_BOB_1:40420
/bobadd bob-vps-2 http://IP_VPS_BOB_2:40420
/bobcheck
```

Bot akan test endpoint dulu sebelum menyimpan.

## Firewall BOB VPS

Kalau monitor bot berjalan di VPS terpisah dari BOB node, pastikan port API BOB bisa diakses dari VPS monitor.

Di VPS BOB:

```bash
sudo ufw allow from IP_VPS_MONITOR to any port 40420 proto tcp
sudo ufw status
```

Hindari membuka `40420` ke seluruh internet kalau tidak perlu. Lebih aman whitelist IP VPS monitor.

Tes dari VPS monitor:

```bash
curl -X POST http://IP_VPS_BOB:40420/qubic \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"qubic_getTickNumber","params":[],"id":1}'
```

Response sukses harus berisi field `result` dengan tick number.

## Auto-Restart Di VPS BOB

Kalau BOB node lama-lama catch-up speed turun drastis setelah jalan lama, pasang script ini langsung di masing-masing VPS BOB:

```bash
cd qubic-monitor
chmod +x scripts/bob-monitor.sh
sudo ./scripts/bob-monitor.sh install
```

Monitor interaktif:

```bash
sudo ./scripts/bob-monitor.sh
```

Cek status dan log:

```bash
sudo ./scripts/bob-monitor.sh status
sudo ./scripts/bob-monitor.sh logs
```

Default logic script:

- kalau container mati, restart dengan cooldown
- kalau API port `40420` gagal beberapa kali, restart dengan cooldown
- kalau `behind <= 1000`, node dianggap sudah sync/dekat sync dan tick/sec rendah tidak memicu restart
- kalau `behind > 1000` dan speed catch-up `< 2.0 tick/s` selama `180s`, restart
- setelah restart, cooldown `900s` supaya tidak restart loop

Config bisa diubah via environment saat install/jalan:

```bash
sudo SYNC_OK_BEHIND=1000 MIN_CATCHUP_SPEED=2.0 SLOW_WINDOW=180 ./scripts/bob-monitor.sh install
```

Untuk BOB yang sudah full sync, jangan pakai threshold speed mentah seperti `MIN_SPEED=2.0` tanpa melihat `behind`, karena tick network normal bisa lebih rendah dari itu.

## Update Bot Di VPS

```bash
cd qubic-monitor
git pull
npm install
pm2 restart qubic-monitor
pm2 logs qubic-monitor
```

## Data

Bot menyimpan watchlist dan status terakhir di:

```text
data.json
```

Backup file ini kalau pindah VPS.
