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
//     Minimal MQTT 3.1.1 client, see mqtt.h.
//
//     The socket blocks: writes are small and wait their turn, reads
//     only happen once poll() says there is something to read.
//

#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "i_timer.h"
#include "m_misc.h"
#include "mqtt.h"
#include "tls.h"

#define CONNECT    1
#define CONNACK    2
#define PUBLISH    3
#define SUBSCRIBE  8
#define SUBACK     9
#define PINGREQ    12

#define KEEPALIVE_S       60
#define HANDSHAKE_WAIT_MS 5000

// Room for many Doom packets, each is at most 1500 bytes plus its topic
#define INBOX_SIZE 65536

static const char *connack_errors[] =
{
    "",
    "unacceptable protocol version",
    "identifier rejected",
    "server unavailable",
    "bad username or password",
    "not authorized",
};

#define MAX_FILTERS 4
#define REOPEN_EVERY_MS 250

static int sock = -1;
// Whether the connection is one of mqtts://
static boolean secure;
static int last_sent_ms;

// What the connection was opened with and subscribed to, for when it is
// lost and opened again
static char opened_url[1024];
static char opened_will[128];
static char filters[MAX_FILTERS][128];
static int num_filters;

// Bytes read from the socket that are not handed out yet
static byte inbox[INBOX_SIZE];
static size_t inbox_len;

//
// A packet under construction
//

typedef struct
{
    byte data[2048];
    size_t len;
} buffer_t;

static void PutByte(buffer_t *buffer, int value)
{
    if (buffer->len < sizeof(buffer->data))
    {
        buffer->data[buffer->len++] = value;
    }
}

static void PutBytes(buffer_t *buffer, const void *data, size_t len)
{
    if (len <= sizeof(buffer->data) - buffer->len)
    {
        memcpy(buffer->data + buffer->len, data, len);
        buffer->len += len;
    }
}

static void PutString(buffer_t *buffer, const char *string)
{
    size_t len = strlen(string);

    PutByte(buffer, len >> 8);
    PutByte(buffer, len & 0xff);
    PutBytes(buffer, string, len);
}

static void Close(void)
{
    if (sock >= 0)
    {
        if (secure)
        {
            TLS_Stop();
        }

        close(sock);
        sock = -1;
    }
}

static void WriteAll(const byte *data, size_t len)
{
    while (sock >= 0 && len > 0)
    {
        ssize_t sent = secure ? TLS_Write(data, len) : write(sock, data, len);

        if (sent <= 0)
        {
            Close();
            return;
        }

        data += sent;
        len -= sent;
    }

    last_sent_ms = I_GetTimeMS();
}

// Sends a packet: its type and flags, the length of the rest as 7 bits
// per byte, then the rest
static void Send(int header, const buffer_t *body)
{
    byte head[5];
    size_t head_len = 0;
    size_t rest = body->len;

    head[head_len++] = header;

    do
    {
        byte digit = rest % 128;

        rest /= 128;
        head[head_len++] = rest > 0 ? digit | 0x80 : digit;
    } while (rest > 0);

    WriteAll(head, head_len);
    WriteAll(body->data, body->len);
}

static boolean Readable(int wait_ms)
{
    struct pollfd fd = {sock, POLLIN, 0};

    return sock >= 0 && ((secure && TLS_Pending()) || poll(&fd, 1, wait_ms) > 0);
}

// Moves what the socket has into the inbox
static void Fill(void)
{
    ssize_t got;

    if (inbox_len == sizeof(inbox))
    {
        return;
    }

    got = secure ? TLS_Read(inbox + inbox_len, sizeof(inbox) - inbox_len)
                 : read(sock, inbox + inbox_len, sizeof(inbox) - inbox_len);

    if (got <= 0)
    {
        Close();
        return;
    }

    inbox_len += got;
}

