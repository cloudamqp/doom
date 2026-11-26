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
//     Every player runs the same game in step, so a bot may read the
//     game but never change it, nor call P_Random: its only way to act
//     is its ticcmd. This is the only file of the bot that knows the
//     engine.
//

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "b_aim.h"
#include "b_native.h"
#include "b_map.h"
#include "b_weapon.h"
#include "d_items.h"
#include "d_event.h"
#include "d_loop.h"
#include "doomstat.h"
#include "i_system.h"
#include "m_argv.h"
#include "net_client.h"
#include "p_local.h"
#include "r_main.h"

#define RUN        50
#define STRAFE     40
#define TOO_CLOSE  (128 * FRACUNIT)
#define TOO_FAR    (384 * FRACUNIT)
#define DODGE_DIST (768 * FRACUNIT)
// Players at about the same height can be walked up to
#define MAX_CLIMB  (48 * FRACUNIT)
// A blocked player moves less than this per tic, a running one 16 units
#define STUCK_DIST (2 * FRACUNIT)
#define STUCK_TICS 8
// Blocked for this long, the route is no good. A lift takes 5 seconds to
// come down, wait and go back up.
#define LOST_TICS  (7 * TICRATE)
#define MAX_PATH   512
// Close enough to a point of the route to head for the next
#define REACHED    (24 * FRACUNIT)
#define ARRIVED    (64 * FRACUNIT)
// Close enough to a thing to have picked it up
#define TOUCHING   (16 * FRACUNIT)
#define LOW_HEALTH 50
// Map units per tic
#define ROCKET_SPEED 20
#define PLASMA_SPEED 25
// How often a bot's aim wanders off anew
#define AIM_TICS   12
// It fires when it aims this close to where it wants to
#define ON_TARGET  (ANG1 * 2)
#define REPLAN_TICS TICRATE
#define MAX_AVOIDED 32
// A door is open enough to walk under after this long
#define DOOR_TICS  (2 * TICRATE)
#define USE_AGAIN_TICS (4 * TICRATE)
// Places to try as the one to shoot from, before giving up for this tic
#define VANTAGE_TRIES 256
// Doom aims up and down by itself at what is this close. Shots at
// players further away, and higher or lower, go past them. A bit less
// than the 1024 units of the game, to be in range for sure.
#define AIM_RANGE  (960 * FRACUNIT)

typedef struct
{
    // Most that it turns in a tic, a full circle is 65536
    int max_turn;
    // Tics that it sees a player before it fires
    int reaction;
    // How far off it aims at most, to either side
    angle_t aim_error;
    // Sidesteps in a fight, to be harder to hit
    boolean dodges;
    // Picks the weapon for the distance, and aims rockets and plasma at
    // where the player will be
    boolean thinks;
    // Goes for weapons that it has not got, and for health when it is low
    boolean collects;
} skill_def_t;

static const skill_def_t skills[] =
{
    {500, 30, ANG1 * 14, false, false, false},
    {800, 20, ANG1 * 9, false, false, true},
    {1300, 12, ANG1 * 5, true, false, true},
    {2500, 6, ANG1 * 2, true, true, true},
    {6000, 2, ANG1 / 2, true, true, true},
};

