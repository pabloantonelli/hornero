<p align="center">
  <img src="hornero/logo.png" alt="Hornero" width="320">
</p>

<p align="center">
  <strong>Mensajería de WhatsApp para Home Assistant.</strong><br>
  Vinculá tu teléfono desde un panel en la barra lateral y enviá o recibí
  mensajes desde cualquier automatización.
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="hornero/DOCS.md">Referencia de servicios</a> ·
  <a href="MIGRATION.md">Actualización</a>
</p>

---

El hornero es el pájaro que construye su casa de barro: un buen nombre para
algo que vive en tu casa y lleva mensajes.

## Qué hace

- **Envía** texto, imágenes, audio, video, documentos, ubicaciones y reacciones
  a contactos y grupos.
- **Recibe** mensajes como eventos de Home Assistant, con una lista de
  remitentes permitidos para que sólo quienes vos elijas disparen
  automatizaciones.
- **Capturas y clips de cámara** directo desde cualquier entidad `camera` o
  `image`, incluyendo los segundos grabados _antes_ del disparo.
- **Entidades**, no sólo servicios: sensores de conexión, el QR de vinculación
  como imagen, botones e interruptores, usables en paneles y condiciones.
- **Varias cuentas** en paralelo, cada una vinculada por separado.

## Requisitos

- Home Assistant OS o Supervised. Esto es un add-on: las instalaciones
  Container y Core no pueden ejecutarlo.
- Arquitecturas: `aarch64` y `amd64` — Home Assistant ya no construye
  imágenes de 32 bits.
- Un teléfono con WhatsApp, para vincular la cuenta.

> **Hornero usa una interfaz no oficial de WhatsApp.** WhatsApp no admite este
> tipo de clientes y las cuentas pueden ser bloqueadas por actividad automática
> o inusual. No lo uses para mensajería masiva ni no solicitada. Leé
> [LEGAL.md](LEGAL.md) antes de instalarlo.

## Instalación

1. **Agregá el repositorio.** En Home Assistant entrá en **Ajustes →
   Complementos → Tienda de complementos**, abrí el menú ⋮, elegí
   **Repositorios** y agregá:

   ```text
   https://github.com/pabloantonelli/hornero
   ```

2. **Instalá Hornero** desde la tienda. La imagen viene compilada, así que se
   descarga en vez de construirse en tu equipo.

3. **Iniciálo**, con **Mostrar en la barra lateral** activado.

4. **Reiniciá Home Assistant Core** (**Ajustes → Sistema → Reiniciar**). Hace
   falta una sola vez, para que se cargue la integración.

5. **Confirmá la integración.** Home Assistant te va a ofrecer configurar
   Hornero solo. Si no aparece, agregala desde **Ajustes → Dispositivos y
   servicios → Añadir integración → Hornero**; el diálogo se completa solo.

6. **Vinculá tu teléfono.** Abrí **Hornero** en la barra lateral y escaneá el
   QR, o ingresá tu número para obtener un código de 8 dígitos y usá
   **WhatsApp → Dispositivos vinculados → Vincular con número de teléfono**.

7. **Probá un mensaje** desde **Herramientas para desarrolladores → Acciones**:

   ```yaml
   action: hornero.send_message
   data:
     clientId: default
     to: "34600000000"
     body:
       text: Hola desde Home Assistant
   ```

## Blueprints

Automatizaciones listas. Tocá para importar:

| Blueprint                                                                                                                                                                                                                     | Qué hace                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [Avisar cuando algo pasa](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fpabloantonelli%2Fhornero%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fhornero%2Fnotify.yaml)          | Una entidad cambia de estado y te llega un mensaje    |
| [Foto o clip ante movimiento](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fpabloantonelli%2Fhornero%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fhornero%2Fcamera.yaml)      | El movimiento dispara una foto o un video             |
| [Avisar si se cae la sesión](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fpabloantonelli%2Fhornero%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fhornero%2Fsession-lost.yaml) | Te avisa por otro canal cuando WhatsApp se desconecta |

## Entidades

Cada cliente vinculado aparece como un dispositivo:

| Entidad                                | Para qué                                                        |
| -------------------------------------- | --------------------------------------------------------------- |
| `binary_sensor.<cliente>_connected`    | Condiciones y alertas de sesión caída                           |
| `sensor.<cliente>_status`              | Conectado, reconectando o desconectado                          |
| `image.<cliente>_qr`                   | El código de vinculación, en un panel                           |
| `button.<cliente>_restart` / `_logout` | Reconectar o desvincular                                        |
| `notify.<cliente>`                     | Envía al destinatario por defecto de las opciones               |
| `notify.<nombre>`                      | Una por remitente permitido, con el nombre del contacto o grupo |

El comportamiento del add-on también está expuesto:
`switch.hornero_typing_indicator`, `switch.hornero_mark_read`,
`switch.hornero_mark_online`, `switch.hornero_groups_require_mention`,
`number.hornero_typing_max_seconds` y `select.hornero_log_level`.

### Cómo callar el ruido de los grupos

Con el número de Hornero en un grupo, todo lo que se escriba ahí llegaría a
Home Assistant. Activá `switch.hornero_groups_require_mention` —o el
interruptor equivalente en la pestaña Ajustes del panel— y un mensaje de
grupo solo pasa cuando menciona a Hornero o responde a un mensaje que Hornero
envió. Los chats directos nunca se filtran así.

### Entidades notify

Una entidad notify es un único destino —Home Assistant no le da campo de
destinatario—, así que Hornero crea **una por cada remitente permitido**, con
el nombre del contacto o del grupo. Aparecen y desaparecen a medida que editás
la lista de permitidos, y sirven para cualquier blueprint que espere un
notificador.

También hay una entidad `notify.<cliente>` que envía a un destinatario fijo,
configurable en **Ajustes → Dispositivos y servicios → Hornero → Configurar**.
Para un destinatario que varía, o uno que no está en la lista, usá
`hornero.send_message`.

## El panel de Hornero

Siete pestañas en la barra lateral:

- **Estado** — cada cliente, con vinculación por QR o código de 8 dígitos.
- **Enviar** — mandás un mensaje o una foto de una cámara para probar todo de punta a punta.
- **Grupos y contactos** — quién puede disparar tus automatizaciones, junto a
  tus chats con foto y buscador. Copiás el ID de un grupo directo al servicio;
  el ID de un grupo no se puede deducir de un número, así que esta es la forma
  de conseguirlo.
- **Mensajes** — qué se envió y se recibió últimamente, con el estado de
  entrega de cada mensaje saliente.
- **Generador** — elegís una acción, completás los campos y copiás la llamada
  como YAML de Home Assistant, como nodo importable de Node-RED, o como `curl`.
- **Ajustes** — comportamiento que podés cambiar sin reiniciar.
- **Ayuda** — servicios, eventos y reglas de direccionamiento.

## Quién puede disparar tus automatizaciones

Los mensajes entrantes llegan como eventos `hornero_message`, y las
automatizaciones actúan sobre ellos. **Mientras no haya remitentes en la lista,
cualquiera que te escriba puede dispararlas.** Abrí la pestaña **Grupos y
contactos** y permití los que aceptás: ahí se listan tus chats y los remitentes
recientes con un botón **Permitir**, así nunca tenés que averiguar un
identificador a mano.

- **Una persona permitida** pasa por privado, y en los grupos permitidos
  configurados como _Solo contactos habilitados_; nunca en un grupo que no esté
  en la lista.
- **Un grupo permitido** deja pasar a _todos los miembros_ o _solo a los
  contactos habilitados_, según elijas para cada grupo. La pestaña muestra qué
  personas permitidas están en cada grupo.

Eso importa porque WhatsApp identifica cada vez más a la gente con un **LID**
(`173478124720340@lid`) que no revela su número. Permitir un número cubre
también el LID de esa persona, y al revés.

## Enviar capturas y clips de cámara

```yaml
action: hornero.send_media
data:
  clientId: default
  to: "34600000000"
  entity_id: camera.puerta
  caption: Hay alguien en la puerta
  duration: 10 # omitilo para una foto
  lookback: 5 # segundos grabados antes del disparo
```