// Finds the first packet in the inbox. Returns its total length, or 0
// when it has not arrived in full yet.
static size_t NextPacket(const byte **body, size_t *body_len)
{
    size_t len = 0;
    size_t pos = 1;
    int shift = 0;

    do
    {
        if (pos >= inbox_len)
        {
            return 0;
        }

        len |= (size_t) (inbox[pos] & 0x7f) << shift;
        shift += 7;
    } while (inbox[pos++] & 0x80 && shift < 28);

    if (pos + len > sizeof(inbox))
    {
        // It can never fit, and the stream is lost without it
        Close();
        return 0;
    }

    if (pos + len > inbox_len)
    {
        return 0;
    }

    *body = inbox + pos;
    *body_len = len;

    return pos + len;
}

static void Drop(size_t len)
{
    inbox_len -= len;
    memmove(inbox, inbox + len, inbox_len);
}

static int Connect(const char *host, const char *port)
{
    struct addrinfo hints = {0};
    struct addrinfo *addresses, *address;
    int fd = -1;
    int on = 1;

    hints.ai_socktype = SOCK_STREAM;

    if (getaddrinfo(host, port, &hints, &addresses) != 0)
    {
        return -1;
    }

    for (address = addresses; address != NULL; address = address->ai_next)
    {
        fd = socket(address->ai_family, address->ai_socktype, address->ai_protocol);

        if (fd >= 0 && connect(fd, address->ai_addr, address->ai_addrlen) == 0)
        {
            break;
        }

        if (fd >= 0)
        {
            close(fd);
            fd = -1;
        }
    }

    freeaddrinfo(addresses);

    if (fd >= 0)
    {
        // Doom sends a small packet every tic, which must not wait for
        // the one before to be acknowledged
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, sizeof(on));
    }

    return fd;
}

// Decodes %3A and the like in place, as in the user "doomq%3Adoomq"
static void PercentDecode(char *text)
{
    char *out = text;

    for (; *text != '\0'; ++text)
    {
        unsigned int value;

        if (text[0] == '%' && sscanf(text + 1, "%2x", &value) == 1)
        {
            *out++ = value;
            text += 2;
        }
        else
        {
            *out++ = *text;
        }
    }

    *out = '\0';
}

static boolean Open(char *error, size_t error_size)
{
    const char *url = opened_url;
    const char *will = opened_will[0] != '\0' ? opened_will : NULL;
    char user[128] = "", password[128] = "", host[256] = "", port[8] = "";
    char scheme[8] = "";
    char authority[512];
    char client_id[32];
    char *at;
    buffer_t packet = {0};
    const byte *body;
    size_t body_len;

    if (sscanf(url, "%7[a-z]://%511[^/]", scheme, authority) != 2
     || (strcmp(scheme, "mqtt") != 0 && strcmp(scheme, "mqtts") != 0))
    {
        // The URL has the password in it, so it is not shown
        M_snprintf(error, error_size, "the broker URL must start with mqtt:// or mqtts://");
        return false;
    }

    secure = strcmp(scheme, "mqtts") == 0;
    M_StringCopy(port, secure ? "8883" : "1883", sizeof(port));

    at = strrchr(authority, '@');

    if (at != NULL)
    {
        *at = '\0';
        sscanf(authority, "%127[^:]:%127s", user, password);
        PercentDecode(user);
        PercentDecode(password);
    }

    sscanf(at != NULL ? at + 1 : authority, "%255[^:]:%7s", host, port);

    // A closed connection must show as a failed write, not end the program
    signal(SIGPIPE, SIG_IGN);

    sock = Connect(host, port);

    if (sock < 0)
    {
        M_snprintf(error, error_size, "could not connect to %s:%s", host, port);
        return false;
    }

    if (secure && !TLS_Start(sock, host, error, error_size))
    {
        Close();
        return false;
    }

    M_snprintf(client_id, sizeof(client_id), "doomq-bot-%08x", (unsigned int) arc4random());

    PutString(&packet, "MQTT");
    PutByte(&packet, 4);    // MQTT 3.1.1
    // User, password, clean session, and with a will: retained
    PutByte(&packet, will != NULL ? 0xe6 : 0xc2);
    PutByte(&packet, KEEPALIVE_S >> 8);
    PutByte(&packet, KEEPALIVE_S & 0xff);
    PutString(&packet, client_id);

    if (will != NULL)
    {
        PutString(&packet, will);
        PutString(&packet, "");
    }

    PutString(&packet, user);
    PutString(&packet, password);
    Send(CONNECT << 4, &packet);

    inbox_len = 0;

    while (NextPacket(&body, &body_len) == 0)
    {
        if (!Readable(HANDSHAKE_WAIT_MS))
        {
            Close();
            M_snprintf(error, error_size, "no answer from %s:%s", host, port);
            return false;
        }

        Fill();
    }

    if (inbox[0] >> 4 != CONNACK || body_len != 2 || body[1] != 0)
    {
        int code = body_len == 2 ? body[1] : 0;

        M_snprintf(error, error_size, "%s:%s refused: %s", host, port,
                   code > 0 && code < arrlen(connack_errors) ? connack_errors[code] : "unexpected answer");
        Close();
        return false;
    }

    Drop(4);

    return true;
}

