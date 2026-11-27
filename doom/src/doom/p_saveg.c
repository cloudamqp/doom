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
//	Archiving: SaveGame I/O.
//


#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "dstrings.h"
#include "deh_main.h"
#include "i_system.h"
#include "z_zone.h"
#include "p_local.h"
#include "p_saveg.h"

// State.
#include "doomstat.h"
#include "g_game.h"
#include "m_misc.h"
#include "r_main.h"
#include "r_state.h"

FILE *save_stream;
int savegamelength;
boolean savegame_error;

// Get the filename of a temporary file to write the savegame to.  After
// the file has been successfully saved, it will be renamed to the 
// real file.

char *P_TempSaveGameFile(void)
{
    static char *filename = NULL;

    if (filename == NULL)
    {
        filename = M_StringJoin(savegamedir, "temp.dsg", NULL);
    }

    return filename;
}

// Get the filename of the save game file to use for the specified slot.

char *P_SaveGameFile(int slot)
{
    static char *filename = NULL;
    static size_t filename_size = 0;
    char basename[32];

    if (filename == NULL)
    {
        filename_size = strlen(savegamedir) + 32;
        filename = malloc(filename_size);
    }

    DEH_snprintf(basename, 32, SAVEGAMENAME "%d.dsg", slot);
    M_snprintf(filename, filename_size, "%s%s", savegamedir, basename);

    return filename;
}

// Endian-safe integer read/write functions

static byte saveg_read8(void)
{
    byte result = -1;

    if (fread(&result, 1, 1, save_stream) < 1)
    {
        if (!savegame_error)
        {
            fprintf(stderr, "saveg_read8: Unexpected end of file while "
                            "reading save game\n");

            savegame_error = true;
        }
    }

    return result;
}

// When set, what would be written goes into this hash instead, see
// P_StateHash
static unsigned int *saveg_hash;

// Snapshots have every player, also those who left the game and whose
// marines are still there. Savegames have only those in the game.
static boolean saveg_all_players;

static void saveg_write8(byte value)
{
    if (saveg_hash != NULL)
    {
        // FNV-1a
        *saveg_hash = (*saveg_hash ^ value) * 16777619u;
        return;
    }

    if (fwrite(&value, 1, 1, save_stream) < 1)
    {
        if (!savegame_error)
        {
            fprintf(stderr, "saveg_write8: Error while writing save game\n");

            savegame_error = true;
        }
    }
}

static short saveg_read16(void)
{
    int result;

    result = saveg_read8();
    result |= saveg_read8() << 8;

    return result;
}

static void saveg_write16(short value)
{
    saveg_write8(value & 0xff);
    saveg_write8((value >> 8) & 0xff);
}

static int saveg_read32(void)
{
    int result;

    result = saveg_read8();
    result |= saveg_read8() << 8;
    result |= saveg_read8() << 16;
    result |= saveg_read8() << 24;

    return result;
}

static void saveg_write32(int value)
{
    saveg_write8(value & 0xff);
    saveg_write8((value >> 8) & 0xff);
    saveg_write8((value >> 16) & 0xff);
    saveg_write8((value >> 24) & 0xff);
}

// Pad to 4-byte boundaries

static void saveg_read_pad(void)
{
    unsigned long pos;
    int padding;
    int i;

    pos = ftell(save_stream);

    padding = (4 - (pos & 3)) & 3;

    for (i=0; i<padding; ++i)
    {
        saveg_read8();
    }
}

static void saveg_write_pad(void)
{
    unsigned long pos;
    int padding;
    int i;

    if (saveg_hash != NULL)
    {
        return;
    }

    pos = ftell(save_stream);

    padding = (4 - (pos & 3)) & 3;

    for (i=0; i<padding; ++i)
    {
        saveg_write8(0);
    }
}


// Pointers

static void *saveg_readp(void)
{
    return (void *) (intptr_t) saveg_read32();
}

static void saveg_writep(const void *p)
{
    // Addresses differ from peer to peer: a hash leaves them out
    saveg_write32(saveg_hash != NULL ? 0 : (intptr_t) p);
}

// Enum values are 32-bit integers.

#define saveg_read_enum saveg_read32
#define saveg_write_enum saveg_write32

// In DooMQ savegames come from the network, from anyone. What Doom goes on
// to use as an index is checked here, where it is read: nothing later does.

static int saveg_index(int index, int count, const char *what)
{
    if (index < 0 || index >= count)
    {
        I_Error("Bad savegame: %s %i", what, index);
    }

    return index;
}

//
// Structure read/write functions
//

//
// mapthing_t
//

static void saveg_read_mapthing_t(mapthing_t *str)
{
    // short x;
    str->x = saveg_read16();

    // short y;
    str->y = saveg_read16();

    // short angle;
    str->angle = saveg_read16();

    // short type;
    str->type = saveg_read16();

    // short options;
    str->options = saveg_read16();
}

static void saveg_write_mapthing_t(mapthing_t *str)
{
    // short x;
    saveg_write16(str->x);

    // short y;
    saveg_write16(str->y);

    // short angle;
    saveg_write16(str->angle);

    // short type;
    saveg_write16(str->type);

    // short options;
    saveg_write16(str->options);
}

//
// actionf_t
// 

static void saveg_read_actionf_t(actionf_t *str)
{
    // actionf_p1 acp1;
    str->acp1 = saveg_readp();
}

static void saveg_write_actionf_t(actionf_t *str)
{
    // actionf_p1 acp1;
    saveg_writep(str->acp1);
}

//
// think_t
//
// This is just an actionf_t.
//

#define saveg_read_think_t saveg_read_actionf_t
#define saveg_write_think_t saveg_write_actionf_t

//
// thinker_t
//

static void saveg_read_thinker_t(thinker_t *str)
{
    // struct thinker_s* prev;
    str->prev = saveg_readp();

    // struct thinker_s* next;
    str->next = saveg_readp();

    // think_t function;
    saveg_read_think_t(&str->function);
}

static void saveg_write_thinker_t(thinker_t *str)
{
    // struct thinker_s* prev;
    saveg_writep(str->prev);

    // struct thinker_s* next;
    saveg_writep(str->next);

    // think_t function;
    saveg_write_think_t(&str->function);
}

//
// mobj_t
//

static void saveg_read_mobj_t(mobj_t *str)
{
    int pl;

    // thinker_t thinker;
    saveg_read_thinker_t(&str->thinker);

    // fixed_t x;
    str->x = saveg_read32();

    // fixed_t y;
    str->y = saveg_read32();

    // fixed_t z;
    str->z = saveg_read32();

    // struct mobj_s* snext;
    str->snext = saveg_readp();

    // struct mobj_s* sprev;
    str->sprev = saveg_readp();

    // angle_t angle;
    str->angle = saveg_read32();

    // spritenum_t sprite;
    str->sprite = saveg_index(saveg_read_enum(), numsprites, "sprite");

    // int frame;
    str->frame = saveg_read32();
    saveg_index(str->frame & FF_FRAMEMASK, sprites[str->sprite].numframes, "frame");

    // struct mobj_s* bnext;
    str->bnext = saveg_readp();

    // struct mobj_s* bprev;
    str->bprev = saveg_readp();

    // struct subsector_s* subsector;
    str->subsector = saveg_readp();

    // fixed_t floorz;
    str->floorz = saveg_read32();

    // fixed_t ceilingz;
    str->ceilingz = saveg_read32();

    // fixed_t radius;
    str->radius = saveg_read32();

    // fixed_t height;
    str->height = saveg_read32();

    // fixed_t momx;
    str->momx = saveg_read32();

    // fixed_t momy;
    str->momy = saveg_read32();

    // fixed_t momz;
    str->momz = saveg_read32();

    // int validcount;
    str->validcount = saveg_read32();

    // mobjtype_t type;
    str->type = saveg_index(saveg_read_enum(), NUMMOBJTYPES, "thing type");

    // mobjinfo_t* info;
    str->info = saveg_readp();

    // int tics;
    str->tics = saveg_read32();

    // state_t* state;
    str->state = &states[saveg_index(saveg_read32(), NUMSTATES, "state")];

    // int flags;
    str->flags = saveg_read32();

    // int health;
    str->health = saveg_read32();

    // int movedir;
    str->movedir = saveg_read32();

    // int movecount;
    str->movecount = saveg_read32();

    // struct mobj_s* target;
    str->target = saveg_readp();

    // int reactiontime;
    str->reactiontime = saveg_read32();

    // int threshold;
    str->threshold = saveg_read32();

    // struct player_s* player;
    pl = saveg_index(saveg_read32(), MAXPLAYERS + 1, "player");

    if (pl > 0 && !playeringame[pl - 1] && !saveg_all_players)
    {
        I_Error("Bad savegame: player %i isn't in the game", pl);
    }

    if (pl > 0)
    {
        str->player = &players[pl - 1];
        str->player->mo = str;
    }
    else
    {
        str->player = NULL;
    }

    // int lastlook;
    str->lastlook = saveg_index(saveg_read32(), MAXPLAYERS, "last look");

    // mapthing_t spawnpoint;
    saveg_read_mapthing_t(&str->spawnpoint);

    // struct mobj_s* tracer;
    str->tracer = saveg_readp();
}

