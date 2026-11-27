//
// Copyright(C) 1993-1996 Id Software, Inc.
// Copyright(C) 2005-2014 Simon Howard
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
//	DOOM Network game communication and protocol,
//	all OS independend parts.
//

#include <stdio.h>
#include <stdlib.h>

#include "b_native.h"
#include "d_main.h"
#include "debug.h"
#include "doomdef.h"
#include "doomstat.h"
#include "g_game.h"
#include "i_system.h"
#include "i_timer.h"
#include "i_video.h"
#include "m_argv.h"
#include "m_menu.h"
#include "m_misc.h"
#include "p_saveg.h"
#include "w_checksum.h"
#include "w_wad.h"

#include "deh_main.h"

#include "d_loop.h"

ticcmd_t *netcmds;

// Called when a player leaves the game

static void PlayerQuitGame(player_t *player)
{
    static char exitmsg[80];
    unsigned int player_num;

    player_num = player - players;

    // Do this the same way as Vanilla Doom does, to allow dehacked
    // replacements of this message

    M_StringCopy(exitmsg, DEH_String("Player 1 left the game"), sizeof(exitmsg));

    exitmsg[7] += player_num;

    playeringame[player_num] = false;
    players[consoleplayer].message = exitmsg;

    // TODO: check if it is sensible to do this:

    if (demorecording) {
        G_CheckDemoStatus();
    }
}

// Where the host saves the game for a player who joins, and where it
// arrives there, see NET_MQTT_SendSnapshot
#define SNAPSHOT_FILE "snapshot.dsg"
#define JOIN_FILE "join.dsg"

// -hash: print a hash of the game every second, see P_StateHash
static boolean print_hashes;

// -snapshottest <tic>: save the game as for a player who joins at that tic,
// and go on from what loads again. Hashes show if anything got lost.
static int snapshot_test = -1;

static void RunTic(ticcmd_t *cmds, boolean *ingame)
{
    extern boolean advancedemo;
    unsigned int i;

    if (gametic == snapshot_test) {
        G_SaveSnapshot(SNAPSHOT_FILE, gametic);
        G_LoadSnapshot(SNAPSHOT_FILE);
    }

    if (print_hashes && gametic % TICRATE == 0 && gamestate == GS_LEVEL) {
        printf("hash: %d %08x\n", gametic, P_StateHash(gametic));
    }

    // Check for player quits, and players who join

    for (i = 0; i < MAXPLAYERS; ++i) {
        if (!demoplayback && playeringame[i] && !ingame[i]) {
            PlayerQuitGame(&players[i]);
        }
        if (!demoplayback && !playeringame[i] && ingame[i]) {
            G_PlayerJoined(i);
        }
    }

    netcmds = cmds;

    // check that there are players in the game.  if not, we cannot
    // run a tic.

    if (advancedemo) D_DoAdvanceDemo();

    G_Ticker();
}

// Between levels there is more to the game than a snapshot has
static const char *SaveSnapshot(void)
{
    if (gamestate != GS_LEVEL || gameaction != ga_nothing) {
        return NULL;
    }

    G_SaveSnapshot(SNAPSHOT_FILE, gametic);

    return SNAPSHOT_FILE;
}

static int LoadSnapshot(int before)
{
    int tic = G_SnapshotTic(JOIN_FILE);

    if (tic < 0 || tic >= before) {
        return -1;
    }

    // Before a spectator is told whom it watches, as when a game starts
    printf("doom: 10, game started\n");

    G_LoadSnapshot(JOIN_FILE);
    remove(JOIN_FILE);

    return tic;
}

static loop_interface_t doom_loop_interface = {D_ProcessEvents, G_BuildTiccmd, RunTic, M_Ticker, SaveSnapshot,
                                               LoadSnapshot};

// Load game settings from the specified structure and
// set global variables.

static void LoadGameSettings(net_gamesettings_t *settings)
{
    unsigned int i;

    deathmatch = settings->deathmatch;
    startepisode = settings->episode;
    startmap = settings->map;
    startskill = settings->skill;
    startloadgame = settings->loadgame;
    lowres_turn = settings->lowres_turn;
    nomonsters = settings->nomonsters;
    fastparm = settings->fast_monsters;
    respawnparm = settings->respawn_monsters;
    timelimit = settings->timelimit;
    consoleplayer = settings->consoleplayer;

    if (lowres_turn) {
        printf("NOTE: Turning resolution is reduced; this is probably "
               "because there is a client recording a Vanilla demo.\n");
    }

    for (i = 0; i < MAXPLAYERS; ++i) {
        playeringame[i] = i < settings->num_players;
    }
}

// Save the game settings from global variables to the specified
// game settings structure.

