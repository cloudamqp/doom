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
//     Lets a program play instead of the keyboard and mouse.
//
//     The program lives in JavaScript as Module.bot (see bot/ at the top
//     of the repository). It is asked for a ticcmd every tic, and reads
//     the world with the B_ functions below. Each returns a pointer to
//     ints: a count, then that many records. The pointer is valid until
//     the next B_ call. bot/world.js names the fields of the records, in
//     the same order as here. Lengths are fixed_t and angles angle_t.
//
//     Reading must not change the game: in a netgame every player
//     simulates the same world from the same ticcmds.
//

#include <emscripten.h>

#include "b_bot.h"
#include "d_loop.h"
#include "doomstat.h"
#include "i_system.h"
#include "p_local.h"
#include "r_state.h"

// As fast as the keyboard runs, MAXPLMOVE in g_game.c
#define MAX_MOVE 50

static int *records;
static int capacity;

// Room for a count and that many records of the given size
static int *Records(int count, int size)
{
    int needed = 1 + count * size;

    if (needed > capacity)
    {
        capacity = needed;
        records = I_Realloc(records, capacity * sizeof(int));
    }

    records[0] = count;

    return records + 1;
}

// The game and the bot's own player, in one record
EMSCRIPTEN_KEEPALIVE int *B_Game(void)
{
    player_t *player = &players[consoleplayer];
    int *out = Records(1, 27);
    int weapons = 0;
    int cards = 0;
    int frags = 0;
    int i;

    for (i = 0; i < NUMWEAPONS; ++i)
    {
        weapons |= (player->weaponowned[i] != 0) << i;
    }

    for (i = 0; i < NUMCARDS; ++i)
    {
        cards |= (player->cards[i] != 0) << i;
    }

    // The other marines it killed
    for (i = 0; i < MAXPLAYERS; ++i)
    {
        frags += i == consoleplayer ? 0 : player->frags[i];
    }

    *out++ = gamestate;
    *out++ = gametic;
    *out++ = leveltime;
    *out++ = gameepisode;
    *out++ = gamemap;
    *out++ = gameskill;
    *out++ = deathmatch;
    *out++ = player->playerstate;
    *out++ = (int) player->mo;
    *out++ = player->health;
    *out++ = player->armorpoints;
    *out++ = player->readyweapon;
    *out++ = player->pendingweapon;
    *out++ = weapons;
    *out++ = cards;
    *out++ = player->powers[pw_strength];
    *out++ = player->killcount;
    *out++ = totalkills;
    *out++ = frags;

    for (i = 0; i < NUMAMMO; ++i)
    {
        *out++ = player->ammo[i];
        *out++ = player->maxammo[i];
    }

    return records;
}

EMSCRIPTEN_KEEPALIVE int *B_Sectors(void)
{
    int *out = Records(numsectors, 5);
    int i;

    for (i = 0; i < numsectors; ++i)
    {
        *out++ = sectors[i].floorheight;
        *out++ = sectors[i].ceilingheight;
        *out++ = sectors[i].special;
        *out++ = sectors[i].tag;
        // A door, lift or floor on the move
        *out++ = sectors[i].specialdata != NULL;
    }

    return records;
}

EMSCRIPTEN_KEEPALIVE int *B_Lines(void)
{
    int *out = Records(numlines, 9);
    int i;

    for (i = 0; i < numlines; ++i)
    {
        *out++ = lines[i].v1->x;
        *out++ = lines[i].v1->y;
        *out++ = lines[i].v2->x;
        *out++ = lines[i].v2->y;
        *out++ = lines[i].flags;
        *out++ = lines[i].special;
        *out++ = lines[i].tag;
        *out++ = lines[i].frontsector - sectors;
        *out++ = lines[i].backsector ? lines[i].backsector - sectors : -1;
    }

    return records;
}

// Puffs, blood and the like are left out
static boolean Listed(mobj_t *mo)
{
    return !(mo->flags & MF_NOBLOCKMAP) || (mo->flags & MF_MISSILE) || mo->type == MT_TELEPORTMAN;
}

EMSCRIPTEN_KEEPALIVE int *B_Things(void)
{
    mobj_t *self = players[consoleplayer].mo;
    thinker_t *th;
    mobj_t *mo;
    int count = 0;
    int *out;

    for (th = thinkercap.next; th != &thinkercap; th = th->next)
    {
        count += th->function.acp1 == (actionf_p1) P_MobjThinker && Listed((mobj_t *) th);
    }

    out = Records(count, 15);

    for (th = thinkercap.next; th != &thinkercap; th = th->next)
    {
        mo = (mobj_t *) th;

        if (th->function.acp1 != (actionf_p1) P_MobjThinker || !Listed(mo))
        {
            continue;
        }

        *out++ = (int) mo;
        *out++ = mo->info->doomednum;
        *out++ = mo->x;
        *out++ = mo->y;
        *out++ = mo->z;
        *out++ = mo->momx;
        *out++ = mo->momy;
        *out++ = mo->angle;
        *out++ = mo->radius;
        *out++ = mo->height;
        *out++ = mo->health;
        *out++ = mo->flags;
        // 1 to 4 for the players' marines
        *out++ = mo->player ? mo->player - players + 1 : 0;
        *out++ = mo->subsector->sector - sectors;
        // In the bot's sight, only told for what can be shot
        *out++ = mo != self && (mo->flags & MF_SHOOTABLE) && P_CheckSight(self, mo);
    }

    return records;
}

EMSCRIPTEN_KEEPALIVE int B_SectorAt(fixed_t x, fixed_t y)
{
    return R_PointInSubsector(x, y)->sector - sectors;
}

// Stores the bot's moves for this tic: forward, side, turn and buttons as
// in ticcmd_t. Returns 0 if there is no bot, or it leaves the tic to the
// keyboard.
EM_JS(int, JS_BotTiccmd, (int maketic, int *moves), {
    const cmd = Module.bot?.ticcmd(maketic);
    if (!cmd) return 0;
    HEAP32.set([cmd.forward, cmd.side, cmd.turn, cmd.buttons], moves >> 2);
    return 1;
});

static int Clamp(int move)
{
    return move > MAX_MOVE ? MAX_MOVE : move < -MAX_MOVE ? -MAX_MOVE : move;
}

void B_BuildTiccmd(ticcmd_t *cmd, int maketic)
{
    int moves[4];

    if (!JS_BotTiccmd(maketic, moves))
    {
        return;
    }

    cmd->forwardmove = Clamp(moves[0]);
    cmd->sidemove = Clamp(moves[1]);
    cmd->angleturn = moves[2];
    cmd->buttons = moves[3];
}