static void saveg_write_mobj_t(mobj_t *str)
{
    // thinker_t thinker;
    saveg_write_thinker_t(&str->thinker);

    // fixed_t x;
    saveg_write32(str->x);

    // fixed_t y;
    saveg_write32(str->y);

    // fixed_t z;
    saveg_write32(str->z);

    // struct mobj_s* snext;
    saveg_writep(str->snext);

    // struct mobj_s* sprev;
    saveg_writep(str->sprev);

    // angle_t angle;
    saveg_write32(str->angle);

    // spritenum_t sprite;
    saveg_write_enum(str->sprite);

    // int frame;
    saveg_write32(str->frame);

    // struct mobj_s* bnext;
    saveg_writep(str->bnext);

    // struct mobj_s* bprev;
    saveg_writep(str->bprev);

    // struct subsector_s* subsector;
    saveg_writep(str->subsector);

    // fixed_t floorz;
    saveg_write32(str->floorz);

    // fixed_t ceilingz;
    saveg_write32(str->ceilingz);

    // fixed_t radius;
    saveg_write32(str->radius);

    // fixed_t height;
    saveg_write32(str->height);

    // fixed_t momx;
    saveg_write32(str->momx);

    // fixed_t momy;
    saveg_write32(str->momy);

    // fixed_t momz;
    saveg_write32(str->momz);

    // int validcount;
    // The renderer counts with it too, so it differs from peer to peer
    saveg_write32(saveg_hash != NULL ? 0 : str->validcount);

    // mobjtype_t type;
    saveg_write_enum(str->type);

    // mobjinfo_t* info;
    saveg_writep(str->info);

    // int tics;
    saveg_write32(str->tics);

    // state_t* state;
    saveg_write32(str->state - states);

    // int flags;
    saveg_write32(str->flags);

    // int health;
    saveg_write32(str->health);

    // int movedir;
    saveg_write32(str->movedir);

    // int movecount;
    saveg_write32(str->movecount);

    // struct mobj_s* target;
    saveg_writep(str->target);

    // int reactiontime;
    saveg_write32(str->reactiontime);

    // int threshold;
    saveg_write32(str->threshold);

    // struct player_s* player;
    if (str->player)
    {
        saveg_write32(str->player - players + 1);
    }
    else
    {
        saveg_write32(0);
    }

    // int lastlook;
    saveg_write32(str->lastlook);

    // mapthing_t spawnpoint;
    saveg_write_mapthing_t(&str->spawnpoint);

    // struct mobj_s* tracer;
    saveg_writep(str->tracer);
}


//
// ticcmd_t
//

static void saveg_read_ticcmd_t(ticcmd_t *str)
{

    // signed char forwardmove;
    str->forwardmove = saveg_read8();

    // signed char sidemove;
    str->sidemove = saveg_read8();

    // short angleturn;
    str->angleturn = saveg_read16();

    // short consistancy;
    str->consistancy = saveg_read16();

    // byte chatchar;
    str->chatchar = saveg_read8();

    // byte buttons;
    str->buttons = saveg_read8();
}

static void saveg_write_ticcmd_t(ticcmd_t *str)
{

    // signed char forwardmove;
    saveg_write8(str->forwardmove);

    // signed char sidemove;
    saveg_write8(str->sidemove);

    // short angleturn;
    saveg_write16(str->angleturn);

    // short consistancy;
    saveg_write16(str->consistancy);

    // byte chatchar;
    saveg_write8(str->chatchar);

    // byte buttons;
    saveg_write8(str->buttons);
}

//
// pspdef_t
//

static void saveg_read_pspdef_t(pspdef_t *str)
{
    int state;

    // state_t* state;
    state = saveg_index(saveg_read32(), NUMSTATES, "weapon state");

    if (state > 0)
    {
        str->state = &states[state];
    }
    else
    {
        str->state = NULL;
    }

    // int tics;
    str->tics = saveg_read32();

    // fixed_t sx;
    str->sx = saveg_read32();

    // fixed_t sy;
    str->sy = saveg_read32();
}

static void saveg_write_pspdef_t(pspdef_t *str)
{
    // state_t* state;
    if (str->state)
    {
        saveg_write32(str->state - states);
    }
    else
    {
        saveg_write32(0);
    }

    // int tics;
    saveg_write32(str->tics);

    // fixed_t sx;
    saveg_write32(str->sx);

    // fixed_t sy;
    saveg_write32(str->sy);
}

//
// player_t
//

static void saveg_read_player_t(player_t *str)
{
    int i;

    // mobj_t* mo;
    str->mo = saveg_readp();

    // playerstate_t playerstate;
    str->playerstate = saveg_index(saveg_read_enum(), PST_REBORN + 1, "player state");

    // ticcmd_t cmd;
    saveg_read_ticcmd_t(&str->cmd);

    // fixed_t viewz;
    str->viewz = saveg_read32();

    // fixed_t viewheight;
    str->viewheight = saveg_read32();

    // fixed_t deltaviewheight;
    str->deltaviewheight = saveg_read32();

    // fixed_t bob;
    str->bob = saveg_read32();

    // int health;
    str->health = saveg_read32();

    // int armorpoints;
    str->armorpoints = saveg_read32();

    // int armortype;
    str->armortype = saveg_read32();

    // int powers[NUMPOWERS];
    for (i=0; i<NUMPOWERS; ++i)
    {
        str->powers[i] = saveg_read32();
    }

    // boolean cards[NUMCARDS];
    for (i=0; i<NUMCARDS; ++i)
    {
        str->cards[i] = saveg_read32();
    }

    // boolean backpack;
    str->backpack = saveg_read32();

    // int frags[MAXPLAYERS];
    for (i=0; i<MAXPLAYERS; ++i)
    {
        str->frags[i] = saveg_read32();
    }

    // weapontype_t readyweapon;
    str->readyweapon = saveg_index(saveg_read_enum(), NUMWEAPONS, "weapon");

    // weapontype_t pendingweapon;
    str->pendingweapon = saveg_read_enum();

    if (str->pendingweapon != wp_nochange)
    {
        saveg_index(str->pendingweapon, NUMWEAPONS, "pending weapon");
    }

    // boolean weaponowned[NUMWEAPONS];
    for (i=0; i<NUMWEAPONS; ++i)
    {
        str->weaponowned[i] = saveg_read32();
    }

    // int ammo[NUMAMMO];
    for (i=0; i<NUMAMMO; ++i)
    {
        str->ammo[i] = saveg_read32();
    }

    // int maxammo[NUMAMMO];
    for (i=0; i<NUMAMMO; ++i)
    {
        str->maxammo[i] = saveg_read32();
    }

    // int attackdown;
    str->attackdown = saveg_read32();

    // int usedown;
    str->usedown = saveg_read32();

    // int cheats;
    str->cheats = saveg_read32();

    // int refire;
    str->refire = saveg_read32();

    // int killcount;
    str->killcount = saveg_read32();

    // int itemcount;
    str->itemcount = saveg_read32();

    // int secretcount;
    str->secretcount = saveg_read32();

    // char* message;
    str->message = saveg_readp();

    // int damagecount;
    str->damagecount = saveg_read32();

    // int bonuscount;
    str->bonuscount = saveg_read32();

    // mobj_t* attacker;
    str->attacker = saveg_readp();

    // int extralight;
    str->extralight = saveg_read32();

    // int fixedcolormap;
    // The colormaps for light levels, then the inverse one of invulnerability
    str->fixedcolormap = saveg_index(saveg_read32(), NUMCOLORMAPS + 1, "colormap");

    // int colormap;
    str->colormap = saveg_read32();

    // pspdef_t psprites[NUMPSPRITES];
    for (i=0; i<NUMPSPRITES; ++i)
    {
        saveg_read_pspdef_t(&str->psprites[i]);
    }

    // boolean didsecret;
    str->didsecret = saveg_read32();
}