// What a bot has in mind. There is one per player: with -sim, several
// bots play each other in this process.
typedef struct
{
    // NULL for players that are no bots
    const skill_def_t *skill;
    unsigned int seed;

    // Turns sent for tics that the game has not run yet. Commands are
    // made a few tics ahead, without these the bot would turn again for
    // an angle it is about to reach, and swing past its target.
    short pending_turns[BACKUPTICS];
    // The tic that the command being made is for
    int command_tic;

    int seen_tics;
    int strafe_dir;
    fixed_t last_x, last_y;
    int stuck_tics;
    angle_t wander_angle;
    // Tics left of walking wherever there is room, after losing the way
    int wander_tics;

    // Where the bot is going while it sees nobody
    boolean has_goal;
    fixed_t goal_x, goal_y;
    // The player that the bot is after was last seen here
    boolean chasing;
    fixed_t chase_x, chase_y;
    // Crossings that the bot got stuck at in this level, the latest ones
    nav_point_t avoided[MAX_AVOIDED];
    int num_avoided;
    nav_point_t path[MAX_PATH];
    int path_len, path_pos;
    // The point of the route that the bot heads for, and the closest
    // that it has been to it
    fixed_t next_x, next_y, closest;
    // How close to the goal is there: in sight of it for a place to look
    // around, on top of it for a thing to pick up
    fixed_t goal_reach;
    // How far off it aims right now, which changes a few times a second
    int aim_off;
    // The routes that its route was made with, see map_version
    int map_version;
    // Whether this bot of -sim tries out a change, see -trial
    boolean trial;
    // How often it has died, by whatever cause, and whether it is dead
    int deaths;
    boolean dead;

    // The fight that it is in, for -bottrace to tell how it went
    struct
    {
        // The player that it fights, counted from 0, or -1 for none
        int with;
        int tics, fire_tics;
        fixed_t min_dist, max_dist;
        int health, their_health;
        int weapon;
    } fight;
} bot_t;

static bot_t bots[MAXPLAYERS];

// The bot that is thinking, and the player that it plays
static bot_t *bot = &bots[0];
static int me;

// Changes when floors and ceilings move, which opens and closes routes
static int map_heights;
// Counts how often the routes were worked out again for that
static int map_version;

// The skill of the one bot of -bot, which plays this process's player
static const skill_def_t *solo_skill;

// For the host of an arena: how many of its players are bots
static int arena_bots;

// With -sim: how many bots play each other, and for how long
static int sim_players;
static int sim_tics;

static const skill_def_t *SkillOf(int level)
{
    return &skills[level < 1 ? 0 : level > arrlen(skills) ? arrlen(skills) - 1 : level - 1];
}

// Reads -bot, -sim and -seed, once
static void Setup(void)
{
    static boolean done = false;
    unsigned int seed = 1;
    int i;

    if (done)
    {
        return;
    }

    done = true;

    //!
    // @arg <skill>
    // @category game
    //
    // Let a bot play, with skill 1 (easy) to 5 (hard).
    //
    i = M_CheckParmWithArgs("-bot", 1);

    if (i > 0)
    {
        solo_skill = SkillOf(atoi(myargv[i + 1]));
    }

    //!
    // @arg <skills>
    // @category game
    //
    // Let bots play each other in this process, as fast as it goes and
    // without a network: one for each skill of a list like 5,3,1.
    //
    i = M_CheckParmWithArgs("-sim", 1);

    if (i > 0)
    {
        const char *list = myargv[i + 1];

        while (sim_players < MAXPLAYERS && *list != '\0')
        {
            bots[sim_players++].skill = SkillOf(atoi(list));
            list += strcspn(list, ",");
            list += *list == ',';
        }
    }

    //!
    // @arg <seconds>
    // @category game
    //
    // How much of the game -sim plays, 300 seconds unless told.
    //
    //!
    // @arg <player>
    // @category game
    //
    // To see whether a change to the bot is for the better: one player of
    // -sim, counted from 1, plays with the change and the others without.
    // In the code, the change is what depends on bot->trial.
    //
    i = M_CheckParmWithArgs("-trial", 1);

    if (i > 0 && atoi(myargv[i + 1]) >= 1 && atoi(myargv[i + 1]) <= MAXPLAYERS)
    {
        bots[atoi(myargv[i + 1]) - 1].trial = true;
    }

    i = M_CheckParmWithArgs("-simtime", 1);
    sim_tics = (i > 0 ? atoi(myargv[i + 1]) : 300) * TICRATE;

    //!
    // @arg <n>
    // @category game
    //
    // Make the bots decide differently than with another seed. The same
    // seed gives the same game again.
    //
    // The host of an arena, see doom/native/platform.c
    i = M_CheckParmWithArgs("-arena", 1);
    arena_bots = i > 0 && M_CheckParm("-server") > 0 ? atoi(myargv[i + 1]) : 0;

    i = M_CheckParmWithArgs("-seed", 1);

    if (i > 0)
    {
        seed = atoi(myargv[i + 1]);
    }

    for (i = 0; i < MAXPLAYERS; ++i)
    {
        bots[i].seed = seed * 2654435761u + i;
        bots[i].strafe_dir = 1;
        bots[i].fight.with = -1;
    }
}

