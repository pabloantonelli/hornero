"""Hornero — WhatsApp messaging for Home Assistant, backed by the Hornero add-on."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import HorneroApi, HorneroError
from .const import CONF_BASE_URL, CONF_TOKEN, DOMAIN
from .coordinator import HorneroCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.IMAGE,
    Platform.NOTIFY,
    Platform.NUMBER,
    Platform.SELECT,
    Platform.SENSOR,
    Platform.SWITCH,
]


def _drop_none(payload: dict) -> dict:
    """The add-on validates strictly, so unset optional keys are removed."""
    return {key: value for key, value in payload.items() if value is not None}


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Hornero from a config entry."""
    api = HorneroApi(
        async_get_clientsession(hass),
        entry.data[CONF_BASE_URL],
        entry.data.get(CONF_TOKEN, ""),
    )

    coordinator = HorneroCoordinator(hass, api)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _register_services(hass, coordinator)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data[DOMAIN].pop(entry.entry_id)
        if not hass.data[DOMAIN]:
            for service in hass.services.async_services_for_domain(DOMAIN):
                hass.services.async_remove(DOMAIN, service)
    return unloaded


def _register_services(hass: HomeAssistant, coordinator: HorneroCoordinator) -> None:
    """Register the Hornero services. Failures surface in the UI."""

    api = coordinator.api

    def client_id(call: ServiceCall) -> str:
        return call.data.get("clientId") or call.data.get("client_id") or "default"

    def target(call: ServiceCall) -> dict:
        """The message a call acts on: its id (plus chat), or its whole key."""
        return _drop_none(
            {
                "chat": call.data.get("chat"),
                "messageId": call.data.get("message_id"),
                "key": call.data.get("key"),
            }
        )

    async def run(coro):
        try:
            return await coro
        except HorneroError as err:
            raise HomeAssistantError(str(err)) from err

    async def send_message(call: ServiceCall) -> dict:
        result = await run(
            api.send_message(
                client_id(call),
                _drop_none(
                    {
                        "to": call.data["to"],
                        "body": call.data["body"],
                        "options": call.data.get("options"),
                        "typing": call.data.get("typing"),
                    }
                ),
            )
        )
        return result or {}

    async def send_media(call: ServiceCall) -> dict:
        result = await run(
            api.send_media(
                client_id(call),
                _drop_none(
                    {
                        "to": call.data["to"],
                        # One source: an entity, a file, a URL or base64 data.
                        "entityId": call.data.get("entity_id"),
                        "path": call.data.get("path"),
                        "url": call.data.get("url"),
                        "data": call.data.get("data"),
                        "kind": call.data.get("kind"),
                        "mimetype": call.data.get("mimetype"),
                        "fileName": call.data.get("file_name"),
                        "caption": call.data.get("caption"),
                        "ptt": call.data.get("ptt"),
                        "duration": call.data.get("duration"),
                        "lookback": call.data.get("lookback"),
                        "typing": call.data.get("typing"),
                    }
                ),
            )
        )
        return result or {}

    async def download_media(call: ServiceCall) -> dict:
        result = await run(
            api.download_media(
                client_id(call),
                _drop_none(
                    {
                        "mediaId": call.data.get("media_id"),
                        "messageId": call.data.get("message_id"),
                        "chat": call.data.get("chat"),
                        "saveTo": call.data.get("save_to"),
                    }
                ),
            )
        )
        return result or {}

    async def react(call: ServiceCall) -> dict:
        payload = {**target(call), "emoji": call.data.get("emoji") or ""}
        return await run(api.react(client_id(call), payload)) or {}

    async def edit_message(call: ServiceCall) -> dict:
        payload = {**target(call), "text": call.data["text"]}
        return await run(api.edit_message(client_id(call), payload)) or {}

    async def delete_message(call: ServiceCall) -> dict:
        return await run(api.delete_message(client_id(call), target(call))) or {}

    async def send_poll(call: ServiceCall) -> dict:
        payload = _drop_none(
            {
                "to": call.data["to"],
                "question": call.data["question"],
                "options": list(call.data["options"]),
                "selectableCount": call.data.get("selectable_count"),
                "typing": call.data.get("typing"),
            }
        )
        return await run(api.send_poll(client_id(call), payload)) or {}

    async def send_location(call: ServiceCall) -> dict:
        payload = _drop_none(
            {
                "to": call.data["to"],
                "latitude": float(call.data["latitude"]),
                "longitude": float(call.data["longitude"]),
                "name": call.data.get("name"),
                "address": call.data.get("address"),
                "typing": call.data.get("typing"),
            }
        )
        return await run(api.send_location(client_id(call), payload)) or {}

    async def get_group(call: ServiceCall) -> dict:
        return await run(api.get_group(client_id(call), call.data["group_id"])) or {}

    async def list_groups(call: ServiceCall) -> dict:
        return await run(api.list_groups(client_id(call))) or {"groups": []}

    async def resolve_contact(call: ServiceCall) -> dict:
        return await run(api.resolve_contact(client_id(call), str(call.data["contact"]))) or {}

    async def mark_read(call: ServiceCall) -> None:
        payload = (
            {"keys": call.data["keys"]}
            if call.data.get("keys")
            else _drop_none(
                {"messageId": call.data.get("messageId"), "to": call.data.get("to")}
            )
        )
        await run(api.mark_read(client_id(call), payload))

    async def set_status(call: ServiceCall) -> None:
        await run(api.set_status(client_id(call), call.data["status"]))

    async def presence_subscribe(call: ServiceCall) -> None:
        await run(api.presence_subscribe(client_id(call), call.data["userId"]))

    async def send_presence_update(call: ServiceCall) -> None:
        await run(
            api.presence(
                client_id(call),
                _drop_none({"type": call.data["type"], "to": call.data.get("to")}),
            )
        )

    async def send_infinity_presence_update(call: ServiceCall) -> None:
        await run(
            api.presence(
                client_id(call),
                _drop_none(
                    {
                        "type": call.data["type"],
                        "to": call.data.get("to"),
                        "infinity": True,
                    }
                ),
            )
        )

    # Sending returns the message id, so a script can keep acting on it.
    hass.services.async_register(
        DOMAIN, "send_message", send_message, supports_response=SupportsResponse.OPTIONAL
    )
    hass.services.async_register(
        DOMAIN, "send_media", send_media, supports_response=SupportsResponse.OPTIONAL
    )
    hass.services.async_register(DOMAIN, "mark_read", mark_read)
    hass.services.async_register(DOMAIN, "set_status", set_status)
    hass.services.async_register(DOMAIN, "presence_subscribe", presence_subscribe)
    hass.services.async_register(DOMAIN, "send_presence_update", send_presence_update)
    hass.services.async_register(
        DOMAIN, "send_infinity_presence_update", send_infinity_presence_update
    )

    # Acting on a message also returns the resulting message id.
    for name, handler in (
        ("react", react),
        ("edit_message", edit_message),
        ("delete_message", delete_message),
        ("send_poll", send_poll),
        ("send_location", send_location),
    ):
        hass.services.async_register(
            DOMAIN, name, handler, supports_response=SupportsResponse.OPTIONAL
        )

    # Lookups exist only for their answer.
    for name, handler in (
        ("download_media", download_media),
        ("get_group", get_group),
        ("list_groups", list_groups),
        ("resolve_contact", resolve_contact),
    ):
        hass.services.async_register(
            DOMAIN, name, handler, supports_response=SupportsResponse.ONLY
        )