static void saveg_write_player_t(player_t *str)
{
    int i;

    // mobj_t* mo;
    saveg_writep(str->mo);

    // playerstate_t playerstate;
    saveg_write_enum(str->playerstate);

    // ticcmd_t cmd;
    saveg_write_ticcmd_t(&str->cmd);

    // fixed_t viewz;
    saveg_write32(str->viewz);

    // fixed_t viewheight;
    saveg_write32(str->viewheight);

    // fixed_t deltaviewheight;
    saveg_write32(str->deltaviewheight);

    // fixed_t bob;
    saveg_write32(str->bob);

    // int health;
    saveg_write32(str->health);

    // int armorpoints;
    saveg_write32(str->armorpoints);

    // int armortype;
    saveg_write32(str->armortype);

    // int powers[NUMPOWERS];
    for (i=0; i<NUMPOWERS; ++i)
    {
        saveg_write32(str->powers[i]);
    }

    // boolean cards[NUMCARDS];
    for (i=0; i<NUMCARDS; ++i)
    {
        saveg_write32(str->cards[i]);
    }

    // boolean backpack;
    saveg_write32(str->backpack);

    // int frags[MAXPLAYERS];
    for (i=0; i<MAXPLAYERS; ++i)
    {
        saveg_write32(str->frags[i]);
    }

    // weapontype_t readyweapon;
    saveg_write_enum(str->readyweapon);

    // weapontype_t pendingweapon;
    saveg_write_enum(str->pendingweapon);

    // boolean weaponowned[NUMWEAPONS];
    for (i=0; i<NUMWEAPONS; ++i)
    {
        saveg_write32(str->weaponowned[i]);
    }

    // int ammo[NUMAMMO];
    for (i=0; i<NUMAMMO; ++i)
    {
        saveg_write32(str->ammo[i]);
    }

    // int maxammo[NUMAMMO];
    for (i=0; i<NUMAMMO; ++i)
    {
        saveg_write32(str->maxammo[i]);
    }

    // int attackdown;
    saveg_write32(str->attackdown);

    // int usedown;
    saveg_write32(str->usedown);

    // int cheats;
    saveg_write32(str->cheats);

    // int refire;
    saveg_write32(str->refire);

    // int killcount;
    saveg_write32(str->killcount);

    // int itemcount;
    saveg_write32(str->itemcount);

    // int secretcount;
    saveg_write32(str->secretcount);

    // char* message;
    saveg_writep(str->message);

    // int damagecount;
    saveg_write32(str->damagecount);

    // int bonuscount;
    saveg_write32(str->bonuscount);

    // mobj_t* attacker;
    saveg_writep(str->attacker);

    // int extralight;
    saveg_write32(str->extralight);

    // int fixedcolormap;
    saveg_write32(str->fixedcolormap);

    // int colormap;
    saveg_write32(str->colormap);

    // pspdef_t psprites[NUMPSPRITES];
    for (i=0; i<NUMPSPRITES; ++i)
    {
        saveg_write_pspdef_t(&str->psprites[i]);
    }

    // boolean didsecret;
    saveg_write32(str->didsecret);
}


//
// ceiling_t
//

static void saveg_read_ceiling_t(ceiling_t *str)
{
    int sector;

    // thinker_t thinker;
    saveg_read_thinker_t(&str->thinker);

    // ceiling_e type;
    str->type = saveg_read_enum();

    // sector_t* sector;
    sector = saveg_index(saveg_read32(), numsectors, "sector");
    str->sector = &sectors[sector];

    // fixed_t bottomheight;
    str->bottomheight = saveg_read32();

    // fixed_t topheight;
    str->topheight = saveg_read32();

    // fixed_t speed;
    str->speed = saveg_read32();

    // boolean crush;
    str->crush = saveg_read32();

    // int direction;
    str->direction = saveg_read32();

    // int tag;
    str->tag = saveg_read32();

    // int olddirection;
    str->olddirection = saveg_read32();
}

static void saveg_write_ceiling_t(ceiling_t *str)
{
    // thinker_t thinker;
    saveg_write_thinker_t(&str->thinker);

    // ceiling_e type;
    saveg_write_enum(str->type);

    // sector_t* sector;
    saveg_write32(str->sector - sectors);

    // fixed_t bottomheight;
    saveg_write32(str->bottomheight);

    // fixed_t topheight;
    saveg_write32(str->topheight);

    // fixed_t speed;
    saveg_write32(str->speed);

    // boolean crush;
    saveg_write32(str->crush);

    // int direction;
    saveg_write32(str->direction);

    // int tag;
    saveg_write32(str->tag);

    // int olddirection;
    saveg_write32(str->olddirection);
}

//
// vldoor_t
//

static void saveg_read_vldoor_t(vldoor_t *str)
{
    int sector;

    // thinker_t thinker;
    saveg_read_thinker_t(&str->thinker);

    // vldoor_e type;
    str->type = saveg_read_enum();

    // sector_t* sector;
    sector = saveg_index(saveg_read32(), numsectors, "sector");
    str->sector = &sectors[sector];

    // fixed_t topheight;
    str->topheight = saveg_read32();

    // fixed_t speed;
    str->speed = saveg_read32();

    // int direction;
    str->direction = saveg_read32();

    // int topwait;
    str->topwait = saveg_read32();

    // int topcountdown;
    str->topcountdown = saveg_read32();
}

static void saveg_write_vldoor_t(vldoor_t *str)
{
    // thinker_t thinker;
    saveg_write_thinker_t(&str->thinker);

    // vldoor_e type;
    saveg_write_enum(str->type);

    // sector_t* sector;
    saveg_write32(str->sector - sectors);

    // fixed_t topheight;
    saveg_write32(str->topheight);

    // fixed_t speed;
    saveg_write32(str->speed);

    // int direction;
    saveg_write32(str->direction);

    // int topwait;
    saveg_write32(str->topwait);

    // int topcountdown;
    saveg_write32(str->topcountdown);
}

//
// floormove_t
//

static void saveg_read_floormove_t(floormove_t *str)
{
    int sector;

    // thinker_t thinker;
    saveg_read_thinker_t(&str->thinker);

    // floor_e type;
    str->type = saveg_read_enum();

    // boolean crush;
    str->crush = saveg_read32();

    // sector_t* sector;
    sector = saveg_index(saveg_read32(), numsectors, "sector");
    str->sector = &sectors[sector];

    // int direction;
    str->direction = saveg_read32();

    // int newspecial;
    str->newspecial = saveg_read32();

    // short texture;
    str->texture = saveg_read16();

    // A flat, for the floors that change theirs once they have moved.
    // Doom leaves it unset in the others.
    if (str->type == donutRaise || str->type == lowerAndChange)
    {
        saveg_index(str->texture, numflats, "flat");
    }

    // fixed_t floordestheight;
    str->floordestheight = saveg_read32();

    // fixed_t speed;
    str->speed = saveg_read32();
}

static void saveg_write_floormove_t(floormove_t *str)
{
    // thinker_t thinker;
    saveg_write_thinker_t(&str->thinker);

    // floor_e type;
    saveg_write_enum(str->type);

    // boolean crush;
    saveg_write32(str->crush);

    // sector_t* sector;
    saveg_write32(str->sector - sectors);

    // int direction;
    saveg_write32(str->direction);

    // int newspecial;
    saveg_write32(str->newspecial);

    // short texture;
    saveg_write16(str->texture);

    // fixed_t floordestheight;
    saveg_write32(str->floordestheight);

    // fixed_t speed;
    saveg_write32(str->speed);
}

//
// plat_t
//