// The bot's own random numbers, the game's are not for it to draw from
static unsigned int Random(void)
{
    bot->seed = bot->seed * 1664525 + 1013904223;

    return bot->seed >> 16;
}

static boolean Active(void)
{
    Setup();

    return solo_skill != NULL || sim_players > 0;
}

static int SimPlayers(void)
{
    Setup();

    return sim_players;
}

// Where the player will face once the turns on their way have happened
static angle_t Facing(mobj_t *mo)
{
    int turn = 0;
    int tic;

    for (tic = gametic; tic < bot->command_tic && tic < gametic + BACKUPTICS; ++tic)
    {
        turn += bot->pending_turns[tic % BACKUPTICS];
    }

    return mo->angle + ((angle_t) turn << 16);
}

static void Turn(ticcmd_t *cmd, mobj_t *mo, angle_t angle)
{
    cmd->angleturn = B_TurnToward(Facing(mo), angle, bot->skill->max_turn);
}

// The closest living player in sight, or NULL
static mobj_t *FindEnemy(mobj_t *mo)
{
    mobj_t *enemy = NULL;
    fixed_t nearest = INT_MAX;
    int i;

    for (i = 0; i < MAXPLAYERS; ++i)
    {
        mobj_t *other = players[i].mo;
        fixed_t dist;

        if (!playeringame[i] || i == me || other == NULL || players[i].playerstate != PST_LIVE)
        {
            continue;
        }

        dist = P_AproxDistance(other->x - mo->x, other->y - mo->y);

        if (dist < nearest && P_CheckSight(mo, other))
        {
            enemy = other;
            nearest = dist;
        }
    }

    return enemy;
}

// How often each weapon can fire with the ammo that the player has
static void CountShots(player_t *player, int *shots)
{
    int i;

    for (i = 0; i < B_WEAPONS; ++i)
    {
        ammotype_t ammo = weaponinfo[i].ammo;

        shots[i] = ammo == am_noammo ? 1 : player->ammo[ammo];
    }
}

// Changes to the best weapon for the distance, unless a change is on
// its way already
static void PickWeapon(ticcmd_t *cmd, player_t *player, fixed_t dist)
{
    int shots[B_WEAPONS];
    int best;

    CountShots(player, shots);
    best = B_BestWeapon(player->weaponowned, shots, dist >> FRACBITS, player->readyweapon);

    if (best != player->readyweapon && player->pendingweapon == wp_nochange)
    {
        cmd->buttons |= BT_CHANGE | best << BT_WEAPONSHIFT;
    }
}

// Where to aim to hit a player: at them, or with rockets and plasma,
// which take their time, at where they will be when it arrives
static angle_t AimAt(player_t *player, mobj_t *mo, mobj_t *enemy, fixed_t dist)
{
    int speed = player->readyweapon == wp_missile ? ROCKET_SPEED : player->readyweapon == wp_plasma ? PLASMA_SPEED : 0;
    int tics = speed > 0 && bot->skill->thinks ? (dist >> FRACBITS) / speed : 0;

    return R_PointToAngle2(mo->x, mo->y, enemy->x + tics * enemy->momx, enemy->y + tics * enemy->momy);
}

