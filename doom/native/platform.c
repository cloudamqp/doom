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
//     The platform layer of the native build: Doom without a screen,
//     sound or input devices. It replaces the SDL based i_video.c,
//     i_sound.c, i_input.c, i_joystick.c, i_timer.c and the waiting room
//     of net_gui.c. Only the clock and the waiting room do anything.
//

#include <stdlib.h>
#include <time.h>

#include "b_bot.h"
#include "broker.h"
#include "doomtype.h"
#include "i_joystick.h"
#include "i_sound.h"
#include "i_system.h"
#include "i_timer.h"
#include "i_video.h"
#include "m_argv.h"
#include "net_client.h"
#include "net_gui.h"
#include "net_server.h"

//
// Clock
//

static int64_t NowMS(void)
{
    struct timespec now;

    clock_gettime(CLOCK_MONOTONIC, &now);

    return (int64_t) now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

int I_GetTimeMS(void)
{
    static int64_t basetime = 0;

    if (basetime == 0)
    {
        basetime = NowMS();
    }

    return NowMS() - basetime;
}

int I_GetTime(void)
{
    return (int64_t) I_GetTimeMS() * TICRATE / 1000;
}

void I_Sleep(int ms)
{
    struct timespec duration = {ms / 1000, (ms % 1000) * 1000000L};

    nanosleep(&duration, NULL);
}

void I_WaitVBL(int count)
{
    I_Sleep((count * 1000) / 70);
}

void I_InitTimer(void) {}

//
// Waiting room: the game starts when the server says so. A host starts it
// once as many clients have joined as -nodes says.
//

#define ARENA_WAIT_MS 10000


void NET_WaitForLaunch(void)
{
    int listed_players = 0;
    int expected_nodes = 0;
    int arena_bots = 0;
    int joined_ms = 0;
    int i = M_CheckParmWithArgs("-nodes", 1);

    if (i > 0)
    {
        expected_nodes = atoi(myargv[i + 1]);
    }

    //!
    // @arg <n>
    // @category net
    //
    // Host a game of n bots that anyone may join: it starts some seconds
    // after the first player who is no bot joined, and ends when the last
    // one left.
    //
    i = M_CheckParmWithArgs("-arena", 1);

    if (i > 0)
    {
        arena_bots = atoi(myargv[i + 1]);
    }

    while (net_waiting_for_launch)
    {
        boolean controls = net_client_received_wait_data && net_client_wait_data.is_controller;

        if (controls && expected_nodes > 0
         && net_client_wait_data.num_players + net_client_wait_data.num_drones >= expected_nodes)
        {
            NET_CL_LaunchGame();
            expected_nodes = 0;
        }

        // More players may want in, so the first one waits a little
        if (controls && arena_bots > 0 && net_client_wait_data.num_players > arena_bots)
        {
            if (joined_ms == 0)
            {
                joined_ms = I_GetTimeMS();
            }
            else if (I_GetTimeMS() - joined_ms > ARENA_WAIT_MS)
            {
                NET_CL_LaunchGame();
                arena_bots = 0;
            }
        }

        // The lobby hears of every player that comes and goes. In
        // between, the listing is said again by itself.
        if (net_client_received_wait_data && net_client_wait_data.num_players != listed_players)
        {
            listed_players = net_client_wait_data.num_players;
            Broker_List("waiting", listed_players);
        }

        NET_CL_Run();
        NET_SV_Run();

        if (!net_client_connected)
        {
            I_Error("Lost connection to server");
        }

        I_Sleep(10);
    }

    Broker_List("playing", listed_players);
}

//
// The Wasm build asks a bot in JavaScript for its moves, see ../../bot
//

void B_BuildTiccmd(ticcmd_t *cmd, int maketic) {}

//
// Video: the engine draws into a buffer that is never shown
//

static pixel_t screen[SCREENWIDTH * SCREENHEIGHT];

pixel_t *I_VideoBuffer = screen;
boolean screenvisible = false;
boolean screensaver_mode = false;
int usegamma = 0;

void I_InitGraphics(void) {}
void I_GraphicsCheckCommandLine(void) {}
void I_SetWindowTitle(const char *title) {}
void I_CheckIsScreensaver(void) {}
void I_SetGrabMouseCallback(grabmouse_callback_t func) {}
void I_DisplayFPSDots(boolean dots_on) {}
void I_BindVideoVariables(void) {}
void I_StartFrame(void) {}
void I_StartTic(void) {}
void I_UpdateNoBlit(void) {}
void I_FinishUpdate(void) {}
void I_ReadScreen(pixel_t *scr) {}
void I_SetPalette(byte *palette) {}
int I_GetPaletteIndex(int r, int g, int b) { return 0; }
void I_Endoom(byte *data) {}

//
// Input
//

int usemouse = 0;
int vanilla_keyboard_mapping = 1;
float mouse_acceleration = 2.0;
int mouse_threshold = 10;
unsigned int joywait = 0;

void I_BindInputVariables(void) {}
void I_StartTextInput(int x1, int y1, int x2, int y2) {}
void I_StopTextInput(void) {}
void I_InitJoystick(void) {}
void I_BindJoystickVariables(void) {}

//
// Sound
//

int snd_musicdevice = SNDDEVICE_NONE;
int snd_pitchshift = 0;

void I_InitSound(boolean use_sfx_prefix) {}
void I_ShutdownSound(void) {}
void I_BindSoundVariables(void) {}
int I_GetSfxLumpNum(sfxinfo_t *sfxinfo) { return 0; }
void I_PrecacheSounds(sfxinfo_t *sounds, int num_sounds) {}
void I_UpdateSound(void) {}
void I_UpdateSoundParams(int channel, int vol, int sep) {}
int I_StartSound(sfxinfo_t *sfxinfo, int channel, int vol, int sep, int pitch) { return 0; }
void I_StopSound(int channel) {}
boolean I_SoundIsPlaying(int channel) { return false; }

void I_InitMusic(void) {}
void I_ShutdownMusic(void) {}
void I_SetMusicVolume(int volume) {}
void I_PauseSong(void) {}
void I_ResumeSong(void) {}
void *I_RegisterSong(void *data, int len) { return NULL; }
void I_UnRegisterSong(void *handle) {}
void I_PlaySong(void *handle, boolean looping) {}
void I_StopSong(void) {}
boolean I_MusicIsPlaying(void) { return false; }
void I_SetOPLDriverVer(opl_driver_ver_t ver) {}
void I_OPL_DevMessages(char *result, size_t result_len) { result[0] = '\0'; }