static void saveg_read_plat_t(plat_t *str)
{
    int sector;

    // thinker_t thinker;
    saveg_read_thinker_t(&str->thinker);

    // sector_t* sector;
    sector = saveg_index(saveg_read32(), numsectors, "sector");
    str->sector = &sectors[sector];

    // fixed_t speed;
    str->speed = saveg_read32();

    // fixed_t low;
    str->low = saveg_read32();

    // fixed_t high;
    str->high = saveg_read32();

    // int wait;
    str->wait = saveg_read32();

    // int count;
    str->count = saveg_read32();

    // plat_e status;
    str->status = saveg_read_enum();

    // plat_e oldstatus;
    str->oldstatus = saveg_read_enum();

    // boolean crush;
    str->crush = saveg_read32();

    // int tag;
    str->tag = saveg_read32();

    // plattype_e type;
    str->type = saveg_read_enum();
}

static void saveg_write_plat_t(plat_t *str)
{
    // thinker_t thinker;
    saveg_write_thinker_t(&str->thinker);

    // sector_t* sector;
    saveg_write32(str->sector - sectors);

    // fixed_t speed;
    saveg_write32(str->speed);

    // fixed_t low;
    saveg_write32(str->low);

    // fixed_t high;
    saveg_write32(str->high);

    // int wait;
    saveg_write32(str->wait);

    // int count;
    saveg_write32(str->count);

    // plat_e status;
    saveg_write_enum(str->status);

    // plat_e oldstatus;
    saveg_write_enum(str->oldstatus);

    // boolean crush;
    saveg_write32(str->crush);

    // int tag;
    saveg_write32(str->tag);

    // plattype_e type;
    saveg_write_enum(str->type);
}

//
// lightflash_t
//

static void saveg_read_lightflash_t(lightflash_t *str)
{
    int sector;

    // thinker_t thinker;
    saveg_read_thinker_t(&str->thinker);

    // sector_t* sector;
    sector = saveg_index(saveg_read32(), numsectors, "sector");
    str->sector = &sectors[sector];

    // int count;
    str->count = saveg_read32();

    // int maxlight;
    str->maxlight = saveg_read32();

    // int minlight;
    str->minlight = saveg_read32();

    // int maxtime;
    str->maxtime = saveg_read32();

    // int mintime;
    str->mintime = saveg_read32();
}

static void saveg_write_lightflash_t(lightflash_t *str)
{
    // thinker_t thinker;
    saveg_write_thinker_t(&str->thinker);

    // sector_t* sector;
    saveg_write32(str->sector - sectors);

    // int count;
    saveg_write32(str->count);

    // int maxlight;
    saveg_write32(str->maxlight);

    // int minlight;
    saveg_write32(str->minlight);

    // int maxtime;
    saveg_write32(str->maxtime);

    // int mintime;
    saveg_write32(str->mintime);
}

//
// strobe_t
//

static void saveg_read_strobe_t(strobe_t *str)
{
    int sector;

    // thinker_t thinker;
    saveg_read_thinker_t(&str->thinker);

    // sector_t* sector;
    sector = saveg_index(saveg_read32(), numsectors, "sector");
    str->sector = &sectors[sector];

    // int count;
    str->count = saveg_read32();

    // int minlight;
    str->minlight = saveg_read32();

    // int maxlight;
    str->maxlight = saveg_read32();

    // int darktime;
    str->darktime = saveg_read32();

    // int brighttime;
    str->brighttime = saveg_read32();
}

static void saveg_write_strobe_t(strobe_t *str)
{
    // thinker_t thinker;
    saveg_write_thinker_t(&str->thinker);

    // sector_t* sector;
    saveg_write32(str->sector - sectors);

    // int count;
    saveg_write32(str->count);

    // int minlight;
    saveg_write32(str->minlight);

    // int maxlight;
    saveg_write32(str->maxlight);

    // int darktime;
    saveg_write32(str->darktime);

    // int brighttime;
    saveg_write32(str->brighttime);
}

//
// glow_t
//

static void saveg_read_glow_t(glow_t *str)
{
    int sector;

    // thinker_t thinker;
    saveg_read_thinker_t(&str->thinker);

    // sector_t* sector;
    sector = saveg_index(saveg_read32(), numsectors, "sector");
    str->sector = &sectors[sector];

    // int minlight;
    str->minlight = saveg_read32();

    // int maxlight;
    str->maxlight = saveg_read32();

    // int direction;
    str->direction = saveg_read32();
}

static void saveg_write_glow_t(glow_t *str)
{
    // thinker_t thinker;
    saveg_write_thinker_t(&str->thinker);

    // sector_t* sector;
    saveg_write32(str->sector - sectors);

    // int minlight;
    saveg_write32(str->minlight);

    // int maxlight;
    saveg_write32(str->maxlight);

    // int direction;
    saveg_write32(str->direction);
}

//
// Write the header for a savegame
//

void P_WriteSaveGameHeader(char *description)
{
    char name[VERSIONSIZE]; 
    int i; 
	
    for (i=0; description[i] != '\0'; ++i)
        saveg_write8(description[i]);
    for (; i<SAVESTRINGSIZE; ++i)
        saveg_write8(0);

    memset(name, 0, sizeof(name));
    M_snprintf(name, sizeof(name), "version %i", G_VanillaVersionCode());

    for (i=0; i<VERSIONSIZE; ++i)
        saveg_write8(name[i]);
	 
    saveg_write8(gameskill);
    saveg_write8(gameepisode);
    saveg_write8(gamemap);

    for (i=0 ; i<MAXPLAYERS ; i++) 
        saveg_write8(playeringame[i]);

    saveg_write8((leveltime >> 16) & 0xff);
    saveg_write8((leveltime >> 8) & 0xff);
    saveg_write8(leveltime & 0xff);
}

// 
// Read the header for a savegame
//

boolean P_ReadSaveGameHeader(void)
{
    int	 i; 
    byte a, b, c; 
    char vcheck[VERSIONSIZE]; 
    char read_vcheck[VERSIONSIZE];
	 
    // skip the description field 

    for (i=0; i<SAVESTRINGSIZE; ++i)
        saveg_read8();
    
    for (i=0; i<VERSIONSIZE; ++i)
        read_vcheck[i] = saveg_read8();

    memset(vcheck, 0, sizeof(vcheck));
    M_snprintf(vcheck, sizeof(vcheck), "version %i", G_VanillaVersionCode());
    if (strcmp(read_vcheck, vcheck) != 0)
	return false;				// bad version 

    gameskill = saveg_index(saveg_read8(), sk_nightmare + 1, "skill");
    gameepisode = saveg_read8();
    gamemap = saveg_read8();

    if (!D_ValidEpisodeMap(gamemission, gamemode, gameepisode, gamemap))
    {
        I_Error("Bad savegame: no map %i of episode %i", gamemap, gameepisode);
    }

    for (i=0 ; i<MAXPLAYERS ; i++) 
	playeringame[i] = saveg_read8();

    // get the times 
    a = saveg_read8();
    b = saveg_read8();
    c = saveg_read8();
    leveltime = (a<<16) + (b<<8) + c; 

    return true;
}

//
// Read the end of file marker.  Returns true if read successfully.
// 

boolean P_ReadSaveGameEOF(void)
{
    int value;

    value = saveg_read8();

    return value == SAVEGAME_EOF;
}

//
// Write the end of file marker
//

void P_WriteSaveGameEOF(void)
{
    saveg_write8(SAVEGAME_EOF);
}

//
// P_ArchivePlayers
//
void P_ArchivePlayers (void)
{
    int		i;
		
    for (i=0 ; i<MAXPLAYERS ; i++)
    {
	if (!playeringame[i])
	    continue;
	
	saveg_write_pad();

        saveg_write_player_t(&players[i]);
    }
}



//
// P_UnArchivePlayers
//
void P_UnArchivePlayers (void)
{
    int		i;
	
    for (i=0 ; i<MAXPLAYERS ; i++)
    {
	if (!playeringame[i])
	    continue;
	
	saveg_read_pad();

        saveg_read_player_t(&players[i]);
	
	// will be set when unarc thinker
	players[i].mo = NULL;	
	players[i].message = NULL;
	players[i].attacker = NULL;
    }
}