static boolean Tracing(void)
{
    static int tracing = -1;

    if (tracing < 0)
    {
        //!
        // @category game
        //
        // Print what the bot does once a second, and how each of its
        // fights went.
        //
        tracing = M_ParmExists("-bottrace");
    }

    return tracing;
}

// Tells how a fight went when it is over: the bot or the other player
// died, or they lost each other. This is what shows where a bot is weak.
static void EndFight(mobj_t *mo)
{
    static const char *weapons[] = {"fist", "pistol", "shotgun", "chaingun", "rockets", "plasma", "bfg", "chainsaw", "ssg"};
    player_t *them;

    if (bot->fight.with < 0)
    {
        return;
    }

    them = &players[bot->fight.with];

    if (Tracing())
    {
        printf("bot %d: fight with player %d for %d tics at %d-%d: fired %d, health %d>%d theirs %d>%d, %s, %s\n", me + 1,
               bot->fight.with + 1, bot->fight.tics, bot->fight.min_dist >> FRACBITS, bot->fight.max_dist >> FRACBITS,
               bot->fight.fire_tics, bot->fight.health, mo->health > 0 ? mo->health : 0, bot->fight.their_health,
               them->mo != NULL && them->mo->health > 0 ? them->mo->health : 0, weapons[bot->fight.weapon],
               mo->health <= 0 ? "died" : them->playerstate != PST_LIVE ? "won" : "lost sight");
    }

    bot->fight.with = -1;
}

static void FollowFight(ticcmd_t *cmd, mobj_t *mo, mobj_t *enemy, fixed_t dist)
{
    int with = enemy->player - players;

    if (bot->fight.with != with)
    {
        EndFight(mo);
        bot->fight.with = with;
        bot->fight.tics = bot->fight.fire_tics = 0;
        bot->fight.min_dist = bot->fight.max_dist = dist;
        bot->fight.health = mo->health;
        bot->fight.their_health = enemy->health;
    }

    ++bot->fight.tics;
    bot->fight.fire_tics += (cmd->buttons & BT_ATTACK) != 0;
    bot->fight.min_dist = dist < bot->fight.min_dist ? dist : bot->fight.min_dist;
    bot->fight.max_dist = dist > bot->fight.max_dist ? dist : bot->fight.max_dist;
    bot->fight.weapon = players[me].readyweapon;
}

static void Fight(ticcmd_t *cmd, mobj_t *mo, mobj_t *enemy)
{
    player_t *player = &players[me];
    fixed_t dist = P_AproxDistance(enemy->x - mo->x, enemy->y - mo->y);
    angle_t angle, off;

    // Nobody aims the same way for long, and the worse a player is, the
    // further off
    if (gametic % AIM_TICS == 0)
    {
        int error = bot->skill->aim_error >> 16;

        bot->aim_off = (int) (Random() % (2 * error + 1)) - error;
    }

    angle = AimAt(player, mo, enemy, dist) + ((angle_t) bot->aim_off << 16);
    off = angle - Facing(mo);
    Turn(cmd, mo, angle);

    // The turn of a tic happens before its shot: what counts is where the
    // bot faces after it. Judged by where it faced before, it held its
    // fire against anyone who moved sideways.
    off -= (angle_t) cmd->angleturn << 16;

    if (++bot->seen_tics >= bot->skill->reaction && (off < ON_TARGET || off > -ON_TARGET))
    {
        cmd->buttons |= BT_ATTACK;
    }

    if (bot->skill->thinks)
    {
        PickWeapon(cmd, player, dist);
    }

    FollowFight(cmd, mo, enemy, dist);

    // Closing in on a player above or below, on a ledge or in a pit, ends
    // under it or at its edge with nothing to shoot at: there, the bot
    // stays where it sees them
    if (dist > TOO_FAR && abs(enemy->z - mo->z) <= MAX_CLIMB)
    {
        cmd->forwardmove = RUN;
    }
    else if (dist < TOO_CLOSE)
    {
        cmd->forwardmove = -RUN;
    }

    // Up close it sidesteps to be harder to hit, and changes side about
    // once a second. From afar, standing still aims better.
    if (dist < DODGE_DIST && bot->skill->dodges)
    {
        if (Random() % TICRATE == 0)
        {
            bot->strafe_dir = -bot->strafe_dir;
        }

        cmd->sidemove = bot->strafe_dir * STRAFE;
    }
}

