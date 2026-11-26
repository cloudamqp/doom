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
//     The bot service, -lobby: sends bots into the games on
//     doomq/lobby/<game> that ask for them, each a process of its own.
//     Anyone can publish a listing, so the bots at play are limited.
//
//     With -arena <n>, it also keeps a game of n bots waiting in the
//     lobby, hosted by one of them. Whether it has started is taken from
//     its host process, not from its listing.
//

#include <ctype.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include "broker.h"
#include "i_system.h"
#include "i_timer.h"
#include "m_argv.h"
#include "m_misc.h"
#include "mqtt.h"

#define DEFAULT_BROKER "mqtt://guest:guest@localhost:1883"
#define LOBBY          "doomq/lobby/"
#define GAME_ID_LEN    12
// The host takes one of Doom's four player slots
#define MAX_GAME_BOTS  3
// At 17 MB and a few percent of a CPU each, what a small server takes
#define MAX_BOTS       16
// Games are listed again every 5 seconds: the ones seen to are kept, the
// oldest make way
#define MAX_GAMES      64

// Arenas at a time, the one that waits and those that play. Each ends
// after its level's minutes at the latest, and the bots that players ask
// for keep their share of MAX_BOTS.
#define MAX_ARENAS     3
// Minutes that an arena's level lasts
#define ARENA_TIMER    "10"

// Levels that the bots know every route of, or nearly
static const char *arena_maps[][2] = {{"3", "4"}, {"4", "8"}, {"1", "5"}, {"4", "6"}, {"3", "9"}};

static char served[MAX_GAMES][GAME_ID_LEN + 1];
static int num_served;
static int bots_at_play;

// The host of an arena, a process that this one started. How it is doing
// is read from what it prints and from whether it is still there. The
// lobby has its listing too, but anyone can write to that.
typedef struct
{
    pid_t pid;
    // The read end of the host's output, -1 for none
    int output;
    // Whether the game has started, and the next arena is due
    boolean started;
} arena_t;

static arena_t arenas[MAX_ARENAS];
static int num_arenas;

static const char *Argument(const char *name, const char *fallback)
{
    int i = M_CheckParmWithArgs(name, 1);

    return i > 0 ? myargv[i + 1] : fallback;
}

// The number that a listing has for a key, like 2 for bots in
// {"title":"Rip and tear","bots":2}, or 0. Listings are flat JSON, and
// a title that says "bots":3 is in quotes with its own escaped.
static int Number(const char *listing, const char *key)
{
    char pattern[32];
    const char *found;

    M_snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    found = strstr(listing, pattern);

    while (found != NULL && found > listing && found[-1] == '\\')
    {
        found = strstr(found + 1, pattern);
    }

    return found != NULL ? atoi(found + strlen(pattern)) : 0;
}

static boolean IsGameId(const char *id)
{
    size_t i;

    for (i = 0; i < GAME_ID_LEN; ++i)
    {
        if (!isdigit((unsigned char) id[i]) && (id[i] < 'a' || id[i] > 'f'))
        {
            return false;
        }
    }

    return id[GAME_ID_LEN] == '\0';
}

static boolean Served(const char *game)
{
    int i;

    for (i = 0; i < MAX_GAMES; ++i)
    {
        if (strcmp(served[i], game) == 0)
        {
            return true;
        }
    }

    return false;
}

// Starts this program again as a bot, in a working directory of its own.
// Returns the process, or -1. With output, what the bot prints goes there.
static pid_t Start(const char *program, const char *iwad, const char *broker, const char *game, int number, int skill,
                   const char *const *more, int output)
{
    char directory[] = "/tmp/doomq-bot-XXXXXX";
    char name[16], level[4];
    const char *args[32];
    int count = 0;
    pid_t pid = fork();

    if (pid != 0)
    {
        bots_at_play += pid > 0;
        return pid;
    }

    if (output >= 0)
    {
        dup2(output, STDOUT_FILENO);
    }

    M_snprintf(name, sizeof(name), "Bot %d", number);
    M_snprintf(level, sizeof(level), "%d", skill);

    if (mkdtemp(directory) == NULL || chdir(directory) != 0)
    {
        _exit(1);
    }

    args[count++] = program;
    args[count++] = "-iwad";
    args[count++] = iwad;
    args[count++] = "-broker";
    args[count++] = broker;
    args[count++] = "-game";
    args[count++] = game;
    args[count++] = "-pet";
    args[count++] = name;
    args[count++] = "-bot";
    args[count++] = level;

    while (*more != NULL && count < arrlen(args) - 1)
    {
        args[count++] = *more++;
    }

    args[count] = NULL;
    execv(program, (char *const *) args);
    _exit(1);
}

// Joins a game that someone hosts
static void StartBot(const char *program, const char *iwad, const char *broker, const char *game, int number, int skill)
{
    const char *join[] = {"-connect", "1", NULL};

    Start(program, iwad, broker, game, number, skill, join, -1);
}

