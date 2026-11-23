// The lobby, the games and the spectators share one page: a game opens in
// place, so the download of Doom that the lobby started carries on. See
// files.js.
import "./files.js";
import "./music.js";
import { show, view } from "./doomq.js";

// Doom can't be stopped once it runs, so going back and forth loads the page
addEventListener("popstate", () => document.querySelector(`#${view()}`).hidden && location.reload());

show(view());
