# dsh-message-gateway

[中文](README.md) · [English](README.en.md)

Un plugin de pasarela de mensajería para la GUI web de DSH: una entrada "Plataformas de mensajería" debajo del botón "Nueva sesión" abre un gestor a pantalla completa para conectores de mensajería multiplataforma — guardado de credenciales, pruebas de conexión, monitoreo de estado — más un puente persistente integrado para el bot de IA de WeCom: los mensajes externos impulsan al asistente de DSH a través de una sesión de agente dedicada, y las respuestas se transmiten token a token.

## Características

- **Entrada en la barra lateral**: un botón "📮 Plataformas de mensajería" debajo de "Nueva sesión" abre el gestor a pantalla completa (cierre con ESC o haciendo clic en el fondo)
- **Conectores multiplataforma**: Telegram / Discord / Bot de QQ / WeCom / Bot de IA de WeCom / WeChat (pasarela Wechaty externa) / Cuenta oficial de WeChat / WhatsApp / Email / Webhooks
  - **Bot de Telegram**: guarde un Bot Token para activar el sondeo largo al instante; chatee directamente con el bot (respuestas en streaming mediante envío + edición progresiva, igual que en la web)
  - **Bot de Discord**: guarde un Bot Token para conectarse a la pasarela (habilite la intención privilegiada MESSAGE CONTENT en el portal de desarrolladores); chatee en canales o mensajes directos
  - **Bot de QQ**: guarde appId + secret para conectarse a la pasarela de la plataforma abierta (canales/grupos/DM); respuestas pasivas + edición en streaming
  - **App de WeCom**: rellene CorpID/AgentID/Secret más el Token/EncodingAESKey de callback, configure la URL de callback (`/gateway/wecom/callback`) en la consola, y los usuarios que escriban al app reciben respuestas automáticas
  - **Cuenta oficial de WeChat**: rellene AppID/Secret más el Token de callback, configure la URL del servidor (`/gateway/wechat-mp/callback`) en la consola, y los seguidores que escriban reciben respuestas automáticas
  - **WhatsApp**: rellene Token + Phone Number ID, configure el webhook (`/gateway/whatsapp/webhook`) en la consola de Meta, y los usuarios que escriban reciben respuestas automáticas
  - **Email**: rellene IMAP (recepción, 993/143) + SMTP (respuesta, 465/587/25); los mensajes se agrupan en sesiones por hilo y las respuestas usan Re: asunto original
- **Gestión de credenciales**: el texto plano se guarda solo en `~/.dsh/gateway.json` (modo 600, escritura atómica); `/gateway/list` nunca devuelve credenciales, solo un marcador `configured`
- **Redacción de secretos**: el contenido de los mensajes escrito en registros / consola se enmascara automáticamente ante posibles secretos (claves con prefijo `sk-`, tokens de GitHub, `Bearer`, asignaciones `password=`, claves PEM privadas y otros patrones comunes), de modo que los secretos de las conversaciones del bot nunca se filtran a los archivos de registro
- **Pruebas de conexión**: comprobaciones reales por plataforma — Telegram/Discord vía Bot API, QQ vía access_token, WeCom vía gettoken, cuenta oficial vía cgi-bin/token, WhatsApp vía Graph API, Email vía banner TCP de IMAP, Bot de IA de WeCom vía la conexión larga del SDK oficial (autenticado = correcto)
- **Puente persistente del Bot de IA de WeCom**: conexión larga WebSocket del SDK oficial con reconexión por retroceso exponencial; los mensajes de texto entrantes se inyectan en una sesión de agente dedicada y aislada que despierta al controlador de DSH; las respuestas se transmiten como fragmentos y finalizan vía `response_url`
  - **Eliminación de menciones @ en grupos**: se quita el `@nombre-del-bot` inicial antes de que el asistente vea el mensaje
  - **Comandos de barra**: `/help` / `/time` / `/status` (alias en chino: 帮助/菜单/时间/状态)
  - **Mensaje de bienvenida**: se responde automáticamente un saludo cuando un usuario entra a un chat individual por primera vez ese día
  - **Canal de envío proactivo**: `POST /gateway/send` (`{"chatid": "...", "content": "..."}`, chat individual = userid, grupo = id de grupo) envía mensajes markdown como el bot
  - **Push proactivo universal**: `POST /gateway/push` (`{"platform": "...", "target": "...", "content": "...", "title": "opcional"}`) envía texto a cualquier plataforma para notificaciones de tareas / otros plugins:
    - `platform` admite `telegram` (target = chatId numérico), `discord` (target = channelId), `wecom-aibot` (target = userid/id de grupo), `email` (target = correo, title como asunto)
    - QQ no admite push activo desde el 2025-04-21 (solo respuestas pasivas); devuelve un error claro
    - una plataforma no conectada devuelve `bridge not connected`
  - **Reglas de enrutado de mensajes** (configuración del plugin `routes`): enruta mensajes por "plataforma + prefijo de palabra clave" a un **preset de agente** específico (sesión aislada) con un **modelo / skill** opcional. Ej.: `{ id: "code", matchPlatform: "telegram", matchPrefix: "code ", agentPreset: "code" }` hace que `code escribe una función` en Telegram entre en una sesión de preset code. Gana la primera regla que coincida; los mensajes sin coincidencia usan el agente por defecto
  - **Comandos de barra**: `/help` / `/time` / `/status` / `/stats` (alias en chino: 帮助/菜单/时间/状态/统计); `/stats` muestra el estado de conexión de cada puente y el número de chats activos
