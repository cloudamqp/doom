//
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
//     Network module that sends packets over MQTT
//

#ifndef NET_MQTT_H
#define NET_MQTT_H

#include "net_defs.h"

extern net_module_t net_mqtt_module;

// The peer id every spectator (drone) listens on. The server sends the
// game to it once and the broker copies it to each spectator.
#define NET_MQTT_SPECTATORS "0"

// Sends the game to a peer who joins it, see D_RequestSnapshot. It is too
// big for a packet: it goes on a topic of its own, and the peer's page
// puts it where Doom loads it, see LoadSnapshot in doom/d_net.c.
void NET_MQTT_SendSnapshot(net_addr_t *addr, const byte *data, int len);

#endif /* #ifndef NET_MQTT_H */
