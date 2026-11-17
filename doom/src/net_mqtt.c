//
// Copyright(C) 2005-2014 Simon Howard
// Copyright(C) 2026 84codes AB
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// DESCRIPTION:
//     Network module that sends packets over MQTT.
//
//     The MQTT connection lives in JavaScript (web/js/play.js exposes it
//     as Module.net); this module only moves packets across the Wasm
//     boundary. Peers are addressed by numeric ids, the server is id 1.
//

#include <stdlib.h>
#include <string.h>

#include <emscripten.h>

#include "m_misc.h"
#include "net_defs.h"
#include "net_mqtt.h"
#include "net_packet.h"

// Same limit as the UDP module
#define MAX_PACKET_SIZE 1500

// Doom never has more than a handful of peers per game
#define MAX_PEERS 32

typedef struct
{
    net_addr_t addr;
    uint32_t id;
} peer_t;

static peer_t peers[MAX_PEERS];

EM_JS(int, JS_Connected, (void), {
    return Module.net.connected() ? 1 : 0;
});

// Wasm passes uint32_t as a signed i32, >>> 0 makes it unsigned again
EM_JS(void, JS_Send, (uint32_t to, const byte *data, int len), {
    Module.net.send(to >>> 0, HEAPU8.slice(data, data + len));
});

// Copies the next queued packet into buf and returns its length,
// or -1 when the queue is empty. Oversized packets are dropped.
EM_JS(int, JS_Recv, (uint32_t *from, byte *buf, int size), {
    for (let packet; (packet = Module.net.recv());) {
        if (packet.data.length > size) continue;
        HEAPU8.set(packet.data, buf);
        HEAPU32[from >> 2] = packet.from;
        return packet.data.length;
    }
    return -1;
});

static uint32_t PeerId(net_addr_t *addr)
{
    return ((peer_t *) addr->handle)->id;
}

// Returns the address for a peer id, allocating one if needed.
// Addresses are freed when their refcount drops to zero.
static net_addr_t *FindAddress(uint32_t id)
{
    peer_t *free_slot = NULL;
    int i;

    for (i = 0; i < MAX_PEERS; ++i)
    {
        if (peers[i].addr.module == NULL)
        {
            if (free_slot == NULL)
            {
                free_slot = &peers[i];
            }
        }
        else if (peers[i].id == id)
        {
            return &peers[i].addr;
        }
    }

    if (free_slot == NULL)
    {
        return NULL;
    }

    free_slot->id = id;
    free_slot->addr.module = &net_mqtt_module;
    free_slot->addr.refcount = 0;
    free_slot->addr.handle = free_slot;

    return &free_slot->addr;
}

static boolean NET_MQTT_Init(void)
{
    return JS_Connected();
}

static void NET_MQTT_SendPacket(net_addr_t *addr, net_packet_t *packet)
{
    JS_Send(PeerId(addr), packet->data, packet->len);
}

static boolean NET_MQTT_RecvPacket(net_addr_t **addr, net_packet_t **packet)
{
    static byte buf[MAX_PACKET_SIZE];
    uint32_t from;
    int len;

    while ((len = JS_Recv(&from, buf, sizeof(buf))) >= 0)
    {
        *addr = FindAddress(from);

        if (*addr == NULL)
        {
            continue;
        }

        *packet = NET_NewPacket(len);
        memcpy((*packet)->data, buf, len);
        (*packet)->len = len;

        return true;
    }

    return false;
}

static void NET_MQTT_AddrToString(net_addr_t *addr, char *buffer, int buffer_len)
{
    M_snprintf(buffer, buffer_len, "mqtt:%u", PeerId(addr));
}

static void NET_MQTT_FreeAddress(net_addr_t *addr)
{
    addr->module = NULL;
}

static net_addr_t *NET_MQTT_ResolveAddress(const char *address)
{
    char *end;
    unsigned long id = strtoul(address, &end, 10);

    if (*address == '\0' || *end != '\0')
    {
        return NULL;
    }

    return FindAddress(id);
}

net_module_t net_mqtt_module =
{
    NET_MQTT_Init,
    NET_MQTT_Init,
    NET_MQTT_SendPacket,
    NET_MQTT_RecvPacket,
    NET_MQTT_AddrToString,
    NET_MQTT_FreeAddress,
    NET_MQTT_ResolveAddress,
};