//
// P_ArchiveWorld
//
void P_ArchiveWorld (void)
{
    int			i;
    int			j;
    sector_t*		sec;
    line_t*		li;
    side_t*		si;
    
    // do sectors
    for (i=0, sec = sectors ; i<numsectors ; i++,sec++)
    {
	saveg_write16(sec->floorheight >> FRACBITS);
	saveg_write16(sec->ceilingheight >> FRACBITS);
	saveg_write16(sec->floorpic);
	saveg_write16(sec->ceilingpic);
	saveg_write16(sec->lightlevel);
	saveg_write16(sec->special);		// needed?
	saveg_write16(sec->tag);		// needed?
    }

    
    // do lines
    for (i=0, li = lines ; i<numlines ; i++,li++)
    {
	saveg_write16(li->flags);
	saveg_write16(li->special);
	saveg_write16(li->tag);
	for (j=0 ; j<2 ; j++)
	{
	    if (li->sidenum[j] == -1)
		continue;
	    
	    si = &sides[li->sidenum[j]];

	    saveg_write16(si->textureoffset >> FRACBITS);
	    saveg_write16(si->rowoffset >> FRACBITS);
	    saveg_write16(si->toptexture);
	    saveg_write16(si->bottomtexture);
	    saveg_write16(si->midtexture);	
	}
    }
}



//
// P_UnArchiveWorld
//
void P_UnArchiveWorld (void)
{
    int			i;
    int			j;
    sector_t*		sec;
    line_t*		li;
    side_t*		si;
    
    // do sectors
    for (i=0, sec = sectors ; i<numsectors ; i++,sec++)
    {
	sec->floorheight = saveg_read16() << FRACBITS;
	sec->ceilingheight = saveg_read16() << FRACBITS;
	sec->floorpic = saveg_index(saveg_read16(), numflats, "flat");
	sec->ceilingpic = saveg_index(saveg_read16(), numflats, "flat");
	sec->lightlevel = saveg_read16();
	sec->special = saveg_read16();		// needed?
	sec->tag = saveg_read16();		// needed?
	sec->specialdata = 0;
	sec->soundtarget = 0;
    }
    
    // do lines
    for (i=0, li = lines ; i<numlines ; i++,li++)
    {
	li->flags = saveg_read16();
	li->special = saveg_read16();
	li->tag = saveg_read16();
	for (j=0 ; j<2 ; j++)
	{
	    if (li->sidenum[j] == -1)
		continue;
	    si = &sides[li->sidenum[j]];
	    si->textureoffset = saveg_read16() << FRACBITS;
	    si->rowoffset = saveg_read16() << FRACBITS;
	    si->toptexture = saveg_index(saveg_read16(), numtextures, "texture");
	    si->bottomtexture = saveg_index(saveg_read16(), numtextures, "texture");
	    si->midtexture = saveg_index(saveg_read16(), numtextures, "texture");
	}
    }
}





//
// Thinkers
//
typedef enum
{
    tc_end,
    tc_mobj

} thinkerclass_t;


//
// P_ArchiveThinkers
//
void P_ArchiveThinkers (void)
{
    thinker_t*		th;

    // save off the current thinkers
    for (th = thinkercap.next ; th != &thinkercap ; th=th->next)
    {
	if (th->function.acp1 == (actionf_p1)P_MobjThinker)
	{
            saveg_write8(tc_mobj);
	    saveg_write_pad();
            saveg_write_mobj_t((mobj_t *) th);

	    continue;
	}
		
	// I_Error ("P_ArchiveThinkers: Unknown thinker function");
    }

    // add a terminating marker
    saveg_write8(tc_end);
}



//
// P_UnArchiveThinkers
//
void P_UnArchiveThinkers (void)
{
    byte		tclass;
    thinker_t*		currentthinker;
    thinker_t*		next;
    mobj_t*		mobj;
    int			i;
    
    // remove all the current thinkers
    currentthinker = thinkercap.next;
    while (currentthinker != &thinkercap)
    {
	next = currentthinker->next;
	
	if (currentthinker->function.acp1 == (actionf_p1)P_MobjThinker)
	    P_RemoveMobj ((mobj_t *)currentthinker);
	else
	    Z_Free (currentthinker);

	currentthinker = next;
    }
    P_InitThinkers ();
    
    // read in saved thinkers
    while (1)
    {
	tclass = saveg_read8();
	switch (tclass)
	{
	  case tc_end:
	    // Doom takes a player's marine for granted
	    for (i=0 ; i<MAXPLAYERS ; i++)
	    {
		if (playeringame[i] && players[i].mo == NULL)
		{
		    I_Error("Bad savegame: player %i has no marine", i + 1);
		}
	    }
	    return; 	// end of list
			
	  case tc_mobj:
	    saveg_read_pad();
	    mobj = Z_Malloc (sizeof(*mobj), PU_LEVEL, NULL);
            saveg_read_mobj_t(mobj);

	    mobj->target = NULL;
            mobj->tracer = NULL;
	    P_SetThingPosition (mobj);
	    mobj->info = &mobjinfo[mobj->type];
	    mobj->floorz = mobj->subsector->sector->floorheight;
	    mobj->ceilingz = mobj->subsector->sector->ceilingheight;
	    mobj->thinker.function.acp1 = (actionf_p1)P_MobjThinker;
	    P_AddThinker (&mobj->thinker);
	    break;

	  default:
	    I_Error ("Unknown tclass %i in savegame",tclass);
	}
	
    }

}


//
// P_ArchiveSpecials
//
enum
{
    tc_ceiling,
    tc_door,
    tc_floor,
    tc_plat,
    tc_flash,
    tc_strobe,
    tc_glow,
    tc_endspecials

} specials_e;	



//
// Things to handle:
//
// T_MoveCeiling, (ceiling_t: sector_t * swizzle), - active list
// T_VerticalDoor, (vldoor_t: sector_t * swizzle),
// T_MoveFloor, (floormove_t: sector_t * swizzle),
// T_LightFlash, (lightflash_t: sector_t * swizzle),
// T_StrobeFlash, (strobe_t: sector_t *),
// T_Glow, (glow_t: sector_t *),
// T_PlatRaise, (plat_t: sector_t *), - active list
//
void P_ArchiveSpecials (void)
{
    thinker_t*		th;
    int			i;
	
    // save off the current thinkers
    for (th = thinkercap.next ; th != &thinkercap ; th=th->next)
    {
	if (th->function.acv == (actionf_v)NULL)
	{
	    for (i = 0; i < MAXCEILINGS;i++)
		if (activeceilings[i] == (ceiling_t *)th)
		    break;
	    
	    if (i<MAXCEILINGS)
	    {
                saveg_write8(tc_ceiling);
		saveg_write_pad();
                saveg_write_ceiling_t((ceiling_t *) th);
	    }
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_MoveCeiling)
	{
            saveg_write8(tc_ceiling);
	    saveg_write_pad();
            saveg_write_ceiling_t((ceiling_t *) th);
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_VerticalDoor)
	{
            saveg_write8(tc_door);
	    saveg_write_pad();
            saveg_write_vldoor_t((vldoor_t *) th);
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_MoveFloor)
	{
            saveg_write8(tc_floor);
	    saveg_write_pad();
            saveg_write_floormove_t((floormove_t *) th);
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_PlatRaise)
	{
            saveg_write8(tc_plat);
	    saveg_write_pad();
            saveg_write_plat_t((plat_t *) th);
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_LightFlash)
	{
            saveg_write8(tc_flash);
	    saveg_write_pad();
            saveg_write_lightflash_t((lightflash_t *) th);
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_StrobeFlash)
	{
            saveg_write8(tc_strobe);
	    saveg_write_pad();
            saveg_write_strobe_t((strobe_t *) th);
	    continue;
	}
			
	if (th->function.acp1 == (actionf_p1)T_Glow)
	{
            saveg_write8(tc_glow);
	    saveg_write_pad();
            saveg_write_glow_t((glow_t *) th);
	    continue;
	}
    }
	
    // add a terminating marker
    saveg_write8(tc_endspecials);

}


