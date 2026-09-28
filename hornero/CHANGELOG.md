# Changelog

## Unreleased

### ✨ Added

- **A Send tab in the panel.** Pick a recipient — the box suggests the allowed
  senders and whatever the Chats tab has loaded — type a message and send it,
  or send a camera snapshot. It checks pairing, recipient and delivery end to
  end without writing an automation first.

### 💅 Changed

- **A new mark**: the ovenbird itself, perched on its mud nest. The old icon
  was a plain brown dome that read as anything at small sizes. The panel takes
  its header mark and favicon from the same drawing, cropped in so it stays
  legible at 40px.
- **The panel works on a phone.** Tabs scroll sideways instead of wrapping into
  an unreadable block, every field takes the full width, the definition lists
  stop forcing two columns onto a 360px screen, and the code blocks shrink.
- **Settings look like settings**: each one is a row with its name, its
  explanation and a real switch, instead of a checkbox the size of a full stop.
- **Incoming moved into Settings.** Both are configuration, and seven tabs did
  not fit on a phone.
- The connection state now sits in the header, so it reads from any tab, and
  the allowlist shows each sender's name above its id.

### 🐛 Fixed

- **The actions carried no documentation outside Home Assistant's own UI.** In
  Node-RED every action read "No description provided by home assistant", with
  an empty Desc column and only three fields offered by *Load example data*.
  Names and descriptions lived in `translations/`, which only the Home
  Assistant frontend reads; the REST API that Node-RED queries serves
  `services.yaml`. That file now carries a name, a description and an example
  for all seven actions and every one of their fields.
- **The snippet builder was still English**: its field labels and every output
  block's title and explanation are now translated into all six languages.

## 4.0.2

### ✨ Added

- **Groups: only when mentioned.** With Hornero's number in a group, every
  message anyone posted there became a `hornero_message` event. The new
  `switch.hornero_groups_require_mention` passes a group message on only when
  it mentions Hornero or replies to something Hornero sent. Direct chats are
  unaffected. Off by default, so nothing changes until you turn it on.

### 🐛 Fixed

- **Notify entities for removed contacts could not be deleted.** Taking a
  contact off the Incoming list left its entity behind, unavailable, with Home
  Assistant's own Delete button greyed out — it refuses to remove an entity the
  integration still provides. They are now dropped from the entity registry as
  the allowlist changes.
- **Untranslated strings in the panel**: the Incoming tab's summary line, and
  every label and hint on the Settings tab, were hardcoded in English.

## 4.0.1

First release with images published for the Hornero name, and the panel fixes
that only surfaced once it was running.

### 🐛 Fixed

- **Broken links in the panel**: four pointed at the old repository and one at
  `whatsapp_addon/DOCS.md`, a path that no longer exists.
- **Half-translated interface.** The Help tab, the snippet builder and every
  explanatory paragraph were still English. The dictionary goes from 46 to 93
  strings across all six languages.
- **The Settings tab showed stale values.** The panel and the Home Assistant
  entities always shared one stored state, but the panel only read it when its
  tab was opened, so a switch flipped in Home Assistant left it out of date. It
  now polls while that tab is open, and skips the redraw while a control has
  focus so it cannot fight an edit in progress.
- **The notify entity showed as unavailable** with no hint why — it wanted a
  default recipient that nothing asked for. Availability now tracks the WhatsApp
  session alone, and the error names the screen to configure.

### ✨ New

- **Messages tab**: recent traffic with the delivery state of each outgoing
  message — sent, delivered, read, or failed with the reason. Recorded in the
  Baileys client, so services, notify entities and the HTTP API are all covered.
  Held in memory only and cleared on restart.
- **A notify entity per allowed sender**, named after the contact or group,
  appearing and disappearing with the allowlist. A notify entity is a single
  destination and takes no target, so one per contact is what makes it usable.
- The Help tab now covers the entities and `mark_read`; `DOCS.md` gains the HTTP
  API reference the README points at.

## 4.0.0

The project is now **Hornero**. Same purpose, own identity — and a full Home
Assistant integration rather than a handful of services.

### ⚠️ Breaking changes

- **Renamed throughout.** The add-on slug is `hornero`, the integration domain
  is `hornero`, and every service and event is renamed. **There is no
  compatibility layer**: automations need editing. MIGRATION.md has the tables.
- **You must pair your phone again**, and uninstall the old add-on first — the
  Supervisor treats the new slug as a new install.
