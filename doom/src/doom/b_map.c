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
//     The areas are the leaves (subsectors) of the level's BSP tree,
//     which are convex. Each leaf's outline is cut out of the whole map,
//     and the leaf across each edge looked up with a point just beyond
//     it. Which edges players can cross is worked out again when floors
//     and ceilings move.
//

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "b_map.h"
#include "doomdata.h"
#include "doomstat.h"
#include "m_bbox.h"
#include "p_local.h"
#include "p_spec.h"
#include "r_main.h"
#include "r_state.h"

// More than the cuts down to a leaf leave of the outline
#define MAX_CORNERS 128
// A player steps up 24 units and is 56 high
#define MAX_STEP    (24 * FRACUNIT)
#define MIN_HEIGHT  (56 * FRACUNIT)
// Shorter edges come from cuts that barely touch a leaf
#define MIN_EDGE    8.0
// A player is 32 wide, 16 to each side, and needs a little more than
// that to get through
#define SHOULDER    16.0
#define MIN_ROOM    1.0
// Room beyond this is as good as any
#define ROOMY       64.0
// Routes cross an edge this far into the next area, so that a player
// who gets there is across
#define BEYOND      16.0

typedef struct
{
    double x, y;
} corner_t;

typedef struct
{
    corner_t corners[MAX_CORNERS];
    int count;
} outline_t;

// A place where players may get from one leaf into another. Whether they
// do depends on the floors and ceilings there, which move.
typedef struct
{
    int from, to;
    nav_point_t at, beyond, before;
    int special;
    boolean teleports;
} crossing_t;

static crossing_t *crossings;
static int num_crossings, max_crossings;

// The outlines of all leaves, one after the other: leaf i has the
// corners from first_corner[i] up to first_corner[i + 1]
static corner_t *corners;
static int num_corners, max_corners;
static int *first_corner;

// The floor of each sector when the level started, which is where lifts
// come back up to
static fixed_t *top_floors;

static double Units(fixed_t value)
{
    return value / (double) FRACUNIT;
}

// How far a point is to the right of the line from x, y towards dx, dy.
// Doom's lines have their front on the right.
static double RightOf(corner_t point, double x, double y, double dx, double dy)
{
    return (point.x - x) * dy - (point.y - y) * dx;
}

// Cuts an outline along a line and keeps what is on its right, or its
// left when side is 1
static void Cut(outline_t *outline, double x, double y, double dx, double dy, int side)
{
    outline_t result;
    double sign = side == 0 ? 1 : -1;
    int i;

    result.count = 0;

    for (i = 0; i < outline->count && result.count < MAX_CORNERS - 1; ++i)
    {
        corner_t a = outline->corners[i];
        corner_t b = outline->corners[(i + 1) % outline->count];
        double da = sign * RightOf(a, x, y, dx, dy);
        double db = sign * RightOf(b, x, y, dx, dy);

        if (da >= 0)
        {
            result.corners[result.count++] = a;
        }

        if ((da > 0 && db < 0) || (da < 0 && db > 0))
        {
            double t = da / (da - db);

            result.corners[result.count++] = (corner_t){a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)};
        }
    }

    *outline = result;
}

// Doors that open for whoever walks up and uses them. In a deathmatch
// every player has all the keys, so the locked ones count too.
static boolean IsDoor(int special)
{
    switch (special)
    {
        case 1: case 31: case 117: case 118:
            return true;

        case 26: case 27: case 28: case 32: case 33: case 34:
            return deathmatch != 0;

        default:
            return false;
    }
}

// A lift: a sector that a switch or a line on the floor (special 62, 88,
// 120 or 123 with the sector's tag) lowers to the floor around it for a
// while. Players get on at the bottom and off at the top.
static boolean IsLift(sector_t *sector)
{
    int i;

    if (sector->tag == 0)
    {
        return false;
    }

    for (i = 0; i < numlines; ++i)
    {
        int special = lines[i].special;

        if (lines[i].tag == sector->tag && (special == 62 || special == 88 || special == 120 || special == 123))
        {
            return true;
        }
    }

    return false;
}

// Whether a player gets from one floor onto another, under the ceilings
static boolean Fits(fixed_t floor, fixed_t ceiling, fixed_t to_floor, fixed_t to_ceiling)
{
    fixed_t top = to_ceiling < ceiling ? to_ceiling : ceiling;
    fixed_t bottom = to_floor > floor ? to_floor : floor;

    return to_floor - floor <= MAX_STEP && top - bottom >= MIN_HEIGHT;
}

