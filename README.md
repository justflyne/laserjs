# LASERJS

## English

### What is this
fake-client to connect prod brawl stars (game.brawlstarsgame.com:9339). Node.js 18+ client for the v69 protocol. JavaScript dependencies are already in `vendor/`, no npm install needed.

### What it does
- Connects to prod over TCP (+ UDP for battles) and logs in (new or saved account).
- Picks a nickname from `names.txt` for new accounts.
- Team rooms: create, join by code / ID, show members, chat, leave.
- Spectate: attach viewers to a player, keep the battle session alive, retry after battle end.
- Saves traffic to `logs/traffic.jsonl` and packet dumps to `dumps/`, downloads game assets to `sc/`.

---

## Русский

### Что это
fake-client to connect prod brawl stars (game.brawlstarsgame.com:9339). Клиент протокола v69 на Node.js 18+. Зависимости уже лежат в `vendor/`, установка через npm не нужна.

### Что делает
- Подключается к проду по TCP (+ UDP для боя) и логинится (новый или сохранённый аккаунт).
- Берёт ник из `names.txt` для новых аккаунтов.
- Комнаты: создание, вход по коду / ID, просмотр участников, чат, выход.
- Наблюдение: подключает зрителей к игроку, держит сессию боя, повторяет запрос после конца боя.
- Сохраняет трафик в `logs/traffic.jsonl`, дампы пакетов в `dumps/`, игровые файлы в `sc/`.
