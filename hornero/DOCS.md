# Hornero — service and event reference

Service and event reference. For installation and upgrading, see the
[project README](https://github.com/pabloantonelli/hornero#readme).

## The services at a glance

| Service                                 | What it does                                         |
| --------------------------------------- | ---------------------------------------------------- |
| `hornero.send_message`                  | Text, images, audio, documents, locations, reactions |
| `hornero.send_media`                    | A file, URL, base64 data, or a camera snapshot/clip  |
| `hornero.download_media`                | Fetch the file of a received message                 |
| `hornero.react`                         | React to a message, or remove the reaction           |
| `hornero.edit_message`                  | Change the text of a message you sent                |
| `hornero.delete_message`                | Delete a message for everyone                        |
| `hornero.send_poll`                     | Send a poll; votes arrive as events                  |
| `hornero.send_location`                 | Send a pin on the map                                |
| `hornero.get_group`                     | A group's name, description and members              |
| `hornero.list_groups`                   | Every group the account is in                        |
| `hornero.resolve_contact`               | Phone number ↔ LID, with the person's name           |
| `hornero.mark_read`                     | Mark a received message as read                      |
| `hornero.set_status`                    | Change the profile status text                       |
| `hornero.presence_subscribe`            | Follow a contact's online and typing status          |
| `hornero.send_presence_update`          | Appear online, typing or recording                   |
| `hornero.send_infinity_presence_update` | Keep a presence showing until stopped                |

Every action that sends something returns `message_id`, `chat`, `timestamp`
and the whole `key`, so a script can keep acting on the message with
`response_variable`. The older `messageId` and `to` fields are still there.
`download_media`, `get_group`, `list_groups` and `resolve_contact` exist only
for their answer, so they must be called with `response_variable`.

Rather than writing these from memory, use the **Snippet builder** tab of the
Hornero panel: it fills in the fields and copies the call out as Home Assistant
YAML, as an importable Node-RED node, or as `curl`.

## How to use

### **How to pair an account**

Open **WhatsApp** in the Home Assistant sidebar. Each configured client shows
its own card, where you can either scan the QR code or enter your phone number
to get an 8-digit pairing code (**WhatsApp → Linked devices → Link with phone
number**).

### **How to add another account**

Go to configuration page in clients input box digit the desired clientId. This one represents an identifier for the session.

Each client is paired separately from the sidebar panel.

### **How to get a User ID**

The user id is made from three parts:

- Country code (Example 39 (Italy))
- User's number
- And a static part: @s.whatsapp.net (for users) @g.us (for groups)

For example for Italian number _3456789010_ the user id is the following _393456789010@s.whatsapp.net_

### **Send a simple text message**

```yaml
action: hornero.send_message
data:
  clientId: default
  to: 391234567890@s.whatsapp.net # User ID
  body:
    text: Hi it's a simple text message
```

### **How to send an image**

```yaml
action: hornero.send_message
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  body:
    image:
      url: "https://dummyimage.com/600x400/000/fff.png"
    caption: Simple text
```

### **How to send a camera snapshot or clip**

Captures directly from a `camera.*` or `image.*` entity — no file to save, no
URL to expose.

```yaml
action: hornero.send_media
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  entity_id: camera.front_door
  caption: Someone is at the door
```

Add `duration` to record a clip instead, and `lookback` to include the seconds
recorded before the call:

```yaml
action: hornero.send_media
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  entity_id: camera.front_door
  duration: 10
  lookback: 5
```

Clips need a camera with the `stream` component; still-image cameras can send
snapshots only.

### **How to send audio message**

```yaml
action: hornero.send_message
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  body:
    audio:
      url: "https://github.com/giuseppecastaldo/ha-addons/blob/main/whatsapp_addon/examples/hello_world.mp3?raw=true"
    ptt: true # Send audio as a voice
```

### **How to send a location**

```yaml
action: hornero.send_message
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  body:
    location:
      degreesLatitude: 24.121231
      degreesLongitude: 55.1121221
```

### **Send a file, a URL or base64 data**

`send_media` takes exactly one source: `entity_id`, `path` (a file under
`/config` or `/media`), `url` or `data` (base64, or a `data:` URL). `kind`
picks how WhatsApp shows it — `image`, `video`, `audio`, `document` or
`sticker` — and is guessed from the type when left out.

```yaml
action: hornero.send_media
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  path: /media/reports/consumption.pdf
  kind: document
  file_name: consumption-october.pdf
  caption: October's consumption
response_variable: sent # {message_id, chat, timestamp, key, …}
```

A voice note from a text-to-speech file — anything that is not already
Ogg/Opus is converted with ffmpeg:

```yaml
action: hornero.send_media
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  url: http://homeassistant.local:8123/api/tts_proxy/abc123.mp3
  ptt: true
```

Images and short clips can go out as stickers with `kind: sticker`; they are
converted to a 512×512 WebP. Files over the size limit (20 MB by default) are
refused.

### **Download a received picture, voice note or document**

Incoming media carries a `media` block (see [Events](#events)). The file is
kept downloadable for 24 hours by default, only for allowed senders:

```yaml
action: hornero.download_media
data:
  clientId: "{{ trigger.event.data.clientId }}"
  media_id: "{{ trigger.event.data.media.media_id }}"
response_variable: file
```

`file` is `{content_type, size, data_base64, media}`. With `save_to` the file
is written instead and `file.path` returned; `save_to` must be under
`/config/www/hornero` (served at `/local/hornero/…`) or `/media`, and a folder
ending in `/` gets a name made from the message id:

```yaml
action: hornero.download_media
data:
  clientId: default
  media_id: 3EB0C2D4E5F6A7B8C9D0
  save_to: /media/hornero/incoming/
response_variable: file # {path, content_type, size, media}
```

WhatsApp's download links expire; when one has, Hornero asks the sender's
phone to upload the file again, which works while the phone is online.

### **React, edit and delete**

Name the message by `message_id` — plus `chat` when it is not among the
recent ones — or pass the whole `key` from an event or a send response.

```yaml
action: hornero.react
data:
  clientId: default
  chat: "{{ trigger.event.data.key.remoteJid }}"
  message_id: "{{ trigger.event.data.key.id }}"
  emoji: "👀" # an empty string removes the reaction
```

```yaml
- action: hornero.send_message
  data:
    clientId: default
    to: 391234567890@s.whatsapp.net
    body:
      text: Washing machine running…
  response_variable: sent
- wait_for_trigger:
    - trigger: state
      entity_id: sensor.washing_machine
      to: idle
- action: hornero.edit_message
  data:
    clientId: default
    message_id: "{{ sent.message_id }}"
    text: Washing machine finished ✅
```

```yaml
action: hornero.delete_message
data:
  clientId: default
  message_id: "{{ sent.message_id }}"
```

WhatsApp only allows edits for about 15 minutes. Deleting someone else's
message needs its whole `key` and admin rights in the group.

The same can still be done through `send_message` with a raw `body`:
`{"react": {"text": "👍", "key": …}}`, `{"text": "…", "edit": <key>}` or
`{"delete": <key>}`.

### **Send a poll and read the votes**

```yaml
action: hornero.send_poll
data:
  clientId: default
  to: 120363000000000000@g.us
  question: Dinner tonight?
  options: ["Pizza", "Sushi", "Tacos"]
  selectable_count: 1 # 0 lets each person pick any number
```

Each vote fires `hornero_poll_vote` with the chosen option names. Votes are
encrypted with a secret only the sender of the poll has, so they can be read
for polls sent from Hornero, for 30 days.

### **Send a location**

```yaml
action: hornero.send_location
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  latitude: 41.8902
  longitude: 12.4922
  name: Colosseum
  address: Piazza del Colosseo, Rome
```

### **Look up groups and contacts**

```yaml
action: hornero.list_groups
data:
  clientId: default
response_variable: result # {groups: [{id, name, description, size, announce, restrict}]}
```

```yaml
action: hornero.get_group
data:
  clientId: default
  group_id: 120363000000000000@g.us
response_variable: group
```

```json
{
  "id": "120363000000000000@g.us",
  "name": "Family",
  "description": "Dinner plans",
  "owner": "391234567890@s.whatsapp.net",
  "created": "2023-11-14T22:13:20.000Z",
  "size": 2,
  "announce": false,
  "restrict": false,
  "participants": [
    {
      "id": "391234567890@s.whatsapp.net",
      "phone": "391234567890",
      "lid": "173478124720340@lid",
      "admin": "superadmin"
    },
    {
      "id": "390987654321@s.whatsapp.net",
      "phone": "390987654321",
      "lid": "209876543210987@lid",
      "admin": null
    }
  ]
}
```

`resolve_contact` turns a LID into the phone number behind it, or the other
way round, with the name the person goes by. A LID WhatsApp has not mapped yet
comes back with `phone: null`.

```yaml
action: hornero.resolve_contact
data:
  clientId: default
  contact: 173478124720340@lid
response_variable: who
# {jid: 391234567890@s.whatsapp.net, phone: "391234567890",
#  lid: 173478124720340@lid, push_name: Anna}
```

### **How to subscribe to presence update**

```yaml
action: hornero.presence_subscribe
data:
  clientId: default
  userId: 391234567890@s.whatsapp.net
```

---

## Events

| Event type           | Description                                  |
| -------------------- | -------------------------------------------- |
| hornero_message      | The message that was received                |
| hornero_reaction     | Someone reacted to a message                 |
| hornero_poll_vote    | Someone voted on a poll sent from Hornero    |
| hornero_group_update | Members, name or settings of a group changed |
| hornero_presence     | Presence of contact in a chat updated        |
| hornero_message_ack  | A message you sent was delivered or read     |

Every event carries the `clientId` it came from. Reactions and votes follow
the same allowlist as messages; group changes are reported for allowed groups
only. Wherever a person appears, both forms of their id are given: `author`
(the phone-number JID when known), `author_phone` and `author_lid`.

### hornero_message

The raw message from WhatsApp, as always, plus two optional blocks. `media`
is present when the message carries a picture, audio, voice note, video,
document or sticker; the file itself is not in the event — fetch it with
`download_media`. `quoted` is present when the message replies to another.

```json
{
  "clientId": "default",
  "type": "audioMessage",
  "key": {
    "remoteJid": "391234567890@s.whatsapp.net",
    "fromMe": false,
    "id": "3EB0C2D4E5F6A7B8C9D0"
  },
  "pushName": "Anna",
  "message": { "audioMessage": { "…": "…" } },
  "media": {
    "type": "audio",
    "mimetype": "audio/ogg; codecs=opus",
    "size": 18342,
    "seconds": 6,
    "ptt": true,
    "caption": null,
    "file_name": null,
    "media_id": "3EB0C2D4E5F6A7B8C9D0"
  },
  "quoted": {
    "message_id": "3EB0AA11BB22CC33DD44",
    "author": "390000000000@s.whatsapp.net",
    "author_phone": "390000000000",
    "author_lid": null,
    "from_me": true,
    "text": "Shall I turn the heating on?"
  }
}
```

`media.type` is `image`, `audio`, `video`, `document` or `sticker`; `seconds`
is set for audio and video, and `ptt` is true for a voice note.
`quoted.from_me` tells whether the message answered was sent by this account.

A voice note that gets transcribed:

```yaml
- alias: Transcribe voice notes
  triggers:
    - trigger: event
      event_type: hornero_message
  conditions:
    - condition: template
      value_template: "{{ trigger.event.data.media is defined and trigger.event.data.media.ptt }}"
  actions:
    - action: hornero.download_media
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        media_id: "{{ trigger.event.data.media.media_id }}"
        save_to: /media/hornero/voice/
      response_variable: file
    # file.path now points at the .ogg; hand it to your speech-to-text.
```

### hornero_reaction

```json
{
  "clientId": "default",
  "chat": "120363000000000000@g.us",
  "author": "391234567890@s.whatsapp.net",
  "author_phone": "391234567890",
  "author_lid": "173478124720340@lid",
  "push_name": "Anna",
  "message_id": "3EB0AA11BB22CC33DD44",
  "emoji": "👍",
  "removed": false,
  "from_me": true
}
```

`message_id` is the message reacted to, and `from_me` whether it was sent by
this account. A withdrawn reaction comes with an empty `emoji` and
`removed: true`. Reactions made by this account are not reported.

### hornero_poll_vote

```json
{
  "clientId": "default",
  "chat": "120363000000000000@g.us",
  "author": "391234567890@s.whatsapp.net",
  "author_phone": "391234567890",
  "author_lid": "173478124720340@lid",
  "push_name": "Anna",
  "poll_message_id": "3EB0F1E2D3C4B5A69788",
  "poll_name": "Dinner tonight?",
  "selected_options": ["Sushi"]
}
```

Each event holds that person's whole current choice: changing a vote sends the
new selection, and withdrawing it sends an empty list.

### hornero_group_update

```json
{
  "clientId": "default",
  "chat": "120363000000000000@g.us",
  "group_name": "Family",
  "action": "add",
  "participants": [
    {
      "id": "390987654321@s.whatsapp.net",
      "phone": "390987654321",
      "lid": "209876543210987@lid",
      "admin": null
    }
  ],
  "author": "391234567890@s.whatsapp.net",
  "author_phone": "391234567890",
  "author_lid": "173478124720340@lid",
  "changes": {}
}
```

`action` is `add`, `remove`, `promote`, `demote` or `modify` for members, with
them in `participants`; or `subject`, `description`, `announce`, `restrict`,
`member_add_mode`, `join_approval_mode` or `ephemeral` for a setting, with the
new values in `changes` — for example `{"subject": "Family 🏠"}`. `author` is
who made the change, when WhatsApp says.

### hornero_message_ack

```yaml
automation:
  - triggers:
      - trigger: event
        event_type: hornero_message_ack
    actions:
      - action: system_log.write
        data:
          message: "Message {{ trigger.event.data.messageId }} status {{ trigger.event.data.status }}"
```

---

## **Sample automations**

## Ping Pong

```yaml
- alias: Ping Pong
  description: ""
  trigger:
    - platform: event
      event_type: hornero_message
  condition:
    - condition: template
      value_template: "{{ trigger.event.data.message.conversation == '!ping' }}"
  action:
    - action: hornero.send_message
      data:
        clientId: default
        to: "{{ trigger.event.data.key.remoteJid }}"
        body:
          text: pong
  mode: single
```

## Arrive at home

```yaml
- alias: Arrive at home
  description: ""
  trigger:
    - platform: device
      domain: device_tracker
      entity_id: device_tracker.iphone_13_pro
      type: enter
      zone: zone.home
  condition: []
  action:
    - action: hornero.send_message
      data:
        clientId: default
        to: 391234567890@s.whatsapp.net
        body:
          text: Hi, I'm at home
  mode: single
```

## Driving mode

```yaml
- alias: Driving mode
  description: ""
  trigger:
    - platform: event
      event_type: hornero_message
  condition: []
  action:
    - action: hornero.send_message
      data:
        clientId: "{{ trigger.event.data.clientId }}" # Which instance of whatsapp should the message come from
        to: "{{ trigger.event.data.key.remoteJid }}"
        body:
          text: Sorry, I'm driving, I will contact you soon
        options:
          quoted: "{{ trigger.event.data }}" # Quote message
  mode: single
```

## Message reaction

```yaml
- alias: React to message
  description: ""
  trigger:
    - platform: event
      event_type: hornero_message
  condition: []
  action:
    - action: hornero.send_message
      data:
        clientId: "{{ trigger.event.data.clientId }}"
        to: "{{ trigger.event.data.key.remoteJid }}"
        body:
          react:
            text: "👍🏻" # Use an empty string to remove the reaction
            key: "{{ trigger.event.data.key }}"
  mode: single
```

## Presence notify (SUBSCRIBE FIRST!)

```yaml
- alias: Nuova automazione
  description: ""
  trigger:
    - platform: event
      event_type: hornero_presence
      event_data: {}
  condition:
    - condition: template
      value_template:
        "{{ trigger.event.data.presences['391234567890@s.whatsapp.net'].lastKnownPresence
        == 'available' }}"
  action:
    - service: persistent_notification.create
      data:
        message: Contact is online!
  mode: single
```

---

## Who may write to Hornero

Every incoming message becomes a `hornero_message` event, and automations act
on those, so an unfiltered inbox means any stranger can trigger them. Two
filters narrow it down, both editable in the panel's **Groups & contacts** tab:

**The allowlist.** While it is empty every sender gets through. Once it has
entries:

- **An allowed group** lets through either _every member_ or _only people I
  choose_, set per group. With the second, the panel lists the group's members
  to tick, and warns when nobody is ticked (then nothing gets through).
- **An allowed private chat** lets that person write to Hornero directly.
  Groups and private chats are independent: ticking someone in a group does
  not open a private chat with them, and allowing a private chat does not let
  them write in a group limited to chosen people. A group not on the list
  never gets through.

Pick senders from the lists in the tab — the group's members, **Add a
person**, or **Recent senders**, which offers **Let them write here** for a
group member who was ignored — rather than typing an id: WhatsApp often addresses people by a LID (`173478…@lid`)
that looks nothing like their phone number, and that is the id an incoming
message carries.

**Groups: only when mentioned.** With Hornero's number in a group, every
message anyone posts there reaches Home Assistant. Turn on
`switch.hornero_groups_require_mention` and a group message is only passed on
when it mentions Hornero's number or replies to a message Hornero sent.
Replying to someone else's message that mentioned Hornero does not count. Direct
chats are never filtered this way.

---

## HTTP API reference

Needed only to reach the add-on from outside Home Assistant; inside it, use the
services above. Every `/api/v1` route requires `Authorization: Bearer <token>`,
using the `api_token` option or the one generated on first start, which is
readable in `/config/custom_components/hornero/connection.json`.

| Method      | Route                                    | Purpose                                         |
| ----------- | ---------------------------------------- | ----------------------------------------------- |
| `GET`       | `/health`                                | Version and per-client state (no token needed)  |
| `GET`       | `/api/v1/clients`                        | List clients and their state                    |
| `GET`       | `/api/v1/clients/:id`                    | One client's state                              |
| `POST`      | `/api/v1/clients/:id/messages`           | Send a message; returns its `messageId`         |
| `POST`      | `/api/v1/clients/:id/media`              | Send a file, URL, base64 data, snapshot or clip |
| `POST`      | `/api/v1/clients/:id/media/download`     | Download the file of a received message         |
| `POST`      | `/api/v1/clients/:id/react`              | React to a message                              |
| `POST`      | `/api/v1/clients/:id/edit`               | Edit a message you sent                         |
| `POST`      | `/api/v1/clients/:id/delete`             | Delete a message for everyone                   |
| `POST`      | `/api/v1/clients/:id/poll`               | Send a poll                                     |
| `POST`      | `/api/v1/clients/:id/location`           | Send a location                                 |
| `GET`       | `/api/v1/clients/:id/groups`             | List groups                                     |
| `GET`       | `/api/v1/clients/:id/groups/:jid`        | A group with its members                        |
| `GET`       | `/api/v1/clients/:id/contacts/:contact`  | Phone number ↔ LID of a contact                 |
| `POST`      | `/api/v1/clients/:id/read`               | Mark messages as read                           |
| `GET`       | `/api/v1/clients/:id/qr`                 | Current QR code (`?format=png` for an image)    |
| `POST`      | `/api/v1/clients/:id/pairing-code`       | Request an 8-digit pairing code                 |
| `GET`       | `/api/v1/clients/:id/chats`              | Groups and contacts, with their IDs             |
| `GET`       | `/api/v1/clients/:id/avatar/:jid`        | Profile picture of a chat                       |
| `GET`       | `/api/v1/clients/:id/check/:phone`       | Check whether a number is on WhatsApp           |
| `POST`      | `/api/v1/clients/:id/status`             | Set the profile status text                     |
| `POST`      | `/api/v1/clients/:id/presence`           | Send a presence update                          |
| `POST`      | `/api/v1/clients/:id/presence/subscribe` | Subscribe to a contact's presence               |
| `POST`      | `/api/v1/clients/:id/restart`            | Reconnect the client                            |
| `POST`      | `/api/v1/clients/:id/logout`             | Drop the session and pair again                 |
| `GET`       | `/api/v1/messages`                       | Recent traffic, with delivery state             |
| `GET` `PUT` | `/api/v1/allowlist`                      | Senders allowed to trigger events               |
| `GET` `PUT` | `/api/v1/settings`                       | Behaviour settings, shared with the entities    |
| `GET`       | `/api/v1/recent-senders`                 | Who wrote lately, allowed or ignored            |

The HTTP bodies use camelCase where the actions use snake_case: `messageId`,
`mediaId`, `saveTo`, `fileName`, `selectableCount`.

Errors come back as `{"error": "..."}` with a real HTTP status code.

## Entities

Each paired client is a device in Home Assistant:

| Entity                             | Notes                                                             |
| ---------------------------------- | ----------------------------------------------------------------- |
| `binary_sensor.<client>_connected` | `device_class: connectivity`; watch it to catch a dropped session |
| `sensor.<client>_status`           | `connected`, `reconnecting` or `disconnected`                     |
| `image.<client>_qr`                | The pairing code; unavailable once paired                         |
| `button.<client>_restart`          | Reconnect without restarting the add-on                           |
| `button.<client>_logout`           | Drop the session so you can pair again                            |
| `notify.<client>`                  | Sends to the default recipient set in the integration options     |
| `notify.<name>`                    | One per allowed sender, named after the contact or group          |

The add-on's behaviour is exposed as `switch.hornero_typing_indicator`,
`switch.hornero_mark_read`, `switch.hornero_mark_online`,
`switch.hornero_groups_require_mention`,
`number.hornero_typing_max_seconds` and `select.hornero_log_level`. These are
the same settings as the panel's **Settings** tab — changing either updates the
other.