// Where a sector's floor can be: where it is, or for a lift, up where
// it was when the level started and down at the floor around it
static int Floors(sector_t *sector, fixed_t *floors)
{
    if (!IsLift(sector))
    {
        floors[0] = sector->floorheight;
        return 1;
    }

    floors[0] = top_floors[sector - sectors];
    floors[1] = P_FindLowestFloorSurrounding(sector);

    return 2;
}

static boolean CanCross(sector_t *from, sector_t *to, int special)
{
    fixed_t floors[2], to_floors[2];
    int count = Floors(from, floors);
    int to_count = Floors(to, to_floors);
    int i, j;

    if (from == to)
    {
        return true;
    }

    // A closed door has no room under it until it is used
    if (IsDoor(special))
    {
        return to->floorheight - from->floorheight <= MAX_STEP;
    }

    // With a lift, players wait for it to be where they get across
    for (i = 0; i < count; ++i)
    {
        for (j = 0; j < to_count; ++j)
        {
            if (Fits(floors[i], from->ceilingheight, to_floors[j], to->ceilingheight))
            {
                return true;
            }
        }
    }

    return false;
}

// The area that a teleporter line takes players to, or -1. Its tag names
// a sector with a landing spot in it. Lines 39 and 97 work for players,
// from the front only.
static int TeleportsTo(seg_t *seg)
{
    line_t *line = seg->linedef;
    thinker_t *thinker;

    if ((line->special != 39 && line->special != 97) || seg->sidedef != &sides[line->sidenum[0]])
    {
        return -1;
    }

    for (thinker = thinkercap.next; thinker != &thinkercap; thinker = thinker->next)
    {
        mobj_t *spot = (mobj_t *) thinker;

        if (thinker->function.acp1 == (actionf_p1) P_MobjThinker && spot->type == MT_TELEPORTMAN
         && spot->subsector->sector->tag == line->tag)
        {
            return spot->subsector - subsectors;
        }
    }

    return -1;
}

// Whether a point is inside a leaf's outline. Doom finds a leaf for any
// point, also for one inside a wall or outside the level, where no
// outline has it.
static boolean Inside(int index, corner_t point)
{
    int count = first_corner[index + 1] - first_corner[index];
    corner_t *outline = &corners[first_corner[index]];
    boolean left = false, right = false;
    int i;

    for (i = 0; i < count; ++i)
    {
        corner_t a = outline[i], b = outline[(i + 1) % count];
        double side = RightOf(point, a.x, a.y, b.x - a.x, b.y - a.y) / fmax(hypot(b.x - a.x, b.y - a.y), 1);

        left = left || side < -0.5;
        right = right || side > 0.5;
    }

    return count >= 3 && !(left && right);
}

// How far a point is from a line of the level
static double DistanceTo(line_t *line, corner_t point)
{
    double x = Units(line->v1->x), y = Units(line->v1->y);
    double dx = Units(line->dx), dy = Units(line->dy);
    double along = ((point.x - x) * dx + (point.y - y) * dy) / (dx * dx + dy * dy);

    along = fmax(0, fmin(1, along));

    return hypot(point.x - (x + along * dx), point.y - (y + along * dy));
}

// How much room a player has to cross an edge at a point: the distance
// from its shoulders, 16 units to each side along the edge, to the
// closest wall or step up. What is ahead does not count.
static double Clearance(corner_t point, double along_x, double along_y, fixed_t floor, line_t *crossed)
{
    double room = ROOMY;
    int i, j;

    for (i = 0; i < numlines; ++i)
    {
        line_t *line = &lines[i];

        if (line != crossed
         && (line->backsector == NULL || line->flags & ML_BLOCKING
          || line->frontsector->floorheight - floor > MAX_STEP || line->backsector->floorheight - floor > MAX_STEP)
         && point.x > Units(line->bbox[BOXLEFT]) - ROOMY && point.x < Units(line->bbox[BOXRIGHT]) + ROOMY
         && point.y > Units(line->bbox[BOXBOTTOM]) - ROOMY && point.y < Units(line->bbox[BOXTOP]) + ROOMY)
        {
            for (j = -2; j <= 2; ++j)
            {
                corner_t shoulder = {point.x + j * SHOULDER / 2 * along_x, point.y + j * SHOULDER / 2 * along_y};

                room = fmin(room, DistanceTo(line, shoulder));
            }
        }
    }

    return room;
}

