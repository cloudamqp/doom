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
//     Which weapon a bot fights with. Pure functions, tested by
//     test/b_weapon_test.c.
//

#ifndef __B_WEAPON__
#define __B_WEAPON__

#include "doomtype.h"

// The weapons that a bot chooses between, numbered as in Doom's
// weapontype_t. It leaves the chainsaw and the BFG alone.
enum
{
    B_FIST,
    B_PISTOL,
    B_SHOTGUN,
    B_CHAINGUN,
    B_ROCKETS,
    B_PLASMA,
    B_WEAPONS
};

// The weapon to use against a player dist map units away. owned tells
// which weapons the bot has, shots how often each can fire with the ammo
// that is left, and current which one it holds.
int B_BestWeapon(const boolean *owned, const int *shots, int dist, int current);

#endif