// Walks straight on, and turns away from what blocks it
static void Wander(ticcmd_t *cmd, mobj_t *mo)
{
    if (bot->stuck_tics >= STUCK_TICS)
    {
        bot->wander_angle = mo->angle + ANG90 + (Random() % 180) * ANG1;
        bot->stuck_tics = 0;
    }

    Turn(cmd, mo, bot->wander_angle);
    cmd->forwardmove = RUN;
}

// Sets out for a place if there is a route to it. It is there when it is
// as close as reach.
static boolean TryGoal(mobj_t *mo, fixed_t x, fixed_t y, fixed_t reach)
{
    bot->goal_x = x;
    bot->goal_y = y;
    bot->goal_reach = reach;
    bot->path_len = B_MapPath(mo->x, mo->y, x, y, bot->path, MAX_PATH);
    bot->path_pos = 0;
    bot->has_goal = bot->path_len > 0 && P_AproxDistance(x - mo->x, y - mo->y) > reach;

    return bot->has_goal;
}

// Sets out for a place to shoot from at whoever is at x, y: there if a
// route leads there, as it gets them in view on the way. If not, like for
// a ledge that players drop from, a place in range that sees it.
static boolean GoNear(mobj_t *mo, fixed_t x, fixed_t y)
{
    unsigned int first = Random();
    int i;

    if (TryGoal(mo, x, y, ARRIVED))
    {
        return true;
    }

    for (i = 0; i < VANTAGE_TRIES; ++i)
    {
        nav_point_t place;
        fixed_t place_x, place_y;

        if (!B_NavPlace(first + i, &place))
        {
            break;
        }

        place_x = place.x << FRACBITS;
        place_y = place.y << FRACBITS;

        if (P_AproxDistance(place_x - x, place_y - y) < AIM_RANGE && B_MapSees(place_x, place_y, x, y)
         && TryGoal(mo, place_x, place_y, ARRIVED))
        {
            return true;
        }
    }

    return false;
}

// Whether a thing lying around is worth going for: a weapon that the
// player has not got, or health when it is low
static boolean Wants(player_t *player, mobj_t *thing)
{
    switch (thing->type)
    {
        case MT_SHOTGUN:
            return !player->weaponowned[wp_shotgun];
        case MT_CHAINGUN:
            return !player->weaponowned[wp_chaingun];
        case MT_MISC27:
            return !player->weaponowned[wp_missile];
        case MT_MISC28:
            return !player->weaponowned[wp_plasma];
        case MT_MISC10: // stimpack
        case MT_MISC11: // medikit
        case MT_MISC12: // soulsphere
            return player->health < LOW_HEALTH;
        default:
            return false;
    }
}

// Sets out for the closest thing worth having that there is a route to,
// of the few closest
static boolean GoCollect(mobj_t *mo)
{
    player_t *player = &players[me];
    fixed_t tried = 0;
    int tries;

    for (tries = 0; tries < 3; ++tries)
    {
        mobj_t *closest = NULL;
        fixed_t closest_dist = INT_MAX;
        thinker_t *thinker;

        for (thinker = thinkercap.next; thinker != &thinkercap; thinker = thinker->next)
        {
            mobj_t *thing = (mobj_t *) thinker;
            fixed_t dist;

            if (thinker->function.acp1 != (actionf_p1) P_MobjThinker || !(thing->flags & MF_SPECIAL)
             || !Wants(player, thing))
            {
                continue;
            }

            dist = P_AproxDistance(thing->x - mo->x, thing->y - mo->y);

            if (dist > tried && dist < closest_dist)
            {
                closest = thing;
                closest_dist = dist;
            }
        }

        if (closest == NULL)
        {
            return false;
        }

        if (TryGoal(mo, closest->x, closest->y, TOUCHING))
        {
            return true;
        }

        tried = closest_dist;
    }

    return false;
}