//
// P_UnArchiveSpecials
//
void P_UnArchiveSpecials (void)
{
    byte		tclass;
    ceiling_t*		ceiling;
    vldoor_t*		door;
    floormove_t*	floor;
    plat_t*		plat;
    lightflash_t*	flash;
    strobe_t*		strobe;
    glow_t*		glow;
	
	
    // read in saved thinkers
    while (1)
    {
	tclass = saveg_read8();

	switch (tclass)
	{
	  case tc_endspecials:
	    return;	// end of list
			
	  case tc_ceiling:
	    saveg_read_pad();
	    ceiling = Z_Malloc (sizeof(*ceiling), PU_LEVEL, NULL);
            saveg_read_ceiling_t(ceiling);
	    ceiling->sector->specialdata = ceiling;

	    if (ceiling->thinker.function.acp1)
		ceiling->thinker.function.acp1 = (actionf_p1)T_MoveCeiling;

	    P_AddThinker (&ceiling->thinker);
	    P_AddActiveCeiling(ceiling);
	    break;
				
	  case tc_door:
	    saveg_read_pad();
	    door = Z_Malloc (sizeof(*door), PU_LEVEL, NULL);
            saveg_read_vldoor_t(door);
	    door->sector->specialdata = door;
	    door->thinker.function.acp1 = (actionf_p1)T_VerticalDoor;
	    P_AddThinker (&door->thinker);
	    break;
				
	  case tc_floor:
	    saveg_read_pad();
	    floor = Z_Malloc (sizeof(*floor), PU_LEVEL, NULL);
            saveg_read_floormove_t(floor);
	    floor->sector->specialdata = floor;
	    floor->thinker.function.acp1 = (actionf_p1)T_MoveFloor;
	    P_AddThinker (&floor->thinker);
	    break;
				
	  case tc_plat:
	    saveg_read_pad();
	    plat = Z_Malloc (sizeof(*plat), PU_LEVEL, NULL);
            saveg_read_plat_t(plat);
	    plat->sector->specialdata = plat;

	    if (plat->thinker.function.acp1)
		plat->thinker.function.acp1 = (actionf_p1)T_PlatRaise;

	    P_AddThinker (&plat->thinker);
	    P_AddActivePlat(plat);
	    break;
				
	  case tc_flash:
	    saveg_read_pad();
	    flash = Z_Malloc (sizeof(*flash), PU_LEVEL, NULL);
            saveg_read_lightflash_t(flash);
	    flash->thinker.function.acp1 = (actionf_p1)T_LightFlash;
	    P_AddThinker (&flash->thinker);
	    break;
				
	  case tc_strobe:
	    saveg_read_pad();
	    strobe = Z_Malloc (sizeof(*strobe), PU_LEVEL, NULL);
            saveg_read_strobe_t(strobe);
	    strobe->thinker.function.acp1 = (actionf_p1)T_StrobeFlash;
	    P_AddThinker (&strobe->thinker);
	    break;
				
	  case tc_glow:
	    saveg_read_pad();
	    glow = Z_Malloc (sizeof(*glow), PU_LEVEL, NULL);
            saveg_read_glow_t(glow);
	    glow->thinker.function.acp1 = (actionf_p1)T_Glow;
	    P_AddThinker (&glow->thinker);
	    break;
				
	  default:
	    I_Error ("P_UnarchiveSpecials:Unknown tclass %i "
		     "in savegame",tclass);
	}
	
    }

}



//
// Snapshots
//
// A savegame is loaded by every peer at once, so what it leaves out each
// peer makes up the same way: monsters forget whom they chase, things
// fill the sectors and blocks in the order they are read, the random
// numbers start over. A snapshot is for a player who joins a running
// game: one peer loads it while the others play on, so it keeps all of it,
// and the game goes on the same for everyone.
//

enum
{
    sc_end,
    sc_mobj,
    sc_ceiling,
    sc_door,
    sc_floor,
    sc_plat,
    sc_flash,
    sc_strobe,
    sc_glow,
    sc_fire
};

#define BODYQUESIZE 32

extern int prndindex;
extern mobj_t *bodyque[BODYQUESIZE];
extern byte consistancy[MAXPLAYERS][BACKUPTICS];
extern boolean levelTimer;
extern int levelTimeCount;
extern mobj_t *braintargets[32];
extern int numbraintargets;
extern int braintargeton;

// The thinkers of a snapshot, in the order they think: a thinker's number
// is its place plus one, 0 is none
static thinker_t **snapshot_thinkers;
static int snapshot_numthinkers;

// The same thinkers by address, to number them as they are written
typedef struct
{
    const thinker_t *thinker;
    int number;
} numbered_t;

static numbered_t *snapshot_numbers;

static int CompareAddresses(const void *a, const void *b)
{
    uintptr_t x = (uintptr_t) ((const numbered_t *) a)->thinker;
    uintptr_t y = (uintptr_t) ((const numbered_t *) b)->thinker;

    return (x > y) - (x < y);
}

// Thinkers that are removed, waiting to be freed, have no number
static int ThinkerNumber(const void *thinker)
{
    numbered_t key = {thinker, 0};
    numbered_t *found;

    if (thinker == NULL)
    {
        return 0;
    }

    found = bsearch(&key, snapshot_numbers, snapshot_numthinkers, sizeof(key), CompareAddresses);

    return found != NULL ? found->number : 0;
}

static thinker_t *ThinkerOfNumber(int number)
{
    number = saveg_index(number, snapshot_numthinkers + 1, "thinker");

    return number > 0 ? snapshot_thinkers[number - 1] : NULL;
}

static mobj_t *MobjOfNumber(int number)
{
    thinker_t *thinker = ThinkerOfNumber(number);

    if (thinker != NULL && thinker->function.acp1 != (actionf_p1) P_MobjThinker)
    {
        I_Error("Bad snapshot: thinker %i is no thing", number);
    }

    return (mobj_t *) thinker;
}

static int ThinkerClass(thinker_t *th)
{
    int i;

    if (th->function.acp1 == (actionf_p1) P_MobjThinker)    return sc_mobj;
    if (th->function.acp1 == (actionf_p1) T_MoveCeiling)    return sc_ceiling;
    if (th->function.acp1 == (actionf_p1) T_VerticalDoor)   return sc_door;
    if (th->function.acp1 == (actionf_p1) T_MoveFloor)      return sc_floor;
    if (th->function.acp1 == (actionf_p1) T_PlatRaise)      return sc_plat;
    if (th->function.acp1 == (actionf_p1) T_LightFlash)     return sc_flash;
    if (th->function.acp1 == (actionf_p1) T_StrobeFlash)    return sc_strobe;
    if (th->function.acp1 == (actionf_p1) T_Glow)           return sc_glow;
    if (th->function.acp1 == (actionf_p1) T_FireFlicker)    return sc_fire;

    // Ceilings and platforms that wait to be set going again
    if (th->function.acv == (actionf_v) NULL)
    {
        for (i = 0; i < MAXCEILINGS; ++i)
        {
            if (activeceilings[i] == (ceiling_t *) th) return sc_ceiling;
        }
        for (i = 0; i < MAXPLATS; ++i)
        {
            if (activeplats[i] == (plat_t *) th) return sc_plat;
        }
    }

    // Removed, to be freed when the thinkers next run
    return sc_end;
}

// Savegames leave flickering fires out, the level makes them anew. They
// take random numbers, so a snapshot has them.

static void saveg_write_fireflicker_t(fireflicker_t *str)
{
    saveg_write_thinker_t(&str->thinker);
    saveg_write32(str->sector - sectors);
    saveg_write32(str->count);
    saveg_write32(str->maxlight);
    saveg_write32(str->minlight);
}

static void saveg_read_fireflicker_t(fireflicker_t *str)
{
    saveg_read_thinker_t(&str->thinker);
    str->sector = &sectors[saveg_index(saveg_read32(), numsectors, "sector")];
    str->count = saveg_read32();
    str->maxlight = saveg_read32();
    str->minlight = saveg_read32();
}

static void AddSnapshotThinker(thinker_t *th, int *size)
{
    if (snapshot_numthinkers == *size)
    {
        thinker_t **more = Z_Malloc(sizeof(*more) * *size * 2, PU_STATIC, NULL);

        memcpy(more, snapshot_thinkers, sizeof(*more) * *size);
        Z_Free(snapshot_thinkers);
        snapshot_thinkers = more;
        *size *= 2;
    }

    snapshot_thinkers[snapshot_numthinkers++] = th;
}

static void FreeSnapshotThinkers(void)
{
    Z_Free(snapshot_thinkers);
    snapshot_thinkers = NULL;
    snapshot_numthinkers = 0;
}