- The pre-3.0 HTTP endpoints (`/sendMessage` and friends) are removed.
- **Only `aarch64` and `amd64` are supported.** Home Assistant's own builder no
  longer produces `armv7`, `armhf` or `i386` images, so those platforms cannot
  be published for. A 32-bit Raspberry Pi install needs to move to the 64-bit
  version of Home Assistant OS.

### ✨ New

- **Entities.** Each client is a device: a connectivity `binary_sensor`, a
  status `sensor`, the pairing QR as an `image` for dashboards, restart and
  logout `button`s, and a `notify` entity per allowed sender. The settings appear as
  switches, a number and a select.
- **Setup from the interface.** The add-on announces itself to the Supervisor,
  so Home Assistant offers to configure it; the manual dialog fills itself in.
- **Three blueprints**, importable with one click: notify on a state change,
  send a camera snapshot or clip on motion, and warn when the session drops.
- **Node-RED subflows** that import with `Ctrl+I`, no package to install.
- **Six languages** — English, Spanish, Portuguese (BR), German, French and
  Italian — across the add-on options, the service dialogs, the entity names
  and the panel.
- **Prebuilt images** published to GHCR for all five architectures. Installing
  downloads instead of compiling, which on a Raspberry Pi is the difference
  between seconds and minutes.
- **Messages tab** showing recent traffic, with the delivery state of each
  message you sent — sent, delivered, read, or failed with the reason. Held in
  memory only, so it clears when the add-on restarts.
- Own icon and logo, and a terracotta palette in the panel.

### 🧹 Internals

- `whatsapp_addon/` is now `hornero/`; the Baileys wrapper is
  `src/baileys-client.js`.
- The integration is rewritten around a config entry and a
  `DataUpdateCoordinator`, replacing the services-only `async_setup`.

## 3.5.0

### ✨ New

- **Settings tab in the panel.** Marking messages as read, the typing indicator
  and its pause, appearing online, the periodic reconnect and the log level can
  all be changed there instead of editing the add-on options and restarting.
  Everything applies immediately except appearing online and the periodic
  reconnect, which the panel marks as needing a restart.
- New `GET`/`PUT /api/v1/settings`.

### 🧹 Internals

- Settings live in `/data`, with the add-on options seeding them on first run,
  the same arrangement the allowlist already used. The client reads them live
  rather than copying them at startup, which is what lets a change take effect
  on the next message.

## 3.4.0

### ✨ New

- **Mark incoming messages as read.** The `mark_read` option does it for every
  accepted message, so chats stop piling up as unread on your phone. It shows
  the blue ticks to the sender, so it is off by default; the new
  `whatsapp.mark_read` service marks them case by case instead, taking the id
  straight from a `new_whatsapp_message` event.
- New `POST /api/v1/clients/:id/read`.

## 3.3.1

### 🐛 Fixed

- **An allowlist of phone numbers never matched incoming messages.** WhatsApp
  increasingly identifies senders by LID (`…@lid`), which does not reveal the
  phone number, and only the primary identifier was compared. Baileys supplies
  the other form of the same identity alongside it, so both are now matched:
  allowing a number covers that person's LID, and the other way round.

### ✨ New

- **Recent senders** in the Incoming tab: whoever wrote lately, allowed or
  ignored, each with an Allow button — so there is no need to work out an
  identifier you never see.
- New `GET /api/v1/recent-senders`.

## 3.3.0

### ✨ New

- **Allowlist for incoming messages.** Messages arrive in Home Assistant as
  events that automations act on, so an unfiltered inbox let any stranger
  trigger them. The new **Incoming** tab controls which senders are accepted,
  the **Groups & contacts** tab gains an **Allow** button per chat, and the
  `allowed_senders` option seeds the list on a fresh install. Listing a group
  accepts everything posted in it; listing a person accepts them anywhere.
  Leaving it empty keeps the previous behaviour of accepting everyone.
- **Typing indicator before sending.** Shows "typing…" — "recording…" for voice
  notes — and pauses for a spell that varies with the message length, so
  consecutive messages stop landing as an instant, evenly spaced burst. Photos
  and videos get the indicator without the extra pause, since the upload
  already takes a variable while. Tune it with `typing_indicator` and
  `typing_max_seconds`, or pass `typing: false` on a call to skip it for urgent
  alerts.
- **Help tab** in the panel with the services, events and addressing rules, plus
  links to the full documentation.

### 🧹 Internals

- New `GET`/`PUT /api/v1/allowlist`. The list is stored in `/data`, so editing
  it from the panel needs no add-on restart.

## 3.2.3

### 🐛 Fixed

- **The panel kept running an old version after an update.** It was served
  without `Cache-Control`, so browsers held on to a cached copy — which is why
  earlier fixes appeared not to work. It now always revalidates.