// Picks where to go with nobody in sight: for something worth having,
// or to look for players at a deathmatch start, where they turn up
// sooner or later
static void PickGoal(mobj_t *mo)
{
    int starts = deathmatch_p - deathmatchstarts;
    mapthing_t *start = starts > 0 ? &deathmatchstarts[Random() % starts] : &playerstarts[Random() % MAXPLAYERS];

    if (bot->skill->collects && GoCollect(mo))
    {
        return;
    }

    GoNear(mo, start->x << FRACBITS, start->y << FRACBITS);
}

// Follows the route to the goal
static void Travel(ticcmd_t *cmd, mobj_t *mo)
{
    fixed_t x, y, dist;
    angle_t angle, off;

    if (!bot->has_goal || P_AproxDistance(bot->goal_x - mo->x, bot->goal_y - mo->y) < bot->goal_reach)
    {
        bot->has_goal = false;
        bot->chasing = false;
        PickGoal(mo);
    }

    // The route is kept while the bot gets on with it, or it would pace
    // up and down between two ways round. After a second of getting
    // nowhere, a new one from where it is helps.
    if (bot->has_goal && (bot->path_len == 0 || bot->stuck_tics == REPLAN_TICS))
    {
        bot->path_len = B_MapPath(mo->x, mo->y, bot->goal_x, bot->goal_y, bot->path, MAX_PATH);
        bot->path_pos = 0;
    }

    if (bot->has_goal && bot->path_len > 0 && bot->stuck_tics >= LOST_TICS)
    {
        bot->avoided[bot->num_avoided++ % MAX_AVOIDED] = bot->path[bot->path_pos];
        B_NavAvoid(bot->path[bot->path_pos]);
    }

    if (!bot->has_goal || bot->path_len == 0 || bot->stuck_tics >= LOST_TICS)
    {
        // No way there, or none that works: try another place after
        // getting away from here
        bot->has_goal = false;
        bot->wander_tics = TICRATE;
        bot->wander_angle = mo->angle + ANG180;
        bot->stuck_tics = 0;
        return;
    }

    for (;;)
    {
        x = bot->path[bot->path_pos].x << FRACBITS;
        y = bot->path[bot->path_pos].y << FRACBITS;
        dist = P_AproxDistance(x - mo->x, y - mo->y);

        if (bot->path_pos == bot->path_len - 1 || dist > REACHED)
        {
            break;
        }

        ++bot->path_pos;
    }

    // Stuck is not getting closer to the next point of the route. Moving
    // is not enough: a player slides along the wall that blocks it.
    if (x != bot->next_x || y != bot->next_y || dist < bot->closest - STUCK_DIST)
    {
        bot->next_x = x;
        bot->next_y = y;
        bot->closest = dist;
        bot->stuck_tics = 0;
    }
    else
    {
        ++bot->stuck_tics;
    }

    angle = R_PointToAngle2(mo->x, mo->y, x, y);
    off = angle - Facing(mo);
    Turn(cmd, mo, angle);

    // Running starts once it faces the right way, more or less
    if (off < ANG45 || off > -ANG45)
    {
        cmd->forwardmove = RUN;
    }

    // What blocks the way may be a door or the switch of a lift: use it,
    // and give it time before trying again. Using a door that is opening
    // closes it again.
    if (bot->stuck_tics % USE_AGAIN_TICS == STUCK_TICS)
    {
        cmd->buttons |= BT_USE;
    }

    // Or the corner of a wall, which a step to the side gets around: to
    // one side first, then to the other
    if (bot->stuck_tics >= DOOR_TICS)
    {
        cmd->sidemove = (bot->stuck_tics / (2 * STUCK_TICS)) % 2 ? STRAFE : -STRAFE;
    }
}