void P_ArchiveSnapshot(int tic)
{
    thinker_t *th;
    sector_t *sec;
    line_t *li;
    side_t *si;
    mobj_t *mobj;
    int size;
    int count;
    int i;
    int j;

    saveg_write32(tic);

    for (i = 0; i < MAXPLAYERS; ++i)
    {
        saveg_write_pad();
        saveg_write_player_t(&players[i]);
    }

    // The world, heights to the fraction
    for (i = 0, sec = sectors; i < numsectors; ++i, ++sec)
    {
        saveg_write32(sec->floorheight);
        saveg_write32(sec->ceilingheight);
        saveg_write16(sec->floorpic);
        saveg_write16(sec->ceilingpic);
        saveg_write16(sec->lightlevel);
        saveg_write16(sec->special);
        saveg_write16(sec->tag);
    }

    // Not which lines a player has seen, for their automap
    for (i = 0, li = lines; i < numlines; ++i, ++li)
    {
        saveg_write16(li->flags & ~ML_MAPPED);
        saveg_write16(li->special);
        saveg_write16(li->tag);
    }

    for (i = 0, si = sides; i < numsides; ++i, ++si)
    {
        saveg_write32(si->textureoffset);
        saveg_write32(si->rowoffset);
        saveg_write16(si->toptexture);
        saveg_write16(si->bottomtexture);
        saveg_write16(si->midtexture);
    }

    // The thinkers, in the order they think
    size = 256;
    snapshot_thinkers = Z_Malloc(sizeof(*snapshot_thinkers) * size, PU_STATIC, NULL);
    snapshot_numthinkers = 0;

    for (th = thinkercap.next; th != &thinkercap; th = th->next)
    {
        if (ThinkerClass(th) != sc_end)
        {
            AddSnapshotThinker(th, &size);
        }
    }

    snapshot_numbers = Z_Malloc(sizeof(*snapshot_numbers) * (snapshot_numthinkers + 1), PU_STATIC, NULL);
    for (i = 0; i < snapshot_numthinkers; ++i)
    {
        snapshot_numbers[i].thinker = snapshot_thinkers[i];
        snapshot_numbers[i].number = i + 1;
    }
    qsort(snapshot_numbers, snapshot_numthinkers, sizeof(*snapshot_numbers), CompareAddresses);

    for (i = 0; i < snapshot_numthinkers; ++i)
    {
        th = snapshot_thinkers[i];

        saveg_write8(ThinkerClass(th));
        saveg_write_pad();

        switch (ThinkerClass(th))
        {
          case sc_mobj:    saveg_write_mobj_t((mobj_t *) th); break;
          case sc_ceiling: saveg_write_ceiling_t((ceiling_t *) th); break;
          case sc_door:    saveg_write_vldoor_t((vldoor_t *) th); break;
          case sc_floor:   saveg_write_floormove_t((floormove_t *) th); break;
          case sc_plat:    saveg_write_plat_t((plat_t *) th); break;
          case sc_flash:   saveg_write_lightflash_t((lightflash_t *) th); break;
          case sc_strobe:  saveg_write_strobe_t((strobe_t *) th); break;
          case sc_glow:    saveg_write_glow_t((glow_t *) th); break;
          case sc_fire:    saveg_write_fireflicker_t((fireflicker_t *) th); break;
        }
    }

    saveg_write8(sc_end);

    // What things point at, and the order of the things in each sector
    // and block, which decides what a move bumps into first. Things in no
    // sector or block keep what they last pointed at, it isn't written.
    for (i = 0; i < snapshot_numthinkers; ++i)
    {
        if (ThinkerClass(snapshot_thinkers[i]) != sc_mobj)
        {
            continue;
        }

        mobj = (mobj_t *) snapshot_thinkers[i];
        saveg_write32(ThinkerNumber(mobj->target));
        saveg_write32(ThinkerNumber(mobj->tracer));
        if (!(mobj->flags & MF_NOSECTOR))
        {
            saveg_write32(ThinkerNumber(mobj->snext));
            saveg_write32(ThinkerNumber(mobj->sprev));
        }
        if (!(mobj->flags & MF_NOBLOCKMAP))
        {
            saveg_write32(ThinkerNumber(mobj->bnext));
            saveg_write32(ThinkerNumber(mobj->bprev));
        }
    }

    for (i = 0, sec = sectors; i < numsectors; ++i, ++sec)
    {
        saveg_write32(ThinkerNumber(sec->thinglist));
        saveg_write32(ThinkerNumber(sec->soundtarget));
        saveg_write32(ThinkerNumber(sec->specialdata));
    }

    count = 0;
    for (i = 0; i < bmapwidth * bmapheight; ++i)
    {
        if (blocklinks[i] != NULL) ++count;
    }
    saveg_write32(count);
    for (i = 0; i < bmapwidth * bmapheight; ++i)
    {
        if (blocklinks[i] != NULL)
        {
            saveg_write32(i);
            saveg_write32(ThinkerNumber(blocklinks[i]));
        }
    }

    for (i = 0; i < MAXPLAYERS; ++i)
    {
        saveg_write32(ThinkerNumber(players[i].mo));
        saveg_write32(ThinkerNumber(players[i].attacker));
    }

    // The rest of what the game goes on with
    // Not M_Random's: sounds and screen wipes take from it, which differ
    // from peer to peer
    saveg_write32(prndindex);
    saveg_write32(paused);
    saveg_write32(levelTimer);
    saveg_write32(levelTimeCount);
    saveg_write32(totalkills);
    saveg_write32(totalitems);
    saveg_write32(totalsecret);

    saveg_write32(bodyqueslot);
    for (i = 0; i < BODYQUESIZE; ++i)
    {
        saveg_write32(ThinkerNumber(bodyque[i]));
    }

    saveg_write32(iquehead);
    saveg_write32(iquetail);
    for (i = 0; i < ITEMQUESIZE; ++i)
    {
        saveg_write_mapthing_t(&itemrespawnque[i]);
        saveg_write32(itemrespawntime[i]);
    }

    for (i = 0; i < MAXBUTTONS; ++i)
    {
        button_t *button = &buttonlist[i];

        saveg_write32(button->line != NULL ? button->line - lines : -1);
        saveg_write32(button->where);
        saveg_write32(button->btexture);
        saveg_write32(button->btimer);
        saveg_write32(button->soundorg != NULL ? (sector_t *) ((byte *) button->soundorg - offsetof(sector_t, soundorg)) - sectors : -1);
    }

    saveg_write32(numbraintargets);
    saveg_write32(braintargeton);
    for (i = 0; i < numbraintargets; ++i)
    {
        saveg_write32(ThinkerNumber(braintargets[i]));
    }

    for (i = 0; i < MAXPLAYERS; ++i)
    {
        for (j = 0; j < BACKUPTICS; ++j)
        {
            saveg_write8(consistancy[i][j]);
        }
    }

    Z_Free(snapshot_numbers);
    snapshot_numbers = NULL;
    FreeSnapshotThinkers();
}