Grabar requiere una cámara con el componente `stream`; las de imagen fija sólo
pueden mandar capturas, y `lookback` necesita el stream precargado.

## Node-RED

No hace falta token ni nodo HTTP: Hornero registra servicios y eventos
normales de Home Assistant, que Node-RED alcanza por su conexión websocket.

- **Para enviar**: un nodo _call service_, dominio `hornero`, servicio
  `send_message` o `send_media`.
- **Para recibir**: un nodo _events: all_ escuchando `hornero_message`,
  `hornero_message_ack` o `hornero_presence`.

Hay subflows listos en
[`node-red/hornero-subflows.json`](node-red/hornero-subflows.json): copiás el
contenido del archivo, apretás `Ctrl+I` en Node-RED y pegás. La pestaña
Generador escribe ambas formas para cualquier acción.

## Configuración

```yaml
clients:
  - default # una entrada por cuenta de WhatsApp
api_token: "" # se genera solo si queda vacío
allowed_senders: [] # vacío acepta a todos
log_level: info
mark_read: false # tildes azules en los mensajes entrantes
typing_indicator: true # "escribiendo…" y una pausa antes de enviar
typing_max_seconds: 3
mark_online: false # cuidado: corta las notificaciones a tu teléfono
refresh_hours: 0
```

Esto siembra los ajustes en una instalación nueva. Después manda la pestaña
**Ajustes** y las entidades de tipo interruptor, así que cambiar el
comportamiento no requiere reiniciar.

Los dos editan los mismos ajustes guardados, así que un cambio en uno aparece
en el otro: el panel se refresca mientras su pestaña está abierta, y las
entidades en su siguiente sondeo, en unos quince segundos.

## Eventos

| Evento                | Cuándo se dispara                            |
| --------------------- | -------------------------------------------- |
| `hornero_message`     | Llega un mensaje de un remitente permitido   |
| `hornero_message_ack` | Un mensaje que enviaste se entregó o se leyó |
| `hornero_presence`    | Un contacto suscrito cambia de presencia     |

## API HTTP

Sólo hace falta para llegar al add-on desde fuera de Home Assistant. Todas las
rutas `/api/v1` requieren un token: el de `api_token`, o el generado en
`/config/custom_components/hornero/connection.json`:

```bash
curl -X POST http://<addon>:3000/api/v1/clients/default/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"to":"34600000000","body":{"text":"Hola"}}'
```

La lista completa de rutas está en [DOCS.md](hornero/DOCS.md).

## Solución de problemas

**El QR no aparece.** Abrí el panel: el QR se muestra ahí. Si queda en
_Esperando el código QR_, revisá el log del add-on y verificá que el equipo
llegue a `web.whatsapp.com`.

**No me ofreció la integración.** Agregala desde **Ajustes → Dispositivos y
servicios**; el diálogo se completa con el archivo que escribe el add-on.

**Faltan los servicios.** Reiniciá Home Assistant Core una vez tras instalar.

**Llegan mensajes pero no pasa nada.** Mirá la pestaña **Entrantes**: si la
lista tiene entradas, todo lo de afuera se ignora a propósito.

## Desarrollo

```bash
cd hornero
npm ci
npm test
```

El build está fijado por `package-lock.json` y corre sobre Node 20+, así que da
el mismo resultado en cualquier máquina. Las actualizaciones de dependencias
llegan como pull requests de Renovate.

## Créditos

- **[WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)** — la
  librería de WhatsApp Web sobre la que está construido Hornero.
- **[Giuseppe Castaldo](https://github.com/giuseppecastaldo/ha-addons)** —
  autor del add-on del que Hornero se bifurcó originalmente. Ver
  [NOTICE](NOTICE).
- La comunidad de Home Assistant.

## Licencia

Apache License 2.0 — ver [LICENSE](LICENSE) y [NOTICE](NOTICE).

Este proyecto no está afiliado, avalado ni vinculado a WhatsApp LLC ni a Meta
Platforms, Inc.