boolean MQTT_Open(const char *url, const char *will, char *error, size_t error_size)
{
    M_StringCopy(opened_url, url, sizeof(opened_url));
    M_StringCopy(opened_will, will != NULL ? will : "", sizeof(opened_will));
    num_filters = 0;

    return Open(error, error_size);
}

boolean MQTT_IsOpen(void)
{
    return sock >= 0;
}

static void Subscribe(const char *filter)
{
    buffer_t packet = {0};

    // Packet id 1: there is only this one to tell apart
    PutByte(&packet, 0);
    PutByte(&packet, 1);
    PutString(&packet, filter);
    PutByte(&packet, 0); // QoS 0
    Send(SUBSCRIBE << 4 | 2, &packet);
}

void MQTT_Subscribe(const char *filter)
{
    if (num_filters < MAX_FILTERS)
    {
        M_StringCopy(filters[num_filters++], filter, sizeof(filters[0]));
    }

    Subscribe(filter);
}

boolean MQTT_Reopen(int wait_ms)
{
    int start_ms = I_GetTimeMS();
    char error[256];
    int i;

    Close();

    while (!Open(error, sizeof(error)))
    {
        if (I_GetTimeMS() - start_ms > wait_ms)
        {
            return false;
        }

        I_Sleep(REOPEN_EVERY_MS);
    }

    for (i = 0; i < num_filters; ++i)
    {
        Subscribe(filters[i]);
    }

    return true;
}

void MQTT_Publish(const char *topic, const byte *payload, size_t len, boolean retain)
{
    buffer_t packet = {0};

    PutString(&packet, topic);
    PutBytes(&packet, payload, len);
    Send(PUBLISH << 4 | (retain ? 1 : 0), &packet);
}

int MQTT_Receive(char *topic, size_t topic_size, byte *payload, size_t payload_size)
{
    static const buffer_t nothing = {0};
    const byte *body;
    size_t body_len, packet_len;

    if (sock >= 0 && I_GetTimeMS() - last_sent_ms > KEEPALIVE_S * 1000 / 2)
    {
        Send(PINGREQ << 4, &nothing);
    }

    for (;;)
    {
        int type;
        size_t topic_len, len;

        while ((packet_len = NextPacket(&body, &body_len)) == 0)
        {
            if (!Readable(0))
            {
                return -1;
            }

            Fill();
        }

        type = inbox[0] >> 4;

        if (type == SUBACK && body_len == 3 && body[2] == 0x80)
        {
            // Without the subscription nothing would ever arrive
            Close();
        }

        if (type != PUBLISH || body_len < 2)
        {
            Drop(packet_len);
            continue;
        }

        // QoS 0 messages have no packet id after the topic
        topic_len = body[0] << 8 | body[1];
        len = body_len - 2 - topic_len;

        if (topic_len + 2 > body_len || topic_len >= topic_size || len > payload_size)
        {
            Drop(packet_len);
            continue;
        }

        memcpy(topic, body + 2, topic_len);
        topic[topic_len] = '\0';
        memcpy(payload, body + 2 + topic_len, len);
        Drop(packet_len);

        return len;
    }
}
