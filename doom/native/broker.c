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
//     Doom packets over MQTT for the native build, the part that
//     web/js/play.js has in the browser. Peers publish to
//     doomq/games/<game>/<to>/<from> and subscribe to their own <to>.
//
//     -broker mqtt://user:password@host:port   default: a broker on localhost,
//                                              mqtts:// for TLS
//     -game <id>                               the game to host or join
//     -title <title>                           with -server: list the game in
//                                              the lobby, for browsers to join
//

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

#include "broker.h"
#include "doomdef.h"
#include "doomstat.h"
#include "i_system.h"
#include "i_timer.h"
#include "m_argv.h"
#include "m_misc.h"
#include "mqtt.h"
#include "net_mqtt.h"

#define DEFAULT_BROKER "mqtt://guest:guest@localhost:1883"
#define SERVER_ID 1
#define TOPIC_SIZE 128
// Room for eight players, and less than a packet of mqtt.c
#define WATCH_SIZE 1536
#define LISTING_MS 5000

static const char *game;
static uint32_t self;

// Topic of packets to this peer, up to the sender's id
static char inbox[TOPIC_SIZE];

// Where a host lists its game, and what it last said there
static char listing_topic[TOPIC_SIZE];
static const char *listing_state;
static int listing_players;
static int listed_ms;

static const char *Argument(const char *name, const char *fallback)
{
    int i = M_CheckParmWithArgs(name, 1);

    return i > 0 ? myargv[i + 1] : fallback;
}

static void Open(void)
{
    char error[256];
    char filter[TOPIC_SIZE];
    const char *url = Argument("-broker", DEFAULT_BROKER);

    game = Argument("-game", NULL);

    if (game == NULL)
    {
        I_Error("doom: 7, -game <id> is missing");
    }

    // A host that is gone takes its listing with it
    if (M_CheckParm("-server") > 0 && Argument("-title", NULL) != NULL)
    {
        M_snprintf(listing_topic, sizeof(listing_topic), "doomq/lobby/%s", game);
    }

    if (!MQTT_Open(url, listing_topic[0] != '\0' ? listing_topic : NULL, error, sizeof(error)))
    {
        I_Error("doom: 7, broker: %s", error);
    }

    // Any id but the server's, in the lower half: the upper is for
    // spectators, see web/js/doomq.js
    self = M_CheckParm("-server") > 0 ? SERVER_ID : SERVER_ID + 1 + arc4random_uniform(0x7ffffff0);

    M_snprintf(inbox, sizeof(inbox), "doomq/games/%s/%u/", game, self);
    M_snprintf(filter, sizeof(filter), "%s+", inbox);
    MQTT_Subscribe(filter);
}

// A JSON string of value, without what would end it
static void Quote(const char *value, char *result, size_t size)
{
    size_t len = 0;

    for (; *value != '\0' && len + 1 < size; ++value)
    {
        if (*value != '"' && *value != '\\' && (unsigned char) *value >= ' ')
        {
            result[len++] = *value;
        }
    }

    result[len] = '\0';
}

// A JSON string of the argument after name
static void Quoted(const char *name, const char *fallback, char *result, size_t size)
{
    Quote(Argument(name, fallback), result, size);
}

void Broker_List(const char *state, int players)
{
    char listing[512], title[64], name[32];
    const char *mode = M_CheckParm("-altdeath") > 0 ? "altdeath" : M_CheckParm("-deathmatch") > 0 ? "deathmatch" : "coop";
    int warp = M_CheckParmWithArgs("-warp", 2);

    if (listing_topic[0] == '\0')
    {
        return;
    }

    Quoted("-title", "Untitled", title, sizeof(title));
    Quoted("-pet", "Bot", name, sizeof(name));

    // What web/js/protocol.js expects of a listing
    M_snprintf(listing, sizeof(listing),
               "{\"title\":\"%s\",\"host\":\"%s\",\"mode\":\"%s\",\"skill\":%d,\"map\":\"E%dM%d\","
               "\"monsters\":%s,\"joinMidGame\":%s,\"players\":%d,\"maxPlayers\":%d,\"state\":\"%s\"}",
               title, name, mode, atoi(Argument("-skill", "3")), warp > 0 ? atoi(myargv[warp + 1]) : 1,
               warp > 0 ? atoi(myargv[warp + 2]) : 1, M_CheckParm("-nomonsters") > 0 ? "false" : "true",
               M_CheckParm("-dropin") > 0 ? "true" : "false", players,
               strcmp(mode, "coop") == 0 ? VANILLA_MAXPLAYERS : MAXPLAYERS, state);
    MQTT_Publish(listing_topic, (const byte *) listing, strlen(listing), true);

    listing_state = state;
    listing_players = players;
    listed_ms = I_GetTimeMS();
}