- **Endpoint de recepción de webhooks**: `POST /gateway/webhook/in` acepta mensajes de sistemas externos (cualquiera de `text` / `content` / `message`), los inyecta en la sesión de agente dedicada y devuelve la respuesta completa de forma síncrona; un secreto de firma HMAC-SHA256 opcional valida las peticiones (contrato: [docs/webhooks.md](docs/webhooks.md))
- **Cuentas personales de WeChat (pasarela externa opcional)**: inicio de sesión por QR y sondeo de estado contra una pasarela HTTP Wechaty local (contrato: [docs/wechaty-gateway.md](docs/wechaty-gateway.md))
- **Multilingüe**: chino / inglés / español, siguiendo el idioma de la interfaz web de DSH (los navegadores en español cambian automáticamente); por defecto chino simplificado
- Tema claro / oscuro siguiendo la GUI web de DSH

## Uso

1. Abra DSH Web (`dsh web`) y haga clic en el botón "Plataformas de mensajería" de la barra lateral
2. Elija una plataforma a la izquierda y complete las credenciales a la derecha
3. Haga clic en **Guardar**: las credenciales se persisten y se ejecuta automáticamente una prueba de conexión, actualizando el estado al instante
4. Haga clic en **Probar conexión**: prueba los valores actuales del formulario sin guardarlos
5. Guardar `botId + secret` del Bot de IA de WeCom establece el puente persistente de inmediato; eliminar la configuración lo desconecta

## Instalación

```sh
# Desde npm (plugin genérico, utilizable por cualquier usuario de DSH)
dsh plugin --profile web add dsh-message-gateway
```

Reinicie `dsh web`: el botón "Plataformas de mensajería" aparece debajo de "Nueva sesión" en la barra lateral. Abra la página, elija una plataforma, complete las credenciales y haga clic en **Guardar** — para el Bot de IA de WeCom, guardar `botId + secret` establece el puente persistente de inmediato y puede chatear con el bot en WeCom al momento (igual que en la web: sesiones por chat + compresión automática de contexto).

## Configuración

Todas las opciones tienen valores por defecto y el plugin funciona de inmediato; ajústelas vía `dsh plugin config` o el archivo de configuración del perfil:

| Opción | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `botLocale` | `zh` \| `en` | `zh` | Idioma de las respuestas del bot |
| `maxChatAgents` | number | `40` | Máximo de sesiones de chat por bot; se elimina la más antigua al superarlo |
| `autoStartWecom` | boolean | `true` | Conectar automáticamente el Bot de IA de WeCom con las credenciales guardadas al iniciar |
| `groupReply` | boolean | `true` | Responder mensajes de grupo (false = solo chats individuales) |

## Documentación

- [Arquitectura y guía de extensión](docs/architecture.md) (cómo añadir un conector de plataforma)
- [Contrato del endpoint de recepción de webhooks](docs/webhooks.md)
- [Contrato de la pasarela HTTP de WeChat (Wechaty)](docs/wechaty-gateway.md)

## Arquitectura

- **Mitad host** (`lib/index.js`): rutas `/gateway/*` (list / save / delete / test / wechat-status) + `BridgeManager` (inyección de sesión de agente y sondeo del flujo de eventos) + `WecomBridge` (ciclo de vida de la conexión larga del SDK) + `gateway-store` (persistencia de credenciales)
- **Mitad cliente** (`lib/client.js`): montaje del botón de la barra lateral + gestor a pantalla completa (React, cargado vía el cierre de `__ModuleLoader__`)

## Licencia

MIT