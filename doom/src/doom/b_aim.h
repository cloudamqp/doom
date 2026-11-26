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
//     How a bot aims. Doom aims up and down by itself, so aiming is
//     turning. Pure functions, tested by test/b_aim_test.c.
//

#ifndef __B_AIM__
#define __B_AIM__

#include "tables.h"

// The turn for one tic (a ticcmd's angleturn) that brings a player facing
// from closer to facing to, the short way round and at most max_turn.
short B_TurnToward(angle_t from, angle_t to, int max_turn);

#endif
