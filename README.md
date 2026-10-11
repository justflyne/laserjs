# LASERJS

## English

### What is this
Fake-client to connect prod Brawl Stars server (game.brawlstarsgame.com:9339). Node.js 18+ client for the v69 protocol. JavaScript dependencies are already in `vendor/`, no npm install needed.

### How to run
1. Edit `settings.json` (server version, hash, public key):
```json
{
  "host": "game.brawlstarsgame.com",
  "port": 9339
}
```

2. Start:
```bash
node index.js
node index.js game.brawlstarsgame.com 9339
node index.js --help
```

3. Wait for `LoginOk`, then type commands in the terminal.

### Flags
Full docs are built into the script:
```bash
node index.js --help
```

Available flags:
```text
--host HOST / --port N  Server (default: game.brawlstarsgame.com:9339)
--config FILE          JSON settings file (default: settings.json)
--piar                 Bot flow visiting rooms with a message from names.txt
--piar-bots N          Concurrent bots; 0 / unlimited = no limit
--dump                 Save packet dumps to dumps/
--dump-sc              Download SC assets from OwnHomeData to sc/
--no-log               Disable packet journal (logs/traffic.jsonl)
--verbose              Verbose output
--no-color             Disable colors
--help, -h             Show help and exit
```
Extra settings (versions, tokens, timeouts, paths) live in `settings.json`. Paths in JSON are relative to the settings file. For local tokens use `settings.local.json`:
```bash
cp settings.json settings.local.json
node index.js --config settings.local.json
```

### Commands
All commands work after `LoginOk`:

| Command | What it does |
| --- | --- |
| `/createRoom` | Creates a team room. After creation the client prints `/joinRoom X...` for a second client |
| `/joinRoom X...` | Joins a room by code (also accepts `HIGH-LOW` or decimal ID from `/createRoom` / `/room`) |
| `/room` | Shows current room: code, ID, type, members, owner, chat state |
| `/chat TEXT` | Sends a chat message to the current room (unmutes first if needed, waits for server echo) |
| `/leaveRoom` | Leaves the current room |
| `/spectate #TAG N true\|false` | Starts `N` viewers on player `#TAG` (`0` = unlimited). `true` = Brawl TV flag, `false` = normal spectate. Retries automatically if the player has no watchable battle |
| `/spectate stop` | Stops running spectator bots |
| `/help` | Prints command list |

UDP host/port for battles comes from server message `24112` and must be reachable from the client.

---

## Русский

### Что это
Фейк-клиент для подключения к прод-серверу Brawl Stars (game.brawlstarsgame.com:9339). Клиент протокола v69 на Node.js 18+. Зависимости уже лежат в `vendor/`, установка через npm не нужна.

### Как запускать
1. Настрой `settings.json` (версия сервера, хеш, публичный ключ):
```json
{
  "host": "game.brawlstarsgame.com",
  "port": 9339
}
```

2. Запуск:
```bash
node index.js
node index.js game.brawlstarsgame.com 9339
node index.js --help
```

3. Дождись `LoginOk`, затем вводи команды в терминал.

### Флаги
Подробная документация встроена в скрипт:
```bash
node index.js --help
```

Доступные флаги:
```text
--host HOST / --port N  Сервер (по умолчанию: game.brawlstarsgame.com:9339)
--config FILE          Файл настроек JSON (по умолчанию: settings.json)
--piar                 Поток ботов: ходят по комнатам с сообщением из names.txt
--piar-bots N          Число ботов; 0 / unlimited = без лимита
--dump                 Сохранять дампы пакетов в dumps/
--dump-sc              Скачивать SC-ассеты из OwnHomeData в sc/
--no-log               Отключить журнал пакетов (logs/traffic.jsonl)
--verbose              Подробный вывод
--no-color             Отключить цвета
--help, -h             Показать помощь и выйти
```
Остальные настройки (версии, токены, таймауты, пути) лежат в `settings.json`. Пути в JSON считаются от файла настроек. Для локальных токенов используй `settings.local.json`:
```bash
cp settings.json settings.local.json
node index.js --config settings.local.json
```

### Команды
Все команды работают после `LoginOk`:

| Команда | Что делает |
| --- | --- |
| `/createRoom` | Создаёт комнату. После создания клиент печатает готовый `/joinRoom X...` для второго клиента |
| `/joinRoom X...` | Вход в комнату по коду (также принимает `HIGH-LOW` или decimal ID из `/createRoom` / `/room`) |
| `/room` | Показывает текущую комнату: код, ID, тип, участников, владельца, состояние чата |
| `/chat TEXT` | Отправляет сообщение в текущую комнату (при нужде сначала снимает мут, ждёт эхо сервера) |
| `/leaveRoom` | Выйти из текущей комнаты |
| `/spectate #TAG N true\|false` | Запускает `N` зрителей на игрока `#TAG` (`0` = без лимита). `true` = флаг Brawl TV, `false` = обычное наблюдение. Если боя нет — повторяет запрос автоматически |
| `/spectate stop` | Останавливает запущенных зрителей |
| `/help` | Список команд |

Адрес/порт UDP для боя приходит от сервера в сообщении `24112` и должен быть доступен клиенту.
