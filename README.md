# Telegram Web Group & Conversation Member Scraper

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Anti-Detection Engine](https://img.shields.io/badge/engine-Camofox%20(Camoufox)-blue.svg)](https://github.com/askjo-ai/camofox)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-14%2F14%20passing-success.svg)](test/)

A high-performance, fingerprint-resistant scraper and channel subscriber automation tool for Telegram, driven by [Camofox](https://github.com/askjo-ai/camofox) (anti-detection browser server running Camoufox) and Telegram Web K.

Unlike traditional MTProto-based scrapers, this project **does not require Telegram Developer API credentials (`API_ID`, `API_HASH`)** or numeric group IDs. It operates directly through an authenticated Telegram Web session with a persistent user profile.

---

## 🌟 Key Features

- 💬 **Conversation Message History Scraping (`scrapeMembersFromMessages`)**:
  - Traverses deep chat message histories to extract all active participants and senders.
  - **Bypasses member list restrictions**: Successfully scrapes group members even when the group administrator has hidden the participant list.
  - Records activity metrics per user: `message_count` (total authored messages) and `last_active_at` timestamp.

- 👥 **Member List Virtual Scroll Scraping (`scrapeParticipantsFromMemberList`)**:
  - Extracts visible participants from public group member panels.

- 🌐 **Multi-Group Aggregator (`npm run multi-scrape`)**:
  - Scrapes multiple groups sequentially in a single pass (e.g. `@arayises`, `@benimhocamkpss`, `@kodu_group`).
  - Automatic cross-group deduplication keyed by Telegram numeric user ID.
  - Continuous incremental saving to CSV so progress is never lost.

- 🚀 **Automated Channel Subscriber Adder (`npm run add-subscribers`)**:
  - Automatically adds scraped usernames to your target Telegram channel (`Subscribers -> Add Subscribers`).
  - **Adaptive Rate Limit & Flood Protection**:
    - Randomized human-like jitter delays (3s – 6s) between invite requests.
    - Periodic cooldown pauses (12s breather every 10 invites).
    - **`FLOOD_WAIT` Detection**: Automatically detects Telegram server cooldown timers and pauses gracefully to protect your account.
    - **Smart Resume**: Remembers previously processed and privacy-restricted users (`subscribers-result.csv`) to skip redundant requests on subsequent runs.

- 🛡️ **Anti-Detection & Persistent Session**:
  - Powered by Camoufox C++ browser engine with humanized fingerprinting and hardware emulation.
  - Interactive first-run login (QR code / VNC) with automatic session reuse across runs.

---

## 📁 Repository Structure

```
├── script.js             # Core scraper CLI & dual-mode scraper engine
├── multi-scrape.js       # Multi-group scraper (aggregates across multiple groups)
├── add-subscribers.js    # Rate-protected channel subscriber invitation tool
├── package.json          # Scripts, dependencies, and engine requirements
├── .env.example          # Environment configuration template
├── test/
│   ├── normalize.test.js       # Target URL and handle normalization tests
│   ├── scraper.test.js         # REST client and scraping engine unit tests
│   ├── add-subscribers.test.js # Subscriber adder and error-handling tests
│   └── multi-scrape.test.js    # Multi-group aggregator unit tests
└── README.md             # Project documentation
```

---

## 🚀 Prerequisites

1. **Node.js** `>= 20.0.0`
2. **Camofox Browser Server** running locally on port `9377`:

```sh
# Start Camofox in a separate terminal
npx @askjo/camofox-browser
```

---

## 🛠️ Installation & Setup

1. Clone the repository:

```sh
git clone https://github.com/thecoldblooded/telegram-group-member-scraper.git
cd telegram-group-member-scraper
```

2. Install dependencies:

```sh
npm install
```

3. Create your `.env` configuration:

```sh
cp .env.example .env
```

4. Configure `.env` parameters:

```ini
# Target group/channel username, invite link, or URL
TARGET=https://t.me/examplegroup

# Scraping mode: 'messages', 'members', or 'both' (default: both)
SCRAPE_MODE=both

# Target unique user goal before stopping (default: 1000)
USER_LIMIT=1000

# Maximum conversation messages to inspect (default: 50000)
MESSAGE_LIMIT=50000

# Camofox browser server endpoint (default: http://127.0.0.1:9377)
CAMOFOX_URL=http://127.0.0.1:9377

# Persistent Camofox user profile ID (retains login across runs)
CAMOFOX_USER_ID=tg-scraper-user

# Output CSV file path (default: participants.csv)
CSV_OUTPUT=participants.csv
```

---

## 📖 Usage Guide

### 1. Single Group Scraping

Extracts members from both conversation messages and group member lists for a single target:

```sh
npm start
```

Or pass target parameters dynamically via CLI:

```sh
TARGET=https://t.me/kodu_group USER_LIMIT=1000 SCRAPE_MODE=both npm start
```

### 2. Multi-Group Aggregation (`multi-scrape`)

Scrapes multiple target groups sequentially to build a large deduplicated dataset (e.g. 10,000 users):

```sh
# Run with default multi-targets
npm run multi-scrape

# Or specify custom target groups
TARGETS="https://web.telegram.org/k/#@arayises,https://web.telegram.org/k/#@benimhocamkpss,https://web.telegram.org/k/#@kodu_group" USER_GOAL=10000 npm run multi-scrape
```

### 3. Adding Subscribers to a Telegram Channel

Invites the scraped users from `participants.csv` into your Telegram channel:

```sh
npm run add-subscribers https://web.telegram.org/k/#@yourchannel participants.csv
```

With custom delay and safety parameters:

```sh
DELAY_MIN_MS=4000 DELAY_MAX_MS=8000 npm run add-subscribers https://web.telegram.org/k/#@yourchannel participants.csv
```

---

## 🔐 Authentication Workflow

1. **First Run**:
   - If your persistent Camofox profile (`CAMOFOX_USER_ID`) is not yet logged into Telegram Web, the scraper detects the login screen.
   - It captures and saves the QR code to `telegram-login-qr.png`.
   - Scan the QR code using your Telegram mobile app (*Settings -> Devices -> Link Desktop Device*).
2. **Subsequent Runs**:
   - Authentication cookies, localStorage, and IndexedDB state are retained permanently in your persistent profile directory.
   - All subsequent runs authenticate instantly in headless mode.

---

## 📊 CSV Output Schema

Scraped user data is saved to `participants.csv` with the following columns:

| Column | Type | Description |
|---|---|---|
| `id` | `String` | Unique Telegram numeric peer ID |
| `username` | `String` | Telegram username handle (`@username`) |
| `first_name` | `String` | First name |
| `last_name` | `String` | Last name |
| `name` | `String` | Full display name (`first_name` + `last_name`) |
| `phone` | `String` | Publicly shared phone number (if available) |
| `is_bot` | `Boolean` | `true` if account is a Telegram bot, `false` otherwise |
| `status` | `String` | Last seen presence status (`online`, `Recently`, `WithinWeek`, etc.) |
| `message_count` | `Number` | Total authored messages in scanned conversation history |
| `last_active_at` | `ISO 8601` | Timestamp of latest message authored by this user |
| `target` | `String` | Group handle(s) where the user was active |
| `scraped_at` | `ISO 8601` | Timestamp when the user record was scraped |

---

## ⚙️ Configuration Reference

| Environment Variable | Default | Description |
|---|---|---|
| `TARGET` | `https://t.me/examplegroup` | Single target group username or URL |
| `TARGETS` | `@arayises,@benimhocamkpss,@kodu_group` | Comma-separated target list for `multi-scrape` |
| `SCRAPE_MODE` | `both` | Scrape mode: `messages`, `members`, or `both` |
| `USER_LIMIT` / `USER_GOAL` | `1000` / `10000` | Target count of unique users before completing |
| `MESSAGE_LIMIT` | `50000` | Safety limit on total conversation messages to inspect |
| `CAMOFOX_URL` | `http://127.0.0.1:9377` | Camofox server endpoint |
| `CAMOFOX_USER_ID` | `tg-scraper-user` | Stable persistent browser profile identifier |
| `CSV_OUTPUT` | `participants.csv` | Path to export scraped participant records |
| `DELAY_MIN_MS` | `3000` | Minimum jitter delay (ms) between channel invite requests |
| `DELAY_MAX_MS` | `6000` | Maximum jitter delay (ms) between channel invite requests |
| `SCROLL_MAX_ITERATIONS` | `100` | Max iterations for DOM member list virtual scrolling |
| `SCROLL_IDLE_LIMIT` | `8` | Stop after N consecutive scrolls with no new users found |

---

## 🛡️ Telegram Privacy & Flood Protection Notes

- **User Privacy Settings**: Telegram users have a privacy setting (*"Who can add me to groups & channels"*). If set to *"My Contacts"*, Telegram restricts direct additions (`PRIVACY_RESTRICTED`). These users are cleanly classified and logged in `subscribers-result.csv`.
- **Flood Limits (`PEER_FLOOD` / `FLOOD_WAIT`)**: Telegram limits the rate of adding non-mutual contacts to channels. The `add-subscribers` script includes jitter delays, periodic cooldowns, and automatic timer detection to protect your account.

---

## 🧪 Testing

The repository includes a comprehensive test suite covering target normalization, REST client operations, error handling, subscriber invitation routines, and multi-target aggregation.

Run tests using Node's native test runner:

```sh
npm test
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
