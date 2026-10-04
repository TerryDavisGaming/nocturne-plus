using HarmonyLib;
using UnityEngine;

namespace NocturnePlus;

/// <summary>
/// The Main menu music switch on Options > Audio: turns off the music of the title screen and the
/// menus reached from it (options, the arcade, custom battles, the hub) and nothing else.
///
/// How the game plays it. All of the game's music is one Wwise music switch container, started once
/// by MX_PLAY_Music when the game starts (AudioController.Start). Which music it plays follows the
/// state Global_Music_State: TitleMenu is the menu music, Combat and Combat_Arcade the battles,
/// Overworld the story. Exactly two events put the state on TitleMenu: MX_PLAY_Music (at start) and
/// MX_Title_Menu (the title screen, and AudioController.PlayTitle: back from a battle or a story
/// scene, or from the chart editor's test play). The game posts both through
/// AudioController.PostEvent. Story music and the sound effects reach PostEvent too (as PostAudioEvent, with other ids),
/// so the postfix has to tell the two music events from everything else.
///
/// What this does. While the setting is off, right after the game posts either of those two events,
/// the mod posts the game's own silence event (MX_Silence_O05_I05, the one CustomMusic uses to fade
/// the menu music out before a custom battle). It sets Global_Music_State to Global, where the
/// container plays nothing, and the game's transition rules fade the menu music out in half a second.
/// The game's own event still runs first, so everything else the title does (stopping the story's
/// ambience, resetting the music volume and filters) happens as always. The menu track starts with
/// about 0.97 s of silence, so even the music starting and being faded out in the same frame is not heard.
/// No volume, bus or RTPC is touched, so the game's volume sliders keep meaning what they say, and
/// battles and the story set their own state when they start, so their music is never held back.
/// A second after a silence the leftover Global_Silence value is changed to the instant one (Settle),
/// so the story's first track starts at once, as it would without the setting, not over 3 s.
///
/// Turning it off in a menu silences the music at once; turning it on again in a menu has the game
/// play its title music again (AudioController.PlayTitle). Turned off or on anywhere else (the pause
/// screen of a battle or of the story), nothing is heard to change: the setting is simply kept for
/// the next time the game starts its menu music.
/// </summary>
internal static class MenuMusic
{
    // The game's own names. The silence event is in its MX_Global soundbank, which it keeps loaded.
    private const string SilenceEvent = "MX_Silence_O05_I05";
    private const string MusicState = "Global_Music_State";
    private const string MenuStateName = "TitleMenu";
    private const string SilentStateName = "Global";
    private const string SilenceGroup = "Global_Silence";
    private const string SilenceNameQuick = "Silence_O0_I0";
    private const string SilenceNameFade = "Silence_O05_I05";

    // The two events that put Global_Music_State on TitleMenu: MX_Title_Menu (AudioController.TitleMusicEvent and
    // TitleScreen.titleMusicEvent) and MX_PLAY_Music (AudioController.PlayMusicEvent), by their Wwise ids.
    private const uint TitleMenuEventId = 3365585109u;
    private const uint PlayMusicEventId = 183086159u;

    // After the music has faded out, the silence is changed to the one that lets later music start at once.
    private const float SettleAfter = 1f;

    private static readonly Dictionary<string, uint> Ids = new();
    private static bool installed, silenced, reportedError;
    private static int silenceFrame = -1;
    private static float settleAt = -1f;

    /// <summary>Times the mod has silenced the game's menu music (for QA).</summary>
    internal static int Silences { get; private set; }

    /// <summary>Whether the mod's silence is up: it silenced the menu music and has not given it back (for QA).</summary>
    internal static bool Silenced => silenced;

    /// <summary>Whether the patch is in; without it the setting row isn't offered.</summary>
    internal static bool Available => installed;

    internal static void Install(HarmonyLib.Harmony harmony)
    {
        var postEvent = AccessTools.DeclaredMethod(typeof(AudioController), "PostEvent", new[] { typeof(string), typeof(WwiseEvent) })
            ?? throw new MissingMethodException(typeof(AudioController).FullName, "PostEvent");
        harmony.Patch(postEvent, postfix: new HarmonyMethod(typeof(MenuMusic), nameof(PostEventPostfix)));
        installed = true;
    }

    /// <summary>The setting's switch: saves it and has it take effect now.</summary>
    internal static void SetEnabled(bool on)
    {
        SettingsState.SetMenuMusic(on);
        try
        {
            if (on) GiveBack();
            else SilenceNow();
        }
        catch (Exception ex) { Report(ex); }
    }

    /// <summary>Called every frame; does something once, a moment after a silence.</summary>
    internal static void Update()
    {
        if (settleAt < 0f || Time.unscaledTime < settleAt) return;
        settleAt = -1f;
        try { Settle(); }
        catch (Exception ex) { Report(ex); }
    }

