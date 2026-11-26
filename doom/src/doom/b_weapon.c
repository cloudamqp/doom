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
//     Which weapon a bot fights with, see b_weapon.h.
//

#include "b_weapon.h"

// A rocket that goes off closer than this hurts the one who fired it
#define ROCKET_DIST 256
// Around that distance the bot stays with what it holds: it puts rockets
// away this much closer, and takes them out this much further away
#define ROCKET_MARGIN 64

int B_BestWeapon(const boolean *owned, const int *shots, int dist, int current)
{
    // From the best to the last resort
    static const int order[] = {B_PLASMA, B_ROCKETS, B_CHAINGUN, B_SHOTGUN, B_PISTOL};
    static const int close_order[] = {B_PLASMA, B_SHOTGUN, B_CHAINGUN, B_PISTOL};
    boolean close = dist < (current == B_ROCKETS ? ROCKET_DIST - ROCKET_MARGIN : ROCKET_DIST + ROCKET_MARGIN);
    const int *weapons = close ? close_order : order;
    int count = close ? arrlen(close_order) : arrlen(order);
    int i;

    for (i = 0; i < count; ++i)
    {
        if (owned[weapons[i]] && shots[weapons[i]] > 0)
        {
            return weapons[i];
        }
    }

    return B_FIST;
}
