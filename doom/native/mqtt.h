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
//     Minimal MQTT 3.1.1 client with what DooMQ needs: QoS 0 publish
//     and subscribe on one connection. The counterpart of web/js/mqtt.js.
//

#ifndef NATIVE_MQTT_H
#define NATIVE_MQTT_H

#include <stddef.h>

#include "doomtype.h"

// Connects to mqtt://user:password@host:port, or with TLS to mqtts://.
// On failure, error says why. will is NULL or a topic that the broker
// clears the retained message of when the connection is lost.
boolean MQTT_Open(const char *url, const char *will, char *error, size_t error_size);

boolean MQTT_IsOpen(void);

// Tries for wait_ms to get a lost connection back, as when the broker
// restarts, subscribed as before. What was published and what came in
// between is lost.
boolean MQTT_Reopen(int wait_ms);

void MQTT_Subscribe(const char *filter);

// A retained message is kept by the broker for whoever subscribes later
void MQTT_Publish(const char *topic, const byte *payload, size_t len, boolean retain);

// Copies the next received message, without waiting for one. Returns the
// length of its payload, or -1 when there is none. Messages that don't
// fit the buffers are dropped.
int MQTT_Receive(char *topic, size_t topic_size, byte *payload, size_t payload_size);

#endif