// What the bot is up to, once a second, for whoever works on it
static void Trace(mobj_t *mo, mobj_t *enemy, ticcmd_t *cmd)
{
    if (!Tracing() || bot->command_tic % TICRATE != 0)
    {
        return;
    }

    printf("bot %d: %ds at %d,%d,%d %s", me + 1, bot->command_tic / TICRATE, mo->x >> FRACBITS, mo->y >> FRACBITS,
           mo->z >> FRACBITS, bot->wander_tics > 0 ? "wanders" : bot->chasing ? "chases" : "patrols");

    if (bot->has_goal)
    {
        printf(" to %d,%d step %d of %d", bot->goal_x >> FRACBITS, bot->goal_y >> FRACBITS, bot->path_pos + 1, bot->path_len);

        if (bot->path_pos < bot->path_len)
        {
            printf(" via %d,%d", bot->path[bot->path_pos].x, bot->path[bot->path_pos].y);
        }
    }

    if (bot->stuck_tics > 0)
    {
        printf(" stuck %d", bot->stuck_tics);
    }

    if (enemy != NULL)
    {
        printf(" sees player at %d,%d,%d with health %d, %d away%s", enemy->x >> FRACBITS, enemy->y >> FRACBITS,
               enemy->z >> FRACBITS, enemy->health, P_AproxDistance(enemy->x - mo->x, enemy->y - mo->y) >> FRACBITS,
               cmd->buttons & BT_ATTACK ? ", fires" : "");
    }

    printf("\n");
}

// Moving floors and ceilings open and close routes: they are worked out
// again then, at most once a second, and every bot makes a new one
static void FollowMap(void)
{
    int i, j;

    if (gametic % TICRATE == 0 && B_MapHeights() != map_heights)
    {
        map_heights = B_MapHeights();
        ++map_version;
        B_MapBuild();

        for (i = 0; i < MAXPLAYERS; ++i)
        {
            for (j = 0; j < bots[i].num_avoided && j < MAX_AVOIDED; ++j)
            {
                B_NavAvoid(bots[i].avoided[j]);
            }
        }
    }

    if (bot->map_version != map_version)
    {
        bot->map_version = map_version;
        bot->path_len = 0;
    }
}

static void Think(ticcmd_t *cmd)
{
    player_t *player = &players[me];
    mobj_t *mo = player->mo;
    mobj_t *enemy;

    // The host left, and Doom plays on alone: nobody to play with
    if (netgame && !net_client_connected && sim_players == 0)
    {
        I_Quit();
    }

    if (arena_bots > 0)
    {
        int in_game = 0;
        int i;

        for (i = 0; i < MAXPLAYERS; ++i)
        {
            in_game += playeringame[i];
        }

        // An arena is there for players to have someone to play with:
        // it ends when the last of them left, and with its level, for
        // the next one to start with whoever is in the lobby then
        if (in_game <= arena_bots || gamestate == GS_INTERMISSION)
        {
            I_Quit();
        }
    }

    // The tally between levels waits for a key
    if (gamestate == GS_INTERMISSION && gametic % 2 == 0)
    {
        cmd->buttons |= BT_USE;
    }

    if (gamestate != GS_LEVEL || mo == NULL)
    {
        return;
    }

    if (player->playerstate != PST_LIVE && !bot->dead)
    {
        ++bot->deaths;
        EndFight(mo);
    }

    bot->dead = player->playerstate != PST_LIVE;

    if (player->playerstate != PST_LIVE)
    {
        // Back into the game
        cmd->buttons |= BT_USE;
        bot->seen_tics = 0;
        return;
    }

    FollowMap();

    enemy = FindEnemy(mo);

    // Where to go when they get out of sight, or are too far to hit
    if (enemy != NULL && (!bot->chasing || P_AproxDistance(enemy->x - bot->chase_x, enemy->y - bot->chase_y) > ARRIVED))
    {
        bot->chasing = true;
        bot->chase_x = enemy->x;
        bot->chase_y = enemy->y;
        GoNear(mo, bot->chase_x, bot->chase_y);
    }

    if (enemy != NULL && P_AproxDistance(enemy->x - mo->x, enemy->y - mo->y) < AIM_RANGE)
    {
        Fight(cmd, mo, enemy);
    }
    else
    {
        EndFight(mo);
        bot->seen_tics = 0;

        if (bot->wander_tics > 0)
        {
            boolean moved = P_AproxDistance(mo->x - bot->last_x, mo->y - bot->last_y) > STUCK_DIST;

            bot->stuck_tics = moved ? 0 : bot->stuck_tics + 1;
            --bot->wander_tics;
            Wander(cmd, mo);
        }
        else
        {
            Travel(cmd, mo);
        }
    }

    Trace(mo, enemy, cmd);

    bot->last_x = mo->x;
    bot->last_y = mo->y;
}