static void AddCrossing(crossing_t crossing)
{
    if (num_crossings == max_crossings)
    {
        max_crossings = max_crossings ? max_crossings * 2 : 4096;
        crossings = realloc(crossings, max_crossings * sizeof(*crossings));
    }

    crossings[num_crossings++] = crossing;
}

// Finds where players can cross a leaf's edge from a to b, and which
// leaf is there. out points out of the leaf. seg is NULL where the edge
// is a cut of the tree, with open floor on both sides.
static void FindCrossing(int index, corner_t a, corner_t b, double out_x, double out_y, seg_t *seg)
{
    static const double places[] = {0.5, 0.25, 0.75, 0, 1};
    // The higher of the floors on either side: on stairs, the step after
    // the next is no wall to whoever is on the next
    fixed_t floor = seg != NULL && seg->backsector->floorheight > seg->frontsector->floorheight
                  ? seg->backsector->floorheight : subsectors[index].sector->floorheight;
    corner_t at = a, across;
    double length = hypot(b.x - a.x, b.y - a.y);
    double most = 0;
    crossing_t crossing;
    int i;

    // The place with the most room: a wide door may be several short
    // stretches, with its jambs at the ends of the outer ones
    for (i = 0; i < arrlen(places); ++i)
    {
        corner_t place = {a.x + places[i] * (b.x - a.x), a.y + places[i] * (b.y - a.y)};
        double room = Clearance(place, (b.x - a.x) / length, (b.y - a.y) / length, floor,
                                seg != NULL ? seg->linedef : NULL);

        if (room > most)
        {
            most = room;
            at = place;
        }
    }

    if (most < MIN_ROOM)
    {
        return;
    }

    across = (corner_t){at.x + 2 * out_x, at.y + 2 * out_y};
    crossing.from = index;
    crossing.at = (nav_point_t){lround(at.x), lround(at.y)};
    crossing.beyond = (nav_point_t){lround(at.x + BEYOND * out_x), lround(at.y + BEYOND * out_y)};
    crossing.before = (nav_point_t){lround(at.x - BEYOND * out_x), lround(at.y - BEYOND * out_y)};
    crossing.special = seg != NULL ? seg->linedef->special : 0;
    crossing.to = seg != NULL ? TeleportsTo(seg) : -1;
    crossing.teleports = crossing.to >= 0;

    if (!crossing.teleports)
    {
        crossing.to = R_PointInSubsector(across.x * FRACUNIT, across.y * FRACUNIT) - subsectors;

        if (crossing.to == index || !Inside(crossing.to, across))
        {
            return;
        }
    }

    AddCrossing(crossing);
}

// The stretch of an edge from a to b that a seg lies along, as distances
// from a. Returns false for segs that are elsewhere.
static boolean Covers(seg_t *seg, corner_t a, corner_t b, double *from, double *to)
{
    double length = hypot(b.x - a.x, b.y - a.y);
    double dx = (b.x - a.x) / length, dy = (b.y - a.y) / length;
    corner_t v1 = {Units(seg->v1->x), Units(seg->v1->y)};
    corner_t v2 = {Units(seg->v2->x), Units(seg->v2->y)};
    double along1 = (v1.x - a.x) * dx + (v1.y - a.y) * dy;
    double along2 = (v2.x - a.x) * dx + (v2.y - a.y) * dy;

    // The corners of leaves are rounded to whole units in the level's
    // data, which puts a seg up to a unit off the edge it made
    if (fabs(RightOf(v1, a.x, a.y, dx, dy)) > 1.5 || fabs(RightOf(v2, a.x, a.y, dx, dy)) > 1.5)
    {
        return false;
    }

    *from = fmax(fmin(along1, along2), 0);
    *to = fmin(fmax(along1, along2), length);

    return *to > *from;
}