// Puts up a game of bots that anyone may join: one hosts it and lists it
// in the lobby, the others join
static void StartArena(arena_t *arena, const char *program, const char *iwad, const char *broker, int bots, int skill)
{
    const char **map = arena_maps[num_arenas++ % arrlen(arena_maps)];
    char game[GAME_ID_LEN + 1], count[4];
    const char *host[] = {"-server", "-title", "Bot arena", "-arena", count, "-deathmatch", "-nomonsters", "-skill", "3",
                          "-warp", map[0], map[1], "-timer", ARENA_TIMER, NULL};
    int output[2];
    int i;

    if (pipe(output) != 0)
    {
        return;
    }

    M_snprintf(count, sizeof(count), "%d", bots);
    M_snprintf(game, sizeof(game), "%08x%04x", (unsigned int) arc4random(), (unsigned int) arc4random_uniform(0x10000));
    printf("lobby: arena %s with %d bots of skill %d on E%sM%s\n", game, bots, skill, map[0], map[1]);

    arena->pid = Start(program, iwad, broker, game, 1, skill, host, output[1]);
    arena->output = output[0];
    arena->started = false;
    close(output[1]);
    fcntl(arena->output, F_SETFL, O_NONBLOCK);
    // The listing of an arena asks for no bots, but anyone can change it
    memcpy(served[num_served++ % MAX_GAMES], game, GAME_ID_LEN + 1);

    for (i = 1; i < bots; ++i)
    {
        StartBot(program, iwad, broker, game, i + 1, skill);
    }
}

// Reads what the hosts of arenas print, to see which have started. A
// host that is gone has closed its end.
static void FollowArenas(void)
{
    char text[1024];
    int i;

    for (i = 0; i < MAX_ARENAS; ++i)
    {
        arena_t *arena = &arenas[i];
        ssize_t len;

        while (arena->pid > 0 && (len = read(arena->output, text, sizeof(text) - 1)) > 0)
        {
            text[len] = '\0';
            arena->started = arena->started || strstr(text, "doom: 10,") != NULL;
        }
    }
}

// Frees the place of an arena whose host has ended
static void EndArena(pid_t pid)
{
    int i;

    for (i = 0; i < MAX_ARENAS; ++i)
    {
        if (arenas[i].pid == pid)
        {
            close(arenas[i].output);
            arenas[i].pid = 0;
        }
    }
}

// Puts up an arena unless one waits for players already, or as many play
// as there may be
static void KeepArena(const char *program, const char *iwad, const char *broker, int bots, int skill)
{
    arena_t *vacant = NULL;
    int i;

    for (i = 0; i < MAX_ARENAS; ++i)
    {
        if (arenas[i].pid > 0 && !arenas[i].started)
        {
            return;
        }

        if (arenas[i].pid <= 0)
        {
            vacant = &arenas[i];
        }
    }

    if (vacant != NULL && bots_at_play + bots <= MAX_BOTS)
    {
        StartArena(vacant, program, iwad, broker, bots, skill);
    }
}

// Ends the bots with the service: they are in its process group
static void Stop(int signal)
{
    kill(0, SIGTERM);
    _exit(0);
}

void Lobby_Run(void)
{
    char error[256], topic[128], listing[1024];
    char *program = realpath(myargv[0], NULL);
    char *iwad = realpath(Argument("-iwad", "freedoom1.wad"), NULL);
    const char *broker = Argument("-broker", DEFAULT_BROKER);
    int arena_bots = atoi(Argument("-arena", "0"));
    int arena_skill = atoi(Argument("-arenaskill", "3"));
    struct sigaction stop = {0};

    if (program == NULL || iwad == NULL)
    {
        I_Error("lobby: start with the path of the program, and -iwad <file>");
    }

    if (!MQTT_Open(broker, NULL, error, sizeof(error)))
    {
        I_Error("lobby: broker: %s", error);
    }

    setpgid(0, 0);
    stop.sa_handler = Stop;
    sigaction(SIGTERM, &stop, NULL);
    sigaction(SIGINT, &stop, NULL);

    MQTT_Subscribe(LOBBY "+");
    printf("lobby: waiting for games that ask for bots\n");

    while (MQTT_IsOpen() || MQTT_Reopen(BROKER_RECONNECT_MS))
    {
        int len = MQTT_Receive(topic, sizeof(topic), (byte *) listing, sizeof(listing) - 1);
        const char *game = topic + strlen(LOBBY);
        int bots, skill, i;
        pid_t ended;

        while ((ended = waitpid(-1, NULL, WNOHANG)) > 0)
        {
            --bots_at_play;
            EndArena(ended);
        }

        if (arena_bots > 0)
        {
            FollowArenas();
            KeepArena(program, iwad, broker, arena_bots > MAX_GAME_BOTS ? MAX_GAME_BOTS : arena_bots, arena_skill);
        }

        if (len < 0)
        {
            I_Sleep(100);
            continue;
        }

        listing[len] = '\0';

        if (strncmp(topic, LOBBY, strlen(LOBBY)) != 0 || !IsGameId(game) || Served(game)
         || strstr(listing, "\"state\":\"waiting\"") == NULL)
        {
            continue;
        }

        bots = Number(listing, "bots");
        skill = Number(listing, "botSkill");
        bots = bots < 0 ? 0 : bots > MAX_GAME_BOTS ? MAX_GAME_BOTS : bots;
        skill = skill < 1 ? 1 : skill > 5 ? 5 : skill;

        if (bots == 0)
        {
            continue;
        }

        memcpy(served[num_served++ % MAX_GAMES], game, GAME_ID_LEN + 1);
        printf("lobby: %d bots of skill %d for game %s\n", bots, skill, game);

        for (i = 0; i < bots && bots_at_play < MAX_BOTS; ++i)
        {
            StartBot(program, iwad, broker, game, i + 1, skill);
        }
    }

    I_Error("lobby: lost connection to the broker");
}