- The avatar observer was created while the script loaded, so on a browser
  without `IntersectionObserver` the whole panel would have died, copy buttons
  included. It is now created on demand and skipped if unsupported.

### 🧹 Internals

- The panel is now covered by tests: it boots in jsdom, and the suite asserts
  that each Copy button copies its own snippet and that copying falls back to
  `execCommand` when `navigator.clipboard` is unavailable, as it is over plain
  HTTP.

## 3.2.2

### ✨ New

- The snippet builder now shows the Node-RED call **both ways**: the plain
  action and data to type into a `call service` node (or the event type for an
  `events: all` node), and the importable node JSON. The fields always apply,
  whatever version of the Node-RED companion is installed.

### 🐛 Fixed

- With several snippets on screen, a block's Copy button could copy the first
  block instead of its own.

## 3.2.1

### 🐛 Fixed

- **Copy buttons did nothing.** `navigator.clipboard` only exists in secure
  contexts and ingress is served over plain HTTP, so copying now falls back to a
  hidden textarea that works without HTTPS.

### ✨ New

- The snippet builder writes **importable Node-RED nodes** instead of an
  `http request` configuration. Node-RED reaches the add-on through Home
  Assistant's websocket, so no token and no HTTP call are needed — copy the JSON
  and paste it with `Ctrl+I`.
- New builder actions for the three events the add-on fires
  (`new_whatsapp_message`, `whatsapp_message_ack`, `whatsapp_presence_update`),
  generating both an automation trigger and an `events: all` node.
- Generated YAML no longer quotes every value, but keeps phone numbers quoted so
  YAML cannot read them as integers and drop a leading zero.

## 3.2.0

### ✨ New

- **Snippet builder** in the sidebar panel. Pick a client, an action and fill in
  the fields, and it writes the call out three ways, ready to copy: **Home
  Assistant** YAML to paste into an automation, **Node-RED** as the method, URL,
  headers and payload for an `http request` node, and **curl** to try from a
  terminal. It covers text, camera snapshots and clips, images and audio by URL,
  locations, presence and profile status, with this install's real URL and token
  filled in.

- **Redesigned panel**, now split into _Status_, _Groups & contacts_ and
  _Snippet builder_ tabs, with status dots and a cleaner layout.
- **Real profile pictures** in the chat list, loaded only for the rows actually
  on screen and cached for an hour, since WhatsApp rate-limits them.

### 🧹 Internals

- New `GET /api/v1/clients/:id/avatar/:jid`, which proxies the picture because
  the ingress content policy blocks WhatsApp's CDN from the browser.
- New `GET /api/v1/connection`, served only over ingress.

## 3.1.0

### ✨ New

- **`whatsapp.send_media`** sends a snapshot straight from any `camera.*` or
  `image.*` entity — no more saving files or exposing URLs first:

  ```yaml
  action: whatsapp.send_media
  data:
    clientId: default
    to: "34600000000"
    entity_id: camera.front_door
    caption: Someone is at the door
  ```

- **Video clips.** Add `duration` to record instead of snapping, and `lookback`
  to include footage from _before_ the automation fired, which is usually the
  part worth seeing. Requires a camera that supports streaming.
- **Group and contact browser** in the sidebar panel, with search and a copy
  button. Group JIDs cannot be derived from a phone number, so this is the only
  practical way to address a group.
- New `GET /api/v1/clients/:id/chats` and `POST /api/v1/clients/:id/media`.

### 🧹 Internals

- The add-on now maps `/media`, which `camera.record` needs to write clips.
- Contacts are accumulated from WhatsApp's sync events, since Baileys 7 no
  longer ships a store. The list fills in gradually after pairing.

## 3.0.0

Released as a new add-on (`ha_whatsapp`) with its own identity, based on the
original WhatsApp add-on by Giuseppe Castaldo.

### ⚠️ Breaking changes

- **The add-on slug changed** from `whatsapp_addon` to `ha_whatsapp`. The
  Supervisor treats it as a new install, so **you must pair your phone again**
  and uninstall the v2 add-on first. See MIGRATION.md.
- **Node 20 or newer is required** (Baileys 7 is ESM-only).
- The `/api/v1` endpoints require a bearer token. The five v2 endpoints stay
  unauthenticated and unchanged.

**Automations are not affected:** the integration is still `whatsapp` and all
five services keep the same names and fields.

### ✨ New

- **Sidebar panel (ingress)** showing each client's state, with pairing by QR
  code or by 8-digit code — no more scanning a picture inside a notification.
