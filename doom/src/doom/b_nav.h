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
//     How a bot finds its way: the shortest path over areas of the map.
//     An area has no walls inside and no dents (it is convex), so a
//     player in it can walk straight to any point of it. Areas connect
//     where a player can cross from one into the next.
//
//     Pure functions on areas described with the calls below, in whole
//     map units. Tested by test/b_nav_test.c. b_map.c describes a Doom
//     level this way.
//

#ifndef __B_NAV__
#define __B_NAV__

#include "doomtype.h"

typedef struct
{
    int x, y;
} nav_point_t;

// Starts the description of a new map with areas 0 to num_areas - 1
void B_NavReset(int num_areas);

// A player can cross from one area into another at this point. Each way
// counts on its own: a ledge is fine to drop from and too high to climb.
void B_NavConnect(int from, int to, nav_point_t at);

// A crossing of the map picked by a number, for somewhere to go. Returns
// false when the map has none.
boolean B_NavPlace(unsigned int number, nav_point_t *place);

// A player did not get across at this point. Routes go another way from
// here on when there is one, until the next B_NavReset.
void B_NavAvoid(nav_point_t at);

// Finds the shortest route between two points, each in the area given.
// Fills path with the points to walk to in turn and returns how many, 0
// when there is no route of max points or fewer.
int B_NavPath(nav_point_t from, int from_area, nav_point_t to, int to_area, nav_point_t *path, int max);

#endif