static void FindCrossings(int index)
{
    subsector_t *leaf = &subsectors[index];
    int count = first_corner[index + 1] - first_corner[index];
    corner_t *outline = &corners[first_corner[index]];
    corner_t center = {0, 0};
    int i, j;

    for (i = 0; i < count; ++i)
    {
        center.x += outline[i].x / count;
        center.y += outline[i].y / count;
    }

    // Segs are the leaf's part of the level's lines: walls, and the lines
    // with a sector behind them that players may cross. The leaf is on
    // their right.
    for (i = 0; i < leaf->numlines; ++i)
    {
        seg_t *seg = &segs[leaf->firstline + i];
        corner_t v1 = {Units(seg->v1->x), Units(seg->v1->y)};
        corner_t v2 = {Units(seg->v2->x), Units(seg->v2->y)};
        double length = hypot(v2.x - v1.x, v2.y - v1.y);

        if (length >= MIN_EDGE && seg->backsector != NULL && !(seg->linedef->flags & ML_BLOCKING))
        {
            FindCrossing(index, v1, v2, -(v2.y - v1.y) / length, (v2.x - v1.x) / length, seg);
        }
    }

    // What is left of the outline between the segs comes from the cuts
    // of the tree
    for (i = 0; i < count; ++i)
    {
        corner_t a = outline[i];
        corner_t b = outline[(i + 1) % count];
        double length = hypot(b.x - a.x, b.y - a.y);
        // Which way is out of the leaf, across the edge
        double out = RightOf(center, a.x, a.y, b.x - a.x, b.y - a.y) > 0 ? -1 : 1;
        double start = 0;

        if (length < MIN_EDGE)
        {
            continue;
        }

        // Walks along the edge from a, over the seg that starts first
        // each time
        while (start < length)
        {
            double next_from = length, next_to = length;

            for (j = 0; j < leaf->numlines; ++j)
            {
                double from, to;

                if (Covers(&segs[leaf->firstline + j], a, b, &from, &to) && to > start && from < next_from)
                {
                    next_from = from;
                    next_to = to;
                }
            }

            if (next_from - start >= MIN_EDGE)
            {
                corner_t from = {a.x + start / length * (b.x - a.x), a.y + start / length * (b.y - a.y)};
                corner_t to = {a.x + next_from / length * (b.x - a.x), a.y + next_from / length * (b.y - a.y)};

                FindCrossing(index, from, to, out * (b.y - a.y) / length, -out * (b.x - a.x) / length, NULL);
            }

            start = fmax(next_to, start + 1);
        }
    }
}

static boolean Near(mobj_t *thing, nav_point_t point)
{
    return P_AproxDistance(thing->x - point.x * FRACUNIT, thing->y - point.y * FRACUNIT)
         < thing->radius + (int) (SHOULDER + MIN_ROOM) * FRACUNIT;
}

// Whether something solid that stays where it is stands in a crossing:
// a barrel, a lamp, a tree
static boolean Blocked(crossing_t *crossing)
{
    thinker_t *thinker;

    for (thinker = thinkercap.next; thinker != &thinkercap; thinker = thinker->next)
    {
        mobj_t *thing = (mobj_t *) thinker;

        if (thinker->function.acp1 == (actionf_p1) P_MobjThinker && thing->flags & MF_SOLID && thing->player == NULL
         && !(thing->flags & MF_COUNTKILL)
         && (Near(thing, crossing->at) || Near(thing, crossing->beyond) || Near(thing, crossing->before)))
        {
            return true;
        }
    }

    return false;
}

// Keeps the outline of a leaf: what the tree's cuts left, within the
// leaf's own walls
static void KeepLeaf(int index, outline_t *outline)
{
    subsector_t *leaf = &subsectors[index];
    int i;

    for (i = 0; i < leaf->numlines; ++i)
    {
        seg_t *seg = &segs[leaf->firstline + i];
        double x = Units(seg->v1->x), y = Units(seg->v1->y);

        Cut(outline, x, y, Units(seg->v2->x) - x, Units(seg->v2->y) - y, 0);
    }

    if (num_corners + outline->count > max_corners)
    {
        max_corners = (num_corners + outline->count) * 2;
        corners = realloc(corners, max_corners * sizeof(*corners));
    }

    // Leaves come in any order, the corners of each are put in place
    // once all are known
    first_corner[index] = num_corners;
    first_corner[numsubsectors + index] = outline->count;
    memcpy(&corners[num_corners], outline->corners, outline->count * sizeof(*corners));
    num_corners += outline->count;
}

static void Descend(int child, outline_t outline)
{
    node_t *node;
    outline_t left;

    if (child & NF_SUBSECTOR)
    {
        KeepLeaf(child & ~NF_SUBSECTOR, &outline);
        return;
    }

    node = &nodes[child];
    left = outline;
    Cut(&outline, Units(node->x), Units(node->y), Units(node->dx), Units(node->dy), 0);
    Cut(&left, Units(node->x), Units(node->y), Units(node->dx), Units(node->dy), 1);
    Descend(node->children[0], outline);
    Descend(node->children[1], left);
}