- **Authenticated `/api/v1`** with schema-validated payloads, clear error
  messages and real HTTP status codes.
- **Sends return the message id**, so delivery can be tracked.
- New `whatsapp_message_ack` event for delivery and read receipts.
- Endpoints to check a number, restart a client, log out, and fetch the QR.
- Docker `HEALTHCHECK` on `/health`, so a dead add-on is restarted.
- New options: `api_token`, `log_level`, `mark_online`, `refresh_hours`.

### 🐛 Fixed

- `/health` always reported `connected: false`, even while connected.
- The integration's address was a container IP rewritten into `whatsapp.py` at
  every start, and broke whenever Docker reassigned it. The add-on now
  publishes a stable hostname that the integration re-reads at call time.
- Failed service calls were silently ignored; they now surface in the UI.
- Only the first message of an incoming batch raised an event.
- Reconnections retried every second forever; they now back off exponentially,
  and reconnect immediately on `restartRequired` (515).
- A failed WhatsApp version lookup no longer breaks a whole reconnection.
- Errors from Baileys kept only a status code; the original message is kept.
- `connect()` ran unawaited from the constructor, producing unhandled
  rejections.

### 🧹 Internals

- Baileys pinned to `7.0.0-rc14` with a committed `package-lock.json`, so the
  build is identical on any machine. Renovate proposes updates.
- Sources reorganised under `src/`; dropped the vendored copy of Baileys 6.7.12
  and the `log4js`, `body-parser`, `events` and `qr-image` dependencies.
- Express 5, single `pino` logger, send queue per client, and a cache for
  number lookups.
- Test suite (`npm test`) covering the v2 compatibility layer, and CI that
  actually runs.

## 2.1.0

**Stable Release**

- 🚀 **Stable release** - Incorporates all connectivity fixes
- 🔒 **Robust IP replacement** - Ensures reliable communication
- 📝 **Improved logging** - Better visibility for diagnostics
- 🐛 **Bug fixes** - Resolved DNS and network resolution issues
- 📦 **Dependencies** - Updated to Baileys v7.0.0-rc.9

This is the recommended stable version for all users. It fixes the `Failed to resolve` and `NameResolutionError` issues by intelligently using the add-on's internal IP address.

## 2.0.9

**Fix & Logging Improvement**

- 🐛 **Robust IP replacement** - Replaces `HOST` variable regardless of previous value
- 📝 **Real-time logging** - Fixed empty log lines, now showing actual file content
- ✅ **Double verification** - Checks file content in both source and destination
- 🚀 **IP 172.30.33.7** - Ensuring this IP is correctly written to the custom component

This version ensures the custom component is updated correctly with the current add-on IP.

## 2.0.8

**Bug Fix Release**

- 🐛 **Fixed script crash** - Removed problematic ip addr show command
- ✅ **Script completes** - Add-on now starts successfully
- 🔍 **Using IP 172.30.33.7** - Confirmed working IP address

This fixes the script crash that prevented the add-on from starting in v2.0.7.

## 2.0.7

**Diagnostic Release**

- 🔍 **Using bashio::addon.ip_address** - Get add-on's actual IP address
- 📝 **Extensive logging** - Added detailed logs for debugging
- 🐛 **Network diagnostics** - Shows IP, hostname, network interfaces
- ✅ **Verification** - Checks custom component before and after installation

This version adds extensive logging to diagnose the connection issue. Logs will show:

- Add-on IP address
- Network configuration
- Custom component HOST value before and after update
- Installed component verification

## 2.0.6

**Critical Fix Release**

- 🐛 **Fixed DNS hostname** - Using `whatsapp-addon` (with hyphen) instead of `whatsapp_addon`
- 🔧 **Valid DNS name** - Underscores are not valid in DNS hostnames, must use hyphens
- 📚 **Based on HA docs** - Following Home Assistant's internal network naming convention

This fixes the error: `Failed to resolve 'whatsapp_addon'`

According to Home Assistant documentation, add-on slugs with underscores must be converted to hyphens for valid DNS hostnames.

## 2.0.5

**Bug Fix Release**

- 🐛 **Fixed bashio command** - Using hardcoded slug instead of bashio::addon.slug
- 🔧 **Hardcoded whatsapp_addon** - Direct value from config.yaml
- ✅ **Should work now** - No more command not found errors

This fixes the error: `bashio::addon.slug: command not found`

## 2.0.4

**Bug Fix Release**

- 🐛 **Fixed hostname using add-on slug** - Using bashio::addon.slug instead of $HOSTNAME
- 🔧 **Improved reliability** - Add-on slug is consistent across installations
- 📝 **Better logging** - Shows configured slug for debugging