// How well the bot knows its way around a level, for whoever picks maps
// for bots: of all routes from one deathmatch start to another, how many
// it finds
static void PrintRoutes(void)
{
    int starts = deathmatch_p - deathmatchstarts;
    int found = 0;
    int a, b;

    //!
    // @category game
    //
    // Print how many of the level's routes the bot finds.
    //
    if (!M_ParmExists("-routes"))
    {
        return;
    }

    for (a = 0; a < starts; ++a)
    {
        for (b = 0; b < starts; ++b)
        {
            found += a != b && B_MapPath(deathmatchstarts[a].x << FRACBITS, deathmatchstarts[a].y << FRACBITS,
                                         deathmatchstarts[b].x << FRACBITS, deathmatchstarts[b].y << FRACBITS,
                                         bot->path, MAX_PATH) > 0;
        }
    }

    printf("doom: 15, E%dM%d routes %d of %d\n", gameepisode, gamemap, found, starts * (starts - 1));
}

static void LevelLoaded(void)
{
    int i;

    if (!Active())
    {
        return;
    }

    B_MapLoad();
    map_heights = B_MapHeights();
    ++map_version;

    for (i = 0; i < MAXPLAYERS; ++i)
    {
        bots[i].has_goal = false;
        bots[i].chasing = false;
        bots[i].path_len = 0;
        bots[i].num_avoided = 0;
    }

    PrintRoutes();
}

static void BuildTiccmd(ticcmd_t *cmd, int maketic)
{
    me = consoleplayer;
    bot = &bots[me];
    bot->skill = solo_skill;
    bot->command_tic = maketic;
    Think(cmd);
    bot->pending_turns[maketic % BACKUPTICS] = cmd->angleturn;
}

// How the game of -sim went, a line per player
static void PrintResults(void)
{
    int i, j;

    for (i = 0; i < sim_players; ++i)
    {
        int frags = 0;

        for (j = 0; j < sim_players; ++j)
        {
            // A frag of oneself is a death by one's own rocket or the
            // level, which Doom counts against the player
            frags += i == j ? -players[i].frags[j] : players[i].frags[j];
        }

        // Deaths by monsters are no frag of anyone's, so they are counted
        // here
        printf("doom: 16, player %d skill %d frags %d deaths %d\n", i + 1, (int) (bots[i].skill - skills) + 1, frags,
               bots[i].deaths);
    }
}

static void Simulate(int player, ticcmd_t *cmd)
{
    if (gametic >= sim_tics)
    {
        PrintResults();
        I_Quit();
    }

    // Commands are for the tic that runs now: nothing is on its way
    me = player;
    bot = &bots[me];
    bot->command_tic = gametic;
    memset(cmd, 0, sizeof(*cmd));
    Think(cmd);
}

const bot_api_t b_builtin = {Active, SimPlayers, Simulate, LevelLoaded, BuildTiccmd};

const bot_api_t *b_api = &b_builtin;
