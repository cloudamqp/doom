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
//     How a bot finds its way, see b_nav.h.
//

#include <limits.h>
#include <math.h>
#include <stdlib.h>

#include "b_nav.h"

// What a crossing that failed adds to the length of a route: more than
// a detour through most of a level, so it is the last resort
#define AVOID_COST 10000

typedef struct
{
    int from, to;
    nav_point_t at;
    // The next connection from the same area, or -1
    int next;
    // A player got stuck here
    boolean avoid;
} connection_t;

// What the search knows of an area: the shortest way to it so far
typedef struct
{
    int dist;
    // The connection that this way came in by, or -1
    int by;
    // First of the connections out of the area, or -1
    int first;
} area_t;

typedef struct
{
    int dist;
    int area;
} candidate_t;

static area_t *areas;
static int num_areas;

static connection_t *connections;
static int num_connections, max_connections;

// Areas to look at next, the closest first (a binary heap). An area is
// in it once for every way found to it, which is at most once per
// connection and once for the start.
static candidate_t *heap;
static int heap_len;

void B_NavReset(int count)
{
    int i;

    num_areas = count;
    num_connections = 0;
    areas = realloc(areas, count * sizeof(*areas));

    for (i = 0; i < count; ++i)
    {
        areas[i].first = -1;
    }
}

void B_NavConnect(int from, int to, nav_point_t at)
{
    if (num_connections == max_connections)
    {
        max_connections = max_connections ? max_connections * 2 : 1024;
        connections = realloc(connections, max_connections * sizeof(*connections));
        heap = realloc(heap, (max_connections + 1) * sizeof(*heap));
    }

    connections[num_connections] = (connection_t){from, to, at, areas[from].first, false};
    areas[from].first = num_connections++;
}

static int Distance(nav_point_t a, nav_point_t b)
{
    return lround(hypot(a.x - b.x, a.y - b.y));
}

static void Push(int dist, int area)
{
    int i = heap_len++;

    for (; i > 0 && heap[(i - 1) / 2].dist > dist; i = (i - 1) / 2)
    {
        heap[i] = heap[(i - 1) / 2];
    }

    heap[i] = (candidate_t){dist, area};
}

static candidate_t Pop(void)
{
    candidate_t top = heap[0];
    candidate_t last = heap[--heap_len];
    int i = 0;

    for (;;)
    {
        int child = 2 * i + 1;

        if (child + 1 < heap_len && heap[child + 1].dist < heap[child].dist)
        {
            ++child;
        }

        if (child >= heap_len || heap[child].dist >= last.dist)
        {
            break;
        }

        heap[i] = heap[child];
        i = child;
    }

    heap[i] = last;

    return top;
}

// Dijkstra's algorithm over the areas. The length of a way is measured
// from crossing to crossing, as the player will walk it.
int B_NavPath(nav_point_t from, int from_area, nav_point_t to, int to_area, nav_point_t *path, int max)
{
    int i, area, steps;

    if (from_area < 0 || from_area >= num_areas || to_area < 0 || to_area >= num_areas || heap == NULL)
    {
        return 0;
    }

    for (i = 0; i < num_areas; ++i)
    {
        areas[i].dist = INT_MAX;
        areas[i].by = -1;
    }

    areas[from_area].dist = 0;
    heap_len = 0;
    Push(0, from_area);

    while (heap_len > 0)
    {
        candidate_t here = Pop();
        nav_point_t at = areas[here.area].by < 0 ? from : connections[areas[here.area].by].at;

        if (here.area == to_area)
        {
            break;
        }

        if (here.dist > areas[here.area].dist)
        {
            // A shorter way here was found after this one was queued
            continue;
        }

        for (i = areas[here.area].first; i >= 0; i = connections[i].next)
        {
            int dist = here.dist + Distance(at, connections[i].at) + (connections[i].avoid ? AVOID_COST : 0);

            if (dist < areas[connections[i].to].dist)
            {
                areas[connections[i].to].dist = dist;
                areas[connections[i].to].by = i;
                Push(dist, connections[i].to);
            }
        }
    }

    if (areas[to_area].dist == INT_MAX)
    {
        return 0;
    }

    // The way is known from its end: each area tells which connection
    // it was entered by, and that one where it came from
    steps = 1;

    for (area = to_area; areas[area].by >= 0; area = connections[areas[area].by].from)
    {
        ++steps;
    }

    if (steps > max)
    {
        return 0;
    }

    path[steps - 1] = to;
    i = steps - 1;

    for (area = to_area; areas[area].by >= 0; area = connections[areas[area].by].from)
    {
        path[--i] = connections[areas[area].by].at;
    }

    return steps;
}

void B_NavAvoid(nav_point_t at)
{
    int i;

    for (i = 0; i < num_connections; ++i)
    {
        if (connections[i].at.x == at.x && connections[i].at.y == at.y)
        {
            connections[i].avoid = true;
        }
    }
}

boolean B_NavPlace(unsigned int number, nav_point_t *place)
{
    if (num_connections == 0)
    {
        return false;
    }

    *place = connections[number % num_connections].at;

    return true;
}
