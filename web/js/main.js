// The lobby and the games share one page: a game opens in place, so the
// download of Doom that the lobby started carries on. See files.js.
import "./files.js";
import "./music.js";
import { inGame, showGame } from "./doomq.js";

// Doom can't be stopped once it runs, so going back and forth loads the page
addEventListener("popstate", () => inGame() === document.querySelector("#game").hidden && location.reload());

showGame(inGame());
import(inGame() ? "./play.js" : "./lobby.js");
