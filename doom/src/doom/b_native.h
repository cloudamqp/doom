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
//     A bot: plays this player in place of keyboard and mouse.
//

#ifndef __B_NATIVE__
#define __B_NATIVE__

#include "d_ticcmd.h"
#include "doomtype.h"

// The game calls the bot through this table, so that a bot can take on
// new code while it plays, see doom/native/reload.c. A bot only makes its
// player's input, so that is safe in the middle of a game.
typedef struct
{
    // True when started with -bot <skill>, skill 1 (easy) to 5 (hard)
    boolean (*Active)(void);
    // How many bots play each other in this process, with -sim, or 0
    int (*SimPlayers)(void);
    // Decides what one of the players of -sim does in the tic that runs now
    void (*Simulate)(int player, ticcmd_t *cmd);
    // Tells the bot that a new level is ready to play
    void (*LevelLoaded)(void);
    // Decides what this player does in the tic maketic
    void (*BuildTiccmd)(ticcmd_t *cmd, int maketic);
} bot_api_t;

// The bot that this program was built with
extern const bot_api_t b_builtin;

// The bot that plays
extern const bot_api_t *b_api;

#endif