// The listing again: the lobby expects to hear from a host every few
// seconds. Players can join a running game, and leave it.
static void ListAgain(void)
{
    int players = listing_players;
    int i;

    if (strcmp(listing_state, "playing") == 0)
    {
        for (players = 0, i = 0; i < MAXPLAYERS; ++i)
        {
            players += playeringame[i];
        }
    }

    Broker_List(listing_state, players);
}

// What web/js/protocol.js expects in parseWatch
void Broker_Watch(const int *numbers, int player_count, int fields, const char *names, int name_size,
                  const int *monsters, int monster_count)
{
    static const char *states[] = {"level", "intermission", "finale", "demo"};
    char watch[WATCH_SIZE], topic[TOPIC_SIZE], name[64];
    const char *separator = "";
    size_t len;
    int i;

    if (listing_topic[0] == '\0')
    {
        return;
    }

    len = M_snprintf(watch, sizeof(watch), "{\"state\":\"%s\",\"map\":\"E%dM%d\",\"time\":%d,\"deathmatch\":%s,\"players\":[",
                     states[numbers[0]], numbers[1], numbers[2], numbers[3], numbers[4] > 0 ? "true" : "false");

    for (i = 0; i < player_count; ++i)
    {
        const int *player = &numbers[5 + i * fields];

        if (!player[0])
        {
            continue;
        }

        Quote(names + i * name_size, name, sizeof(name));
        len += M_snprintf(watch + len, sizeof(watch) - len,
                          "%s{\"number\":%d,\"name\":\"%s\",\"x\":%d,\"y\":%d,\"angle\":%d,\"health\":%d,\"armor\":%d,"
                          "\"frags\":%d,\"kills\":%d,\"dead\":%s}",
                          separator, i, name, player[1], player[2], player[3], player[4], player[5], player[6],
                          player[7], player[8] ? "true" : "false");
        separator = ",";
    }

    // Where the monsters are is left out: bots host deathmatches
    len += M_snprintf(watch + len, sizeof(watch) - len, "]}");

    M_snprintf(topic, sizeof(topic), "doomq/watch/%s", game);
    MQTT_Publish(topic, (const byte *) watch, len, false);
}

boolean Broker_Connected(void)
{
    if (game == NULL)
    {
        Open();
    }

    return MQTT_IsOpen();
}

void Broker_Send(uint32_t to, const byte *data, int len)
{
    char topic[TOPIC_SIZE];

    M_snprintf(topic, sizeof(topic), "doomq/games/%s/%u/%u", game, to, self);
    MQTT_Publish(topic, data, len, false);
}

// A game for a peer who joins it, see NET_MQTT_SendSnapshot. Gzipped, as
// browsers send it: it is up to 400 KB, more than a broker may take in a
// message.
void Broker_Snapshot(uint32_t to, const byte *data, int len)
{
    char topic[TOPIC_SIZE];
    z_stream stream = {0};
    uLong size = compressBound(len) + 32;
    byte *gzipped = malloc(size);

    // 16 more window bits for a gzip header
    if (gzipped == NULL || deflateInit2(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY) != Z_OK)
    {
        I_Error("Broker_Snapshot: out of memory");
    }

    stream.next_in = (Bytef *) data;
    stream.avail_in = len;
    stream.next_out = gzipped;
    stream.avail_out = size;

    if (deflate(&stream, Z_FINISH) != Z_STREAM_END)
    {
        I_Error("Broker_Snapshot: could not gzip the game");
    }

    M_snprintf(topic, sizeof(topic), "doomq/join/%s/%u", game, to);
    MQTT_Publish(topic, gzipped, stream.total_out, false);

    deflateEnd(&stream);
    free(gzipped);
}

int Broker_Recv(uint32_t *from, byte *buf, int size)
{
    char topic[TOPIC_SIZE];
    size_t prefix = strlen(inbox);
    int len;

    while ((len = MQTT_Receive(topic, sizeof(topic), buf, size)) >= 0)
    {
        char *end;
        unsigned long id;

        if (strncmp(topic, inbox, prefix) != 0)
        {
            continue;
        }

        id = strtoul(topic + prefix, &end, 10);

        if (id >= 1 && id <= 0xffffffff && *end == '\0')
        {
            *from = id;
            return len;
        }
    }

    if (!MQTT_IsOpen())
    {
        printf("broker: lost connection\n");

        if (!MQTT_Reopen(BROKER_RECONNECT_MS))
        {
            I_Error("doom: 7, lost connection to the broker");
        }

        printf("broker: back\n");

        // The broker cleared the listing as the connection was lost
        if (listing_state != NULL)
        {
            ListAgain();
        }
    }

    if (listing_state != NULL && I_GetTimeMS() - listed_ms > LISTING_MS)
    {
        ListAgain();
    }

    return -1;
}