// Changes whenever a floor or a ceiling moves: doors, lifts, and what
// switches do to a level
int B_MapHeights(void)
{
    int sum = 0;
    int i;

    for (i = 0; i < numsectors; ++i)
    {
        sum = sum * 31 + sectors[i].floorheight + sectors[i].ceilingheight;
    }

    return sum;
}

void B_MapBuild(void)
{
    int i;

    B_NavReset(numsubsectors);

    for (i = 0; i < num_crossings; ++i)
    {
        crossing_t *crossing = &crossings[i];
        sector_t *from = subsectors[crossing->from].sector;
        sector_t *to = subsectors[crossing->to].sector;

        if (Blocked(crossing))
        {
            continue;
        }

        if (crossing->teleports || CanCross(from, to, crossing->special))
        {
            B_NavConnect(crossing->from, crossing->to, crossing->beyond);
        }

        // The way back too: the neighbour may have a longer edge here with
        // its middle against another leaf, and never find this one
        if (!crossing->teleports && CanCross(to, from, crossing->special))
        {
            B_NavConnect(crossing->to, crossing->from, crossing->before);
        }
    }
}

void B_MapLoad(void)
{
    outline_t whole;
    corner_t *sorted;
    double left = INT_MAX, right = INT_MIN, bottom = INT_MAX, top = INT_MIN;
    int i, next = 0;

    for (i = 0; i < numvertexes; ++i)
    {
        left = fmin(left, Units(vertexes[i].x));
        right = fmax(right, Units(vertexes[i].x));
        bottom = fmin(bottom, Units(vertexes[i].y));
        top = fmax(top, Units(vertexes[i].y));
    }

    whole.count = 4;
    whole.corners[0] = (corner_t){left - 64, bottom - 64};
    whole.corners[1] = (corner_t){right + 64, bottom - 64};
    whole.corners[2] = (corner_t){right + 64, top + 64};
    whole.corners[3] = (corner_t){left - 64, top + 64};

    top_floors = realloc(top_floors, numsectors * sizeof(*top_floors));

    for (i = 0; i < numsectors; ++i)
    {
        top_floors[i] = sectors[i].floorheight;
    }

    // Where each leaf's corners are, then how many it has
    first_corner = realloc(first_corner, (2 * numsubsectors + 1) * sizeof(*first_corner));
    memset(first_corner, 0, (2 * numsubsectors + 1) * sizeof(*first_corner));
    num_corners = 0;

    // A map of a single leaf has no nodes
    Descend(numnodes > 0 ? numnodes - 1 : NF_SUBSECTOR, whole);

    sorted = malloc((num_corners + 1) * sizeof(*sorted));

    for (i = 0; i < numsubsectors; ++i)
    {
        int count = first_corner[numsubsectors + i];

        memcpy(&sorted[next], &corners[first_corner[i]], count * sizeof(*sorted));
        first_corner[i] = next;
        next += count;
    }

    first_corner[numsubsectors] = next;
    free(corners);
    corners = sorted;
    max_corners = num_corners + 1;

    num_crossings = 0;

    for (i = 0; i < numsubsectors; ++i)
    {
        FindCrossings(i);
    }

    B_MapBuild();
}

int B_MapPath(fixed_t x, fixed_t y, fixed_t to_x, fixed_t to_y, nav_point_t *path, int max)
{
    nav_point_t from = {x >> FRACBITS, y >> FRACBITS};
    nav_point_t to = {to_x >> FRACBITS, to_y >> FRACBITS};

    return B_NavPath(from, R_PointInSubsector(x, y) - subsectors, to, R_PointInSubsector(to_x, to_y) - subsectors, path, max);
}

// A player standing on the floor at a place, as far as seeing goes
static mobj_t Stand(fixed_t x, fixed_t y)
{
    mobj_t mobj = {0};

    mobj.x = x;
    mobj.y = y;
    mobj.subsector = R_PointInSubsector(x, y);
    mobj.z = mobj.subsector->sector->floorheight;
    mobj.height = MIN_HEIGHT;

    return mobj;
}

boolean B_MapSees(fixed_t x, fixed_t y, fixed_t to_x, fixed_t to_y)
{
    mobj_t from = Stand(x, y);
    mobj_t to = Stand(to_x, to_y);

    return P_CheckSight(&from, &to);
}
