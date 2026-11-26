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
//     Describes a Doom level to b_nav.c as areas that connect.
//

#ifndef __B_MAP__
#define __B_MAP__

#include "b_nav.h"
#include "m_fixed.h"

// Reads the level that was just loaded
void B_MapLoad(void);

// Works out anew what connects, from the level as it is now. A level
// changes as it is played: what is behind a switch has no route to it
// until someone finds the switch.
void B_MapBuild(void);

// Whether players standing at two places of the level see each other
boolean B_MapSees(fixed_t x, fixed_t y, fixed_t to_x, fixed_t to_y);

// A number that changes when floors or ceilings move
int B_MapHeights(void);

// The route between two places of the level, see B_NavPath
int B_MapPath(fixed_t x, fixed_t y, fixed_t to_x, fixed_t to_y, nav_point_t *path, int max);

#endif
