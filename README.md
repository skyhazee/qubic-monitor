# 🛡️ Qubic Node Monitor Bot

Telegram bot untuk memantau node Qubic Guardian. Tambahkan node, cek status live, lihat skor dan estimasi reward.

## Setup

1. **Clone & install**
   ```bash
   npm install
   ```

2. **Buat file `.env`**
   ```bash
   cp .env.example .env
   ```
   Isi `TELEGRAM_BOT_TOKEN` dengan token dari [@BotFather](https://t.me/BotFather)

3. **Jalankan bot**
   ```bash
   npm start
   ```
   Atau dengan auto-reload:
   ```bash
   npm run dev
   ```

## Commands

| Command | Deskripsi |
|---------|-----------|
| `/start` | Welcome message |
| `/add <address atau alias>` | Tambah node ke watchlist |
| `/check` | Lihat semua node terdaftar |
| `/info <address atau alias>` | Info node tanpa menambahkan |
| `/remove <address atau alias>` | Hapus node dari watchlist |
| `/help` | Bantuan |

## Contoh

```
/add 0xami
/add SFRKDOXIGWAXJDKTSWQDGXYDWSEBWSDRNKCTYZIKLCNKPQRXGSLAPKZGYRAD
/info bitos
/remove 0xami
```

Bot akan menampilkan:
- Status aktif (🟢/🔴) dan tipe (BOB/LITE)
- Eligible/ineligible status + alasan
- Sync status (last tick vs reference tick)
- Live scores (uptime, sync, final) dengan progress bar
- Reward points + estimasi dalam USD
- Epoch history

## Tech Stack
- Node.js
- node-telegram-bot-api
- better-sqlite3
- CoinGecko API (harga QUBIC)
- Qubic Guardians API