This should finally fix the hostname resolution issue by using the add-on slug (whatsapp_addon) instead of the container hostname.

## 2.0.3

**Bug Fix Release**

- 🐛 **Fixed custom component hostname** - Restored {{HOSTNAME}} placeholder
- 📝 **Improved logging** - Added hostname logging in run.sh
- 🔧 **Fixed connection issue** - Custom component can now connect to add-on

This fixes the error: `Failed to resolve '0a91b8e8-whatsapp-addon'`

## 2.0.2

**Bug Fix Release**

- 🐛 **Fixed EventEmitter import** - Changed to default import for CommonJS compatibility
- 🔧 **Fixed ESM/CommonJS interop** - eventemitter2 is a CommonJS module

This fixes the error: `SyntaxError: Named export 'EventEmitter' not found`

## 2.0.1

**Bug Fix Release**

- 🐛 **Fixed Docker build** - Added custom_component to Dockerfile
- 🐛 **Fixed run.sh paths** - Corrected paths for custom component installation
- 🐛 **Fixed .dockerignore** - Removed exclusion of custom_component folder
- 📝 **Improved logging** - Added better startup messages

This fixes the issue where the add-on would fail to start with "No such file or directory" error.

## 2.0.0

**BREAKING CHANGES - Major Update to Baileys 7.0.0-rc.9**

- 🚀 **Updated to Baileys 7.0.0-rc.9** - Latest WhatsApp Web API with improved stability
- 📦 **Migrated to ESM (ES Modules)** - Modern JavaScript module system
- 🔐 **LID Support** - Full support for Linked Device Identifiers
- 🤝 **Meta Coexistence** - Compatible with Meta Business API
- ⚡ **Performance Improvements** - 80% bundle size reduction, faster message processing
- 🛡️ **Enhanced Security** - Removed automatic ACKs to reduce ban risk
- 🔧 **Better Error Handling** - Improved error messages and async/await throughout
- 📊 **Health Check Endpoint** - New `/health` endpoint for monitoring
- 🐛 **Bug Fixes** - Multiple stability and reliability improvements
- 📝 **Updated Dependencies** - All dependencies updated to latest versions

**Migration Notes:**

- This version requires re-authentication (scan QR code again)
- Session data from previous versions is not compatible
- All API endpoints remain the same for backward compatibility

## 1.5.0

- Updated whatsapp library
- Updated docker base image

## 1.4.1

- Bug QR-Code fixed

## 1.4.0

- Updated whatsapp library
- Changed session saving method
- Special functions such as sending buttons, sending lists, etc., are no longer available.

## 1.3.5

- Revert [(Pull request)](https://github.com/giuseppecastaldo/ha-addons/pull/33)

## 1.3.4

- Bug fixed [(Pull request)](https://github.com/giuseppecastaldo/ha-addons/pull/33)
- Bug fixed [(Pull request)](https://github.com/giuseppecastaldo/ha-addons/pull/55)

## 1.3.3

- Added donation button.

## 1.3.2

- Bug fixed.

## 1.3.0

- Bug fixed.

## 1.2.4

- Bug fixed.
- Added patch for receive button on iOS (Attention! iOS receive buttons only if app is open (it seems to be a iOS app bug))

## 1.2.2

- Added the ability to always be online or offline. This could lead to not receiving notifications on other devices. (**Restard required**)
- Bug fixed.

## 1.2.1

- Fixed bug that did not allow the reception of push notifications on other devices.
- Added event presence update.
- Added two more services like subscribe presence and send presence update.

## 1.2.0

- **Changed radically command and events. Please refer to doc and developer tools for change your automations.**
- **Performance boost! (Required re-authentication)**
- Bug fixed on send location.
- Bug fixed on send mulitple buttons.

## 1.1.2

- Bug fixed.
- Performance improvements.

## 1.1.1

- Migration from Home Assistant base image to Debian image

## 1.1.0

- Added the ability to manage multiple whatsapp sessions (re-authentication required)
- Buttons bug fixed (better visibility on android devices)
- Message options bug fixed
- Bug fixed.

**NOTE:** If you have problems with the custom components being updated, please follow this steps:

- Remove Whatsapp configuration in _configuration.yaml_
- Restart Home Assistant
- Add Whatsapp configuration in _configuration.yaml_
- Restart Home Assistant

## 1.0.2

- Addedd message revoke event.
- Added buttons message type (view documentation) (may not work properly on some devices)
- Added set status service (for sets the current user's status message)
- Bug fixed.

## 1.0.1

- Initial release