static void SaveGameSettings(net_gamesettings_t *settings)
{
    // Fill in game settings structure with appropriate parameters
    // for the new game

    settings->deathmatch = deathmatch;
    settings->episode = startepisode;
    settings->map = startmap;
    settings->skill = startskill;
    settings->loadgame = startloadgame;
    settings->gameversion = gameversion;
    settings->nomonsters = nomonsters;
    settings->fast_monsters = fastparm;
    settings->respawn_monsters = respawnparm;
    settings->timelimit = timelimit;

    settings->lowres_turn = (M_ParmExists("-record") && !M_ParmExists("-longtics")) || M_ParmExists("-shorttics");
}

static void InitConnectData(net_connect_data_t *connect_data)
{
    boolean shorttics;

    // Co-op maps have four player starts; the host's client connects
    // first, so its game mode sets the limit for everyone
    connect_data->max_players = M_ParmExists("-deathmatch") || M_ParmExists("-altdeath") ? MAXPLAYERS : VANILLA_MAXPLAYERS;
    connect_data->drone = false;

    //!
    // @category net
    //
    // Run as the left screen in three screen mode.
    //

    if (M_CheckParm("-left") > 0) {
        viewangleoffset = ANG90;
        connect_data->drone = true;
    }

    //!
    // @category net
    //
    // Run as the right screen in three screen mode.
    //

    if (M_CheckParm("-right") > 0) {
        viewangleoffset = ANG270;
        connect_data->drone = true;
    }

    //
    // Connect data
    //

    // Game type fields:

    connect_data->gamemode = gamemode;
    connect_data->gamemission = gamemission;

    //!
    // @category demo
    //
    // Play with low turning resolution to emulate demo recording.
    //

    shorttics = M_ParmExists("-shorttics");

    // Are we recording a demo? Possibly set lowres turn mode

    connect_data->lowres_turn = (M_ParmExists("-record") && !M_ParmExists("-longtics")) || shorttics;

    // Read checksums of our WAD directory and dehacked information

    W_Checksum(connect_data->wad_sha1sum);
    DEH_Checksum(connect_data->deh_sha1sum);

    // Are we playing with the Freedoom IWAD?

    connect_data->is_freedoom = W_CheckNumForName("FREEDOOM") >= 0;
}

void D_ConnectNetGame(void)
{
    net_connect_data_t connect_data;

    InitConnectData(&connect_data);

    // Bots that play each other in this process: a netgame without a
    // network, and with a tic for every frame
    if (b_api->SimPlayers() > 0) {
        local_players = b_api->SimPlayers();
        singletics = true;
    }

    netgame = D_InitNetGame(&connect_data) || local_players > 1;

    //!
    // @category net
    //
    // Start the game playing as though in a netgame with a single
    // player.  This can also be used to play back single player netgame
    // demos.
    //

    if (M_CheckParm("-solo-net") > 0) {
        netgame = true;
    }
}

//
// D_CheckNetGame
// Works out player numbers among the net participants
//
void D_CheckNetGame(void)
{
    net_gamesettings_t settings;
    int i;

    if (netgame) {
        autostart = true;
    }

    D_RegisterLoopCallbacks(&doom_loop_interface);

    print_hashes = M_ParmExists("-hash");

    i = M_CheckParmWithArgs("-snapshottest", 1);
    if (i > 0) {
        snapshot_test = atoi(myargv[i + 1]);
    }

    SaveGameSettings(&settings);
    D_StartNetGame(&settings, NULL);
    LoadGameSettings(&settings);

#ifndef __EMSCRIPTEN__
    // The game that a player who joins gets is too big for native/mqtt.c
    if (settings.join_tic >= 0) {
        I_Error("doom: 7, could not join: the game has started");
    }
#endif

    DEH_printf("startskill %i  deathmatch: %i  startmap: %i  startepisode: %i\n", startskill, deathmatch, startmap,
               startepisode);

    DEH_printf("player %i of %i (%i nodes)\n", consoleplayer + 1, settings.num_players, settings.num_players);

    // Show players here; the server might have specified a time limit

    if (timelimit > 0 && deathmatch) {
        // Gross hack to work like Vanilla:

        if (timelimit == 20 && M_CheckParm("-avg")) {
            DEH_printf("Austin Virtual Gaming: Levels will end "
                       "after 20 minutes\n");
        }
        else {
            DEH_printf("Levels will end after %d minute", timelimit);
            if (timelimit > 1) printf("s");
            printf(".\n");
        }
    }
    // A player who joins a running game is in once it has arrived
    if (settings.join_tic < 0) {
        printf("doom: 10, game started\n");
    }
    else {
        printf("doom: 17, joining at tic %d\n", settings.join_tic);
    }
}

