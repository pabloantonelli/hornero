# Hornero — service and event reference

Service and event reference. For installation and upgrading, see the
[project README](https://github.com/pabloantonelli/hornero#readme).

## The services at a glance

| Service                                 | What it does                                         |
| --------------------------------------- | ---------------------------------------------------- |
| `hornero.send_message`                  | Text, images, audio, documents, locations, reactions |
| `hornero.send_media`                    | A snapshot or a recorded clip from a camera entity   |
| `hornero.mark_read`                     | Mark a received message as read                      |
| `hornero.set_status`                    | Change the profile status text                       |
| `hornero.presence_subscribe`            | Follow a contact's online and typing status          |
| `hornero.send_presence_update`          | Appear online, typing or recording                   |
| `hornero.send_infinity_presence_update` | Keep a presence showing until stopped                |

`send_message` and `send_media` return the message id, so a script can keep
acting on it with `response_variable`.

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

### **How to subscribe to presence update**

```yaml
action: hornero.presence_subscribe
data:
  clientId: default
  userId: 391234567890@s.whatsapp.net
```

---

## Events

| Event type          | Description                              |
| ------------------- | ---------------------------------------- |
| hornero_message     | The message that was received            |
| hornero_presence    | Presence of contact in a chat updated    |
| hornero_message_ack | A message you sent was delivered or read |

Every event carries the `clientId` it came from.

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

- **An allowed person** gets through in a direct chat, and in allowed groups
  set to _Only allowed contacts_. Allowing a person does not open groups that
  are not on the list.
- **An allowed group** lets through either _every member_ or _only allowed
  contacts_, chosen per group. With _Only allowed contacts_ the panel lists
  which allowed people are actually in the group, and warns when none are.

Allow senders from the **Not allowed yet** or **Recent senders** lists rather
than typing an id: WhatsApp often addresses people by a LID (`173478…@lid`)
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

| Method      | Route                                    | Purpose                                        |
| ----------- | ---------------------------------------- | ---------------------------------------------- |
| `GET`       | `/health`                                | Version and per-client state (no token needed) |
| `GET`       | `/api/v1/clients`                        | List clients and their state                   |
| `GET`       | `/api/v1/clients/:id`                    | One client's state                             |
| `POST`      | `/api/v1/clients/:id/messages`           | Send a message; returns its `messageId`        |
| `POST`      | `/api/v1/clients/:id/media`              | Send a camera snapshot or clip                 |
| `POST`      | `/api/v1/clients/:id/read`               | Mark messages as read                          |
| `GET`       | `/api/v1/clients/:id/qr`                 | Current QR code (`?format=png` for an image)   |
| `POST`      | `/api/v1/clients/:id/pairing-code`       | Request an 8-digit pairing code                |
| `GET`       | `/api/v1/clients/:id/chats`              | Groups and contacts, with their IDs            |
| `GET`       | `/api/v1/clients/:id/avatar/:jid`        | Profile picture of a chat                      |
| `GET`       | `/api/v1/clients/:id/check/:phone`       | Check whether a number is on WhatsApp          |
| `POST`      | `/api/v1/clients/:id/status`             | Set the profile status text                    |
| `POST`      | `/api/v1/clients/:id/presence`           | Send a presence update                         |
| `POST`      | `/api/v1/clients/:id/presence/subscribe` | Subscribe to a contact's presence              |
| `POST`      | `/api/v1/clients/:id/restart`            | Reconnect the client                           |
| `POST`      | `/api/v1/clients/:id/logout`             | Drop the session and pair again                |
| `GET`       | `/api/v1/messages`                       | Recent traffic, with delivery state            |
| `GET` `PUT` | `/api/v1/allowlist`                      | Senders allowed to trigger events              |
| `GET` `PUT` | `/api/v1/settings`                       | Behaviour settings, shared with the entities   |
| `GET`       | `/api/v1/recent-senders`                 | Who wrote lately, allowed or ignored           |

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