    // After AudioController.PostEvent(eventName, event) in the game. Almost every call is one of the game's
    // sounds; only the two music events matter, and only while the setting is off.
    private static void PostEventPostfix(AudioController __instance, string eventName, WwiseEvent @event)
    {
        if (SettingsState.MenuMusic) return;
        try
        {
            if (!StartsMenuMusic(eventName, @event)) return;
            PostSilence(__instance, "the game started its menu music");
        }
        catch (Exception ex) { Report(ex); }
    }

    private static bool StartsMenuMusic(string? name, WwiseEvent? @event)
    {
        // The game's own labels: AudioController.Start, AudioController.PlayTitle and, from the title
        // screen, the event's name. The id is the sure way for any other.
        if (name == "PlayMusicEvent" || name == "TitleMusicEvent" || name == "MX_Title_Menu" || name == "MX_PLAY_Music") return true;
        if (@event == null) return false;
        uint id = @event.Id;
        return id == TitleMenuEventId || id == PlayMusicEventId;
    }

    // ---- silence and giving it back ----------------------------------------------------------------------------------

    private static void SilenceNow()
    {
        if (!AkSoundEngine.IsInitialized()) return;
        // Only music that is the menu's: in a battle or the story the state isn't TitleMenu. When Wwise can't say,
        // the game's own state does.
        bool menuMusic = TryGetState(MusicState, out uint state) ? state == Id(MenuStateName) : InMenus();
        if (!menuMusic)
        {
            ModLog.Info("Main menu music: turned off; no menu music is playing now, so the next one the game starts will be silenced.");
            return;
        }
        PostSilence(AudioController.Instance, "turned off in the menus");
    }

    private static void GiveBack()
    {
        if (!silenced) return;
        silenced = false;
        settleAt = -1f;
        if (!AkSoundEngine.IsInitialized()) return;
        if (!InMenus())
        {
            ModLog.Info("Main menu music: turned on; the game plays it the next time it starts its menu music.");
            return;
        }
        // Only if Wwise still has the state the silence set; anything else has moved on and brings its own music.
        if (TryGetState(MusicState, out uint state) && state != Id(SilentStateName)) return;
        AudioController.PlayTitle();
        AkSoundEngine.SetState(SilenceGroup, "None");
        ModLog.Info("Main menu music: turned on; the game's title music plays again.");
    }

    private static void PostSilence(AudioController? controller, string why)
    {
        if (!AkSoundEngine.IsInitialized()) return;
        int frame = Time.frameCount;
        if (frame == silenceFrame) return;
        silenceFrame = frame;
        if (controller == null || !controller) controller = AudioController.Instance;
        uint id = controller != null && controller ? AkSoundEngine.PostEvent(SilenceEvent, controller.gameObject) : 0u;
        if (id == 0)
        {
            // The event's own states, if Wwise didn't take the event.
            ModLog.Error($"Main menu music: Wwise didn't play {SilenceEvent}; setting its states instead.");
            AkSoundEngine.SetState("Global_PostCombat", "Z_Off");
            AkSoundEngine.SetState("Global_Combat", "Z_Off");
            AkSoundEngine.SetState(SilenceGroup, SilenceNameFade);
            AkSoundEngine.SetState(MusicState, SilentStateName);
        }
        silenced = true;
        Silences++;
        settleAt = Time.unscaledTime + SettleAfter;
        ModLog.Info($"Main menu music: silenced ({why}).");
    }

    // The silence the game's events use before a song has the story's music start 3 s softer than it otherwise
    // does; once the menu music is gone, the instant one is in place. Only the silence this left is changed, and
    // only while the container is still on it: Global_Silence matters nowhere else.
    private static void Settle()
    {
        if (!silenced || !AkSoundEngine.IsInitialized()) return;
        if (TryGetState(SilenceGroup, out uint quiet) && quiet == Id(SilenceNameFade) &&
            TryGetState(MusicState, out uint state) && state == Id(SilentStateName))
            AkSoundEngine.SetState(SilenceGroup, SilenceNameQuick);
    }

    // ---- what the game and Wwise say -----------------------------------------------------------------------------------

    private static bool InMenus()
    {
        try { return GameManager.GameState == GameStates.MainMenu; }
        catch { return false; }
    }

    // The current state of a state group; false when Wwise can't say.
    private static bool TryGetState(string group, out uint state)
    {
        state = 0;
        try { return (int)AkSoundEngine.GetState(group, out state) == 1; }
        catch { return false; }
    }

    private static uint Id(string name)
    {
        if (!Ids.TryGetValue(name, out uint id)) Ids[name] = id = AkSoundEngine.GetIDFromString(name);
        return id;
    }

    private static void Report(Exception ex)
    {
        if (reportedError) return;
        reportedError = true;
        ModLog.Error("Main menu music failed: " + ex);
    }
}
