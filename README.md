# LASERJS

## English

### What is this
Node.js 18+ client for the Brawl Stars v69 protocol. JavaScript dependencies are already in `vendor/`, no npm install needed.

### What it does
- Connects to a server over TCP (+ UDP for battles) and logs in (new or saved account).
- Picks a nickname from `names.txt` for new accounts.
- Team rooms: create, join by code / ID, show members, chat, leave.
- Spectate: attach viewers to a player, keep the battle session alive, retry after battle end.
- Bots mode (`--piar`): many bots create rooms, scan neighbor IDs, join free rooms, send a message and leave.
- Saves traffic to `logs/traffic.jsonl` and packet dumps to `dumps/`, downloads game assets to `sc/`.

### How to connect
1. Edit `settings.json` (server version, hash, public key):
```json
{
  "host": "127.0.0.1",
  "port": 9339
}
```

2. Run:
```bash
node index.js
node index.js 127.0.0.1 9339
node index.js --help
```

3. After `LoginOk`, use terminal commands:
```text
/createRoom
/joinRoom X...
/joinRoom HIGH-LOW
/room
/chat hello
/leaveRoom
/spectate #2PP 100 true
/spectate stop
/help
```

Notes:
- `/joinRoom` needs a room code or ID from `/createRoom` or `/room`.
- `/spectate #TAG N true|false`: `N` is viewer count (`0` = unlimited), `true` sets the Brawl TV flag.
- Viewers need the player to be in a watchable battle; otherwise they retry automatically.
- UDP host/port comes from server message `24112` and must be reachable from the client.
- Bots mode:
```bash
node index.js --piar
node index.js --piar --piar-bots 100
```
- Useful options: `--host`, `--port`, `--config FILE`, `--piar`, `--piar-bots N`, `--dump`, `--dump-sc`, `--no-log`, `--verbose`, `--no-color`, `--help`. Other settings live in `settings.json`. Paths in JSON are relative to the settings file. Use `settings.local.json` + `--config settings.local.json` for local tokens.

---

## Русский

### Что это
Клиент протокола Brawl Stars v69 на Node.js 18+. Зависимости уже лежат в `vendor/`, установка через npm не нужна.

### Что делает
- Подключается к серверу по TCP (+ UDP для боя) и логинится (новый или сохранённый аккаунт).
- Берёт ник из `names.txt` для новых аккаунтов.
- Комнаты: создание, вход по коду / ID, просмотр участников, чат, выход.
- Наблюдение: подключает зрителей к игроку, держит сессию боя, повторяет запрос после конца боя.
- Режим ботов (`--piar`): много ботов создают комнаты, сканируют соседние ID, заходят в свободные комнаты, отправляют сообщение и выходят.
- Сохраняет трафик в `logs/traffic.jsonl`, дампы пакетов в `dumps/`, игровые файлы в `sc/`.

### Как подключиться
1. Настрой `settings.json` (версия сервера, хеш, публичный ключ):
```json
{
  "host": "127.0.0.1",
  "port": 9339
}
```

2. Запусти:
```bash
node index.js
node index.js 127.0.0.1 9339
node index.js --help
```

3. После `LoginOk` используй команды:
```text
/createRoom
/joinRoom X...
/joinRoom HIGH-LOW
/room
/chat привет
/leaveRoom
/spectate #2PP 100 true
/spectate stop
/help
```

Заметки:
- Для `/joinRoom` нужен код или ID комнаты из `/createRoom` или `/room`.
- `/spectate #TAG N true|false`: `N` — число зрителей (`0` = без лимита), `true` — флаг Brawl TV.
- Зрителям нужен игрок в бою, доступном для наблюдения, иначе запрос повторяется автоматически.
- Адрес/порт UDP приходит от сервера в сообщении `24112` и должен быть доступен клиенту.
- Режим ботов:
```bash
node index.js --piar
node index.js --piar --piar-bots 100
```
- Полезные опции: `--host`, `--port`, `--config FILE`, `--piar`, `--piar-bots N`, `--dump`, `--dump-sc`, `--no-log`, `--verbose`, `--no-color`, `--help`. Остальное — в `settings.json`. Пути в JSON считаются от файла настроек. Для локальных токенов используй `settings.local.json` + `--config settings.local.json`.
