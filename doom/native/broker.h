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
//     Doom packets over MQTT for the native build, see broker.c.
//

#ifndef NATIVE_BROKER_H
#define NATIVE_BROKER_H

// For how long a lost connection to the broker is tried again, as
// RECONNECT_FOR in web/js/protocol.js: Doom drops a peer it hasn't heard
// from for 10 s
#define BROKER_RECONNECT_MS 8000

// Tells the lobby how the game of this host is doing: "waiting" for
// players or "playing", and how many players it has. Said again every
// few seconds from then on. Does nothing without -title.
void Broker_List(const char *state, int players);

// Tells spectators what goes on in the game of this host. The arguments
// are those of JS_Watch in src/doom/d_watch.c, which does the same in a
// browser.
void Broker_Watch(const int *numbers, int player_count, int fields, const char *names, int name_size,
                  const int *monsters, int monster_count);

#endif