int P_UnArchiveSnapshot(void)
{
    thinker_t *th;
    thinker_t *next;
    sector_t *sec;
    line_t *li;
    side_t *si;
    mobj_t *mobj;
    int class;
    int size;
    int count;
    int i;
    int j;
    int tic;

    tic = saveg_read32();

    for (i = 0; i < MAXPLAYERS; ++i)
    {
        saveg_read_pad();
        saveg_read_player_t(&players[i]);
        players[i].mo = NULL;
        players[i].message = NULL;
        players[i].attacker = NULL;
    }

    for (i = 0, sec = sectors; i < numsectors; ++i, ++sec)
    {
        sec->floorheight = saveg_read32();
        sec->ceilingheight = saveg_read32();
        sec->floorpic = saveg_index(saveg_read16(), numflats, "flat");
        sec->ceilingpic = saveg_index(saveg_read16(), numflats, "flat");
        sec->lightlevel = saveg_read16();
        sec->special = saveg_read16();
        sec->tag = saveg_read16();
    }

    for (i = 0, li = lines; i < numlines; ++i, ++li)
    {
        li->flags = saveg_read16();
        li->special = saveg_read16();
        li->tag = saveg_read16();
    }

    for (i = 0, si = sides; i < numsides; ++i, ++si)
    {
        si->textureoffset = saveg_read32();
        si->rowoffset = saveg_read32();
        si->toptexture = saveg_index(saveg_read16(), numtextures, "texture");
        si->bottomtexture = saveg_index(saveg_read16(), numtextures, "texture");
        si->midtexture = saveg_index(saveg_read16(), numtextures, "texture");
    }

    // Away with the level's own thinkers
    for (th = thinkercap.next; th != &thinkercap; th = next)
    {
        next = th->next;
        Z_Free(th);
    }
    P_InitThinkers();
    for (i = 0; i < MAXCEILINGS; ++i) activeceilings[i] = NULL;
    for (i = 0; i < MAXPLATS; ++i) activeplats[i] = NULL;

    size = 256;
    snapshot_thinkers = Z_Malloc(sizeof(*snapshot_thinkers) * size, PU_STATIC, NULL);
    snapshot_numthinkers = 0;

    saveg_all_players = true;

    while ((class = saveg_read8()) != sc_end)
    {
        saveg_read_pad();

        switch (class)
        {
          case sc_mobj:
            mobj = Z_Malloc(sizeof(*mobj), PU_LEVEL, NULL);
            saveg_read_mobj_t(mobj);
            mobj->info = &mobjinfo[mobj->type];
            mobj->subsector = R_PointInSubsector(mobj->x, mobj->y);
            mobj->snext = mobj->sprev = mobj->bnext = mobj->bprev = NULL;
            mobj->thinker.function.acp1 = (actionf_p1) P_MobjThinker;
            th = &mobj->thinker;
            break;

          case sc_ceiling:
          {
            ceiling_t *ceiling = Z_Malloc(sizeof(*ceiling), PU_LEVEL, NULL);
            saveg_read_ceiling_t(ceiling);
            if (ceiling->thinker.function.acp1)
                ceiling->thinker.function.acp1 = (actionf_p1) T_MoveCeiling;
            P_AddActiveCeiling(ceiling);
            th = &ceiling->thinker;
            break;
          }

          case sc_door:
          {
            vldoor_t *door = Z_Malloc(sizeof(*door), PU_LEVEL, NULL);
            saveg_read_vldoor_t(door);
            door->thinker.function.acp1 = (actionf_p1) T_VerticalDoor;
            th = &door->thinker;
            break;
          }

          case sc_floor:
          {
            floormove_t *floor = Z_Malloc(sizeof(*floor), PU_LEVEL, NULL);
            saveg_read_floormove_t(floor);
            floor->thinker.function.acp1 = (actionf_p1) T_MoveFloor;
            th = &floor->thinker;
            break;
          }

          case sc_plat:
          {
            plat_t *plat = Z_Malloc(sizeof(*plat), PU_LEVEL, NULL);
            saveg_read_plat_t(plat);
            if (plat->thinker.function.acp1)
                plat->thinker.function.acp1 = (actionf_p1) T_PlatRaise;
            P_AddActivePlat(plat);
            th = &plat->thinker;
            break;
          }

          case sc_flash:
          {
            lightflash_t *flash = Z_Malloc(sizeof(*flash), PU_LEVEL, NULL);
            saveg_read_lightflash_t(flash);
            flash->thinker.function.acp1 = (actionf_p1) T_LightFlash;
            th = &flash->thinker;
            break;
          }

          case sc_strobe:
          {
            strobe_t *strobe = Z_Malloc(sizeof(*strobe), PU_LEVEL, NULL);
            saveg_read_strobe_t(strobe);
            strobe->thinker.function.acp1 = (actionf_p1) T_StrobeFlash;
            th = &strobe->thinker;
            break;
          }

          case sc_glow:
          {
            glow_t *glow = Z_Malloc(sizeof(*glow), PU_LEVEL, NULL);
            saveg_read_glow_t(glow);
            glow->thinker.function.acp1 = (actionf_p1) T_Glow;
            th = &glow->thinker;
            break;
          }

          case sc_fire:
          {
            fireflicker_t *fire = Z_Malloc(sizeof(*fire), PU_LEVEL, NULL);
            saveg_read_fireflicker_t(fire);
            fire->thinker.function.acp1 = (actionf_p1) T_FireFlicker;
            th = &fire->thinker;
            break;
          }

          default:
            I_Error("Bad snapshot: thinker class %i", class);
            return -1;
        }

        P_AddThinker(th);
        AddSnapshotThinker(th, &size);
    }

    saveg_all_players = false;

    for (i = 0; i < snapshot_numthinkers; ++i)
    {
        if (snapshot_thinkers[i]->function.acp1 != (actionf_p1) P_MobjThinker)
        {
            continue;
        }

        mobj = (mobj_t *) snapshot_thinkers[i];
        mobj->target = MobjOfNumber(saveg_read32());
        mobj->tracer = MobjOfNumber(saveg_read32());
        if (!(mobj->flags & MF_NOSECTOR))
        {
            mobj->snext = MobjOfNumber(saveg_read32());
            mobj->sprev = MobjOfNumber(saveg_read32());
        }
        if (!(mobj->flags & MF_NOBLOCKMAP))
        {
            mobj->bnext = MobjOfNumber(saveg_read32());
            mobj->bprev = MobjOfNumber(saveg_read32());
        }
    }

    for (i = 0, sec = sectors; i < numsectors; ++i, ++sec)
    {
        sec->thinglist = MobjOfNumber(saveg_read32());
        sec->soundtarget = MobjOfNumber(saveg_read32());
        sec->specialdata = ThinkerOfNumber(saveg_read32());
    }

    memset(blocklinks, 0, sizeof(*blocklinks) * bmapwidth * bmapheight);
    count = saveg_read32();
    for (j = 0; j < count; ++j)
    {
        i = saveg_index(saveg_read32(), bmapwidth * bmapheight, "block");
        blocklinks[i] = MobjOfNumber(saveg_read32());
    }

    for (i = 0; i < MAXPLAYERS; ++i)
    {
        players[i].mo = MobjOfNumber(saveg_read32());
        players[i].attacker = MobjOfNumber(saveg_read32());

        if (playeringame[i] && players[i].mo == NULL)
        {
            I_Error("Bad snapshot: player %i has no marine", i + 1);
        }
    }

    prndindex = saveg_read32() & 0xff;
    paused = saveg_read32() != 0;
    levelTimer = saveg_read32() != 0;
    levelTimeCount = saveg_read32();
    totalkills = saveg_read32();
    totalitems = saveg_read32();
    totalsecret = saveg_read32();

    bodyqueslot = saveg_read32();
    for (i = 0; i < BODYQUESIZE; ++i)
    {
        bodyque[i] = MobjOfNumber(saveg_read32());
    }

    iquehead = saveg_index(saveg_read32(), ITEMQUESIZE, "item queue");
    iquetail = saveg_index(saveg_read32(), ITEMQUESIZE, "item queue");
    for (i = 0; i < ITEMQUESIZE; ++i)
    {
        saveg_read_mapthing_t(&itemrespawnque[i]);
        itemrespawntime[i] = saveg_read32();
    }

    for (i = 0; i < MAXBUTTONS; ++i)
    {
        button_t *button = &buttonlist[i];
        int line = saveg_read32();
        int sector;

        button->line = line >= 0 ? &lines[saveg_index(line, numlines, "line")] : NULL;
        button->where = saveg_read32();
        button->btexture = saveg_read32();
        button->btimer = saveg_read32();
        sector = saveg_read32();
        button->soundorg = sector >= 0 ? &sectors[saveg_index(sector, numsectors, "sector")].soundorg : NULL;
    }

    numbraintargets = saveg_index(saveg_read32(), arrlen(braintargets) + 1, "brain targets");
    braintargeton = saveg_read32();
    if (braintargeton != 0)
    {
        saveg_index(braintargeton, numbraintargets, "brain target");
    }
    for (i = 0; i < numbraintargets; ++i)
    {
        braintargets[i] = MobjOfNumber(saveg_read32());
    }

    for (i = 0; i < MAXPLAYERS; ++i)
    {
        for (j = 0; j < BACKUPTICS; ++j)
        {
            consistancy[i][j] = saveg_read8();
        }
    }

    FreeSnapshotThinkers();

    return tic;
}

// A hash of everything a snapshot keeps, the same on every peer that is in
// step: peers print it with -hash, to show that they are
unsigned int P_StateHash(int tic)
{
    unsigned int hash = 2166136261u;

    saveg_hash = &hash;
    saveg_write32(leveltime);
    P_ArchiveSnapshot(tic);
    saveg_hash = NULL;

    return hash;
}
